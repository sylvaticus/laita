/** Single source of truth for configuration. Imported by background, options and popup. */

export const DEFAULTS = {
  // --- connection ---
  endpoint: "http://localhost:11434",
  model: "qwen3.5:9b",
  temperature: 0,
  // 0 = send no num_ctx and inherit whatever Ollama is configured for. Ollama keys a
  // loaded model by its runtime options, so naming a context size here that differs from
  // another client's evicts that client's runner and loads a second copy of the same
  // weights - which on a card that only just fits the model is where load failures come
  // from. Pin a number only to deliberately override the server.
  numCtx: 0,
  think: false,            // disable "thinking" on reasoning models: much faster
  keepAlive: "10m",        // keep the model resident between checks
  requestTimeoutMs: 90000,
  // Ollama serialises requests unless OLLAMA_NUM_PARALLEL is raised, and its own default
  // is 1. Sending a second chunk early therefore gains nothing and costs something: the
  // request timeout starts when a chunk is sent, so one waiting in Ollama's queue spends
  // the first chunk's whole duration burning its own budget. Only worth raising to match
  // a server actually configured for more.
  concurrency: 1,          // chunks in flight at once

  // --- when to check ---
  enabled: true,
  triggerMode: "auto",     // "auto" (debounced while typing) | "manual" (hotkey / button only)
  debounceMs: 1500,
  minChars: 12,            // do not touch fields shorter than this
  // Cap on how much one check may send, not on how long a field may be: with the
  // default caret scope a single paragraph goes out, so a long document is fine and only
  // an explicit whole-field sweep can exceed this. Also caps a single transform.
  maxChars: 12000,
  chunkMaxChars: 700,      // a paragraph longer than this is split into sentence groups
  // "caret"  - only the paragraph the caret is in, leaving the rest of a long document
  //            alone until you work on it. Opening a 2000-word post should not queue up
  //            twenty requests before you have typed anything.
  // "field"  - everything, the way a spell checker sweeps a document.
  // Alt+Shift+C and the toolbar button always sweep the whole field regardless.
  checkScope: "caret",

  // --- language ---
  language: "auto",        // "auto" or an ISO code such as "en", "fr"

  // --- transform (right-click on a selection) ---
  transformDefault: "polish",   // instruction used when the prompt is submitted empty
  transformHistory: [],         // recent instructions, most recent first

  // --- what to report ---
  categories: { error: true, style: true, rephrase: true },
  colors: { error: "#e5484d", style: "#e0a02a", rephrase: "#3b82f6" },
  tint: true,              // faint background behind a highlight, on top of the underline
  dictionary: [],          // words that must never be flagged
  extraInstructions: "",   // free-form house style rules appended to the prompt

  // --- where to run ---
  siteMode: "all",         // "all" (everywhere except disabledSites) | "allowlist"
  disabledSites: [],       // hostnames
  enabledSites: [],        // hostnames, used when siteMode === "allowlist"
  siteOverrides: {},       // hostname -> bool; beats siteMode. Set from the context menu,
                           // Alt+Shift+X and the popup, i.e. "off/on here, right now"

  // --- misc ---
  ignored: [],             // fingerprints of suggestions the user dismissed for good
  showBadge: true,
  debug: false
};

/** Deep-ish merge that only walks the one level of nested objects we actually have. */
/**
 * Ranges for the numeric settings.
 *
 * These MUST match the min/max on the matching inputs in options.html. The spinner already
 * enforced them, but nothing did when a value arrived any other way - typed over,
 * restored from a synced profile, or written straight into storage - and every consumer
 * then trusted it: concurrency 100 against a server that serialises, debounceMs 0 (a
 * request per keystroke), a negative temperature. options.test.mjs fails if the two
 * drift apart.
 */
export const LIMITS = {
  temperature:      [0, 1],
  numCtx:           [0, 131072],
  concurrency:      [1, 8],
  requestTimeoutMs: [5000, 3600000],
  debounceMs:       [300, 20000],
  minChars:         [1, 500],
  chunkMaxChars:    [120, 4000],
  maxChars:         [500, 200000]
};

export function clampSetting(key, value) {
  const range = LIMITS[key];
  if (!range) return value;
  // Number("") and Number("  ") are 0, which would clamp to the minimum and look like a
  // deliberate choice. An empty field means "I have not said", so it takes the default.
  if (value === "" || value === null || value === undefined ||
      (typeof value === "string" && value.trim() === "")) {
    return DEFAULTS[key];
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULTS[key];
  return Math.min(range[1], Math.max(range[0], n));
}

/**
 * Merge stored settings over the defaults, without trusting what is stored.
 *
 * Every consumer assumes the shapes hold - `s.ignored.includes(fp)`,
 * `s.dictionary.slice(0, 300).join(", ")` - so a store that has been corrupted, restored
 * from another version, or hand-edited turns each of those into a TypeError that surfaces
 * as an unhelpful "something went wrong". Taking the default for anything of the wrong
 * type makes the store self-healing instead.
 */
export function withDefaults(stored) {
  const out = { ...DEFAULTS, ...(stored || {}) };
  for (const key of ["categories", "colors", "siteOverrides"]) {
    const from = stored && stored[key];
    const usable = from && typeof from === "object" && !Array.isArray(from) ? from : {};
    out[key] = { ...DEFAULTS[key], ...usable };
  }
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const v = out[key];
    if (Array.isArray(fallback)) {
      if (!Array.isArray(v)) out[key] = [...fallback];
    } else if (typeof fallback === "number") {
      out[key] = clampSetting(key, v);
    } else if (typeof fallback === "boolean") {
      if (typeof v !== "boolean") out[key] = fallback;
    } else if (typeof fallback === "string") {
      if (typeof v !== "string") out[key] = fallback;
    }
  }
  return out;
}

