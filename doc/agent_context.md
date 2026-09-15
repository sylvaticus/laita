# Session context for an LLM agent

Working on this project with an LLM assistant means starting each session with an
assistant that remembers nothing. Three files carry what it needs:

| File | Holds | Changes |
| --- | --- | --- |
| `CLAUDE.md` | design invariants — why the code is shaped as it is, and what breaks if you "tidy" it | rarely |
| `doc/dev_doc.md` | how to build, test, sign and release | rarely |
| **this file** | the volatile state: versions, store submissions, what is verified, what is not, and the quirks of this machine | **every session** |

The first two are durable documentation. This one is a handover note, and it is only
useful if it is rewritten when it stops being true.

## Reloading (start of a session)

Point the assistant at this file. Its job is to answer, without being asked: what version
are we on, what is waiting on a store, what has already been tried and rejected, and what
is known to be untested.

## Saving (end of a session)

Rewrite the sections below. Be ruthless about deleting what is no longer true — a stale
handover is worse than none, because it is believed. Three things earn their place:

1. **Decisions that look like mistakes.** Anything a fresh reader would want to "fix",
   with the reason it is the way it is. The extension id below is the example.
2. **Facts that cost time to rediscover.** Measurements, environment quirks, store
   behaviour. Each line here stands for something that took a while to work out.
3. **What is *not* verified.** The most expensive thing an assistant can do is assume
   something was tested.

Design invariants go in `CLAUDE.md` instead, not here; procedures go in `dev_doc.md`.

---

## State — last updated 2026-09-15

### Identity

- **LAITA** = Local AI Text Assistant. Short name `laita`; sandbox global `LAITA`; display
  name `LAITA - Local AI Text Assistant`.
- Repository <https://github.com/sylvaticus/laita>; the git remote is **SSH**, not the
  https URL, because there is no credential helper configured and `gh` is set to ssh.
- **The extension id is `locaispell@lobianco.org` and must not change.** It predates the
  rename and is invisible to users, but AMO ties every uploaded version to it. Changing it
  creates a second, unrelated add-on and abandons the listing, its slug and any review in
  flight.
- **The Chrome Web Store ID is `kkonkblgjafnampabmfflabkdkggpnjn`**, assigned at first
  upload and identical for every user — so unlike Firefox's per-profile UUID it can be
  published, and the README does. An unpacked `dist-chrome/` load gets a different local
  ID, which is why development still needs the wildcard.
- All three packages are at **0.3.9**. The two browser manifests must match and
  `dist-chrome.test.mjs` enforces it; the VS Code package is kept in step by convention
  only, with nothing checking it.

### Store status

| | Firefox (AMO) | Chrome Web Store | VS Code Marketplace |
| --- | --- | --- | --- |
| Consumed versions | 0.1.0, 0.2.0, 0.2.1 unlisted; **0.2.2 submitted listed, in human review** | 0.3.2, 0.3.3 uploaded as drafts | **0.3.9 live since 2026-09-14** |
| Listing id | slug `local-ai-text-assistant` | — | `sylvaticus.laita` |
| Ready to upload | `browser/web-ext-artifacts/laita-firefox-0.3.9.zip` | `laita-chrome-0.3.9.zip` | — |

- Neither store will accept a version number it has already seen, in either channel, even
  after the version is deleted.
- AMO's listing name, summary and description are stored separately from `manifest.json`
  and were edited by hand; a manifest rename does not update them.
- The AMO listing still describes 0.2.2, which predates the LAITA rename.
- `alarms` was declared in the Chrome manifest and removed again at 0.3.3: nothing used
  it, and the store makes you justify every permission individually.
- The VS Code Marketplace is the odd one out: no review queue, so a mistake is public
  immediately and the only remedy is another version. The publisher is `sylvaticus`,
  owned by a Microsoft account — unrelated to the GitHub organisation of the same name.
  `dev_doc.md` §3b decodes the three failures that cost time the first time.

### Verified, and not

- **Verified by hand on Chrome 152:** proofreading and transforms both work.
- **Not verified, and it matters:** whether `holdOpen`'s 20-second interval keeps a Chrome
  *service worker* alive during a long request. Chrome kills an idle worker after 30
  seconds, and this is exactly the bug that produced "Receiving end does not exist" on
  Firefox. Needs a human running a multi-minute transform in Chrome. If it fails, the fix
  is `chrome.alarms` or a port held open from the content script.
- **Chrome cannot be driven by a script.** 137+ refuses `--load-extension`; confirmed on
  152, including with `--disable-features=DisableLoadExtensionCommandLineSwitch`. The
  extension never appears among the debugger targets. `test/unit/chrome-compat.test.mjs`
  fakes both API surfaces instead.
- `<all_urls>` in `content_scripts.matches` cannot be replaced by `activeTab`: automatic
  proofreading has no user gesture to hang off. It stays.
