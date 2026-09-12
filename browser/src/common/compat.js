/**
 * One API surface for Firefox and Chrome.
 *
 * Chrome exposes `chrome`, Firefox exposes both `browser` (promise-based) and `chrome`
 * (callback-based). Chrome's MV3 APIs return promises when no callback is passed, so
 * aliasing `browser` to `chrome` is enough for everything this extension calls - there
 * is no need for a polyfill library.
 *
 * Imported first by the background module. Content scripts get the same aliasing at the
 * top of `content/common.js`, because they are classic scripts and cannot import.
 */
globalThis.browser ??= globalThis.chrome;

/**
 * Context menus are `menus` in Firefox and `contextMenus` in Chrome. The two overlap for
 * create/remove/onClicked; `onShown` and `refresh` are Firefox-only, and callers must
 * check for them rather than assume.
 */
export const menus = globalThis.browser.menus ?? globalThis.browser.contextMenus;

/** True on Firefox, where a menu's title can be rewritten as the menu opens. */
export const canRefreshMenus = typeof menus?.onShown?.addListener === "function" &&
                               typeof menus?.refresh === "function";
