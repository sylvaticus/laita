# Session context for an LLM agent

Working on this project with an LLM assistant means starting each session with an
assistant that remembers nothing. Three files carry what it needs:

| File | Holds | Changes |
| --- | --- | --- |
| `CLAUDE.md` | design invariants — why the code is shaped as it is, and what breaks if you "tidy" it | rarely |
| `NEWS.md` | what changed for users, per release | each release |
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

## State — last updated 2026-09-23

### Identity

- **LAITA** = Local AI Text Assistant. Short name `laita`; sandbox global `LAITA`; display
  name `LAITA - Local AI Text Assistant`.
- Repository <https://github.com/sylvaticus/laita>; the git remote is **SSH**, not the
  https URL, because there is no credential helper configured and `gh` is set to ssh.
- **The Firefox extension id is `locaispell@lobianco.org` and must not change.** It
  predates the rename and is invisible to users, but AMO ties every uploaded version to
  it. Changing it creates a second, unrelated add-on and abandons the listing, its slug
  and any review in flight.
- **The Chrome Web Store id is `kkonkblgjafnampabmfflabkdkggpnjn`**, assigned at first
  upload and identical for every user — so unlike Firefox's per-profile UUID it can be
  published, and the README gives it as the value for `OLLAMA_ORIGINS`. An unpacked
  `dist-chrome/` load gets a different local id, which is why development needs the
  wildcard.
- All packages are at **0.4.3** and the release workflow refuses to publish unless the
  manifests match the tag. There are now **four** things to keep in step:
  `browser/manifest.json`, `browser/manifest.chrome.json`, `vscode/package.json` and
  `libreoffice/src/description.xml`.
- **`languagetool/` is a fourth component and is versioned separately** (`VERSION` in
  `laita_lt_server.py`, currently 0.1.0). It is a server, not a client, and is not part of
  any store release.

### Store status

| | Firefox (AMO) | Chrome Web Store | VS Code Marketplace |
| --- | --- | --- | --- |
| Live | **nothing** | yes | **0.4.0** |
| Consumed versions | 0.1.0, 0.2.0, 0.2.1 unlisted; 0.2.2 listed, **still in human review** | 0.3.2, 0.3.3 drafts; listing live | 0.3.9, 0.4.0 |
| Identifier | slug `local-ai-text-assistant` | `kkonkblgjafnampabmfflabkdkggpnjn` | `sylvaticus.laita` |

- **Firefox is the gap.** The AMO listing still 404s, 0.2.2 is still queued, and no signed
  `.xpi` exists for anything recent — the only one ever attached to a release is 0.2.0
  under the old name. The zips on the releases page are unsigned submissions that Firefox
  refuses. The README now says there is no Firefox build to install, which is the truth;
  the fix is either the review landing or `web-ext sign --channel=unlisted` and attaching
  the result.
- Neither browser store will accept a version number it has already seen, in either
  channel, even after the version is deleted.
- AMO's listing name, summary and description are stored separately from `manifest.json`
  and were edited by hand; a manifest rename does not update them. The listing still
  describes 0.2.2, which predates the LAITA rename.
- The Chrome listing still needs its **Privacy practices** tab completed and the publisher
  email verified, and 0.4.0 has not been uploaded.
- The VS Code Marketplace has no review queue, so a mistake there is public immediately
  and the only remedy is another version.

### What the two reviews changed

`CODE-REVIEW.md` and `SECURITY-REVIEW.md` (untracked, and `SECURITY-REVIEW.md` says not
for a public tracker) were worked through in full. Everything in them is closed. The five
that mattered, because a fresh reader should know these were real and are fixed:

1. **A hostile repository could redirect VS Code proofreading to its own server.** Every
   setting was window-scoped, so `.vscode/settings.json` could set `laita.endpoint`; with
   `checkOnType` on by default and `git-commit`/`scminput` in the default language list,
   opening a file sent paragraphs and commit messages to it — and the attacker then chose
   the replacement text `Ctrl+.` `Enter` pasted in. Connection settings are `machine`
   scope now, dictionary and ignored are `application`, `untrustedWorkspaces` is declared,
   and an untrusted workspace gets no automatic checking.