- **`<all_urls>` was removed from `host_permissions` at 0.4.0.** It was used only to read
  `tab.url` for the per-site pause; the content script now answers a `hostname` message
  instead, and `hostnameForTab` falls back to `tab.url` where a content script cannot run.
  A remote endpoint asks for its own origin through `permissions.request` against
  `optional_host_permissions: ["*://*/*"]`.
  - **What this actually buys differs by browser, and the difference is not documented
    anywhere obvious.** On Chrome it is a real reduction: `content_scripts.matches` never
    granted fetch-anywhere, so the background can no longer reach arbitrary origins. On
    Firefox 127+, host permissions listed in `content_scripts` are *also* granted at
    install, so the grant may be unchanged — the code no longer depends on it either way.
  - It does **not** silence either store's permission warning; `content_scripts.matches`
    alone triggers that.
  - **Not verified on a real Firefox or Chrome profile.** The unit tests pin the manifest
    shape and the hostname path, but nobody has watched a per-site pause work after an
    upgrade that drops a previously granted permission.

### This machine

- **Firefox is a snap.** It cannot read `/tmp`, so test profiles and extension copies must
  live under `$HOME`. Snap AppArmor also blocks signals from outside the snap: leftover
  headless Firefox processes cannot be killed by a script and the user must run
  `pkill -f laita-testrun`.
- **The ssh key is passphrase-protected.** After every reboot, `ssh-add ~/.ssh/id_rsa`
  must be run once or `git push` hangs — and each failed attempt leaves `gcr-ssh-agent`
  forking an `ssh-add` that spins at 97% CPU indefinitely. Two such processes once ran for
  39 hours.
- **The power profile silently costs 17×.** `power-saver` pins the dGPU to 210 MHz of
  3105; `performance` gives ~30 tok/s against ~1.8. It does not present as slowness, it
  presents as an extension that hangs and times out. Check `powerprofilesctl get` before
  believing any performance measurement.
- GPU: RTX 2000 Ada Laptop, 8 GB. `qwen3.5:9b` is 5.7 GB at 16384 context.
- Ollama: `OLLAMA_CONTEXT_LENGTH=16384`, `OLLAMA_NUM_PARALLEL=1`,
  `OLLAMA_ORIGINS=moz-extension://*`, keep-alive pinned.

### Measurements worth not repeating

- Proofreading latency grows **faster than linearly** with the text sent: 139 chars 0.7s,
  419 chars 4.4s, 699 chars 9.0s, 1119 chars 19.4s. This is why both surfaces chunk, and
  why an automatic check sends exactly one chunk.

- `qwen3.5:9b`: ~30 tok/s for a short answer, **~10 tok/s for a long one**. The rate falls
  as the answer grows, so big jobs are worse than linear.
- A 10269-character transform took **205 s** and returned all 65 paragraphs intact.
- Ollama keys a loaded model by model **plus runtime options**: changing `num_ctx` evicts
  the runner and reloads the weights (~7 s warm, far worse under memory pressure). This is
  why the extension sends no `num_ctx` at all.
- Context size is cheap: 4096 → 32768 costs only ~700 MB with `q8_0` KV cache.

### VS Code extension

`vscode/`, version **0.3.9** (numbered in step with the browser manifests rather than
starting at 0.1.0: three numbers for three targets of one tool is the worse confusion).
**Published to the Marketplace as `sylvaticus.laita` on 2026-09-14**, the first of the
three surfaces to be publicly listed under the LAITA name.

Built and installed like this:

```bash
cd vscode
./tools/sync-core.sh                              # only after touching browser/src/background
npm run package                                   # -> laita-vscode-0.3.9.vsix
code --install-extension laita-vscode-0.3.9.vsix --force
```

`--force` is needed to reinstall the same version. To run it without installing, open
`vscode/` in VS Code and press **F5**, or launch an isolated instance:

```bash
code --user-data-dir=/tmp/laita-ud --extensions-dir=/tmp/laita-ext \
     --extensionDevelopmentPath="$PWD" --new-window somefile.md
```

The isolated `--user-data-dir` matters twice over: without it the window joins the normal
session, and with it the extension host log lands somewhere predictable —
`<user-data-dir>/logs/*/window1/exthost/exthost.log`, where `_doActivateExtension
sylvaticus.laita` confirms it started.

**Things that cost time here, in the order they bit:**

1. **F5 did nothing** because there was no `.vscode/launch.json`. It is not optional
   scaffolding; without it there is no launch configuration to run.
2. **`console.log` from an extension never reaches the log files.** It goes to the Debug
   Console of the *debugging* instance. Tracing a headless run means writing to a file
   (`fs.appendFileSync`) — which is how the next one was found.
3. **Opening a document checked nothing**, because the cursor starts on line 0, which is
   usually the title, and a seven-character heading is correctly not worth sending. The
   initial check now falls back to the first paragraph that is real prose. The logic had
   been right and the outcome useless, which no unit test would have caught.
4. **A `ReferenceError` shipped.** `node --check` validates syntax, not references, and
   nothing else loaded `extension.js` because it requires the `vscode` module.
   `test/unit/activate.test.mjs` now loads it against a stubbed `vscode` and calls
   `activate()`; it was confirmed to fail on a deliberately broken call. **For this
   package, "tests pass" is not the same as "it starts" — run that test.**
