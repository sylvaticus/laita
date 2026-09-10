# Local AI Spell Checker

A Firefox extension that proofreads what you type into web forms, using a model running
locally in **Ollama**. It works like [Harper](https://writewithharper.com/) or
LanguageTool, but the judgement comes from an LLM rather than from hand-written rules, so
it handles style and phrasing as well as hard grammar errors, and it works in any language
the model knows.

Three kinds of problem are reported, each with its own colour:

| Colour | Category | What it means |
| --- | --- | --- |
| 🔴 red | **error** | Objectively wrong: spelling, agreement, conjugation, punctuation, wrong preposition. |
| 🟡 yellow | **style** | Not wrong, but weak: wordiness, redundancy, needless passive, repetition. |
| 🔵 blue | **rephrase** | A better word or a more natural formulation. |

Alongside the proofreader there is a second, deliberately manual tool: select any text,
right-click, and **Locaispell transform…** rewrites it however you ask — *polish*,
*translate to French*, *shorten it*. See [§3](#transforming-a-selection).

The language of each field is detected automatically (English and French are the tuned
cases; Italian, Spanish, German, Portuguese and Dutch are also recognised), or you can pin
one language in the options.

**Nothing leaves your machine.** The only network destination is your own Ollama endpoint.

---

## 1. Requirements

- Firefox 142 or newer
- [Ollama](https://ollama.com) running locally, with a model pulled:
  ```bash
  ollama pull qwen3.5:9b
  ```

A 7–9B instruction model is the sweet spot. `qwen3.5:9b` was used to develop this and
gives good results in both English and French. Smaller models are faster but miss more and
invent more.

**Expect roughly 10–30 seconds per paragraph** on a mid-range GPU, and considerably longer
if something else is already using the GPU. That is why Local AI Spell Checker checks paragraph by
paragraph, caches every result, and only re-sends paragraphs you actually changed: a long
message is checked once, and editing its last line re-checks one paragraph, not the whole
thing. If it still feels slow, lower *maximum chunk size*, turn off the *rephrase*
category, or move to a smaller model.

---

## 2. Install

### Step 1 — let Ollama accept requests from the extension  ⚠️ required

Ollama rejects requests whose `Origin` is a browser extension unless you allow it
explicitly. Firefox **does** send `Origin: moz-extension://…`, so without this step every
check fails with an error. Add a systemd drop-in:

```bash
sudo mkdir -p /etc/systemd/system/ollama.service.d
printf '[Service]\nEnvironment="OLLAMA_ORIGINS=moz-extension://*"\n' \
  | sudo tee /etc/systemd/system/ollama.service.d/locaispell.conf
sudo systemctl daemon-reload
sudo systemctl restart ollama
```

This is a separate file, so it will not disturb any drop-in you already have.

Check it worked — you want anything except `403`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:11434/api/show \
  -H 'Origin: moz-extension://test' -H 'Content-Type: application/json' \
  -d '{"model":"qwen3.5:9b"}'
```

> **On the wildcard.** `moz-extension://*` lets *any* Firefox extension you have installed
> reach Ollama. To be stricter, install Local AI Spell Checker first, open `about:debugging` and copy its
> internal UUID, then use `OLLAMA_ORIGINS=moz-extension://<that-uuid>` instead. Note that a
> temporarily-loaded extension gets a fresh UUID every time Firefox restarts, so the
> wildcard is the practical choice until you install Local AI Spell Checker permanently (§6).

If you do not use systemd, set `OLLAMA_ORIGINS="moz-extension://*"` in the environment of
whatever starts `ollama serve`.

### Step 2 — load the extension

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…**
3. Pick the `manifest.json` file in this folder

Local AI Spell Checker's options page opens automatically the first time. A temporary add-on is removed
when Firefox restarts — see §6 to make it permanent.

### Step 3 — check the connection

On the options page press **Test connection**. You should see
*"Connected. N models available, "qwen3.5:9b" is one of them."*

That test deliberately performs a `POST`, because a plain `GET` carries no `Origin` header
and would report success even while real checks were being refused.

---

## 3. Using it

Click into any text box and type. Roughly 1.5 seconds after you stop, the text is checked
and problems get a coloured wavy underline. A small pill in the corner of the field shows
progress.

- **Click a highlight** to open a card with the explanation and the suggested text.
  - **Apply** — replaces just that span. Your undo history (`Ctrl+Z`) still works.
  - **Dismiss** — hides this one for now.
  - **Never suggest** — remembers the suggestion and never offers it again.
  - **Add to dictionary** — for a single word, adds it to your personal dictionary.
- **Alt+Shift+C** — check the focused field immediately.
- **Alt+Shift+X** — turn Local AI Spell Checker off (or back on) for the current site.
- The **toolbar button** shows the issue count, the connection status, and per-site and
  global on/off switches.

Both plain `<textarea>` / `<input>` fields and rich `contenteditable` editors (webmail,
wikis, most WYSIWYG editors) are supported.

### Transforming a selection

Proofreading suggests small fixes and never rewrites wholesale. When you *want* a rewrite,
select the text, right-click and choose **Locaispell transform…** (or press
**Alt+Shift+T**).

A one-line box opens. Type what you want done and press Enter:

| You type | You get |
| --- | --- |
| *(nothing)* | the default instruction, `polish` — change it in the options |
| `translate to French` | the same passage in French |
| `shorten it` | a tighter version |
| `make it more formal` | register changed, meaning kept |
| `turn into bullet points` | the passage restructured |

`↑` and `↓` recall your recent instructions. `Esc` cancels — including while the model is
still working, which aborts the request.

The result appears in a panel with three choices:

- **Accept & replace** — the selection becomes the new text. This is the default: the
  button already has focus, so Enter takes it.
- **Reject** — nothing changes.
- **Accept & append** — the new text is inserted *after* the selection, which keeps the
  original. A space is added between them, or a blank line if either side spans more than
  one line.

`Ctrl+Z` undoes an accepted transform like any other edit.

Selecting text that is **not** in an editable field still works — a paragraph of an
article, say — but since there is nothing to replace, the panel offers **Copy** instead.

Two things worth knowing:

- The instruction is free text sent to the model as-is, so anything the model understands
  works. The prompt forbids commentary, so you get the rewritten passage and nothing else.
- Unlike proofreading, a transform is never automatic and ignores the per-site switch: you
  asked for it explicitly, so it runs wherever you ask for it.

### What Local AI Spell Checker will not touch

Passwords, payment fields, one-time codes, and any field whose type, `autocomplete`, name,
id, placeholder or class hints at a secret are skipped outright — they are never read and
never sent anywhere. Fields shorter than 12 characters are ignored too.

To exclude anything else, add `data-locaispell="off"` to it or to any ancestor.

---

## 4. Options

Open them from the toolbar popup, or from `about:addons` → Local AI Spell Checker → Preferences.

| Setting | Default | Notes |
| --- | --- | --- |
| Ollama endpoint | `http://localhost:11434` | |
| Model | `qwen3.5:9b` | The field autocompletes from your installed models. |
| Temperature | `0` | Keep at 0 for repeatable corrections. |
| Context window | `4096` | Per request; raise only for very long chunks. |
| Parallel requests | `2` | How many paragraphs are checked at once. |
| Keep model loaded for | `10m` | Avoids a slow reload on every check. |
| Allow the model to "think" | off | Reasoning traces make checks several times slower. |
| Trigger | automatic | Or manual only, via `Alt+Shift+C`. |
| Typing pause | `1500 ms` | |
| Ignore fields shorter than | `12` characters | |
| Maximum chunk size | `700` characters | Longer paragraphs are split on sentence boundaries. |
| Language | detect | Or pin one. |
| Categories and colours | all on | Turn off a category to stop paying for it. |
| House style rules | empty | Free text appended to the prompt, e.g. *"Prefer British spelling."* |
| Personal dictionary | empty | One word per line, never flagged. |
| Sites | run everywhere | Or switch to an allowlist. |
| Default transform instruction | `polish` | What an empty transform prompt means. |
| Recent instructions | empty | The ↑/↓ history in the transform box; editable here. |

---

## 5. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| *"Ollama refused the request because it came from a browser extension"* | Step 1 was skipped, or Ollama was not restarted after it. |
| *"Cannot reach Ollama"* | `ollama serve` is not running, or the endpoint is wrong. Try `curl http://localhost:11434/api/tags`. |
| *"Ollama does not have that model"* | `ollama pull <model>`. |
| *"The request to Ollama timed out"* | The model is slow to load, or too large for the machine. Raise the timeout, or use a smaller model. |
| Nothing happens at all | The site may be disabled (check the toolbar popup), the field may be too short, or it may look like a password field. |
| Highlights sit slightly off | Report it — the field probably uses a layout the mirror does not yet copy. |
| Checks feel slow | Lower *maximum chunk size*, turn off the *rephrase* category, or use a smaller model. The first check after an idle period also pays for reloading the model. |

Turn on **Log debug output to the page console** in the options to see what Local AI Spell Checker is
doing, then open the web console on the page (`Ctrl+Shift+K`).

---

## 6. Signing, and the two different "IDs"

### The extension ID is already permanent

`browser_specific_settings.gecko.id` in `manifest.json` is `locaispell@lobianco.org`.
**That is the permanent ID, and signing does not change it.** It is what addons.mozilla.org
(AMO) ties every future version to, so never change it once you have uploaded anything —
changing it would create a second, unrelated add-on.

Do not confuse it with the **internal UUID**, the `moz-extension://<uuid>` part that Ollama
sees. That one is generated randomly *per Firefox profile* and is not something you choose.
It is stable once the add-on is permanently installed in a profile, but it differs on every
machine and profile, so it is not usable as a public identifier. It matters only if you want
to tighten `OLLAMA_ORIGINS` (below).

### Sign an unlisted build

Unlisted means self-distribution: Mozilla signs it so Firefox will install it permanently,
but it is not published in the add-ons directory and gets only automated review, usually
within a few minutes.

```bash
npm install --global web-ext
```

1. Sign in at <https://addons.mozilla.org/developers/> with a Firefox Account.
2. Create API credentials at
   <https://addons.mozilla.org/developers/addon/api/key/>. You get a JWT **issuer** and a
   **secret**. Treat the secret like a password — never commit it.
3. Bump `version` in `manifest.json`. **Every upload needs a version that has never been
   used before**, or AMO rejects it.
4. Sign:

```bash
export WEB_EXT_API_KEY='user:12345678:123'      # the issuer
export WEB_EXT_API_SECRET='...'                 # the secret
web-ext sign --channel=unlisted
```

The signed file lands in `web-ext-artifacts/`. Install it permanently with
`about:addons` → gear icon → **Install Add-on From File…**. It now survives restarts.

`web-ext-config.cjs` keeps `test/`, the README and other development files out of the
package, so what you sign is only what the extension actually needs.

Unlisted add-ons do **not** update themselves. If you want that later, host an update
manifest and point `browser_specific_settings.gecko.update_url` at it; until then, signing a
new version and installing the new `.xpi` is the upgrade path.

### Optional: restrict Ollama to just this extension

With the add-on permanently installed, its UUID stops changing, so you can replace the
wildcard from §2 with the exact origin:

1. Open `about:config`, search for `extensions.webextensions.uuids`.
2. Find `locaispell@lobianco.org` in the JSON and copy its UUID.
3. Put `OLLAMA_ORIGINS=moz-extension://<that-uuid>` in the drop-in file and restart Ollama.

Now no other extension can reach Ollama. Remember it is per profile: a second Firefox
profile, or another machine, will have a different UUID and will need its own entry (the
variable accepts a comma-separated list).

### When you want to make it public

The same ID carries over — a listed version is just another version of the same add-on, so
nothing you sign now is wasted. Before submitting to the listed channel:

- [ ] Fill in `author` and `homepage_url` in `manifest.json`.
- [ ] Choose a licence and add a `LICENSE` file.
- [ ] Prepare listing assets: a PNG icon (128px or larger — the current icon is an SVG,
      which Firefox accepts but the AMO listing page wants a raster version), one or two
      screenshots, a summary and a description.
- [ ] Re-read the permission story. A listed add-on gets **human** review, and this one asks
      for `<all_urls>` and reads what the user types, so expect scrutiny. In your favour:
      everything stays on the user's machine, the manifest already declares
      `data_collection_permissions: { "required": ["none"] }`, and password and payment
      fields are excluded in code. Keep all three statements true.
- [ ] Decide what happens for users without Ollama — right now the extension simply reports
      that it cannot connect, which is honest but abrupt for someone who installed it from a
      directory listing.

Submit with `web-ext sign --channel=listed`, or upload the same `.xpi` through the AMO web
interface, which is easier the first time because it walks you through the listing fields.

### Testing without signing at all

`about:debugging` → **Load Temporary Add-on…** installs an unsigned build instantly, and it
disappears when Firefox restarts. That is the fastest loop while developing, and it is what
§2 describes. Firefox Developer Edition, Nightly and ESR can also install unsigned builds
permanently after setting `xpinstall.signatures.required` to `false` in `about:config`;
release Firefox ignores that setting.

## 7. How it works

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

- **The model quotes, it does not count.** LLMs are bad at character offsets, so the prompt
  asks for the *verbatim substring* to change. `src/background/anchor.js` locates that
  quote in the text (tolerating curly quotes, collapsed whitespace and, as a last resort,
  case), discards anything it cannot find, and resolves overlapping suggestions by priority.
  This is what stops a hallucinated quote from corrupting your text.
- **The overlay never intercepts input.** It is `pointer-events: none`, and clicks are
  matched against the rectangles it drew. Caret placement and text selection stay exactly
  as the page intended.
- **Only changed paragraphs are re-checked.** Results are cached per chunk, so editing the
  last paragraph of a long message does not re-check the whole thing.
- **Highlights follow your edits.** After every keystroke the spans are re-anchored against
  the current text, so they shift with the text instead of drifting until the next check.

### Layout

```
manifest.json
src/common/settings.js       defaults, storage, per-site rules
src/background/main.js       message router, cache, queue, cancellation, badge
src/background/ollama.js     prompt construction, transport, response parsing
                             (both the proofreading and the transform prompt)
src/background/anchor.js     quotes → exact offsets; the correctness-critical part
src/content/common.js        shared state, language detection, re-anchoring
src/content/segment.js       paragraph and sentence chunking
src/content/textmap.js       field adapters (mirror geometry, text-node mapping)
src/content/overlay.js       shadow-DOM layer, wavy underlines, hit-testing
src/content/card.js          the suggestion card
src/content/transform.js     "Locaispell transform…": the instruction box and its panel
src/content/main.js          orchestration
src/options/, src/popup/     UI
test/                        unit tests + browser harness (see test/README.md)
web-ext-config.cjs           keeps development files out of the signed package
```

### Development

```bash
./test/run.sh           # unit tests, node only, no dependencies
npm install --global web-ext
web-ext lint            # 0 errors, 0 warnings expected
web-ext run             # launches a scratch Firefox with the extension loaded
```

`test/README.md` also describes a browser harness that runs the real extension in headless
Firefox against a fake Ollama and checks the highlight geometry against independently
measured positions. It is more setup than the unit tests, but it is the only thing that
catches overlay and event-handling bugs.

---

## Licence

MIT — see [LICENSE](LICENSE).
