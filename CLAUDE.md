# LAITA — notes for future sessions

**LAITA** = Local AI Text Assistant. Short name `laita`; the sandbox global in the content
scripts is `LAITA`. Display name "LAITA - Local AI Text Assistant".

The repository is a monorepo. `browser/` is the Firefox extension (and Chrome later);
`doc/roadmap.md` has the plan for the other targets and why the shared core has not been
extracted yet.

`browser/` is an MV3 extension for **both Firefox and Chrome**: one `src/`, two manifests
(`manifest.json` is Firefox and loads in place; `manifest.chrome.json` is assembled into
`dist-chrome/` by `tools/build-chrome.sh`). It proofreads web form fields with a local
Ollama model and rewrites a selection on demand (context menu / Alt+Shift+T).

**The extension ID stays `locaispell@lobianco.org`.** It predates the rename and is
invisible to users, but AMO ties every uploaded version to it — changing it would create a
second, unrelated add-on and abandon the listing. Do not "tidy" it.

User-facing docs are in `README.md`. This file is the things that are **not** obvious from
reading the code.

## Verify changes with

```bash
browser/test/run.sh                                    # 8 unit test files, node only
(cd browser && npx web-ext lint --self-hosted)        # must stay 0 errors / 0 warnings
```

`browser/test/README.md` has two browser harnesses (real extension, headless Firefox, fake Ollama).
`page.html` checks highlight geometry against independently measured DOM Ranges;
`page-transform.html` drives the transform panel and checks the text that actually lands in
the field. Use them for any change to `overlay.js`, `textmap.js`, `transform.js` or the
event handling in `content/main.js` — unit tests cannot see those bugs.

## Non-obvious constraints

**Ollama blocks browser extensions.** Firefox sends `Origin: moz-extension://<uuid>` and
Ollama answers 403 unless `OLLAMA_ORIGINS` allows it. Already configured on this machine via
`/etc/systemd/system/ollama.service.d/laita.conf`. A plain
`GET` carries no Origin and succeeds regardless — that is why `probe()` in
`background/ollama.js` deliberately ends with a POST to `/api/show`. Do not "simplify" it
back to a GET; it would report a healthy connection while every real check failed.

**Firefox here is a snap.** It cannot read anything under `/tmp`, so test profiles and
extension copies must be staged under `$HOME`. Snap AppArmor also blocks signals from
outside the snap, so scripts cannot kill leftover headless Firefox processes — the user has
to run `pkill -f testrun` themselves.

**Never `pkill -f <pattern>` when the pattern also appears in the command being typed** —
it matches the shell running it and kills the session. Kill by port (`fuser -k -n tcp N`) or
by PID instead.

## The LanguageTool server (`languagetool/`)

**It reuses `libreoffice/src/pythonpath/` rather than copying it.** Those modules import no
`uno`. `laita_lt_shared.py` is the only place that says where they are; `LAITA_SHARED_PATH`
overrides it. A second copy of `anchor.py`'s four guards would be a third place for them to
be wrong, which `doc/roadmap.md` already flags as this project's main risk.

**The client gives up after 10 seconds and it is not configurable.** LibreOffice core sets
`CURLOPT_TIMEOUT, 10L` in `lingucomponent/source/spellcheck/languagetool/languagetoolimp.cxx`,
and a paragraph takes this model 8–50 s. So a check must NEVER wait for the model: answer
from cache, or from `provisional()`, or with nothing, and let the model run behind. There is
no `PROOFREAD_AGAIN` on this path, so the answer is collected by the next keystroke instead
of appearing by itself. `test_server.py` asserts the no-waiting property directly; if a
change makes `check()` block, that is the one bug this design exists to prevent.

**One debounce timer per paragraph, not per server.** The extension's single pending slot is
right for one cursor and wrong for many: the protocol carries no session, document or user,
so two typists would cancel each other and the timer would fire only for whoever paused
last. `StreamDebouncer` asks `laita_engine.same_stream` whether two texts are one paragraph
an edit apart. It counts characters shared at **both ends** — a prefix-only key would treat
editing the start of a paragraph as a new person and fire a request per keystroke.

