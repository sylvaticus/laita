/**
 * The numeric settings, and the two places that define their ranges.
 *
 * options.html already carried min/max on every number input, so the spinner was fine.
 * Nothing enforced them when a value arrived any other way - typed over the field, saved
 * from a synced profile, restored from an older version, or written straight into
 * storage - and every consumer then trusted it. clampSetting closes that, but only while
 * the two lists agree, which is what this file is really for.
 */
import { readFileSync } from "node:fs";
import { LIMITS, clampSetting, withDefaults, DEFAULTS } from "../../src/common/settings.js";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) pass++; else { fail++; console.log(`FAIL ${name}\n  got  ${a}\n  want ${b}`); }
};

// --- the two sources of truth must agree ---------------------------------------------
const html = readFileSync(new URL("../../src/options/options.html", import.meta.url).pathname, "utf8");
const inputs = [...html.matchAll(/<input id="(\w+)" type="number"([^>]*)>/g)].map(([, id, attrs]) => ({
  id,
  min: Number((attrs.match(/min="(-?[\d.]+)"/) || [])[1]),
  max: Number((attrs.match(/max="(-?[\d.]+)"/) || [])[1])
}));
eq("every number input was found", inputs.length > 0, true);
for (const { id, min, max } of inputs) {
  eq(`${id}: html min/max present`, Number.isFinite(min) && Number.isFinite(max), true);
  eq(`${id}: LIMITS matches the html`, LIMITS[id], [min, max]);
}
for (const id of Object.keys(LIMITS)) {
  const inHtml = inputs.some((i) => i.id === id);
  // requestTimeoutMs has no number input; it is still clamped on the way in.
  if (!inHtml) eq(`${id}: clamped even without an input`, Array.isArray(LIMITS[id]), true);
}

// --- clamping -------------------------------------------------------------------------
eq("concurrency 100 is pulled back to the maximum", clampSetting("concurrency", 100), 8);
eq("concurrency 0 is pulled up to the minimum", clampSetting("concurrency", 0), 1);
eq("debounceMs 0 would be a request per keystroke", clampSetting("debounceMs", 0), 300);
eq("a negative temperature is not a temperature", clampSetting("temperature", -5), 0);
eq("temperature 0.7 is left alone", clampSetting("temperature", 0.7), 0.7);
eq("maxChars 1e9 is capped", clampSetting("maxChars", 1e9), 200000);
eq("a non-number falls back to the default", clampSetting("debounceMs", "abc"), DEFAULTS.debounceMs);
eq("an empty string falls back too", clampSetting("minChars", ""), DEFAULTS.minChars);
eq("numCtx 0 is meaningful and must survive", clampSetting("numCtx", 0), 0);
eq("an unknown key is passed through untouched", clampSetting("model", "qwen3.5:9b"), "qwen3.5:9b");

// --- withDefaults must not trust what is stored ----------------------------------------
// Every consumer assumes these shapes: s.ignored.includes(fp), s.dictionary.join(", ").
eq("a string where an array belongs is replaced",
   Array.isArray(withDefaults({ dictionary: "not an array" }).dictionary), true);
eq("null for an array is replaced",
   Array.isArray(withDefaults({ ignored: null }).ignored), true);
eq("a number where a boolean belongs is replaced",
   typeof withDefaults({ enabled: 1 }).enabled, "boolean");
eq("an object where a string belongs is replaced",
   typeof withDefaults({ model: { evil: true } }).model, "string");
eq("an out-of-range stored number is clamped on read",
   withDefaults({ concurrency: 999 }).concurrency, 8);
eq("an array where an object belongs does not poison the merge",
   typeof withDefaults({ categories: ["error"] }).categories.error, "boolean");
eq("a string where an object belongs is survivable",
   typeof withDefaults({ siteOverrides: "x" }).siteOverrides, "object");
eq("good values are untouched",
   withDefaults({ dictionary: ["laita"], concurrency: 2 }).dictionary, ["laita"]);
eq("and the defaults still come through",
   withDefaults({}).model, DEFAULTS.model);
eq("a completely empty store yields usable settings",
   Array.isArray(withDefaults(undefined).ignored), true);

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
