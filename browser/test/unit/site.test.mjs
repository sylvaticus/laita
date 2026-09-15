import { readFileSync } from "node:fs";
import {
  siteAllowed, withDefaults, contentVisibleChange, isLoopbackEndpoint, isClearTextEndpoint,
  resolveHostname
} from "../../src/common/settings.js";

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

// --- the settings broadcast -----------------------------------------------------------
// Every settings write used to wake every frame of every open tab to re-read the whole
// store. The trap: the options page collects EVERY field into one patch and saves it 350ms
// after each keystroke, so onChanged always names every key. Filtering on key names alone
// therefore changes nothing at all - the values have to be compared.
const chg = (o) => Object.fromEntries(
  Object.entries(o).map(([k, [a, b]]) => [k, { oldValue: a, newValue: b }]));

eq("a real change to a watched key broadcasts",
   contentVisibleChange(chg({ enabled: [true, false] })), true);
eq("the whole-patch save with nothing actually changed does not",
   contentVisibleChange(chg({
     enabled: [true, true], debounceMs: [1500, 1500], model: ["m", "m"],
     extraInstructions: ["a", "ab"], dictionary: [[], []]
   })), false);
eq("...but the same save does broadcast once a watched value moves",
   contentVisibleChange(chg({
     enabled: [true, true], debounceMs: [1500, 900], extraInstructions: ["a", "ab"]
   })), true);
eq("a dictionary addition alone stays in the background",
   contentVisibleChange(chg({ dictionary: [["a"], ["a", "b"]] })), false);
eq("so does an ignored fingerprint",
   contentVisibleChange(chg({ ignored: [[], ["ff00"]] })), false);
eq("a per-site pause reaches the tabs",
   contentVisibleChange(chg({ siteOverrides: [{}, { "x.com": "off" }] })), true);
eq("nested objects are compared by value, not identity",
   contentVisibleChange(chg({ categories: [{ error: true }, { error: true }] })), false);
eq("and a nested change is caught",
   contentVisibleChange(chg({ categories: [{ error: true }, { error: false }] })), true);
eq("no detail at all is treated as significant",
   contentVisibleChange(undefined), true);

// --- the endpoint classification --------------------------------------------------------
// The endpoint is free text and it is the single setting that can make "nothing leaves
// your machine" false. Anything this cannot parse must be treated as remote: a malformed
// endpoint waved through is exactly the case the check exists to catch.
const local = (u) => eq(`local: ${u}`, isLoopbackEndpoint(u), true);
const remote = (u) => eq(`remote: ${u}`, isLoopbackEndpoint(u), false);

local("http://localhost:11434");
local("http://127.0.0.1:11434");
local("https://localhost");
local("http://LOCALHOST:11434");           // the URL parser lower-cases it
local("http://dev.localhost:3000");
local("http://127.5.6.7");                  // the whole 127/8 block, not just .0.1
local("http://[::1]:11434");
local("http://[0:0:0:0:0:0:0:1]/");
local("  http://localhost:11434  ");        // stray whitespace from a paste

remote("http://192.168.1.5:11434");         // the LAN is not this machine
remote("https://collector.attacker.example");
remote("http://127.0.0.1.evil.com");        // the classic prefix trick
remote("http://localhost.evil.com");
remote("http://0.0.0.0:11434");             // binds locally, is not a loopback destination
remote("http://[2001:db8::1]");
remote("ftp://localhost");                  // only http(s) is ever fetched
remote("file:///etc/passwd");
remote("http://999.0.0.1");                 // not a valid v4 address
remote("not a url");
remote("");
remote(undefined);
remote(null);

eq("plain http to another host is cleartext",
   isClearTextEndpoint("http://192.168.1.5:11434"), true);
eq("https to another host is not",
   isClearTextEndpoint("https://ollama.example"), false);
eq("http to loopback never leaves the machine, so it is not cleartext risk",
   isClearTextEndpoint("http://localhost:11434"), false);
eq("an unparseable endpoint is not reported as cleartext, only as remote",
   isClearTextEndpoint("not a url"), false);

// --- which site is a tab on -------------------------------------------------------------
// The background used to read tab.url, which needs a host permission over every site. It
// no longer holds one, so the page is asked instead. If this path is wrong the per-site
// pause silently degrades to "this page" and does nothing when clicked - the single most
// likely regression from dropping <all_urls>.
const replies = (h) => async () => ({ ok: true, hostname: h });
const throws = () => async () => { throw new Error("Could not establish connection"); };

eq("the content script's answer is used",
   await resolveHostname({ id: 1, url: "https://example.com/x" }, replies("example.com")),
   "example.com");
eq("it is preferred over tab.url when they disagree",
   await resolveHostname({ id: 1, url: "https://stale.example/" }, replies("fresh.example")),
   "fresh.example");
eq("no content script falls back to tab.url",
   await resolveHostname({ id: 1, url: "https://example.com/x" }, throws()),
   "example.com");
eq("no content script and no readable url gives nothing, not a crash",
   await resolveHostname({ id: 1, url: undefined }, throws()), "");
eq("an about: page gives nothing",
   await resolveHostname({ id: 1, url: "about:blank" }, throws()), "");
eq("a tab with no id is not messaged at all",
   await resolveHostname({ url: "https://example.com/" }, () => { throw new Error("must not be called"); }),
   "");
eq("no tab at all is safe",
   await resolveHostname(undefined, throws()), "");
eq("an empty reply falls through to tab.url rather than returning empty",
   await resolveHostname({ id: 1, url: "https://example.com/" }, async () => ({ ok: true })),
   "example.com");
eq("tab id 0 is a real id, not a missing one",
   await resolveHostname({ id: 0, url: "https://example.com/" }, replies("asked.example")),
   "asked.example");

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
