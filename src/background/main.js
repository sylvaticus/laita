/**
 * Background event page.
 *
 * Content scripts never talk to Ollama directly: they hand chunks of text to this page,
 * which de-duplicates them against a cache, queues them at a bounded concurrency, and
 * cancels work that a newer keystroke has already made obsolete.
 */

import { getSettings, setSettings, siteAllowed, DEFAULTS } from "../common/settings.js";
import { requestIssues, requestTransform, probe, PROMPT_VERSION } from "./ollama.js";
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
        return await requestIssues({ text, lang, settings, signal: controller.signal });
      } finally {
        clearTimeout(timer);
        inFlight.delete(req);
      }
    }
  });

  cacheSet(key, raw);
  return { ok: true, cached: false, issues: anchor(raw) };
}

function describeError(err) {
  if (err?.stale) return { ok: false, stale: true };
  const msg = String(err?.message || err);
  if (err?.name === "AbortError") {
    return { ok: false, error: "The request to Ollama timed out.", kind: "timeout" };
  }
  if (/NetworkError|Failed to fetch|ECONNREFUSED|network/i.test(msg)) {
    return {
      ok: false,
      kind: "connection",
      error:
        "Cannot reach Ollama. Check that `ollama serve` is running and that the endpoint " +
        "in Local AI Spell Checker's options is correct."
    };
  }
  if (/HTTP 403/.test(msg)) {
    return {
      ok: false,
      kind: "cors",
      error:
        "Ollama refused the request because it came from a browser extension. Allow it once " +
        "with OLLAMA_ORIGINS=\"moz-extension://*\" and restart Ollama - see the README."
    };
  }
  if (/HTTP 404/.test(msg)) {
    return { ok: false, kind: "model", error: "Ollama does not have that model. Run `ollama pull <model>`." };
  }
  return { ok: false, kind: "other", error: msg };
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
  if (reqId != null) transforms.set(reqId, controller);
  const timer = setTimeout(() => controller.abort(), settings.requestTimeoutMs);
  try {
    await rememberInstruction(instruction);
    const output = await requestTransform({ text, instruction, lang, settings, signal: controller.signal });
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

  async toggleSite({ hostname }) {
    const s = await getSettings();
    if (s.siteMode === "allowlist") {
      const on = s.enabledSites.includes(hostname);
      await setSettings({
        enabledSites: on ? s.enabledSites.filter((h) => h !== hostname) : [...s.enabledSites, hostname]
      });
    } else {
      const off = s.disabledSites.includes(hostname);
      await setSettings({
        disabledSites: off ? s.disabledSites.filter((h) => h !== hostname) : [...s.disabledSites, hostname]
      });
    }
    const next = await getSettings();
    return { ok: true, active: next.enabled && siteAllowed(next, hostname) };
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

const MENU_ID = "locaispell-transform";

/**
 * Firefox keeps menu registrations across restarts of a non-persistent background page, so
 * creating them again on every wake-up would throw on the duplicate id. Clearing first
 * makes this safe to call unconditionally, which in turn means the item exists even when
 * neither onInstalled nor onStartup has fired in this browsing session.
 */
async function installMenus() {
  await browser.menus.removeAll().catch(() => {});
  browser.menus.create({
    id: MENU_ID,
    title: "Locaispell transform\u2026",
    contexts: ["selection"]
  });
}

installMenus();
browser.runtime.onInstalled.addListener(installMenus);

browser.menus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab) return;
  await browser.tabs
    .sendMessage(tab.id, { cmd: "transformSelection" }, { frameId: info.frameId ?? 0 })
    .catch(() => {});
});

browser.commands.onCommand.addListener(async (name) => {
  if (name === "check-now") {
    await tellActiveTab({ cmd: "checkNow" });
  } else if (name === "transform-selection") {
    await tellActiveTab({ cmd: "transformSelection" });
  } else if (name === "toggle-site") {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return;
    try {
      const hostname = new URL(tab.url).hostname;
      await handlers.toggleSite({ hostname });
      await browser.tabs.sendMessage(tab.id, { cmd: "settingsChanged" }).catch(() => {});
    } catch {
      /* non-http tab */
    }
  }
});

browser.storage.onChanged.addListener(async () => {
  const tabs = await browser.tabs.query({});
  for (const tab of tabs) {
    browser.tabs.sendMessage(tab.id, { cmd: "settingsChanged" }).catch(() => {});
  }
});

browser.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") browser.runtime.openOptionsPage().catch(() => {});
});
