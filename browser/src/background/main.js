/**
 * Background event page.
 *
 * Content scripts never talk to Ollama directly: they hand chunks of text to this page,
 * which de-duplicates them against a cache, queues them at a bounded concurrency, and
 * cancels work that a newer keystroke has already made obsolete.
 */

// compat first: it aliases `browser` to `chrome` before anything else can look for it.
import { menus, canRefreshMenus } from "../common/compat.js";
import {
  getSettings, setSettings, siteAllowed, DEFAULTS, contentVisibleChange
} from "../common/settings.js";
import {
  requestIssues, requestTransform, probe, describeError, isTransient,
  estimateTransformTokens, transformTimeoutMs, PROMPT_VERSION,
  effectiveContext, looksTruncatedTransform
} from "./ollama.js";
import { anchorIssues, hash } from "./anchor.js";

// ---------------------------------------------------------------- cache

const CACHE_MAX = 600;
/** key -> raw model issues. Raw, so that changing the ignore list needs no invalidation. */
const cache = new Map();

function cacheKey(text, lang, s) {
  const cats = ["error", "style", "rephrase"].map((c) => (s.categories[c] ? "1" : "0")).join("");
  const profile = [
    PROMPT_VERSION, s.model, lang, cats, s.temperature,
    hash((s.dictionary || []).join(",")), hash(s.extraInstructions || "")
  ].join("|");
  return profile + "|" + hash(text) + "|" + text.length;
}

function cacheGet(key) {
  if (!cache.has(key)) return undefined;
  const v = cache.get(key);
  cache.delete(key);            // refresh LRU position
  cache.set(key, v);
  return v;
}