/**
 * Resolved settings, cached.
 *
 * getSettings() is on every hot path there is - every chunk, every transform, every badge
 * update, and setBadge runs on every status message from every content script in every
 * frame. Each uncached call deserialised the entire store: a dictionary of up to 300
 * words, up to 500 ignored fingerprints and the whole transform history, several times per
 * keystroke. The storage.onChanged listener below keeps this honest, and it is the same
 * event every other part of the extension already reacts to.
 */
let cached = null;
let inflight = null;

/** Settings changed underneath us - through this module or any other page.
 *  Guarded because this module is also imported by unit tests, where there is no
 *  extension API at all, and by pages that may load before compat.js has aliased
 *  `browser` onto `chrome`. */
try {
  globalThis.browser?.storage?.onChanged?.addListener(() => {
    cached = null;
    inflight = null;
  });
} catch {
  /* no extension storage here; getSettings will simply not cache */
}

export async function getSettings() {
  if (cached) return cached;
  // Concurrent callers before the first read lands must not each issue their own.
  if (!inflight) {
    inflight = browser.storage.local.get(null).then((stored) => {
      cached = withDefaults(stored);
      inflight = null;
      return cached;
    });
  }
  return inflight;
}

export async function setSettings(patch) {
  cached = null;
  inflight = null;
  await browser.storage.local.set(patch);
  return getSettings();
}

/**
 * Which site is a tab on?
 *
 * Asked of the page rather than read from `tab.url`. `tab.url` is only populated for tabs
 * the extension holds a host permission for, and it deliberately no longer holds one over
 * every site - reading this string was the only thing `<all_urls>` in `host_permissions`
 * ever bought. The content script is already on the page and already knows.
 *
 * `ask` is injected so this is testable without a browser: it takes a tab id and resolves
 * to whatever the content script replied.
 */
export async function resolveHostname(tab, ask) {
  if (!tab || tab.id == null) return "";
  try {
    const res = await ask(tab.id);
    if (res?.hostname) return String(res.hostname);
  } catch {
    /* no content script here: about:, the add-on stores, a PDF viewer, a discarded tab */
  }
  try {
    return new URL(tab.url).hostname;
  } catch {
    return "";
  }
}

/**
 * Is this endpoint on the machine the browser is running on?
 *
 * The privacy claim is "nothing leaves your machine", and the endpoint is the one setting
 * that can make it false. It is free text, so this is the only place that can tell the
 * difference between the default and a server on the internet - and the answer drives a
 * confirmation, a permission request and a visible marker rather than being advisory.
 *
 * Deliberately strict: anything it cannot parse is treated as remote. A malformed
 * endpoint that is waved through is exactly the case this exists to catch.
 */
export function isLoopbackEndpoint(endpoint) {
  let url;
  try {
    url = new URL(String(endpoint || "").trim());
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;

  // URL lower-cases the hostname but KEEPS the brackets on an IPv6 literal, so
  // "http://[::1]/" gives "[::1]" rather than "::1".
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  // The whole 127.0.0.0/8 block, not just 127.0.0.1.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    if (parts.some((n) => n > 255)) return false;
    return parts[0] === 127;
  }
  return false;
}

/** Is the text sent in clear over a network? Loopback http never leaves the machine, so
 *  it is not the same risk as http to another host. */
export function isClearTextEndpoint(endpoint) {
  if (isLoopbackEndpoint(endpoint)) return false;
  try {
    return new URL(String(endpoint || "").trim()).protocol === "http:";
  } catch {
    return false;
  }
}

/** Settings a content script actually reads. The dictionary and the ignored list are used
 *  only when the background builds a prompt or filters a reply, so a change to either
 *  needs no tab to hear about it. */
export const CONTENT_VISIBLE = new Set([
  "enabled", "sites", "siteMode", "siteOverrides", "categories", "colors",
  "debounceMs", "minChars", "maxChars", "chunkMaxChars", "showBadge", "debug",
  "transformDefault", "language", "triggerMode", "transformHistory"
]);

/**
 * Should a storage change be announced to every tab?
 *
 * Comparing VALUES, not key names, is the whole point. The options page collects every
 * field into one patch and writes it 350 ms after each keystroke, so onChanged always
 * reports every key - a name-based filter lets the storm straight through. Typing one
 * sentence into "Extra instructions" used to make every frame of every open tab re-read
 * the entire store, several times a second.
 */
export function contentVisibleChange(changes) {
  if (!changes) return true;            // no detail supplied: assume it matters
  const same = (a, b) => {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;                     // unserialisable is not a reason to skip it
    }
  };
  return Object.entries(changes).some(
    ([k, c]) => CONTENT_VISIBLE.has(k) && !same(c?.oldValue, c?.newValue)
  );
}

/**
 * Decide whether Local AI Text Assistant should run on a given hostname.
 *
 * A per-site override always wins. It is what the context menu, Alt+Shift+X and the popup
 * set, so that "pause here" means paused whatever the allowlist says; the lists stay the
 * standing policy for every site without one.
 */
export function siteAllowed(settings, hostname) {
  if (!hostname) return false;
  const override = settings.siteOverrides?.[hostname];
  if (typeof override === "boolean") return override;
  const matches = (list) =>
    list.some((h) => {
      const n = String(h).trim().toLowerCase().replace(/^\*\./, "");
      return n && (hostname === n || hostname.endsWith("." + n));
    });
  if (settings.siteMode === "allowlist") return matches(settings.enabledSites);
  return !matches(settings.disabledSites);
}
