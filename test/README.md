# Tests

## Unit tests

```bash
./test/run.sh
```

No dependencies beyond node. `anchor.test.mjs` covers the correctness-critical part: turning
the model's quoted substrings into exact offsets, tolerating curly quotes, collapsed
whitespace and case, dropping quotes that cannot be found, and resolving overlapping
suggestions by priority. `segment.test.mjs` covers paragraph/sentence chunking and checks
that every chunk's recorded offset still indexes its own text.

## Browser harness

This is what caught the two real bugs during development (shadow-host event retargeting,
and double-shifting offsets after applying a fix). It runs the real extension in a real
headless Firefox against a fake Ollama, and reports what it observed back to the terminal.

It needs three temporary edits, so work on a **copy** of the extension, never the source:

```bash
SRC=$(pwd)
RUN=~/locaispell-testrun            # must be under $HOME: see the snap note below
rm -rf $RUN && mkdir -p $RUN/prof && cp -r $SRC $RUN/ext

# 1. point at the mock, speed up the debounce
sed -i 's|endpoint: "http://localhost:11434"|endpoint: "http://localhost:11499"|;
        s|model: "qwen3.5:9b"|model: "mock:test"|;
        s|debounceMs: 1500|debounceMs: 400|' $RUN/ext/src/common/settings.js
# 2. let the harness page see inside the overlay
sed -i 's/mode: "closed"/mode: "open"/' $RUN/ext/src/content/overlay.js
# 3. don't steal the tab on install
sed -i 's|if (reason === "install") browser.runtime.openOptionsPage().catch(() => {});|if (reason === "install") {}|' \
       $RUN/ext/src/background/main.js
```

If you are testing the **transform** panel, make a fourth edit — page script cannot open a
context menu, so the harness needs a way in:

```bash
sed -i 's|^LAS.Transform = {|document.addEventListener("las-test-transform", () => LAS.Transform.open());\nLAS.Transform = {|' \
       $RUN/ext/src/content/transform.js
```

The pill steps also need a way to start a check without the hotkey, and the page needs to
know the content script is actually there - Firefox reloads the tab once while shutting
down, by which point the extension is gone, and without the marker that second run throws
its way through every step and buries the real results:

```bash
sed -i 's|^  // ---------------------------------------------------------------- boot|  document.documentElement.dataset.lasAlive = "1";\n  document.addEventListener("las-test-check", () => runCheck(true));\n  document.addEventListener("las-test-check-auto", () => runCheck(false));\n  document.addEventListener("las-test-clear", () => LAS.send({ cmd: "clearSiteOverrides" }));\n\n  // ---------------------------------------------------------------- boot|' \
       $RUN/ext/src/content/main.js
```

and use `triggerMode: "manual"` in edit 1, so that automatic proofreading does not put its
own requests in the log:

```bash
sed -i 's|triggerMode: "auto"|triggerMode: "manual"|' $RUN/ext/src/common/settings.js
```

Also add the offset hook at the top of `paint()` in `$RUN/ext/src/content/main.js`, which is
what lets the page audit the internal anchoring:

```js
document.documentElement.dataset.lasIssues =
  JSON.stringify(issues.map((i) => ({ s: i.start, e: i.end, o: i.original, t: i.type })));
```

Then run it:

```bash
cp $SRC/test/browser/page.html $RUN/
PORT=11499 PAGE=$RUN/page.html LOGFILE=/tmp/requests.json \
  node $SRC/test/browser/mock-ollama.mjs &

cd $RUN && MOZ_HEADLESS=1 timeout 60 web-ext run \
  --source-dir $RUN/ext --firefox=/usr/bin/firefox \
  --firefox-profile $RUN/prof --keep-profile-changes \
  --start-url "http://localhost:11499/page.html" --no-input --no-reload

python3 -c "
import json
for e in json.load(open('/tmp/requests.json')):
    if e['url'] == '/api/beacon':
        b = json.loads(e['bodyPreview']); print('STEP', b['step'], '->', json.dumps(b['data']))
    else:
        print('REQ ', e['method'], e['url'], 'origin=', e['origin'])
"
```