function cacheSet(key, value) {
  cache.set(key, value);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

// ---------------------------------------------------------------- queue

class Queue {
  constructor() {
    this.limit = DEFAULTS.concurrency;
    this.pending = [];
    this.running = 0;
  }
  add(item) {
    return new Promise((resolve, reject) => {
      this.pending.push({ ...item, resolve, reject });
      this.pump();
    });
  }
  pump() {
    while (this.running < this.limit && this.pending.length) {
      const item = this.pending.shift();
      if (isStale(item.clientId, item.gen)) {
        item.reject(new StaleError());
        continue;
      }
      this.running++;
      item
        .run()
        .then(item.resolve, item.reject)
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }
}

const queue = new Queue();

class StaleError extends Error {
  constructor() {
    super("superseded");
    this.stale = true;
  }
}

/** Newest generation seen per content-script client, and the requests still in flight. */
const generations = new Map();
const inFlight = new Set();

function isStale(clientId, gen) {
  return gen != null && gen < (generations.get(clientId) ?? 0);
}

function noteGeneration(clientId, gen) {
  if (clientId == null || gen == null) return;
  if (gen <= (generations.get(clientId) ?? 0)) return;
  generations.set(clientId, gen);
  for (const req of inFlight) {
    if (req.clientId === clientId && req.gen < gen) req.controller.abort();
  }
}

// ---------------------------------------------------------------- staying alive

/**
 * Firefox unloads an MV3 background page after about 30 seconds without extension
 * activity, and a pending `fetch()` does not count as activity. A model that takes
 * longer than that to answer therefore has its request killed along with the page, and
 * the content script's waiting message is refused with "Receiving end does not exist" -
 * which is exactly what a slow proofread looked like in the wild, and why it only ever
 * happened on long text or a loaded GPU.
 *
 * Touching an extension API on a timer resets that idle clock. The interval has to be
 * comfortably under the timeout, and is only running while something is outstanding, so
 * an idle extension is still allowed to be unloaded.
 */
const KEEPALIVE_MS = 20000;

let outstanding = 0;
let keepalive = null;

function holdOpen() {
  outstanding++;
  if (keepalive) return;
  keepalive = setInterval(() => {
    browser.runtime.getPlatformInfo().catch(() => {});
  }, KEEPALIVE_MS);
}

function releaseHold() {
  outstanding = Math.max(0, outstanding - 1);
  if (outstanding > 0 || !keepalive) return;
  clearInterval(keepalive);
  keepalive = null;
}

// ---------------------------------------------------------------- retry

const RETRY_DELAY_MS = 700;

/**
 * Run `attempt` again once if it failed in a way that tends to fix itself.
 *
 * The common case is Ollama returning 500 because the model runner did not start in
 * time. That first attempt is what triggers the load, so the second one usually lands on
 * a model that is now resident. Without this a routine reload shows up as an error in
 * the middle of typing.
 */
async function withRetry(attempt, signal) {
  // Every request the extension makes goes through here, so this is the one place that
  // has to keep the background page from being unloaded underneath it.
  holdOpen();
  try {
    try {
      return await attempt();
    } catch (err) {
      if (signal?.aborted || !isTransient(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      if (signal?.aborted) throw err;
      return await attempt();
    }
  } finally {
    releaseHold();
  }
}

// ---------------------------------------------------------------- checking

async function checkChunk({ text, lang, clientId, gen }) {
  const settings = await getSettings();
  queue.limit = Math.max(1, Number(settings.concurrency) || 1);
  noteGeneration(clientId, gen);

  const anchor = (raw) =>
    anchorIssues(text, raw, { categories: settings.categories, ignored: settings.ignored });

  const key = cacheKey(text, lang, settings);
  const hit = cacheGet(key);
  if (hit) return { ok: true, cached: true, issues: anchor(hit) };

  const raw = await queue.add({
    clientId,
    gen,
    run: async () => {
      const controller = new AbortController();
      const req = { clientId, gen, controller };
      inFlight.add(req);
      const timer = setTimeout(() => controller.abort(), settings.requestTimeoutMs);
      try {
        return await withRetry(
          () => requestIssues({ text, lang, settings, signal: controller.signal }),
          controller.signal
        );
      } finally {
        clearTimeout(timer);
        inFlight.delete(req);
      }
    }
  });

  cacheSet(key, raw);
  return { ok: true, cached: false, issues: anchor(raw) };
}

// ---------------------------------------------------------------- transform

/** Transforms are user-initiated and never queued: they start the moment they are asked
 *  for. Each carries an id from the content script so that closing the panel can abort it. */
const transforms = new Map();

const HISTORY_MAX = 20;

async function rememberInstruction(instruction) {
  const s = await getSettings();
  const next = [instruction, ...s.transformHistory.filter((i) => i !== instruction)].slice(0, HISTORY_MAX);
  if (next.join("\u0000") === s.transformHistory.join("\u0000")) return;
  await setSettings({ transformHistory: next });
}

async function transform({ text, instruction, lang, reqId }) {
  const settings = await getSettings();
  const controller = new AbortController();
  // This guard used to run only when numCtx was pinned - and numCtx defaults to 0, so in
  // the shipped configuration it never ran at all. maxChars allows 12000 characters, which
  // is ~8400 tokens, against a default Ollama window of 4096: the server silently truncated
  // the input, the model rewrote only the part it saw, and accepting replaced the WHOLE
  // selection with it. Ten pages in, one page out, no warning.
  const needed = estimateTransformTokens(text.length);
  const ctx = await effectiveContext(settings, controller.signal);
  if (needed > ctx.tokens) {
    const where = {
      pinned: `the ${ctx.tokens} context window pinned in the options`,
      server: `the ${ctx.tokens} window Ollama has this model loaded with`,
      assumed: `Ollama's default window of ${ctx.tokens} (the model is not loaded, so its ` +
               `real window could not be read)`
    }[ctx.source];
    return {
      ok: false,
      kind: "context",
      error:
        `This selection needs roughly ${needed} tokens to rewrite, more than ${where}. ` +
        `Select less, or raise the window with OLLAMA_CONTEXT_LENGTH and reload the model.`
    };
  }

  // Registered only once every early return is behind us: the delete lives in the finally
  // below, so anything that returns before this point would leave the controller in the
  // map for the life of the background page.
  if (reqId != null) transforms.set(reqId, controller);

  // Not settings.requestTimeoutMs: that is sized for a paragraph, and a transform's
  // work scales with the selection.
  const timer = setTimeout(() => controller.abort(), transformTimeoutMs(text.length, settings));
  try {
    await rememberInstruction(instruction);
    const output = await withRetry(
      () => requestTransform({ text, instruction, lang, settings, signal: controller.signal }),
      controller.signal
    );
    // The last line of defence. The size check above uses an estimate, and an estimate that
    // is 20% optimistic on a long selection still loses the tail. Proofreading has refused
    // visibly-abbreviated replacements since one destroyed a paragraph; this path replaces
    // far more text at once and had no equivalent.
    if (looksTruncatedTransform(text, output, instruction)) {
      return {
        ok: false,
        kind: "truncated",
        error:
          `The model returned ${output.trim().length} characters for a ${text.trim().length}-character ` +
          `selection, which is too short to be a rewrite of it - usually a sign the text did not fit ` +
          `in the context window. Nothing has been changed. Try a smaller selection.`
      };
    }
    return { ok: true, output };
  } finally {
    clearTimeout(timer);
    if (reqId != null) transforms.delete(reqId);
  }
}

// ---------------------------------------------------------------- badge

const BADGE_COLOR = { error: "#e5484d", style: "#e0a02a", rephrase: "#3b82f6", none: "#6b7280" };

async function setBadge(tabId, state) {
  const settings = await getSettings();
  if (tabId == null) return;
  if (!settings.showBadge) {
    await browser.action.setBadgeText({ tabId, text: "" }).catch(() => {});
    return;
  }
  let text = "";
  let color = BADGE_COLOR.none;
  if (state.busy) {
    text = "...";
  } else if (state.error) {
    text = "!";
    color = BADGE_COLOR.error;
  } else if (state.count > 0) {
    text = String(Math.min(state.count, 99));
    color = BADGE_COLOR[state.worst] || BADGE_COLOR.none;
  }
  await browser.action.setBadgeText({ tabId, text }).catch(() => {});
  await browser.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  await browser.action.setBadgeTextColor?.({ tabId, color: "#ffffff" }).catch(() => {});
}

// ---------------------------------------------------------------- messaging

const handlers = {
  async getSettings() {
    return await getSettings();
  },

  async getConfigFor({ hostname }) {
    const settings = await getSettings();
    return { settings, active: settings.enabled && siteAllowed(settings, hostname) };
  },

  async checkChunk(msg) {
    try {
      return await checkChunk(msg);
    } catch (err) {
      return describeError(err);
    }
  },

  async cancel({ clientId, gen }) {
    noteGeneration(clientId, gen);
    return { ok: true };
  },

  async status(msg, sender) {
    await setBadge(sender?.tab?.id, msg.state || {});
    return { ok: true };
  },

  async ignoreSuggestion({ fp }) {
    const s = await getSettings();
    if (fp && !s.ignored.includes(fp)) {
      const ignored = [...s.ignored, fp].slice(-500);
      await setSettings({ ignored });
    }
    return { ok: true };
  },

  async addToDictionary({ word }) {
    const s = await getSettings();
    const w = String(word || "").trim();
    if (w && !s.dictionary.includes(w)) {
      await setSettings({ dictionary: [...s.dictionary, w] });
    }
    return { ok: true };
  },

  async transformText(msg) {
    try {
      return await transform(msg);
    } catch (err) {
      return describeError(err);
    }
  },

  async cancelTransform({ reqId }) {
    transforms.get(reqId)?.abort();
    transforms.delete(reqId);
    return { ok: true };
  },

  async probe() {
    try {
      const s = await getSettings();
      return { ok: true, ...(await probe(s)), model: s.model, endpoint: s.endpoint };
    } catch (err) {
      return describeError(err);
    }
  },

  async setSettings({ patch }) {
    return await setSettings(patch);
  },

  /**
   * "Off/on here, right now", from the context menu, Alt+Shift+X or the popup.
   *
   * This writes a per-site override rather than editing the allowlist/denylist, so it
   * takes effect whatever the standing policy says. Turning a site back on also lifts a
   * global off-switch, because "resume here" that leaves the extension globally disabled
   * would appear to do nothing.
   */
  async toggleSite({ hostname, on }) {
    if (!hostname) return { ok: false, active: false };
    const s = await getSettings();
    const next = typeof on === "boolean" ? on : !(s.enabled && siteAllowed(s, hostname));
    const patch = { siteOverrides: { ...s.siteOverrides, [hostname]: next } };
    if (next && !s.enabled) patch.enabled = true;
    await setSettings(patch);
    return { ok: true, active: next };
  },

  async clearSiteOverrides() {
    await setSettings({ siteOverrides: {} });
    return { ok: true };
  },

  async clearCache() {
    cache.clear();
    return { ok: true, cleared: true };
  }
};

browser.runtime.onMessage.addListener((msg, sender) => {
  const handler = handlers[msg?.cmd];
  if (!handler) return false;
  return handler(msg, sender).catch((err) => describeError(err));
});

// ---------------------------------------------------------------- commands & lifecycle

async function tellActiveTab(payload) {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  await browser.tabs.sendMessage(tab.id, payload).catch(() => {});
}

const MENU_ID = "laita-transform";
const TOGGLE_ID = "laita-toggle-site";

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";                     // about:, view-source:, a blank tab
  }
}

/**
 * Firefox keeps menu registrations across restarts of a non-persistent background page, so
 * creating them again on every wake-up would throw on the duplicate id. Clearing first
 * makes this safe to call unconditionally, which in turn means the item exists even when
 * neither onInstalled nor onStartup has fired in this browsing session.
 */
async function installMenus() {
  await menus.removeAll().catch(() => {});
  menus.create({
    id: MENU_ID,
    title: "Transform\u2026",
    contexts: ["selection"]
  });
  menus.create({
    id: TOGGLE_ID,
    title: "Pause spell check here",
    contexts: ["page", "editable", "selection"]
  });
}

installMenus();
browser.runtime.onInstalled.addListener(installMenus);

/**
 * Both browsers group an extension's menu items under a submenu named after the
 * extension, so these titles must not repeat it: the user reads
 * "LAITA - Local AI Text Assistant > Transform".
 */

/** Word the pause/resume item for whichever site the given tab is on. */
async function toggleTitleFor(tab) {
  const hostname = hostnameOf(tab?.url);
  const settings = await getSettings();
  const running = !!hostname && settings.enabled && siteAllowed(settings, hostname);
  const where = hostname || "this page";
  return {
    title: running ? `Pause spell check on ${where}` : `Resume spell check on ${where}`,
    enabled: !!hostname
  };
}

if (canRefreshMenus) {
  // Firefox can rewrite a title as the menu opens, which is exact. `menus.onShown` may
  // resolve after the menu has already closed or been reopened, hence the instance
  // counter: refreshing a stale menu is an error.
  let menuInstance = 0;

  menus.onShown.addListener(async (info, tab) => {
    if (!info.menuIds.includes(TOGGLE_ID)) return;
    const instance = ++menuInstance;
    const patch = await toggleTitleFor(tab);
    if (instance !== menuInstance) return;
    await menus.update(TOGGLE_ID, patch);
    menus.refresh();
  });

  menus.onHidden.addListener(() => {
    menuInstance++;
  });
} else {
  // Chrome has neither onShown nor refresh, so the title is updated whenever the active
  // tab changes or navigates - ahead of time rather than on open, but correct by the
  // time anyone right-clicks. Also refreshed after a toggle, since that is the one
  // change that does not involve switching tab.
  const refreshActiveTitle = async () => {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    await menus.update(TOGGLE_ID, await toggleTitleFor(tab)).catch(() => {});
  };
  browser.tabs.onActivated.addListener(refreshActiveTitle);
  browser.tabs.onUpdated.addListener((_id, change) => {
    if (change.url || change.status === "complete") refreshActiveTitle();
  });
  browser.windows?.onFocusChanged?.addListener(refreshActiveTitle);
  browser.storage.onChanged.addListener(refreshActiveTitle);
}

menus.onClicked.addListener(async (info, tab) => {
  if (!tab) return;
  if (info.menuItemId === MENU_ID) {
    await browser.tabs
      .sendMessage(tab.id, { cmd: "transformSelection" }, { frameId: info.frameId ?? 0 })
      .catch(() => {});
    return;
  }
  if (info.menuItemId === TOGGLE_ID) {
    const hostname = hostnameOf(tab.url);
    if (!hostname) return;
    await handlers.toggleSite({ hostname });
    await browser.tabs.sendMessage(tab.id, { cmd: "settingsChanged" }).catch(() => {});
  }
});

browser.commands.onCommand.addListener(async (name) => {
  if (name === "check-now") {
    await tellActiveTab({ cmd: "checkNow" });
  } else if (name === "transform-selection") {
    await tellActiveTab({ cmd: "transformSelection" });
  } else if (name === "toggle-site") {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    const hostname = hostnameOf(tab?.url);
    if (!hostname) return;
    await handlers.toggleSite({ hostname });
    await browser.tabs.sendMessage(tab.id, { cmd: "settingsChanged" }).catch(() => {});
  }
});

browser.storage.onChanged.addListener(async (changes) => {
  if (!contentVisibleChange(changes)) return;
  const tabs = await browser.tabs.query({});
  for (const tab of tabs) {
    browser.tabs.sendMessage(tab.id, { cmd: "settingsChanged" }).catch(() => {});
  }
});

browser.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") browser.runtime.openOptionsPage().catch(() => {});
});
