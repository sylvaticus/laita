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

**"Editing" means the text CHANGED, not that it matched.** Closing a document and
reopening it offers every paragraph again, unchanged, and each one matches the stream
remembered from the previous session — so a reopen swept the whole document, which is
exactly what `scope: "typed"` exists to prevent. Somebody typing produces a text that is
similar but DIFFERENT; a re-display produces one that is identical. `StreamDebouncer.note`
returns `editing`, not `known`, for that reason.

**Only paragraphs somebody is editing are sent to the model (`scope: "typed"`).** The
client offers every paragraph of a document at once on open; under `"document"` each is a
model call, so typing on page five queued the answer behind fifty paragraphs. There is no
caret in this protocol and no document id — the only evidence is that an edited paragraph
arrives repeatedly, a character apart, which is the same question `laita_engine.same_stream`
already answers for the debounce. First sightings are remembered but unarmed, so the first
keystroke in a paragraph is recognised without a round trip. Known limitation, tested: near
identical paragraphs read as edits of one another and degrade towards checking everything,
which is the safe direction.

**Answer immediately if there is anything to answer with; wait only when there is not.**
The order in `Checker.check` is the whole design and both halves were measured against a
real Collabora. Waiting only when the cache missed but a previous answer existed made every
answer arrive ~3 s after the keystroke that asked for it; by then the paragraph had moved
on and **no underline appeared at all**, though the log showed matches going out on every
request. A result describing text the user has already edited is no result. Answering in
0 ms from `provisional()` put them back. Do not reorder these.

**A check must wait for the model when it has nothing at all, within a budget.** The
first version did not wait, reasoning as the extension does: answer empty, fill the cache,
let the next keystroke collect it. Measured against a real Collabora that is worthless — 75
checks, 25 answered `queued`, **not one match ever delivered** — because the client stops
asking when the user stops typing and there is no `PROOFREAD_AGAIN` here to tell it
otherwise. The last check of a paragraph is the one that matters and the one with no answer
yet. Do not "restore" the non-blocking version; `waitMs: 0` is kept for a client that polls.

Waiting is safe for two measured reasons, and both must hold: LibreOffice never proofreads
one document concurrently (`doc/roadmap.md`), so the call throttles that document rather
than queueing behind itself; and the 8–50 s figures were a throttling laptop GPU, where a
server with the model resident answers in 0.7–2.2 s.

**The budget is a hard promise.** `CURLOPT_TIMEOUT, 10L` is compiled into the client
(`lingucomponent/source/spellcheck/languagetool/languagetoolimp.cxx`). `waitMs` is capped at
9000 and must exceed `debounceMs` — it spans the debounce *and* the model, so a smaller
budget means every check times out empty, which is the failure the wait was added to fix.
Config refuses it at startup. `test_server.py` asserts the budget is never overrun, against
a model that never answers at all.

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

**Never ask the model about the word being typed, and never let a quote match inside a
word.** `laita_lt_typing.py`, and both halves were paid for by one measured session: the
model was asked about `...I would wish that  I can spea`, reported "Missing letter 'k' and
incomplete word" quoting the fragment, and that answer - cached and reused while the next
computed - matched inside a correctly spelled `speak` EARLIER in the same sentence, offering
to replace a good word with itself. `anchor.py`'s `already_there` covers the shapes where
the replacement contains the quote; `I can spea -> speak` is not one of them. The word
guard is the load-bearing one, because it is what makes a stale cached answer safe against
edited text. It must stay script-aware: in Japanese, Chinese and Korean every character
abuts another, and a naive test would reject every suggestion in those languages.

**Translation must never return an empty string.** Core pastes the reply over the user's
selection with `SwTransferable::Paste`, and pastes an empty string when the request fails —
a reported bug in the real DeepL integration. So every failure path in `Checker.translate`
and its handler returns the ORIGINAL text with HTTP 200: model down, whitespace answer,
exception, missing target language, wrong `auth_key`, feature switched off. A 4xx would
make core paste nothing, so there are none. A wrong key costs a model call, not a
paragraph. Core sets no timeout on this call (`// todo add timeout`), so nothing here has
to be fast.

**The model is never shown markup on the translate path.** The selection arrives as HTML;
block tags pass through and inline tags are dropped, so the model only ever sees and writes
text. It cannot then invent, drop or reorder a tag — and this path PASTES, so a mangled tag
is damage rather than a bad suggestion. Its output is HTML-escaped on the way out for the
same reason. Translation also does not go through the `Engine`: proofreading and
transforming do not share a code path anywhere in LAITA.

**The guards are in `languagetool/`, not in `laita_anchor.py`, deliberately.** That file is
a transcription of `browser/src/background/anchor.js` and the two are tested against each
other. A guard added to one and not the other breaks the parity. If this proves right, it
belongs in the JavaScript first and in the port after — the browser and VS Code have the
same latent bug through their own `provisional`.

**`install.sh` must `systemctl restart`, not `enable --now`.** `--now` starts a stopped
service and does nothing at all to one already running, so a reinstall left the old process
serving the old code while every file on disk said the fix was deployed. That cost a whole
debugging round: the symptom was the fix "not working".

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

**The model hands its own fence back.** Usually the closing marker alone on a line, and
sometimes without its `>>>`. Observed as `Hello world\nTEXT_3082eae76f9d` from a
translation, which was then pasted into the document; neither `cleanTransformOutput` nor
its port stripped it, so it had been reaching browser and VS Code transforms too, just less
visibly. `FENCE_ECHO`/`_FENCE_ECHO` removes any line that is only `TEXT_<hex>`, in both
ports, with the cases in both halves of the parity list.

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

**The answer cache is sized in megabytes, not in a round number.** `CACHE_MAX` was 200,
which is about a quarter of a megabyte and threw away answers still worth having. Measured
with tracemalloc against realistic content: **2.2 KB** for a typical prose paragraph of
~550 characters with three issues, 4.3 KB for a long one, 0.7 KB for a short one. The
default of 20000 is therefore ~45 MB, roughly double that if every paragraph is long. It is
a setting on all four surfaces (`cacheMax`, `laita.cacheMax`, `CacheMax`, `--cache-max`)
and `Engine.cache_max` is a public attribute because the caller re-reads its settings as
they change.

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
