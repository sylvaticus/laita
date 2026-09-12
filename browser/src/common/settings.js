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
  maxChars: 12000,         // safety cap on a single field
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
export function withDefaults(stored) {
  const out = { ...DEFAULTS, ...(stored || {}) };
  for (const key of ["categories", "colors", "siteOverrides"]) {
    out[key] = { ...DEFAULTS[key], ...((stored && stored[key]) || {}) };
  }
  return out;
}

export async function getSettings() {
  const stored = await browser.storage.local.get(null);
  return withDefaults(stored);
}

export async function setSettings(patch) {
  await browser.storage.local.set(patch);
  return getSettings();
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
