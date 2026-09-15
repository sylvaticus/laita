/**
 * The options page and the popup must work on Chrome.
 *
 * Chrome does not define `browser`; only `chrome` exists. The background module aliases one
 * onto the other through compat.js, and the content scripts do the same at the top of
 * common.js - but these two pages imported neither, while calling `browser.tabs`,
 * `browser.storage` and `browser.runtime` directly. The modules still *load*, because every
 * such call sits inside a function, so the failure arrives on the first click: a blank
 * popup and an options page that cannot save.
 *
 * chrome-compat.test.mjs covers the service worker only and would never have seen this.
 *
 * Each case runs in its own process because compat.js aliases at module-evaluation time and
 * a module evaluates once per process - checking two pages in one would test the first one
 * twice.
 */
import { execFileSync } from "node:child_process";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (got === want) pass++;
  else { fail++; console.log(`FAIL ${name}\n  got  ${got}\n  want ${want}`); }
};

const SRC = new URL("../../src/", import.meta.url).href;

/** Evaluate one module in a world that has `chrome` and no `browser`, as Chrome does,
 *  and report whether the name the page calls ended up existing. */
function aliasesBrowser(spec) {
  const script = `
    const noop = () => {};
    const ev = () => ({ addListener: noop, removeListener: noop });
    const element = () => ({
      value: "", checked: false, textContent: "", className: "", style: {},
      addEventListener: noop, appendChild: noop, append: noop, remove: noop,
      setAttribute: noop, getAttribute: () => null,
      classList: { add: noop, remove: noop, toggle: noop },
      querySelectorAll: () => [], querySelector: () => null
    });
    globalThis.chrome = {
      storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: ev() },
      tabs: { query: async () => [{ id: 1, url: "https://example.com" }], sendMessage: async () => {} },
      runtime: { sendMessage: async () => ({}), getURL: (p) => "chrome-extension://abc/" + p,
                 onMessage: ev(), openOptionsPage: async () => {}, lastError: null },
      contextMenus: { create: noop, remove: noop, update: async () => {}, onClicked: ev() },
      commands: { onCommand: ev() },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {},
                setTitle: async () => {} }
    };
    const els = new Map();
    globalThis.document = {
      getElementById: (id) => { if (!els.has(id)) els.set(id, element()); return els.get(id); },
      querySelector: () => element(), querySelectorAll: () => [],
      createElement: () => element(), addEventListener: noop,
      body: element(), documentElement: element(), readyState: "complete"
    };
    globalThis.window = { addEventListener: noop, close: noop, getSelection: () => null };
    await import(${JSON.stringify(spec)});
    console.log(globalThis.browser === globalThis.chrome ? "ALIASED" : "MISSING");
    // popup.js starts a 1s poll and both pages register listeners, so nothing would ever
    // let the process end on its own.
    process.exit(0);
  `;
  try {
    return execFileSync(process.execPath, ["--input-type=module", "-e", script],
                        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20000 }).trim();
  } catch (e) {
    return "THREW: " + String(e.stderr || e.message).split("\n").find((l) => /Error/.test(l));
  }
}

eq("popup.js makes `browser` exist on Chrome", aliasesBrowser(SRC + "popup/popup.js"), "ALIASED");
eq("options.js makes `browser` exist on Chrome", aliasesBrowser(SRC + "options/options.js"), "ALIASED");
eq("compat.js is what does the aliasing", aliasesBrowser(SRC + "common/compat.js"), "ALIASED");

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
