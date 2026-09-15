# Developer documentation

Everything needed to work on Local AI Text Assistant. User-facing documentation is in
[`../README.md`](../README.md); `../CLAUDE.md` records the design invariants that are not
obvious from reading the code.

---

## 0. Where the packages are

Three packages come out of this repository, and they are **not** interchangeable:

| File | For | Why it is specific |
| --- | --- | --- |
| `laita-firefox-<v>.zip` | addons.mozilla.org | carries `browser_specific_settings` with the Gecko id |
| `laita-chrome-<v>.zip` | Chrome Web Store, or *Load unpacked* | no Gecko block, `service_worker` instead of an event page, `manifest.json` at the zip root |
| `laita-vscode-<v>.vsix` | VS Code Marketplace, or *Install from VSIX…* | contains `core/`, which is generated at package time |

Uploading one to the wrong store fails.

### Released versions — the usual answer

Every `v*` tag builds all three and attaches them to a GitHub release:

**<https://github.com/sylvaticus/laita/releases/latest>**

```bash
gh release download v0.4.0 --repo sylvaticus/laita     # all three
gh release download v0.4.0 --pattern '*.vsix'          # or just one
```

These are the artefacts the stores receive, so what you download here is what was
reviewed. Note that the Firefox zip is the **unsigned** submission: Firefox will not
install it, and only a Mozilla-signed `.xpi` will (§3).

### Any commit — CI builds them too