**`style` is sent as LanguageTool category `GRAMMAR`, and that is not a mistake.** The
reader picks the underline colour from `rule.category.id` through a fixed table — `TYPOS`
and `orth` red, `STYLE` blue, anything else orange — and there is no way to send a colour.
`GRAMMAR` is what makes a style suggestion the same orange it is in LibreOffice. Likewise
`rephrase` is sent as `STYLE` to get blue. `test_protocol.py` pins all three.

**Both `message` and `shortMessage` must be sent.** The reader loads `shortMessage` into
`aShortComment` and then overwrites it from `message`; sending only the former gives an
empty tooltip.

**`Checker` takes its model callable as a constructor argument (`ask=`).** `Engine` binds
the callable it is handed, so assigning `checker._ask_the_model` afterwards changes nothing
and a test doing that silently exercises the real Ollama instead of the fake. This was a
real bug in the first draft of `test_server.py`.

**An unknown key in the config file is fatal.** The extension degrades to defaults on
purpose — raising inside LibreOffice becomes a modal dialog on every keystroke — but a
server silently ignoring `chunkMaxChar` costs an afternoon. Settings that need a cursor are
refused with a message saying why.

## Design invariants — breaking these causes silent corruption

**A transform captures the selection as text offsets before its panel opens.** Focusing the
panel's input blurs the field: `selectionStart/End` survive that, a live DOM Range does not.
`EditableAdapter._offsetOf` is the inverse of `_point` and exists only for this. Before
applying, `accept()` re-checks that those offsets still hold the fragment the model was
given, and searches for it again if the page moved it — the same defence `anchor.js` gives
proofreading.

**Proofreading and transforming must not share a code path.** Proofreading is automatic,
returns anchored spans and never rewrites wholesale; a transform is explicit, covers exactly
the selected fragment and is not cached, queued or fingerprinted. The one thing they share
is the adapter, deliberately: `transform.js` reuses the instance `main.js` is driving
(`LAITA.getAdapter()`) rather than building a second layout mirror for the same `<textarea>`.

**The extension never names a `num_ctx` unless the user pinned one.** Ollama keys a
loaded model by its runtime options, so asking for the same model at a different context
size evicts whatever runner is resident and loads a second copy of the same weights -
which on a card that only just fits the model is a load failure waiting to happen, and
makes the extension impossible to run alongside Open WebUI or anything else. `runnerOptions`
is the single place that decides this, and proofreading and transforming must both use it:
a per-request context size, however well meant, defeats the whole point. An earlier
`transformNumCtx` widened the window for long selections and was removed for exactly that
reason; an oversized transform against a pinned window is now refused instead.

**An automatic check looks at one paragraph, an explicit one at the whole field.**
`checkScope` defaults to `"caret"`, and `runCheck` then sends only the chunk
`LAITA.chunkAtCaret` points at, keeping the issues found elsewhere via `LAITA.issuesOutside`.
Without this, focusing a long document queues one request per paragraph before the user
has typed a character, which is what made the extension unusable on a blog post. `force`
- the hotkey and the toolbar button - deliberately ignores the scope.

**The "already checked this" guard is keyed on text *and* range.** With a scoped check,
`lastCheckedText` alone would mean clicking into a second paragraph never checks it: the
text has not changed. `lastCheckedRange` holds the chunks that were looked at, or `ALL`
after a full sweep and after the two places that deliberately suppress a re-check
(`cancelCheck`, `applyIssue`). The guard also has to run *after* the scope is worked out
and *before* `generation` is bumped, or a duplicate check would cancel the one already in
flight.

