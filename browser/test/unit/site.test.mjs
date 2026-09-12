import { readFileSync } from "node:fs";
import { siteAllowed, withDefaults } from "../../src/common/settings.js";

// common.js declares `var LAITA`, so it has to be evaluated in the global sloppy scope.
(0, eval)(readFileSync(new URL("../../src/content/common.js", import.meta.url).pathname, "utf8"));
const LAITA = globalThis.LAITA;

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) pass++; else { fail++; console.log("FAIL " + name + "\n  got  " + a + "\n  want " + b); }
};

// ---------------------------------------------------------------- siteAllowed

const s = (patch) => withDefaults(patch);

eq("runs everywhere by default", siteAllowed(s({}), "example.com"), true);
eq("no hostname, no run", siteAllowed(s({}), ""), false);
eq("denylist blocks", siteAllowed(s({ disabledSites: ["example.com"] }), "example.com"), false);
eq("denylist covers subdomains", siteAllowed(s({ disabledSites: ["example.com"] }), "mail.example.com"), false);
eq("allowlist blocks anything unlisted",
   siteAllowed(s({ siteMode: "allowlist", enabledSites: ["a.com"] }), "b.com"), false);
eq("allowlist admits what is listed",
   siteAllowed(s({ siteMode: "allowlist", enabledSites: ["a.com"] }), "a.com"), true);

// the point of the override: it beats the standing policy either way
eq("override resumes a denylisted site",
   siteAllowed(s({ disabledSites: ["example.com"], siteOverrides: { "example.com": true } }), "example.com"),
   true);
eq("override pauses an ordinary site",
   siteAllowed(s({ siteOverrides: { "example.com": false } }), "example.com"), false);
eq("override resumes a site outside the allowlist",
   siteAllowed(s({ siteMode: "allowlist", enabledSites: ["a.com"], siteOverrides: { "b.com": true } }), "b.com"),
   true);
eq("override pauses a site inside the allowlist",
   siteAllowed(s({ siteMode: "allowlist", enabledSites: ["a.com"], siteOverrides: { "a.com": false } }), "a.com"),
   false);
eq("an override is exact, never inherited by subdomains",
   siteAllowed(s({ siteOverrides: { "example.com": false } }), "mail.example.com"), true);
eq("a non-boolean override is ignored",
   siteAllowed(s({ siteOverrides: { "example.com": "yes" } }), "example.com"), true);
eq("overrides survive withDefaults",
   withDefaults({ siteOverrides: { "a.com": false } }).siteOverrides, { "a.com": false });
eq("missing overrides default to none", withDefaults({}).siteOverrides, {});

// ---------------------------------------------------------------- pillPosition

const view = { width: 1000, height: 800 };
const size = { width: 90, height: 20 };
const field = { left: 100, top: 200, width: 400, height: 100 };

const below = LAITA.pillPosition(field, size, view);
eq("sits below the field, clear of the text", below.where, "below");
eq("below starts past the field's bottom edge", below.top >= field.top + field.height, true);
eq("right-aligned to the field", below.left, 100 + 400 - 90 - 4);

const atBottom = LAITA.pillPosition({ left: 100, top: 700, width: 400, height: 90 }, size, view);
eq("flips above when the field runs to the bottom", atBottom.where, "above");
eq("above ends before the field's top edge", atBottom.top + size.height <= 700, true);

const tall = LAITA.pillPosition({ left: 100, top: -50, width: 400, height: 900 }, size, view);
eq("falls back inside only when nothing else fits", tall.where, "inside");
eq("inside stays on screen", tall.top >= 4 && tall.top + size.height <= view.height, true);

const offRight = LAITA.pillPosition({ left: 900, top: 100, width: 400, height: 50 }, size, view);
eq("never runs off the right edge", offRight.left + size.width <= view.width - 4, true);
const offLeft = LAITA.pillPosition({ left: -300, top: 100, width: 200, height: 50 }, size, view);
eq("never runs off the left edge", offLeft.left >= 4, true);

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