### The transform harness

Same procedure, with `page-transform.html` instead of `page.html`. The mock answers a
transform request — recognisable because it carries no `format` — by echoing the fragment
with every `e` turned into `E`, wrapped in a preamble and quotation marks that the
extension is expected to strip. The page can therefore predict the exact text that should
end up in the field.

```bash
cp $SRC/test/browser/page-transform.html $RUN/page.html
```

Every beacon must report `true`:

- `textarea-replace`: `shownMatchesMock` proves the model was sent exactly the selected
  substring, and `valueCorrect` that only that substring changed.
- `textarea-append`: `valueCorrect` — the original is still there, the result follows it
  after a single space.
- `contenteditable-replace`: `sentFragmentCorrect` is the one that matters. It fails if
  `EditableAdapter._offsetOf` maps the DOM Range to the wrong offsets, which is the way
  this feature would silently corrupt text.
- `plain-text`: `offersCopyOnly` and `pageUnchanged` — a non-editable selection must never
  be written to.
- `escape`: the panel closes; `no-selection`: it never opens.
- `clear-overrides-then-check` and `idle-background`: both send a check into a moment
  when the background might not answer - straight after a storage write that broadcasts
  to every tab, and after Firefox has unloaded the event page. Both must paint highlights
  with no error pill. The second needs the idle timeout lowered, or the wait would be
  minutes:

  ```
  --pref extensions.background.idle.timeout=4000
  ```

  Neither reproduced the "Receiving end does not exist" seen in the wild; they are kept
  because they pin down two things that plausibly could have caused it and do not.
- `caret-scope`: a four-paragraph field with the caret in the second. Exactly one
  `/api/chat` must go out and it must contain that paragraph. Drive it with
  `las-test-check-auto`, not `las-test-check` - the latter forces a check, and a forced
  check is supposed to sweep the whole field.
- `slow-request`: the one that matters most. The mock takes 45 seconds over any text
  containing `SLOWME`, longer than Firefox's 30 second background idle timeout, so the
  step fails unless something is holding the background page open. Run this against the
  real timeout - do not lower `extensions.background.idle.timeout` for it - and give
  web-ext a generous `timeout`, since this step plus `idle-background` wait 80 seconds
  between them.
- `retry-after-500`: the mock fails the first request whose text contains `RETRYME` with
  the 500 Ollama returns when its runner will not start, then succeeds. Highlights must
  still appear and `noErrorPill` must hold: one failed model load is meant to be invisible.
- `pill-cancel`: `clearOfTheText` is the regression guard — the pill must sit below the
  field, not on top of the words. `decosAfterCancel: 0` proves the × abandoned the check
  rather than only hiding the pill, and `pill-completes` must then report `decos: 2` for
  the same field, so that a zero above means something. Run the mock with
  `CHAT_DELAY_MS=3000` for these two: it slows proofreading only, leaving transforms
  instant, so there is a pill to catch mid-flight.
- Every `/api/chat` must show `format=False`: with `triggerMode: "manual"` there should be
  no proofreading requests at all.

### What to look for

- `audit` entries must all be `"ok": true` — every highlight's recorded span still holds its
  own text, both before and after applying a fix.
- The contenteditable `decos` must match `truth` exactly; `truth` is measured independently
  with a DOM Range, so any drift means the geometry code is wrong.
- Exactly the expected number of `POST /api/chat` requests, and **none** whose text comes
  from the opted-out textarea or the password field.
- `origin=` on those requests shows `moz-extension://…`, which is why `OLLAMA_ORIGINS` is
  required (README §2).

### Gotchas on this machine

- **Firefox is a snap.** It cannot read anything under `/tmp`, so the profile, the extension
  copy and the page must all live under `$HOME`, or Firefox exits with "Could not find
  profile folder".
- **Snap AppArmor blocks signals from outside the snap**, so leftover headless Firefox
  processes cannot be killed by scripts. Clear them yourself with `pkill -f testrun`.
- Never `pkill -f` a pattern that also appears in the command you are typing — it matches
  your own shell and kills it.