**The background page has to be held open while a request is outstanding.** Firefox
unloads an MV3 background page after about 30 seconds without extension activity, and a
pending `fetch()` does not count. A model slower than that gets its request killed along
with the page, and the content script's waiting message is refused with "Receiving end
does not exist" - so the symptom is a connection error that only ever appears on long
text or a busy GPU, and never in a quick test. `holdOpen`/`releaseHold` in
`background/main.js` touch an extension API every 20 seconds while anything is in
flight, which resets that idle clock; `withRetry` is the single choke point that calls
them. An idle extension is still allowed to be unloaded, which is the point of the
counter. The `slow-request` harness step fails without this.

**A failed request is retried exactly once, and only when retrying can help.**
`isTransient` in `ollama.js` says which: 5xx and dropped connections yes; 403, 404, a
parse failure and our own aborts no. This exists because Ollama returns 500 when its model
runner fails to start, which is routine when the model only just fits in VRAM, and the
failed attempt is what triggers the load. Do not retry on abort: `withRetry` checks
`signal.aborted` both before and after the delay, or a cancelled check would come back.

**`describeError` lives in `ollama.js`, not in the background router**, so that it can be
unit tested. Its job is to turn transport failures into something the user can act on -
in particular a 500 mentioning `llama-server` becomes an explanation about VRAM rather
than a Go error string.

**`null` from `LAITA.send` means the message never reached the background page**, which is a
different failure from anything Ollama said, and must not be reported as "could not reach
the model". Two causes hide behind the same "Receiving end does not exist", and
`sendFailureKind` separates them: the background is an event page that may still be
waking, which one 250 ms retry covers; or the content script is *orphaned*, left behind in
an open tab by reloading the extension, in which case no retry will ever work and the user
must be told to reload the page. `LAITA.isOrphaned` reads `browser.runtime.id`, which is
gone in an orphan. Never retry an orphan - it only delays the one instruction that helps.

**Nothing may assume a Firefox-only API exists.** `common/compat.js` aliases `browser` to
`chrome` and exports `menus` (Firefox `menus`, Chrome `contextMenus`) plus
`canRefreshMenus`. `menus.onShown` and `menus.refresh` do not exist on Chrome, and calling
them at top level kills the service worker before it registers anything — so the menu
title is rewritten on open in Firefox and from tab events in Chrome. Chrome cannot be
driven by a script (137+ refuses `--load-extension`), so `chrome-compat.test.mjs` fakes
both API surfaces and boots the real background module; keep it passing, it is the only
automated thing standing between a Chrome release and a dead service worker.

**A per-site override beats the allowlist/denylist.** `siteOverrides` in
`common/settings.js` is checked first by `siteAllowed`, and is what the context menu,
`Alt+Shift+X` and the popup all write through the single `toggleSite` handler — they must
not go back to editing the lists, or "pause here" stops meaning paused. Matching is exact,
never by suffix: an override is set from one concrete tab's hostname.

**The status pill is click-through; only its × is not.** `.pill` keeps
`pointer-events: none` so that text underneath stays selectable and the caret still lands
where the user clicked, and `.pillx` opts back in. It is also positioned *outside* the
field by `LAITA.pillPosition` - it used to cover the words being typed. Do not move it back
inside or make the whole pill clickable.

**The pill's × stops the check, it does not merely hide it.** `cancelCheck` bumps
`generation` (which aborts the in-flight fetch in the background) and sets
`lastCheckedText` to the current text, so the next keystroke does not immediately restart
the work the user just stopped.

**Context menu titles must not repeat the extension name.** Firefox groups an extension's
items under a submenu named after the extension, so a title of "LAITA transform…"
reads as "Local AI Text Assistant > LAITA transform…". They are bare verbs for that
reason.

**The transform panel swallows key events.** Sites bind single-letter shortcuts, and a
closed shadow root still lets events bubble out retargeted to the host, so `panel()`
stops `keydown`/`keyup`/`keypress` propagation. Removing that makes typing an instruction
trigger the page underneath.