2. **`isCheckable` returned true for every contenteditable host** before any
   sensitive-field check ran. The check now runs first and walks ancestors.
   `sensitive.test.mjs` asserts the invariant over hostile field shapes.
3. **`locate()` corrupted the range whenever case-folding changed a string's length**
   (`"İ".toLowerCase()` is two code units) and stored the corrupted span as `original`,
   defeating every later "is this still the same text?" guard.
4. **A long transform silently destroyed the selection in the default configuration** —
   the size guard only ran when `numCtx` was pinned, and it defaults to 0.
5. **The endpoint was unvalidated free text and the extension held `<all_urls>`.**

Three review findings were **wrong**, which is worth knowing before trusting either
document: `data_collection_permissions` is in the manifest (nested under
`browser_specific_settings.gecko`); the number inputs do carry `min`/`max`/`step`; and the
suggested `/api/show` fix for the context window returns the *architecture's* maximum
(262144), which would have made the guard pass every time — `/api/ps` reports the real one.

Two bugs **neither review found**: the options page and the popup called `browser` while
importing neither compat.js nor common.js, so on Chrome everything past the first click
threw; and `vscode/.vscode/launch.json` was never tracked, so a fresh clone still had the
"F5 does nothing" problem the docs recorded as fixed.

### Infrastructure added since

- **CI on every push** (`.github/workflows/ci.yml`): both unit suites, eslint, `web-ext
  lint`, and a job that builds all three packages and uploads them as a `packages`
  artifact for 14 days.
- **A release workflow** on a `v*` tag: runs everything CI runs, checks all three
  manifests against the tag, builds the Firefox zip, the Chrome zip and the `.vsix`, and
  attaches them to the GitHub release. It does **not** publish to any store — the VS Code
  PAT is deliberately not a repository secret.
- **A pinned toolchain** at the repository root (`web-ext` 10.6.0, `eslint` 10.10.0) with
  a committed `package-lock.json`. `browser/` and `vscode/` stay free of `node_modules`.
  Root `package.json` declares `"type": "module"`; before it, Node 22's module-syntax
  detection was carrying the browser ESM imports implicitly.
- **eslint**, three configs for three kinds of JavaScript. `no-unsanitized` is the rule
  that earns its keep: it makes the "model output never becomes markup" invariant
  mechanical.
- **`browser/dist-chrome/` and `vscode/core/{anchor,ollama}.js` are generated, not
  committed** (5,480 lines removed). The test runners generate them before running
  anything, so a fresh clone needs no extra step — verified against a checkout containing
  only tracked files. `vscode/core/package.json` *is* committed.
- Test counts: **11 browser files, 4 VS Code files**, up from 7 and 4.

### What can and cannot be tested automatically

- **Chrome cannot be driven from a script.** Since 137 the `--load-extension` switch is
  refused, and `--disable-features=DisableLoadExtensionCommandLineSwitch` does not revive
  it — re-confirmed on **152.0.7977.64**, where Chrome ignored both the flag and the start
  URL and only its own built-in extensions appeared among the debugger targets. Chrome's
  half of the compatibility layer is covered by `test/unit/chrome-compat.test.mjs` and
  `chrome-pages.test.mjs`, which fake the API surface. Anything beyond that needs a human.
- **`browser/test/browser/run-harness.sh` drives real headless Firefox** against a mock
  Ollama and is the only thing that sees overlay geometry, event handling and the actual
  text that lands in a field. It has earned its keep twice in one session: it caught the
  S4 fence change (the mock parsed the old fixed `<<<TEXT` marker and every transform came
  back empty) and it is what confirmed the content script still injects after `<all_urls>`
  was dropped. **Run it for any change to `overlay.js`, `textmap.js`, `transform.js` or
  the event handling in `content/main.js`.** It is not in CI: it needs a browser and
  several minutes.
- **Firefox is a snap, so the harness leaks processes.** Leftover headless instances
  cannot be killed by a script; they accumulate at ~550 MB each. Run `pkill -f
  laita-testrun` yourself afterwards — five had built up over four days at one point.
- **No automated coverage at all** for `content/main.js` orchestration, `textmap.js`
  geometry, `overlay.js`/`card.js` rendering, or the options and popup round-trips beyond
  "they load on Chrome".

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