The `the generated packages assemble` job uploads all three on every push, so an
unreleased build can be tested without building anything. Open the run from the
[Actions tab](https://github.com/sylvaticus/laita/actions) and take *packages* from the
Artifacts section at the bottom, or:

```bash
gh run download --name packages                        # newest run on this branch
gh run list --limit 5                                  # to pick a different one
```

GitHub keeps these for 14 days; releases are permanent.

### Building them yourself

Nothing is compiled, so this needs only node and a shell:

```bash
npm ci                                  # once: pins web-ext and eslint

V=$(node -p "require('./browser/manifest.json').version")

cd browser
./tools/build-chrome.sh                                     # assembles dist-chrome/
npx web-ext build --overwrite-dest                          # -> laita-firefox-$V.zip
(cd dist-chrome && zip -qr "../web-ext-artifacts/laita-chrome-$V.zip" . -x '.*')
cd ../vscode
./tools/sync-core.sh                                        # copies the shared core
npm run package                                             # -> laita-vscode-$V.vsix
```

They land in `browser/web-ext-artifacts/` and `vscode/`, both gitignored. The Chrome zip
**must** be built with that `(cd dist-chrome && zip …)` form: compressing the folder from
a file manager puts the folder inside the archive and Chrome rejects it.

To load a build rather than package one, see §1 — that loop needs no build at all.

---

## 1. Running the development version

This is the fastest loop: no build step, no signing, and changes reload in a click.

1. Open **`about:debugging#/runtime/this-firefox`**
2. Click **Load Temporary Add-on…**
3. Select **`browser/manifest.json`** — the manifest itself, not a `.zip`
   or `.xpi`

The add-on appears under **Temporary Extensions**:

```
┌─ Temporary Extensions ──────────────────────────────────┐
│  [icon]  LAITA - Local AI Text Assistant                         │
│          Extension ID    locaispell@lobianco.org         │
│          Internal UUID   d2f842af-951b-4d15-…            │
│          Location        /home/…/laita/browser/manifest.json │
│                                                          │
│          [ Inspect ]  [ Reload ]  [ Remove ]             │
└──────────────────────────────────────────────────────────┘
```

Pointing Firefox at the manifest means it reads the live source tree, so **Reload**
picks up your edits with no repackaging. A `.zip` would have to be rebuilt every time.

### After every reload

- **Refresh the tabs you are testing on.** The background page updates immediately, but
  content scripts are only injected when a page loads, so an open tab keeps running the
  previous ones. A tab left behind this way is *orphaned*: it looks alive and its
  messages fail with `Receiving end does not exist`. The extension detects this and says
  so, but the only cure is reloading the page.
- **Remove any permanently installed copy first** (`about:addons`), or two copies run at
  once: every highlight is drawn twice and every check sends two requests to Ollama.

A temporary add-on disappears when Firefox restarts. **Reload** exists only for temporary
add-ons — a signed `.xpi` installed through `about:addons` has no such button.

### Debugging

- **Background page**: `about:debugging` → **Inspect**. Errors from the Ollama call, the
  queue and the context menus appear here. To share them: right-click in the Console →
  *Export Visible Messages To* → *File*.
- **Content scripts**: the page's own console, `Ctrl+Shift+K`. These only log when
  *Log debug output to the page console* is ticked in the options.

### Settings are lost when you remove an add-on

`browser.storage.local` is deleted with the extension, so removing the signed build
before loading a temporary one resets every option. Note anything you changed first.

---

### Chrome

```bash
cd browser && ./tools/build-chrome.sh      # assembles dist-chrome/
```

`chrome://extensions` → **Developer mode** → **Load unpacked** → `browser/dist-chrome`.
Re-run the script and press **Reload** on the card after an edit.

`dist-chrome/` is assembled rather than loaded in place because Chrome insists the
manifest be named `manifest.json`, and that name is taken by the Firefox one. The script
copies files and swaps the manifest; it transforms no code, so the JavaScript Chrome runs
is byte-identical to `src/`.

**`dist-chrome/` is generated and not committed**, and `test/run.sh` builds it before
running anything, so there is nothing to keep in step by hand.
`test/unit/dist-chrome.test.mjs` then checks what came out: every file identical to
`src/`, no source file missing, and the two manifests agreeing on the version.

The icons are generated too: `python3 tools/make-icons.py` rebuilds `icons/icon-*.png`
from `assets/imgs/laita_logo.png`. They are committed so that a build needs neither
Python nor Pillow.

**Chrome cannot be driven from a script any more.** Since Chrome 137 the
`--load-extension` switch is refused, and
`--disable-features=DisableLoadExtensionCommandLineSwitch` no longer revives it on 152 —
verified here: the extension simply never appears among the debugger targets. So the
browser harness is Firefox-only, and Chrome's half of the compatibility layer is covered
by `test/unit/chrome-compat.test.mjs`, which fakes each browser's API surface, loads the
real background module and checks what it registers. Anything beyond that needs a human
with a Chrome window.

### Loading a released build, rather than a working copy

These are the routes the README used to describe. They are here because they are ways of
running the extension *outside* a store, which is a developer's problem rather than a
user's: a user installs from the Chrome Web Store or addons.mozilla.org.

**Chrome, from a release zip.** Download `laita-chrome-<version>.zip` from
[the releases page](https://github.com/sylvaticus/laita/releases), unzip it, then
`chrome://extensions` → Developer mode → **Load unpacked** → the unzipped folder. That zip
is byte-for-byte what the Chrome Web Store receives.

Two consequences, neither of them faults:

- Chrome shows *"Disable developer mode extensions"* warnings on startup — its standard
  notice for anything not installed from the Web Store.
- It does not update itself: download the new zip, replace the folder, press **Reload**.

**An unpacked extension gets its own ID**, generated from the folder path, not the Web
Store one. So it needs the wildcard `chrome-extension://*` in `OLLAMA_ORIGINS`; the
published ID the README gives will refuse it with a `403`.

**Firefox, from a signed `.xpi`.** `about:addons` → gear icon → *Install Add-on From
File…*. Only a Mozilla-signed file installs permanently; the `laita-firefox-<v>.zip` on
the releases page is the **unsigned** package that was submitted to AMO and Firefox will
not accept it. Producing a signed `.xpi` means `web-ext sign` or an AMO web upload — see
§3 below.

**VS Code, from source.** Open `vscode/` and press **F5**, or build a `.vsix` with
`npm run package` — both covered in §3b.

### Working with an LLM assistant

An assistant starts every session knowing nothing about this project.
[`agent_context.md`](agent_context.md) is the handover note it should be given first —
versions, what is waiting on a store, what has been tried and rejected, what is untested,
and the quirks of this machine. It is meant to be **rewritten at the end of a session**,
not appended to; a stale handover is worse than none, because it is believed.

Design invariants live in `../CLAUDE.md` and procedures in this file; both are durable and
change rarely. `agent_context.md` is the volatile one.

## 2. Tests

Once, to install the pinned tooling (eslint and web-ext; nothing that ships depends on it):

```bash
npm ci                     # exactly what package-lock.json pins, not "whatever is newest"
```

Then:

```bash
npm run check              # everything CI runs: eslint, web-ext lint, both unit suites
```

or piecemeal:

```bash
browser/test/run.sh        # unit tests, node only, no dependencies
vscode/test/run.sh
npx eslint .               # no-unsanitized is the rule that earns its keep
npm run lint:ext           # web-ext lint - must stay 0 errors / 0 warnings
```

Both runners deliberately do **not** stop at the first failing file: they run everything
and exit with the number of files that failed, so one broken test does not hide four
others. Each file prints its own pass/fail line.

`.github/workflows/ci.yml` runs all of the above on every push, plus a fourth job that
builds every package - the Firefox zip, the Chrome zip and the `.vsix` - to prove they
still assemble, which the unit tests never attempt.

`browser/dist-chrome/` and `vscode/core/{anchor,ollama}.js` are **generated and not
committed**. The tests that check them run their generators first, so a fresh clone needs
no extra step; `vscode:prepublish` runs `sync-core.sh` before `vsce` packages anything;
and `.github/workflows/release.yml` builds all three artefacts and attaches them to the
GitHub release when a `v*` tag is pushed. `vscode/core/package.json` *is* committed - it
declares those copies as ESM and is hand-written.

`web-ext lint` is **not** run against `dist-chrome/`: web-ext validates against the
Firefox specification, so a Chrome manifest fails by design
(`BACKGROUND_SERVICE_WORKER_NOFALLBACK`, `ADDON_ID_REQUIRED`).
`test/unit/dist-chrome.test.mjs` checks that package instead.

`browser/test/README.md` describes the browser harnesses: the real extension in headless Firefox
against a fake Ollama, checking highlight geometry against independently measured DOM
Ranges and the text that actually lands in the field. They need more setup than the unit
tests and are the only thing that catches overlay, geometry and event-handling bugs.

Run them for any change to `overlay.js`, `textmap.js`, `transform.js` or the event
handling in `content/main.js`:

```bash
browser/test/browser/run-harness.sh
```

That script applies the test-build edits, starts the mock, drives headless Firefox and
prints one line per step. It lives in the repository deliberately: it was twice rebuilt
from scratch because it had only existed in a scratch directory.

---

## 3. Building and signing

### What goes into the package

`web-ext build` archives the repository *minus* everything listed in `ignoreFiles` in
`web-ext-config.cjs`. The result is only what the extension needs at runtime:

```
manifest.json
icons/icon.svg
src/background/   main.js  ollama.js  anchor.js
src/common/       settings.js
src/content/      common.js  segment.js  textmap.js  overlay.js  card.js
                  transform.js  main.js
src/options/      options.html  options.css  options.js
src/popup/        popup.html  popup.css  popup.js
LICENSE
```

Excluded: `test/`, `doc/`, `assets/`, `README.md`, `CLAUDE.md`, `web-ext-config.cjs`,
`web-ext-artifacts/`, `node_modules/`, `package*.json`. Screenshots and documentation are
for the repository and the AMO listing page, not for the browser.

There is no build step — no bundler, no minifier, no template engine. The JavaScript in
the package is byte-identical to the JavaScript in `src/`. That matters when AMO asks
*"Do you need to submit source code?"*: the answer is **No**, because a reviewer opening
the `.xpi` sees exactly what is in this repository.

### Build

Every `web-ext` command must be run **from inside `browser/`**: web-ext reads
`web-ext-config.cjs` from the current directory, not from `--source-dir`, so running it
from the repository root silently ignores `ignoreFiles` and packages `test/`.

```bash
(cd browser && npx web-ext build --overwrite-dest)
```

Output: `browser/web-ext-artifacts/laita-firefox-<version>.zip`.

### Cutting a release

Both stores reject a version number they have already seen, in either channel, even after
a version is deleted. So every upload starts with a bump.

```bash
cd browser

# 1. bump BOTH manifests to the same new version
#    (dist-chrome.test.mjs fails if they disagree)
V=0.3.5
python3 - "$V" <<'EOF'
import json, sys, collections
for p in ("manifest.json", "manifest.chrome.json"):
    m = json.load(open(p), object_pairs_hook=collections.OrderedDict)
    m["version"] = sys.argv[1]
    json.dump(m, open(p, "w"), indent=2, ensure_ascii=False)
    open(p, "a").write("\n")
EOF

# 2. regenerate the committed Chrome folder, or the tests will fail
./tools/build-chrome.sh

# 3. everything must be green before anything is uploaded
./test/run.sh
npx web-ext lint --self-hosted            # from inside browser/, see above

# 4. build both packages
npx web-ext build --overwrite-dest                  # Firefox -> laita-firefox-$V.zip
(cd dist-chrome && zip -qr "../web-ext-artifacts/laita-chrome-$V.zip" . -x '.*')

# 5. commit the bump, tag it, and let the release workflow build and publish
cd .. && git add -A -- browser vscode && git commit -m "Version $V"
git tag "v$V" && git push && git push origin "v$V"
```

Two packages come out of `browser/web-ext-artifacts/` and they are **not**
interchangeable:

| File | Store | Why it is specific |
| --- | --- | --- |
| `laita-firefox-<V>.zip` | addons.mozilla.org | has `browser_specific_settings` with the Gecko id |
| `laita-chrome-<V>.zip` | Chrome Web Store | no Gecko block, `service_worker` instead of an event page |

Uploading one to the other store fails.

#### Firefox (addons.mozilla.org)

<https://addons.mozilla.org/developers/> → the add-on → **Upload New Version** →
`laita-firefox-<V>.zip`.

- **"Do you need to submit source code?" → No.** There is no build step; the JavaScript in
  the package is byte-identical to `src/`. `tools/build-chrome.sh` only copies files.
- Listed submissions get a human review and take days. Unlisted ones are signed
  automatically in minutes.
- **The channel is chosen on the submission form, and "Upload New Version" can skip that
  step** when the add-on has only ever been unlisted — silently sending the upload to the
  unlisted channel and consuming the version number. To be sure of the channel, use
  `npx web-ext sign --channel=listed`, where `--channel` is a required argument.
- AMO keeps the listing name, summary and description separate from `manifest.json`. A
  rename in the manifest does not update them; edit them on *Edit Product Page*.

#### Chrome (Chrome Web Store)

<https://chrome.google.com/webstore/devconsole> → the item → **Package** → **Upload new
package** → `laita-chrome-<V>.zip`.

The zip must have `manifest.json` at its **root**. Compressing the `dist-chrome` folder
from a file manager puts the folder inside the archive and Chrome rejects it; the
`(cd dist-chrome && zip …)` above is what produces the right shape.

Artwork for the listing lives in `assets/store/` and is regenerated by
`python3 tools/make-store-assets.py`:

| Listing field | File | Size |
| --- | --- | --- |
| Store icon | `store-icon-128.png` | 128×128 |
| Screenshots | `screenshot-1…5.png` | 1280×800 |
| Small promo tile | `promo-440x280.png` | 440×280 |
| Marquee promo tile | `promo-marquee-1400x560.png` | 1400×560 |

The store rejects any other screenshot size, and the *Privacy practices* tab needs a
justification for **every** declared permission plus a single-purpose statement. Declare
nothing that is not used: an unused permission is a question with no good answer.
Answer **No** to remote code — there is no `eval`, no `new Function`, no remotely loaded
script, and model responses are inserted as text, never evaluated.

### The two different "IDs"

`browser_specific_settings.gecko.id` is `locaispell@lobianco.org`. **That is the permanent
ID, and signing does not change it.** AMO ties every future version to it, so never change
it once anything has been uploaded — changing it would create a second, unrelated add-on.

Do not confuse it with the **internal UUID**, the `moz-extension://<uuid>` part Ollama
sees. That is generated randomly *per Firefox profile*: stable once the add-on is
permanently installed in a profile, but different on every machine, so it is not a public
identifier. It matters only when tightening `OLLAMA_ORIGINS` (§4).

### Sign an unlisted build

Unlisted means self-distribution: Mozilla signs it so Firefox will install it
permanently, but it is not published in the add-ons directory and gets only automated
review, usually within a few minutes.

**Every upload needs a `version` in `manifest.json` that has never been used before**, or
AMO rejects it. Bump it first.

Either upload `web-ext-artifacts/*.zip` by hand at
<https://addons.mozilla.org/developers/> — easier the first time, since it walks you
through the questions — or use the API:

```bash
export WEB_EXT_API_KEY='user:12345678:123'      # the JWT issuer
export WEB_EXT_API_SECRET='...'                 # the secret
(cd browser && npx web-ext sign --channel=unlisted)
```

Credentials come from <https://addons.mozilla.org/developers/addon/api/key/>. **Treat the
secret like a password.** Keep it outside the repository — a sibling `secrets/` directory
is ignored by git, or use your shell profile or a password manager. Never paste it into a
file inside the repo, even temporarily: it would remain in the git history afterwards.

The signed `.xpi` lands in `web-ext-artifacts/`, or under *My Extensions* on AMO if you
uploaded through the web interface.

Unlisted add-ons do **not** update themselves. To change that, host an update manifest
and point `browser_specific_settings.gecko.update_url` at it; until then, the upgrade
path is signing a new version and installing the new `.xpi`.

### Submitting to the listed channel

**Listed** means published in the Firefox add-ons directory: anyone can find and install
it, it updates itself, and it gets a **human** review rather than only an automated one.
**Unlisted** means self-distribution — signed so Firefox will install it, but not
published and not self-updating.

The same extension ID carries over, so nothing signed as unlisted is wasted: a listed
version is simply another version of the same add-on. Switching channel does not reset
anything, but **the version number still has to be one that has never been uploaded**.

Submit at <https://addons.mozilla.org/developers/> → *Upload New Version*, choosing
**"On this site"** where the unlisted flow chose "On your own". Or
`(cd browser && npx web-ext sign --channel=listed)`.

Before submitting:

- [ ] **Set a readable URL slug.** *Edit Product Page* → *Describe Add-on* → **Add-on
      URL**. It defaults to a random string like `0c79ab30ae2841e295ef`, which becomes
      the public address. Changing it later breaks every link already published,
      including the one in `README.md`.
- [ ] **Check the listing name and summary.** AMO stores these separately from
      `manifest.json` once the add-on exists, so renaming the extension does not update
      them — they have to be edited by hand on that page.
- [ ] **A PNG icon, 128px or larger.** `browser/icons/icon.svg` is fine for Firefox itself, but
      the listing page wants a raster version.
- [ ] **Screenshots and a description.** `assets/imgs/` has five screenshots; the
      description field is empty by default and is what a stranger reads first.
- [ ] **Re-read the permission story.** This add-on matches `<all_urls>` in
      `content_scripts` and reads what
      the user types, so expect scrutiny. In its favour: everything stays on the user's
      machine, the manifest declares
      `data_collection_permissions: { "required": ["none"] }`, and password and payment
      fields are excluded in code. Keep all three statements true, and say so in the
      notes to the reviewer.
- [ ] **Tell the reviewer how to test it.** A reviewer without Ollama sees an extension
      that cannot connect to anything. Give them the two commands that make it work
      (`ollama pull`, and the `OLLAMA_ORIGINS` drop-in from the README) in the *Notes to
      Reviewer* field, or the review will stall.
- [ ] **Decide what a user without Ollama sees.** Right now the extension reports that it
      cannot connect — honest, but abrupt for someone who installed it from a directory
      listing and has never heard of Ollama.

### Installing unsigned builds permanently

Firefox Developer Edition, Nightly and ESR can, after setting
`xpinstall.signatures.required` to `false` in `about:config`. Release Firefox ignores
that setting — there, a temporary add-on or a signed `.xpi` are the only options.

---

## 3b. The VS Code extension

Lives in `vscode/`. Nothing is bundled or compiled; `src/extension.js` is CommonJS
because that is what VS Code's extension host loads, and the shared ESM core is pulled in
with a dynamic `import()` at activation.

```bash
cd vscode
./tools/sync-core.sh     # after ANY change to browser/src/background/{anchor,ollama}.js
./test/run.sh            # pure logic; core.test.mjs fails if the copies drifted
npm run package          # -> laita-vscode-<version>.vsix
```

Run it from source without packaging: open `vscode/` in VS Code and press **F5**, or

```bash
code --user-data-dir=/tmp/laita-ud --extensions-dir=/tmp/laita-ext \
     --extensionDevelopmentPath="$PWD" --new-window --log debug somefile.md
```

The isolated `--user-data-dir` matters: without it the window joins your normal session.
Activation shows up in the log as `_doActivateExtension sylvaticus.laita`; anything
thrown during activation appears in the same file, under
`<user-data-dir>/logs/*/window1/exthost/exthost.log`.

Two things that warn if you get them wrong, both already handled: `core/package.json`
must declare `"type": "module"` or node cannot tell what the shared files are, and a
document selector must carry a `scheme` or it also matches output panels and diff views.

### Publishing to the Marketplace

Unlike the two browser stores there is no review queue: a successful `vsce publish` is
live as soon as validation passes. Three separate identities are involved and only the
last is ever shown to users:

| | Where | Public? |
| --- | --- | --- |
| Azure DevOps organisation | <https://dev.azure.com> | no — it exists only to mint the token |
| Personal access token (PAT) | same site, avatar -> Personal access tokens | no |
| Marketplace **publisher** `sylvaticus` | <https://marketplace.visualstudio.com/manage> | **yes** — it is the `publisher` field of `package.json` |

A GitHub organisation of the same name is unrelated to all three.

The PAT must be created with **Organization: `All accessible organizations`**, and with
**Marketplace -> Manage**, which only appears after clicking *Show all scopes*. Anything
narrower fails, because the Marketplace does not live inside your organisation.

```bash
cd vscode
npm run package
npx @vscode/vsce publish --packagePath laita-vscode-<V>.vsix     # prompts for the PAT
```

`--azure-credential` authenticates through the Azure CLI with Microsoft Entra ID instead,
if a token that expires every year is not worth the bother.

The three failures worth recognising:

- **`TF400813: The user 'aaaaaaaa-…' is not authorized`.** That all-`a` GUID is Azure
  DevOps's anonymous identity: the token resolved to nobody at all, so this is never a
  permission problem on the publisher. Either the PAT is scoped to a single organisation,
  or it was truncated on paste — a current PAT is 84 characters.
- **The `…/extensions/<name>/hub` link 404s.** The Marketplace answers 404, not 403, for
  a publisher the signed-in browser account does not own; easy to hit with both a
  personal and a work Microsoft account. Open <https://marketplace.visualstudio.com/manage>
  with no publisher in the path — it resolves to whichever publisher you do own.
- **The public item page 404s after a successful publish.** Validation runs after the
  upload and the page does not exist until it passes, typically 5-15 minutes. Poll it
  without the browser:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -L \
  "https://marketplace.visualstudio.com/items?itemName=sylvaticus.laita"
```

The gallery API is more informative than the page, and answers immediately: a version
carries `flags: none` until validation completes, and `validated` afterwards.

## 4. Restricting Ollama to just this extension

Once the add-on is permanently installed its UUID stops changing, so the
`moz-extension://*` wildcard from the README can be narrowed to one origin:

1. Open `about:config`, search for `extensions.webextensions.uuids`.
2. Find `locaispell@lobianco.org` in the JSON and copy its UUID.
3. Set `OLLAMA_ORIGINS=moz-extension://<that-uuid>` and restart Ollama.

No other extension can then reach Ollama. It is per profile: another profile or another
machine has a different UUID and needs its own entry, and the variable accepts a
comma-separated list.

Chrome is the easy case: the Web Store assigns the ID and it is identical for every
user, so the README can print it outright —
`OLLAMA_ORIGINS=chrome-extension://kkonkblgjafnampabmfflabkdkggpnjn`. Verified by probing a
throwaway Ollama pinned to that origin: the real ID reached the API, another
`chrome-extension://` ID, a `moz-extension://` origin and an ordinary web origin were all
refused with `403`.

**Keep the wildcard while developing — on both browsers.** A Firefox temporary add-on
gets a fresh UUID on every load, and a Chrome extension loaded unpacked from
`dist-chrome/` gets a locally generated ID that is *not* the store one. Pin either
published origin and your own development builds stop working, with the same `403` and no
hint as to why. Narrow the origin only on a profile where LAITA is permanently installed
from the store.

`OLLAMA_ORIGINS` is a CORS setting, so it constrains browsers and nothing else: a request
carrying no `Origin` header is allowed through regardless. It is a way to keep other
extensions out, not a security boundary around Ollama.

---

## 5. How it works

```
content scripts (per page)                  background page              Ollama
──────────────────────────                  ───────────────              ──────
focused field
  └─ adapter  ── plain text ──┐
       textarea → hidden      │
         mirror div for       │
         geometry             │
       contenteditable →      │
         text-node map        │
                              ▼
                    split into paragraphs
                    (long ones split on
                     sentence boundaries)
                              │
                    the paragraph holding
                    the caret, or all of
                    them on an explicit check
                              │
                       one message per chunk ──▶  cache lookup
                                                  (LRU, 600 chunks)
                                                       │ miss
                                                  bounded queue  ──▶  POST /api/chat
                                                                      JSON schema,
                                                                      think: false
                                                       ◀── issues quoted as substrings
                                                  anchor: locate each
                                                  quote, drop the
                                                  unfindable, resolve
                                                  overlaps by priority
                              ◀── issues with exact offsets ──┘
  shadow-DOM overlay
  draws wavy underlines,
  hit-tests clicks
```

A few decisions worth knowing about:

- **The model quotes, it does not count.** LLMs are bad at character offsets, so the
  prompt asks for the *verbatim substring* to change. `src/background/anchor.js` locates
  that quote in the text (tolerating curly quotes, collapsed whitespace and, as a last
  resort, case), discards anything it cannot find, and resolves overlapping suggestions
  by priority. This is what stops a hallucinated quote from corrupting the user's text.
- **The overlay never intercepts input.** It is `pointer-events: none`, and clicks are
  matched against the rectangles it drew. Caret placement and text selection stay exactly
  as the page intended.
- **One paragraph at a time.** An automatic check looks only at the paragraph holding the
  caret; the hotkey and the toolbar button sweep the whole field. Results are cached per
  chunk, so revisiting a paragraph costs nothing.
- **Highlights follow your edits.** After every keystroke the spans are re-anchored
  against the current text, so they shift with the text instead of drifting until the
  next check.
- **The extension never dictates a context size.** Ollama keys a loaded model by its
  runtime options, so naming a `num_ctx` that differs from another client's would evict
  that client's model and load a second copy of the same weights.

### Layout

```
manifest.json
src/common/settings.js       defaults, storage, per-site rules
src/background/main.js       message router, cache, queue, cancellation, keep-alive, badge
src/background/ollama.js     prompt construction, transport, response parsing, error
                             classification (proofreading and transform)
src/background/anchor.js     quotes → exact offsets; the correctness-critical part
src/content/common.js        shared state, language detection, re-anchoring, messaging
src/content/segment.js       paragraph and sentence chunking, locating the caret's chunk
src/content/textmap.js       field adapters (mirror geometry, text-node mapping)
src/content/overlay.js       shadow-DOM layer, wavy underlines, status pill, hit-testing
src/content/card.js          the suggestion card
src/content/transform.js     the transform instruction box and its result panel
src/content/main.js          orchestration
src/options/, src/popup/     UI
test/                        unit tests + browser harnesses (see test/README.md)
doc/                         this file
assets/imgs/                 screenshots for the README and the AMO listing
web-ext-config.cjs           keeps development files out of the signed package
```
