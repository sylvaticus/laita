/** Single source of truth for configuration. Imported by background, options and popup. */

export const DEFAULTS = {
  // --- connection ---
  endpoint: "http://localhost:11434",
  model: "qwen3.5:9b",
  temperature: 0,
  numCtx: 4096,
  think: false,            // disable "thinking" on reasoning models: much faster
  keepAlive: "10m",        // keep the model resident between checks
  requestTimeoutMs: 90000,
  concurrency: 2,          // parallel requests to Ollama

  // --- when to check ---
  enabled: true,
  triggerMode: "auto",     // "auto" (debounced while typing) | "manual" (hotkey / button only)
  debounceMs: 1500,
  minChars: 12,            // do not touch fields shorter than this
  maxChars: 12000,         // safety cap on a single field
  chunkMaxChars: 700,      // a paragraph longer than this is split into sentence groups

  // --- language ---
  language: "auto",        // "auto" or an ISO code such as "en", "fr"

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

  // --- misc ---
  ignored: [],             // fingerprints of suggestions the user dismissed for good
  showBadge: true,
  debug: false
};

/** Deep-ish merge that only walks the one level of nested objects we actually have. */
export function withDefaults(stored) {
  const out = { ...DEFAULTS, ...(stored || {}) };
  for (const key of ["categories", "colors"]) {
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

/** Decide whether Local AI Spell Checker should run on a given hostname. */
export function siteAllowed(settings, hostname) {
  if (!hostname) return false;
  const matches = (list) =>
    list.some((h) => {
      const n = String(h).trim().toLowerCase().replace(/^\*\./, "");
      return n && (hostname === n || hostname.endsWith("." + n));
    });
  if (settings.siteMode === "allowlist") return matches(settings.enabledSites);
  return !matches(settings.disabledSites);
}
