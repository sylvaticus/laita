/**
 * The interface text, and the three ways it can quietly go wrong.
 *
 * The card used to hold five hardcoded translation tables keyed on the detected language
 * of the TEXT, which is backwards: a French speaker proofreading English got English
 * buttons. It now uses browser.i18n, which keys on the reader's browser locale.
 *
 * What breaks silently with _locales/ is a key added to one file and not the others -
 * getMessage returns "" and the button loses its label - or a key used in code that no
 * catalogue defines. Both are checked here.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;
const LOCALES = join(ROOT, "_locales");

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) pass++; else { fail++; console.log(`FAIL ${name}\n  got  ${a}\n  want ${b}`); }
};
const ok = (name, cond, detail = "") => {
  if (cond) pass++; else { fail++; console.log("FAIL " + name + (detail ? "\n  " + detail : "")); }
};

const locales = readdirSync(LOCALES).sort();
ok("locales exist", locales.length > 0);
ok("en is present - it is the default_locale", locales.includes("en"));

const catalogues = {};
for (const loc of locales) {
  const raw = readFileSync(join(LOCALES, loc, "messages.json"), "utf8");
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
  ok(`${loc}: messages.json parses`, !!parsed);
  if (parsed) catalogues[loc] = parsed;
}

const enKeys = Object.keys(catalogues.en || {}).sort();
ok("en defines some messages", enKeys.length > 0);

for (const [loc, cat] of Object.entries(catalogues)) {
  eq(`${loc}: exactly the same keys as en`, Object.keys(cat).sort(), enKeys);
  for (const [k, v] of Object.entries(cat)) {
    ok(`${loc}.${k}: has a non-empty message`, typeof v.message === "string" && v.message.trim() !== "");
  }
}

// --- the code and the catalogues must agree ---------------------------------------------
const card = readFileSync(join(ROOT, "src/content/card.js"), "utf8");
const used = [...card.matchAll(/\bt\("([A-Za-z0-9_]+)"\)/g)].map((m) => m[1]);
const viaMap = [...card.matchAll(/^\s*(?:error|style|rephrase):\s*"([A-Za-z0-9_]+)"/gm)].map((m) => m[1]);
const allUsed = [...new Set([...used, ...viaMap])].sort();

ok("card.js asks for some messages", allUsed.length > 0, allUsed.join(", "));
for (const k of allUsed) {
  ok(`en defines "${k}", which card.js uses`, enKeys.includes(k));
}

// The fallback exists for a content script whose i18n data did not load. It must cover
// every key, or that case loses a label instead of degrading to English.
const fallbackKeys = [...card.matchAll(/^\s{2}([A-Za-z0-9_]+):\s*"/gm)].map((m) => m[1]);
for (const k of allUsed) {
  ok(`the in-code fallback covers "${k}"`, fallbackKeys.includes(k),
     `fallback has: ${fallbackKeys.join(", ")}`);
}

// --- the manifest must declare the default --------------------------------------------
for (const f of ["manifest.json", "manifest.chrome.json"]) {
  const m = JSON.parse(readFileSync(join(ROOT, f), "utf8"));
  eq(`${f}: default_locale is en`, m.default_locale, "en");
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