**The model also abbreviates its own answer.** Asked to add a comma to a long sentence
it replied with the sentence's opening followed by "...", and applying that deleted the
rest of the paragraph. `looksTruncated` in `anchor.js` drops a replacement carrying an
ellipsis the original lacks, and one less than half the length of a quote of 60
characters or more. Both signs of elision rather than editing. A replacement that is
visibly not a drop-in must never be applied: the cost of a wrong drop is a missed
suggestion, the cost of a wrong apply is destroyed text.

**The model also quotes short.** Asked about a sentence that already ends in a full
stop, it answers original "English", replacement "English." - complaining of punctuation
that is already there, which applied gives "English..". `alreadyThere` in `anchor.js`
drops any suggestion whose replacement merely wraps the quote in characters the document
already has on that side. Same principle as dropping an unfindable quote: never trust
the model's view of the text over the text.

**The model quotes, it never counts.** The prompt asks for a verbatim substring, never an
offset. `background/anchor.js` locates the quote, tolerating curly quotes, collapsed
whitespace and (last resort) case, and *drops* anything it cannot find. This is what stops a
hallucinated quote from mangling the user's text. Never trust an offset from the model.
`anchor.js` also re-reads `original` from the document rather than keeping the model's copy.

**Events from the closed shadow root retarget to the host.** The document-level capture
listeners in `content/main.js` must call `LAITA.Overlay.isOurs(e.target)` and bail, or they
tear the card down before its own buttons can fire. This was a real bug.

**`applyFix` dispatches `input` synchronously**, and the `input` handler re-anchors the
remaining issues by searching for their text. So `applyIssue` must *not* also shift offsets
by the length delta — that double-shifts them. Retire the applied issue from the list before
calling `applyFix`, and let re-anchoring do the rest. Also a real bug.

**`data-laita="off"` is set on the overlay host in `overlay.js` and read by `isCheckable`
in `textmap.js`.** They must be renamed together or the extension starts proofreading its
own suggestion card. `isCheckable` also honours the pre-rename `data-locaispell="off"`,
because users were told to put it on their pages and a rename must not silently switch
their proofreading back on.

**The overlay is `pointer-events: none`** and clicks are matched against the rectangles it
drew. That is deliberate: it keeps caret placement and text selection exactly as the page
intended. Do not make decorations clickable.

**Highlights are kept when focus moves to a non-checkable element** (a button, a link), and
only torn down when another real field is focused. A test showing leftover decorations after
focusing an excluded field is therefore expected — check the count of `POST /api/chat`
requests instead to prove a field was never read.

## Geometry

`<textarea>`/`<input>` have no DOM for their text, so `InputAdapter` lays the same string
out in a hidden mirror div copying the field's typography, and reads rectangles from that.
Verified pixel-exact against a contenteditable with identical font and padding: both gave
`left 85, w 52` for the same word. If highlights drift on some site, the mirror is probably
missing a CSS property — add it to `MIRROR_PROPS`.

`contenteditable` uses a real text-node map (`EditableAdapter`), with `\n` inserted at block
boundaries and `<br>`.

## Performance

10–30s per paragraph with `qwen3.5:9b` on this machine, longer under GPU contention (a
one-token reply took 14.5s while the GPU was busy). Hence paragraph-level chunking, an LRU
cache of raw model output keyed by content, and re-checking only changed paragraphs. The
cache stores *raw* responses so that changing the ignore list needs no invalidation.

## Conventions

- Content scripts share one sandbox global: `var LAITA` in `common.js`, visible to the files
  listed after it in the manifest. They are classic scripts, not modules.
- Background, options and popup are ES modules and import `common/settings.js`.
- Settings live in exactly one place: `DEFAULTS` in `src/common/settings.js`.
- Bump `PROMPT_VERSION` in `background/ollama.js` whenever the *proofreading* prompt
  changes; it is part of the cache key, so stale entries are discarded automatically. The
  transform prompt needs no version: transform results are never cached.
- Content scripts reach the transform only through `main.js`'s single
  `runtime.onMessage` listener. Do not add a second listener: an `async` listener always
  returns a promise, and a second one would answer for messages meant for the first.
