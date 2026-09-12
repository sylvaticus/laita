# Porting LAITA to other editors

Where the code can genuinely be shared, where it cannot, and why the repository is laid
out the way it is.

## What is actually portable

Measured on the Firefox extension, counting references to `browser.*` and to the DOM:

| Layer | Lines | Portable |
| --- | ---: | --- |
| `anchor.js`, `ollama.js`, `segment.js` | 646 | **yes** — no DOM, no `browser.*` |
| `settings.js` defaults + `siteAllowed`, pure helpers in `common.js` | ~200 | **yes** |
| `textmap.js`, `overlay.js`, `card.js`, `transform.js`, content `main.js` | 1,762 | no — DOM |
| background `main.js` | 501 | no — WebExtension API |

**About a quarter is platform-neutral**, and it is the valuable quarter: the prompts, the
quote-anchoring that stops a hallucinated quote corrupting the user's text, the chunking,
the output cleaning, the error classification.

The other three quarters are *text access* and *UI*. A hidden mirror `div`, a
`vscode.TextDocument` and an UNO `XTextCursor` have nothing in common, and no abstraction
over them would pay for itself.

## The targets, in the order they are worth doing

### Chrome — a build target, not a port

Roughly 95% of `browser/` already works. Do this one first: it needs no shared core at
all, and it will show which parts genuinely vary before anything is extracted. Known
differences:

- `browser.*` vs `chrome.*` — one-line shim, since Chrome MV3 returns promises.
- **Event page vs service worker.** `holdOpen`/`releaseHold` in `background/main.js` keeps
  the Firefox event page alive with a 20-second API call. Chrome service workers cannot be
  held open that way; use `chrome.alarms` or a connected port. Expect to re-solve this bug
  rather than port the fix.
- **`menus.onShown` and `menus.refresh()` are Firefox-only.** The pause/resume item names
  the current site by rewriting its title when the menu opens. Chrome has no equivalent —
  update the title from `tabs.onActivated` and `tabs.onUpdated` instead.
- Chrome sends `Origin: chrome-extension://<id>`, so `OLLAMA_ORIGINS` needs
  `chrome-extension://*` as well. Unlike Firefox's per-profile UUID, that id is stable.
- `browser_specific_settings` is ignored by Chrome; the Web Store has its own id.

### VS Code — shares the core, rebuilds the surface

Do not port the overlay. VS Code already provides what `overlay.js` and `card.js`
laboriously draw:

| LAITA concept | VS Code equivalent |
| --- | --- |
| wavy underline | `languages.createDiagnosticCollection` |
| suggestion card, **Apply** | `CodeActionProvider` quick fix |
| transform instruction box | `window.showInputBox` |
| transform result panel | diff view, or a quick pick |
| field adapters (`textmap.js`) | `TextDocument` + `WorkspaceEdit` |

It runs in Node, so `fetch` works and there is **no `Origin` header** — `OLLAMA_ORIGINS`
is irrelevant, which removes the single biggest setup obstacle.

### LibreOffice — do not write an extension

Two reasons. UNO extensions are Python, Basic or Java, so **no** JavaScript is reusable —
the anchoring and prompts would have to be reimplemented and then kept in step by hand.

And LibreOffice can already talk to a **remote LanguageTool server** (Tools ▸ Options ▸
Languages ▸ LanguageTool Server, on 7.4 and later — verify on your version). A small local
HTTP service implementing the LanguageTool API and proxying to Ollama would therefore give
LibreOffice support **with no extension at all**, and the same service would serve the
LanguageTool add-ons for Thunderbird, Obsidian and others for free. That service is Node,
so it shares the core.

This is the highest reward per line of code of the three, and it is the one that needs no
new UI.

## Repository layout

```
README.md          what LAITA is; installing the Firefox add-on
CLAUDE.md          design invariants
doc/               dev_doc.md, this file
assets/imgs/       screenshots, logos
browser/           Firefox now, Chrome later - self-contained, no build step
  manifest.json  src/  icons/  test/  web-ext-config.cjs  LICENSE
```

Planned, when each is started: `vscode/`, `server/` (the LanguageTool bridge), and
`core/` once something other than `browser/` needs it.

One monorepo rather than several repositories: for a single maintainer it avoids
publishing and versioning a package for one consumer, keeps core and front-ends from
drifting apart, and keeps one test suite and one issue tracker. Tags gain a prefix once
one version number no longer fits everything — `browser-v0.4.0`, `vscode-v0.1.0`.

## Why `core/` does not exist yet

Two concrete obstacles, not laziness:

1. **Content scripts cannot be ES modules.** MV3 `content_scripts` are classic scripts
   sharing one `var LAITA` global in manifest order. `segment.js` is one of them, so it
   cannot simply be `import`ed from a shared package the way `anchor.js` and `ollama.js`
   (background modules) could.
2. **A shared directory outside `browser/` would require a build step** to get into the
   package, and the absence of a build step is worth protecting: the JavaScript in the
   signed `.xpi` is byte-identical to the repository, which is exactly what lets the AMO
   submission answer "No" to *"Do you need to submit source code?"*. A bundler turns that
   into "Yes" and an obligation to ship sources separately.

So the boundary should be discovered by the second real consumer, not guessed now. VS Code
is that consumer; Chrome is not, because Chrome shares everything.
