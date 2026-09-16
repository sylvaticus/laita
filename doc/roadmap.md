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

### Chrome — done

Implemented as a build target rather than a port: one `src/`, two manifests, and
`tools/build-chrome.sh` to assemble `dist-chrome/`. What it actually took:

- **`browser.*` vs `chrome.*`** — `common/compat.js` aliases them. Chrome MV3 returns
  promises, so no polyfill library is needed. Content scripts repeat the one line,
  because they are classic scripts and cannot import.
- **`menus` vs `contextMenus`, and `onShown` is Firefox-only.** The pause/resume item
  names the current site by rewriting its title as the menu opens; Chrome has neither
  `onShown` nor `refresh`, and calling them would kill the service worker on startup.
  `canRefreshMenus` picks the path: Firefox rewrites on open, Chrome refreshes the title
  from `tabs.onActivated`/`onUpdated` instead — slightly early, but correct by the time
  anyone right-clicks.
- **Chrome rejects SVG icons.** `icons/icon-*.png` are generated from `icon.svg` with
  `rsvg-convert`; both manifests now use the PNGs, which also satisfies what the AMO
  listing page wants.
- **Event page vs service worker.** Chrome runs `background` as a `service_worker`.
  `holdOpen`/`releaseHold` is unchanged so far and *unverified on Chrome* — see below.
- Chrome sends `Origin: chrome-extension://<id>`, so `OLLAMA_ORIGINS` needs
  `chrome-extension://*`. Unlike Firefox's per-profile UUID, that id is stable, so it can
  be narrowed to one extension permanently.
- `browser_specific_settings` is Firefox-only and absent from the Chrome manifest; the
  Web Store assigns its own id.

**Confirmed working** by hand on Chrome 152 - proofreading and transforms both. The one
thing still unmeasured is the service-worker lifetime under a genuinely slow model; see
below.

**What is not verified automatically.** Chrome 137+ refuses `--load-extension`, so the browser harness
cannot run there — confirmed on 152, including with
`--disable-features=DisableLoadExtensionCommandLineSwitch`. `chrome-compat.test.mjs`
covers the API-surface differences by faking both browsers and booting the real
background module, but the service-worker *lifetime* is the open question: Chrome
terminates an idle worker after 30 seconds, and whether a 20-second `setInterval` keeps
it alive the way it does a Firefox event page needs a human to check with a slow model.
If it does not, `chrome.alarms` (30-second minimum) or a port held open from the content
script are the alternatives. `alarms` was declared in the Chrome manifest in advance and
has been removed again: an unused permission is one more thing to justify to a reviewer,
and adding it back later is a one-line change.

### VS Code — done

In `vscode/`. The surface is native rather than ported, which is the whole point:

| LAITA concept | What it became |
| --- | --- |
| wavy underline | `DiagnosticCollection` — squiggles, Problems panel, hovers, for free |
| suggestion card, **Apply** | `CodeActionProvider` quick fix on `Ctrl+.` |
| transform instruction box | `window.showInputBox` |
| transform result panel | a modal with **Replace** / **Insert after** |
| field adapters (`textmap.js`) | `TextDocument` and `WorkspaceEdit` |
| status pill | a status bar item |

`core/anchor.js` and `core/ollama.js` are **copied** from `browser/src/background/` by
`tools/sync-core.sh`, because a packaged `.vsix` may only contain files from inside
`vscode/`. `test/unit/core.test.mjs` fails if a copy drifts, and also checks the copies
still load and work under plain node.

What is *not* shared, and why:

- **Chunking.** The browser works in character offsets because that is what a DOM Range
  speaks; VS Code speaks (line, character). `src/text.js` finds paragraphs by line
  instead, which also makes fenced code blocks easy to mark opaque and never send.
- **Language detection.** The browser can fall back on Firefox's own detector; there is
  no equivalent in Node, so `src/text.js` keeps the stopword heuristic alone. This is the
  one genuine duplication and would be the first candidate if a real `core/` package is
  ever extracted.

Running in Node also removes the single biggest setup obstacle: no `Origin` header is
sent, so **`OLLAMA_ORIGINS` is irrelevant** for this target.

### LibreOffice — a UNO extension, and the measurements that decided it

**Decided: a real `.oxt` extension implementing `XProofreader`, not a LanguageTool server.**

The earlier plan was a local service speaking the LanguageTool API, on the reasoning that
it needed no extension and would serve Thunderbird and Obsidian too. It was abandoned for
one reason: **the LanguageTool protocol has no slot for a transform.** It can return
corrections to a span; it cannot take "rewrite this in plainer English" and hand back a
paragraph. Half of LAITA would simply not exist on that route.

The cost of the extension route is that no JavaScript is reusable — UNO extensions are
Python, Basic or Java — so `anchor.js` and the prompts must be reimplemented in Python and
kept in step by hand. That is the thing that will rot; see "What has to be duplicated".

#### What the API gives us for nothing

`doProofreading` returns errors as `nErrorStart` / `nErrorLength` plus `aSuggestions`, and
LibreOffice draws the whole interface itself: the coloured underline, the context menu of
replacements, applying the chosen one, *Ignore* and *Ignore All*. Confirmed working from
Python, with our own text in the menu. `aProperties` carries a line colour per error, which
maps onto LAITA's error/style/rephrase categories.