5. **The lightbulb menu is shared.** VS Code's own *View Problem* and any AI assistant's
   *Fix* appear next to ours and cannot be suppressed, so every LAITA action names itself
   and the apply-the-fix one is `isPreferred`.

`core/` is a committed copy of `anchor.js` and `ollama.js` from `browser/src/background/`,
because a packaged `.vsix` may only contain files from inside `vscode/`.
`test/unit/core.test.mjs` fails if a copy drifts.

**A diagnostic range does not move with the text.** VS Code leaves a
DiagnosticCollection's ranges exactly where they were set, so editing one paragraph
leaves every suggestion after it pointing a few characters off, and applying one then
corrupts the document - reported in the wild as "Finally the negative" becoming
"FiFinally, theegative". Two defences now, mirroring the browser: `shiftDiagnostics`
moves them on every change and drops any the edit went through, and `locateIssue`
refuses to replace text that is not what the model was shown, relocating nearby or
offering no fix at all. `test/unit/stale.test.mjs` reproduces the exact corruption when
either is removed.

The same staleness applies when the squiggle is **drawn**, not only when a fix is
applied: a model answer arrives seconds after the text it describes, and mapping its
offsets straight onto a document that shrank meanwhile makes `positionAt` clamp the end,
underlining part of the phrase with the whole message attached. `rangeForIssue`
re-anchors before creating each diagnostic. The browser has never had this because
`runCheck` already calls `LAITA.reconcile` against the current text before painting -
the port simply omitted the equivalent.

Verified end to end against a live Ollama: opening a markdown file produces exactly one
`POST /api/chat`. Everything past that — quick fixes, the dictionary, transforms — has
been exercised by hand in the F5 window but has no automated coverage.

### LibreOffice — the next target, nothing built yet

The plan and its reasoning are in `roadmap.md`; only the volatile parts belong here.
Checked on **LibreOffice 26.2.5.2, Ubuntu 26.04**, by reading the shipped registry:

- The built-in `LanguageToolGrammarChecker` is a **client with no server behind it**,
  disabled by default, and `languagetool` is not in the Ubuntu archive. Nothing local
  checks grammar on this machine today; Hunspell does spelling only. The empty
  `BaseURL` setting is the whole opportunity.
- No LLM-backed LanguageTool server exists anywhere. `ltapiserv-rs` (Rust, ~27 stars) is
  the only third-party server in use and proves the clients accept one.

**Inferred, not measured — and the next session should measure these before writing
anything:**

1. Whether LibreOffice appends `/check` to `BaseURL` or wants the full path.
2. How much text arrives per request, and how often.
3. Whether plain `http` on localhost is accepted (there is an `SSLCertVerify` setting,
   which suggests yes, but that is not proof).
4. **What LibreOffice does when a reply takes fifteen seconds.** This is the one that
   could sink the plan: every LanguageTool client was written against a checker that
   answers in milliseconds, and our own curve is 0.7 s at 139 characters, 19.4 s at 1119.

The agreed first step is a logging proxy between LibreOffice and a real LanguageTool
server, which answers all four at once and yields a known-good reply to imitate. Nothing
has been installed for this yet — no Docker image pulled, no server downloaded.

### Open items

- Upload **0.3.9** to both browser stores — neither has yet seen a version under the
  LAITA name. The Chrome listing still needs its Privacy practices tab completed and the
  publisher email verified.
- The Marketplace listing has no screenshots and reuses the browser README; the artwork
  in `assets/store/` was sized for Chrome and has not been reviewed against what the
  Marketplace page actually renders.
- The Chrome service-worker lifetime question above.
- AMO 0.2.2 review outcome, after which the listing name should be updated to LAITA.
- qwen3.5:9b reliably claims a missing full stop on a sentence that has one; the
  `alreadyThere` guard in `anchor.js` drops it. Prompt wording did not stop it, a code
  guard did.
- The model sometimes writes "..." instead of the rest of its replacement. Guarded by
  `looksTruncated`; it destroyed a paragraph before that existed.
- `DiagnosticSeverity.Hint` is drawn by VS Code as three dots at the start of a range,
  not as an underline across it. Using it for the rephrase category looked exactly like
  a broken range and cost two wrong diagnoses before the severity was dumped from a live
  run. Severities are now settings, defaulting to warning/info/info.
- The 16px icon is legible but weak; a hand-drawn simplified mark was offered and not done.
- If the LibreOffice adapter is built, packaging is its hard part, not the code: a
  background service needs a per-OS autostart and, for a signed binary, an Apple
  Developer account and a Windows certificate. A configuration-only `.oxt` remains the
  friendliest way to set `BaseURL` — an extension with no code in it.
- Language detection is now duplicated between `browser/src/content/common.js` and
  `vscode/src/text.js`; the first candidate if a real shared `core/` package is extracted.