- Proofreading cost is dominated by what the model **writes**, not what it reads. Reading
  the input is near-free (≲1s for hundreds of tokens); generation runs at a near-constant
  **~55 output tokens per issue found**. An earlier note here claimed latency "grows faster
  than linearly with the text sent" (139 chars 0.7s … 1119 chars 19.4s) - that was length
  confounded with error density (longer samples had more wrong with them) and, on the
  laptop, thermal throttling. `browser/tools/measure-chunking.mjs` reads Ollama's token
  counters and shows the real shape. Chunking still earns its place, but for **coverage**
  (see below), not for a latency curve.

- The response schema caps a single request at **12 issues** (`maxItems`). A long paragraph
  checked whole silently loses everything past the twelfth; splitting is the only way to
  reach them. This, not speed, is why chunking is on by default on all three surfaces.

- `qwen3.5:9b`: ~30 tok/s for a short answer falling toward ~10 for a long one, and lower
  still on a thermally throttled laptop GPU (measured 22→4 tok/s under sustained load).
  **Time comparisons on this machine are only valid run ABBA or normalised to tokens** -
  a plain A-then-B charges the cooling curve to B.
- A 10269-character transform took **205 s** and returned all 65 paragraphs intact.
- Ollama keys a loaded model by model **plus runtime options**: changing `num_ctx` evicts
  the runner and reloads the weights (~7 s warm, far worse under memory pressure). This is
  why the extension sends no `num_ctx` at all.
- Context size is cheap: 4096 → 32768 costs only ~700 MB with `q8_0` KV cache.

### VS Code extension

`vscode/`, version **0.4.0** (numbered in step with the browser manifests rather than
starting at 0.1.0: three numbers for three targets of one tool is the worse confusion).
Live on the Marketplace as `sylvaticus.laita`.

Packaging and running from source are in `dev_doc.md` §0 and §3b. What belongs here is
what cost time:

1. **F5 did nothing** because there was no `.vscode/launch.json`. It is not optional
   scaffolding. It was also untracked until 2026-09-15, so it was fixed on one machine
   and for nobody else.
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
   `activate()`. **For this package, "tests pass" is not the same as "it starts".**
5. **The lightbulb menu is shared.** VS Code's own *View Problem* and any AI assistant's
   *Fix* appear next to ours and cannot be suppressed, so every LAITA action names itself
   and the apply-the-fix one is `isPreferred`.
6. **`DiagnosticSeverity.Hint` is drawn as three dots, not an underline.** Using it for
   the rephrase category looked exactly like a broken range and cost two wrong diagnoses.
   Severities are settings now, defaulting to warning/info/info.

**A diagnostic range does not move with the text.** VS Code leaves a
DiagnosticCollection's ranges exactly where they were set, so editing one paragraph
leaves every suggestion after it pointing a few characters off, and applying one then
corrupts the document - reported in the wild as "Finally the negative" becoming
"FiFinally, theegative". Two defences, mirroring the browser: `shiftDiagnostics` moves
them on every change and drops any the edit went through, and `locateIssue` refuses to
replace text that is not what the model was shown. `test/unit/stale.test.mjs` reproduces
the exact corruption when either is removed.

The same staleness applies when the squiggle is **drawn**, not only when a fix is
applied: a model answer arrives seconds after the text it describes, and mapping its
offsets straight onto a document that shrank meanwhile makes `positionAt` clamp the end,
underlining part of the phrase with the whole message attached. `rangeForIssue`
re-anchors before creating each diagnostic. The browser never had this because `runCheck`
already calls `LAITA.reconcile` against the current text before painting - the port
simply omitted the equivalent.

Verified end to end against a live Ollama: opening a markdown file produces exactly one
`POST /api/chat`. Everything past that — quick fixes, the dictionary, transforms — has
been exercised by hand in the F5 window but has no automated coverage.

### LibreOffice — built and working

`libreoffice/`, a Python `.oxt`. Proofreading in Writer; the transform in Writer, Calc,
Impress and Draw; a toolbar, a Tools menu, a right-click entry and an options dialog.
The design and the measurements behind it are in `roadmap.md`; what follows is what the
building of it cost, because most of it is not recoverable from the code.