That is the same UI the LanguageTool route would have given us, so nothing was lost there.

#### The four things that were measured, not assumed

A throwaway extension (`libreoffice/`, see its README) was built to answer these, because
none of them are in the API documentation.

1. **`doProofreading` is called on every keystroke**, and each call receives the whole
   paragraph. 33 calls for a 27-character sentence, a median of 190 ms apart.
2. **It is called on a background thread.** With an artificial 2-second delay inside the
   call, typing stayed completely smooth and the underline simply arrived late.
3. **LibreOffice never calls it concurrently** — 0 overlapping calls out of 27. It waits
   for the previous call to return, so a slow checker self-throttles instead of queueing.
4. **`XLinguServiceEventBroadcaster` works.** Returning nothing, computing in a background
   thread, then firing `PROOFREAD_AGAIN` makes LibreOffice call again — and the second
   call served the answer instantly from cache. The underline appeared 3.0 s after the
   last keystroke with no further typing, exactly the configured think-time.

Point 2 is the one that killed the LanguageTool-server route in reverse: **we are allowed
to be slow here.** Every LanguageTool client was written against a checker answering in
milliseconds; LibreOffice's own proofreading path is built to tolerate a slow one.

#### The architecture that follows

```
doProofreading(paragraph)          <- called on every keystroke, must return at once
  |
  +-- answer in the cache?  -> return it. Done.
  |
  +-- otherwise             -> return no errors, and debounce a background job
                                  |
                                  +-- text still unchanged after ~1.5s?
                                        |
                                        +-- ask Ollama, cache the answer,
                                            fire PROOFREAD_AGAIN
                                                  |
                                                  +-- LibreOffice calls again -> cache hit
```

This is structurally what the browser and VS Code versions already do. The difference is
that there LAITA decides when to check; here it is asked constantly and must mostly
decline.

**The debounce is not optional.** The probe deliberately started a worker on every call and
the result is the measurement that matters most: **17 workers for a 17-character sentence**,
each firing its own re-check, producing 49 `doProofreading` calls. With a real model that
is 17 inferences on a paragraph still being typed. The browser's 1.5 s debounce plus the
existing chunk cache should collapse that to one.

#### Chunking: ported, measured, and turned off

The browser splits a long paragraph at sentence boundaries because latency grows faster
than the text - 0.7 s at 139 characters, 19.4 s at 1119. That was ported, and then
measured against a real model through the extension. It does not hold here:

| paragraph | sent whole | in 700-character chunks |
| --- | --- | --- |
| 551 chars | 7.9 s, 3 issues | 9.4 s, 3 issues |
| 1379 chars | **41.0 s**, 3 issues | **98.4 s**, 6 issues |
| 2483 chars | **49.5 s**, 3 issues | **191.9 s**, 12 issues |

Splitting is close to four times slower and the gap widens. Whole-paragraph cost is
sub-linear in this range - 1379 to 2483 characters is 41 s to 49 s - because the time
goes on generating the answer and on re-processing the ~1500-character system prompt
once per request, not on reading the input.

What splitting does buy is **coverage**: twelve issues instead of three, because the
model caps itself at twelve per request. That is a genuine trade of speed for
thoroughness, so `ChunkMaxChars` defaults to 0, meaning off, and remains available.

Worth carrying back to the browser: its 700-character default may be costing speed
rather than saving it, and the original measurement was never repeated with the current
prompt.

#### What has to be duplicated, and what does not

| | |
| --- | --- |
| Reimplement in Python | the anchoring (`anchor.js`), the prompts and transport (`ollama.js`), language detection |
| Free from LibreOffice | underline, context menu, applying a fix, Ignore, per-category colour, paragraph segmentation |
| Still to design | the transform: no `XProofreader` slot for it, so it needs a menu entry (`Addons.xcu`) and a dialog |

The Python port of `anchor.js` is the risk. It carries four guards that were each paid for
with corrupted text - `looksTruncated`, `alreadyThere`, the case-folding index map, and the
quote-based location - and a second implementation is a second place for them to be wrong.
Its unit tests should be ported alongside it, not after.

#### Constraints that are LibreOffice's, not ours

- **The document decides the language, and the list is fixed at install time.** A document
  whose language is *[None]*, or outside the `Locales` list in `Linguistic.xcu`, is never
  checked - and our code is never called, so it cannot even say why. The browser version
  detects the language itself and works in any of the 25 the model knows; this one cannot.
- **Only one grammar checker runs per language.** LAITA competes with the built-in
  LanguageTool client rather than coexisting, and the user must enable it per language in
  Tools ▸ Options ▸ Writing Aids ▸ Available Language Modules ▸ **Edit…**. Installing the
  extension is not enough, which is a support burden.
- **A failing checker shows a blocking modal dialog** on the first keystroke. The
  extension must swallow every error and report problems some other way.
- **The development loop is slow**: LibreOffice must be fully closed - including the
  background `soffice.bin` - before a reinstalled extension is picked up.

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
