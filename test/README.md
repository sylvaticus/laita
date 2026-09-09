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
