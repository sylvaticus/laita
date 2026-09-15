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

### LibreOffice — a LanguageTool server, not an extension

Two reasons. UNO extensions are Python, Basic or Java, so **no** JavaScript is reusable —
the anchoring and prompts would have to be reimplemented and then kept in step by hand.

And LibreOffice can already talk to a **remote LanguageTool server**. A small local HTTP
service implementing the LanguageTool API and proxying to Ollama therefore gives
LibreOffice support **with no extension at all**, and the same service serves the
LanguageTool add-ons for Thunderbird, Obsidian and others for free. That service is Node,
so it shares the core.

**Verified on LibreOffice 26.2.5.2 (Ubuntu 26.04)**, replacing the earlier "7.4 and
later — verify on your version":

- `share/registry/lingucomponent.xcd` registers exactly one grammar checker,
  `org.openoffice.lingu.LanguageToolGrammarChecker`, with a hardcoded list of ~45
  locales. A document in any other language never produces a request.
- `share/registry/main.xcd` defines its settings under
  `Linguistic/GrammarChecking/LanguageTool`: `BaseURL`, `IsEnabled` (**default false**),
  `Username`, `ApiKey`, `SSLCertVerify`, `RestProtocol`.
- **That checker is a client with nothing behind it.** No server ships with LibreOffice,
  `languagetool` is not in the Ubuntu archive, and the only checker installed by default
  is Hunspell spelling. Every LibreOffice user wanting grammar checking must already
  supply a server URL — which is exactly the slot we fill.

The name misleads: "LanguageTool Grammar Checker" in the options dialog is an HTTP caller,
not a checker.

#### What the ecosystem looks like

The **client** half is large and stable — LibreOffice, OnlyOffice, MS Word, Google Docs,
Obsidian, Zettlr, TeXstudio, Emacs, Vim, Sublime, VS Code (LTeX+), Thunderbird, Trados —
and nearly all accept a custom server URL, because self-hosting is normal practice.

The **server** half is nearly empty. Almost everything calling itself "self-hosted
LanguageTool" is the official Java server in Docker. The one genuine third-party
implementation in use is
[`ltapiserv-rs`](https://github.com/cpg314/ltapiserv-rs) (Rust, nlprule + symspell, ~27
stars). It is worth knowing for two reasons: it proves a third-party server drops into
the real clients (tested against the official browser extensions, `flycheck-languagetool`
and `ltex-ls`), and it ships exactly the way we would — one binary, a systemd *user*
service, deb/Arch packages, Docker.

**Nobody has put an LLM behind this API.** The nearest projects are adjacent, not the
same: [`lm-writing-tool`](https://github.com/peteole/lm-writing-tool) is an independent
reinvention of our VS Code extension, paragraph chunking and all, and does not use the
LanguageTool API at all.

That gap is an opportunity, but "nobody has done it" deserves a suspicious question, and
there is a plausible answer: **speed**. Every one of those clients was written against a
checker answering in milliseconds. We measured 0.7 s for 139 characters and 19.4 s for
1119, growing worse than linearly. The risk is not compatibility, it is a client that
spins, times out, or queues requests while the user keeps typing.

#### Shipping is where this plan is weakest

| | Adapter service | Python UNO extension |
| --- | --- | --- |
| Build cost | low — reuses `anchor.js` and `ollama.js` unchanged | high — reimplement ~600 lines in Python, then keep two copies honest forever |
| Ship cost | **high** — a binary per platform, code signing, an autostart mechanism per OS, plus the LibreOffice setting | **low** — one `.oxt`, double-click, all platforms, no runtime |
| Transform feature | impossible — the protocol has no slot for it | possible |
| Reach | Thunderbird, Obsidian, Zettlr and the rest for free | LibreOffice only |

The adapter is cheap to write and awkward to ship; the extension is the reverse. The
choice here was made on code, and it still looks right — a duplicated core is the thing
that actually rots — but if "a non-technical colleague must be able to install it" ever
becomes the deciding constraint, the `.oxt` wins and this section should change.

Distribution, if the adapter wins: `npx` first (no signing, no binaries, works
everywhere, costs a Node install), then a `node:sea` single-file binary (~100 MB, needs
an Apple Developer account and a Windows certificate to avoid Gatekeeper and SmartScreen
warnings). Autostart is a systemd user unit, a launchd LaunchAgent, or a Startup-folder
shortcut, all installable without root. Bind **127.0.0.1 only** — it is an
unauthenticated endpoint in front of an LLM.

The last step, setting `BaseURL`, can be automated by a **configuration-only `.oxt`**:
an extension containing an `.xcu` and no code at all. Do *not* write
`registrymodifications.xcu` directly — LibreOffice rewrites it on exit.

#### The first experiment, before any LAITA code

Run the official server locally and put a logging proxy in front of it:

```
LibreOffice  ->  :8082 logging proxy  ->  :8081 official LanguageTool
```

```bash
docker run -d --name lt -p 8081:8010 meyay/languagetool
# or, from https://languagetool.org/download/ (needs Java 17+):
java -cp languagetool-server.jar org.languagetool.server.HTTPServer --port 8081
```

Then Tools ▸ Options ▸ Languages and Locales ▸ Writing Aids ▸ LanguageTool Server:
enable, Base URL `http://localhost:8081/v2`.

That one capture answers everything currently inferred rather than known: whether
LibreOffice appends `/check` to the base URL, how much text arrives per request and how
often, the exact JSON shape of a working reply (to imitate rather than reverse-engineer),
and what LibreOffice does when a reply takes fifteen seconds.

This remains the highest reward per line of code of the three, and the only one needing
no new UI.

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