**Testing it.** `libreoffice/test/run.sh` needs neither LibreOffice nor Ollama: the two
ported modules are compared against the JavaScript they came from, and `test_wiring.py`
checks every name that has to match across the XML and the Python. Separately,
`tools/uno-run.sh` starts a headless LibreOffice and hands a script a live component
context - that is the only way to test anything at the UNO boundary, and it is how the
options dialog and the settings round trip were fixed. It cannot type, click, or see an
underline.

**The write-back, which took eleven rounds.** A rewritten selection would not appear in
the document. Worth reading before touching that code, because almost every hypothesis
was wrong in an instructive way:

- The write *did* land, every time. What varied was whether it survived.
- **The cause: a text editor owns the text, and a model write goes underneath it.** A
  spreadsheet cell being edited, and a Draw or Impress shape being edited, both hand out
  an object whose `setString` succeeds and is then overwritten when the editor commits.
  `.uno:EnterString` and a posted `.uno:Escape` fail the same way, because they are the
  same mistake.
- **The cure is to paste**, which goes through the editor rather than around it. Only
  where an editor is actually in the way: a paste onto a *selected shape* inserts a new
  object and empties it. The route is chosen by the selection's type, which says who
  owns the text - `ScCellObj` and `SvxUnoText*` are editors, everything else is not.
- **Verification kept lying.** First by reading back through the object just written to,
  which a detached copy passes. Then by reading back through a text range whose extent
  the write had changed, which reports an empty string for a write that worked. Ask the
  enclosing text instead.
- **Two crashes, both self-inflicted.** A `threading.Timer` touching the document, and
  restoring a clipboard transferable belonging to another application. Neither raises;
  both take LibreOffice down seconds later.
- The diagnostic that finally cracked it was a *delayed* re-read plus a survey of every
  open document. Four fixes had been shipped before anything distinguished the
  hypotheses rather than confirming one.

**Rules that are not obvious and cost time:**

- **Never touch UNO from a `threading.Timer`.** Use `later_on_main()`, which goes
  through `AsyncCallback`. The same applies to anything a worker thread wants to do to a
  dialog or a document.
- **Never block the main thread waiting for a dispatch.** `executeDispatch` posts; the
  main loop has to run for it to happen, and sleeping there is what stops it.
- **A `.xdl` event binding has exactly one working spelling:**
  `script:macro-name="vnd.sun.star.UNO:onName"` with `script:language="UNO"` and no
  `script:location`. Anything else throws at dialog creation naming neither the event nor
  the control.
- **An `oor:string-list` needs a typed `uno.Any` through `uno.invoke`.** A plain list is
  refused as "configmgr inappropriate property value". Swallowing that error is how the
  dictionary appeared to save and read back empty.
- **A virtualenv on `PATH` breaks `unopkg`** with a bare `std::bad_alloc` mentioning
  neither Python nor the environment. `install.sh` strips it.
- **LibreOffice must be fully closed** - including the background `soffice.bin` - before
  a reinstalled extension is picked up. Installing over a running instance reports
  success and then never instantiates the component.
- **Installing is not enabling.** The user must tick LAITA for their language under
  Writing Aids > Available Language Modules > Edit, and a document with no language set
  is never checked at all.
- **`onDocumentOpened` fires for both new and loaded documents**, so listing it beside
  `OnNew` and `OnLoad` registers the context menu twice and the menu grows two identical
  entries.
- The extension options page never appeared in the Tools > Options tree despite the `Id`
  matching the extension identifier, which is the documented requirement. The toolbar
  opens our own dialog instead.

**Chunking is ported and on, default 700.** An earlier measurement made it look four
times *slower* and it was turned off; that was a throttling laptop GPU measured
whole-then-split, not the splitting. Re-measured by tokens and run ABBA, splitting is a
proportional trade that also gets past the 12-issue-per-request cap. See `roadmap.md`.

**Not verified:** anything requiring a real window. `Xvfb`, `openbox` and `xdotool` are
installed, but LibreOffice maps no window on the virtual display, so the transform
dialog could never be driven end to end here - every fix to it was confirmed by the
user.

### The LanguageTool server (new since 2026-09-22)

`languagetool/` serves LAITA over the LanguageTool HTTP API, which is how **Collabora
Online** reaches it — Collabora cannot install extensions, and draws its own UI, so the
`.oxt` is impossible there. Deployed and in daily use on this server for the lab's
Nextcloud. It also answers Collabora's DeepL hook, so translation runs on the same local
model.

