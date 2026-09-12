/**
 * The background page must boot on Chrome as well as Firefox.
 *
 * Chrome 137+ refuses --load-extension, so a headless Chrome cannot be driven from a
 * script any more. This stands in for that: it fakes each browser's API surface, loads
 * the real background module, and checks it registers the right things and throws
 * nothing. The failure it exists to catch is `menus.onShown.addListener` on Chrome,
 * where `onShown` does not exist and the service worker would die on startup.
 */
let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) pass++; else { fail++; console.log("FAIL " + name + "\n  got  " + a + "\n  want " + b); }
};

function fakeBrowser({ firefox }) {
  const calls = { created: [], listeners: [], menuUpdates: 0 };
  const ev = (name) => ({ addListener: () => calls.listeners.push(name) });
  const menuApi = {
    removeAll: async () => {},
    create: (o) => calls.created.push(o.id),
    update: async () => { calls.menuUpdates++; },
    onClicked: ev("menus.onClicked")
  };
  if (firefox) {
    menuApi.refresh = () => {};
    menuApi.onShown = ev("menus.onShown");
    menuApi.onHidden = ev("menus.onHidden");
  }
  const api = {
    runtime: {
      onMessage: ev("runtime.onMessage"), onInstalled: ev("runtime.onInstalled"),
      getPlatformInfo: async () => ({ os: "linux" }), lastError: null
    },
    storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: ev("storage.onChanged") },
    tabs: {
      query: async () => [], sendMessage: async () => {},
      onActivated: ev("tabs.onActivated"), onUpdated: ev("tabs.onUpdated")
    },
    windows: { onFocusChanged: ev("windows.onFocusChanged") },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    commands: { onCommand: ev("commands.onCommand") }
  };
  if (firefox) api.menus = menuApi; else api.contextMenus = menuApi;
  return { api, calls };
}

/**
 * Each surface needs its own process. Cache-busting the import of main.js is not
 * enough: compat.js is imported *by* it without a query string, so the second load
 * would reuse the first one's `menus` and `canRefreshMenus` and silently test nothing.
 */
async function bootInChild(firefox) {
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(process.execPath, [new URL(import.meta.url).pathname], {
    env: { ...process.env, LAITA_FAKE: firefox ? "firefox" : "chrome" },
    encoding: "utf8"
  });
  return JSON.parse(out);
}

if (process.env.LAITA_FAKE) {
  const firefox = process.env.LAITA_FAKE === "firefox";
  const { api, calls } = fakeBrowser({ firefox });
  globalThis.chrome = api;
  if (firefox) globalThis.browser = api;
  await import("../../src/background/main.js");
  await new Promise((r) => setTimeout(r, 30));   // let installMenus() settle
  process.stdout.write(JSON.stringify(calls));
  process.exit(0);
}

const boot = async ({ firefox }) => await bootInChild(firefox);

const chromeCalls = await boot({ firefox: false });
eq("chrome: boots without throwing", true, true);
eq("chrome: both menu items created", chromeCalls.created.sort(),
   ["laita-toggle-site", "laita-transform"]);
eq("chrome: never registers menus.onShown", chromeCalls.listeners.includes("menus.onShown"), false);
eq("chrome: keeps the title fresh from tab events",
   ["tabs.onActivated", "tabs.onUpdated"].every((l) => chromeCalls.listeners.includes(l)), true);
eq("chrome: still handles menu clicks", chromeCalls.listeners.includes("menus.onClicked"), true);
eq("chrome: still handles messages", chromeCalls.listeners.includes("runtime.onMessage"), true);
eq("chrome: still handles commands", chromeCalls.listeners.includes("commands.onCommand"), true);

const ffCalls = await boot({ firefox: true });
eq("firefox: both menu items created", ffCalls.created.sort(),
   ["laita-toggle-site", "laita-transform"]);
eq("firefox: uses onShown for exact titles", ffCalls.listeners.includes("menus.onShown"), true);
eq("firefox: pairs it with onHidden", ffCalls.listeners.includes("menus.onHidden"), true);
eq("firefox: does not need tab events for titles",
   ffCalls.listeners.includes("tabs.onActivated"), false);

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