Everything about it is in `languagetool/README.md` (design) and `languagetool/DEPLOY.md`
(runbook), and its invariants are in `CLAUDE.md`. What matters for a fresh session:

- It **reuses** `libreoffice/src/pythonpath/` rather than copying it, so a change there is
  a change to the server too. `libreoffice/test/run.sh` must pass after any such change.
- Four bugs were found only by running it against real Collabora, and each is now an
  invariant in `CLAUDE.md` with the measurement attached. Do not "simplify" the order of
  operations in `Checker.check`; both halves of it were paid for.
- Deployed by `sudo languagetool/tools/install.sh`, which copies to `/opt/laita` and
  restarts the systemd unit. It does **not** run from the checkout.

### Open items

- **LibreOffice desktop 0.4.3 has reported issues, not yet diagnosed.** The user found
  them after the 0.4.3 artefacts were built and will continue from a desktop machine.
  Nothing is known about them beyond that, and nothing has been attempted. Start by asking
  what the symptoms are rather than guessing; `~/laita-libreoffice.log` is the first place
  to look.
- **Two screenshots are out of date.** `assets/imgs/sceenshot_laita_lo4.png` shows the
  transform dialog without its Copy button, and `sceenshot_laita_lo5.png` the options
  dialog without "Paragraphs to remember". Both changed in 0.4.3 and want retaking.
- **VS Code cannot edit a transform before applying it**, unlike the browser and
  LibreOffice. Both sides of its review diff are served by a `TextDocumentContentProvider`
  and are read-only by construction; making the right-hand side writable needs a
  `FileSystemProvider` on its own scheme. Copy is offered instead. Deliberate, not missed.
- **0.4.3 is built but not tested by a human on any surface**, and not uploaded anywhere.
  The artefacts are in `browser/web-ext-artifacts/`, `vscode/` and `libreoffice/dist/`.

- **Firefox has no installable build.** See Store status above. This is the one thing a
  user can currently not do.
- Upload **0.4.0** to the Chrome Web Store, and complete its Privacy practices tab and
  publisher email verification.
- **Not verified in any real browser:** that Chrome and Firefox keep injecting the content
  script after an upgrade that *drops* a previously granted `<all_urls>` host permission.
  Both were confirmed on a **fresh** install of the 0.4.0 manifest — Chrome by hand, and
  Firefox by the full harness — but nobody has watched an existing profile update. Chrome
  152 still ignores `--load-extension`, so this needs a human.
- Whether `holdOpen`'s 20-second interval keeps a Chrome **service worker** alive during a
  long request. Chrome kills an idle worker after 30 seconds, and this is exactly the bug
  that produced "Receiving end does not exist" on Firefox. Needs a human running a
  multi-minute transform in Chrome. If it fails, the fix is `chrome.alarms` or a port held
  open from the content script.
- AMO 0.2.2 review outcome, after which the listing name should be updated to LAITA.
- Language detection is duplicated between `browser/src/content/common.js` and
  `vscode/src/text.js`; the anchoring and the prompts now exist a third time, in Python.
  `libreoffice/test/` compares the Python against the JavaScript, which is what keeps
  them honest - a real shared package would be better and is not obviously possible
  across three languages.
- ~~The browser's chunking should be re-measured.~~ **Done.**
  `browser/tools/measure-chunking.mjs` reads Ollama's token counters: cost is
  ~55 output tokens per issue, splitting is a proportional trade (not the "four times
  slower" the wall clock showed on a throttling GPU), and it gets past the 12-issue cap.
  700 kept on the browser; LibreOffice flipped 0 → 700 to match. The false latency line in
  the browser options page was corrected.
- The 16px icon is legible but weak; a hand-drawn simplified mark was offered and not done.
- ~~The LibreOffice extension is not packaged for distribution.~~ **Done.** It is on
  <https://extensions.libreoffice.org> and `tools/build-oxt.sh --release` produces
  `dist/laita-<version>.oxt`.
- The transform dialog gives no progress beyond a status line while the model works.
  It runs off the UI thread so LibreOffice stays responsive, but a long selection is
  a long wait with nothing moving.
