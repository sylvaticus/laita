# <img src="assets/imgs/laita_logo_h100.png" width="200" align="middle" />&nbsp;&nbsp;  <u>Local</u> AI Text Assistant


A **multi-app** extension that **proofreads what you type** and **rewrites the text you select** (_polish_, _translate_, _summarize_...), using any model running locally on your machine via [Ollama](https://ollama.com).

Differently from integrated spellcheckers or apps like [Harper](https://writewithharper.com/), the judgement comes from an LLM rather than hand-written rules, so it handles style and phrasing as well as hard grammar errors, and it works in any language the model knows.

**Nothing leaves your machine**, as long as Ollama is running locally on a local model — the default, and the only thing LAITA ever talks to. See [Privacy](#6-privacy) for what that depends on.

The **Firefox extension** is the most exercised; the **Chrome extension** works and has been used by hand, though one detail of its background lifetime is still unverified (see [`doc/roadmap.md`](doc/roadmap.md)); the **VS Code extension** is newer. A **LibreOffice** port is on its way.

**[What it does](#1-what-it-does) · [Install](#2-install) · [Using it](#3-using-it) · [Options](#4-options) · [Troubleshooting](#5-troubleshooting) · [Privacy](#6-privacy) · [Development](#7-development) · [Licence](#8-licence) · [Acknowledgements](#9-acknowledgements)**

---

## 1. What it does

_(the following screenshots are based on the Firefox extension)_ 

### Catches mistakes as you type

Problems get a coloured wavy underline. Click one for the explanation and the fix.

![An error highlight: the card explains "Use 'I' instead of 'me' as the subject" and offers to replace "me" with "I"](assets/imgs/screenshot_laita_firefox5.png)

Three kinds of problem, each with its own colour:

| Colour | Category | What it means |
| --- | --- | --- |
| 🔴 red | **error** | Objectively wrong: spelling, agreement, conjugation, punctuation, wrong preposition. |
| 🟡 yellow | **style** | Not wrong, but weak: wordiness, redundancy, needless passive, repetition. |
| 🔵 blue | **rephrase** | A better word or a more natural formulation. |

![A rephrase suggestion: "too well english" becomes "very well English"](assets/imgs/screenshot_laita_firefox4.png)

Each card offers **Apply**, **Dismiss**, **Never suggest** — and **Add to dictionary** when
the text is a single word.

### Rewrites a selection however you ask

Select text, right-click, and pick **Transform…**:

![The Firefox context menu showing the Local AI Text Assistant submenu with "Transform…" and "Pause spell check on this site"](assets/imgs/screenshot_laita_firefox3.png)

Type what you want done with it. Press Enter on an empty box for the default, `polish`:

![The transform box, a single line containing the word "polish", with the hint "Enter to run · Esc to cancel · ↑ ↓ for recent"](assets/imgs/screenshot_laita_firefox2.png)

The result can replace the selection, be inserted after it, or be thrown away:

![The transform result: "Sorry, me don't speak too well english." rewritten as "Sorry, I don't speak English very well.", with buttons Accept & replace, Reject, Accept & append](assets/imgs/screenshot_laita_firefox1.png)

`translate to French`, `shorten it`, `make it more formal`, `turn into bullet points` — the instruction is free text, so anything the model understands works.

The language of each field is detected automatically (English and French are the tuned cases; Italian, Spanish, German, Portuguese and Dutch are also recognised), or you can pin one language in the options.

> [!WARNING]
> Text is not sanitized before being sent to your Ollama running model. Use it only with text you trust and on non-agentic models.

---

## 2. Install

- [Install Ollama](#21-install-ollama)
- [Pull a model](#22-pull-a-model)
- [Let Ollama talk to the extension  ⚠️ required](#23-let-ollama-accept-requests-from-the-extension---required)
- [Install the extension](#24-install-the-extension)

The Firefox extension requires **Firefox 142** or newer, the Chrome extension requires **Chrome 116** or newer.

### 2.1. Install Ollama

Go to https://ollama.com/download and follow the instructions.

### 2.2. Pull a model

I suggest `qwen3.5:9b` for GPU with a VRAB >= 8 GB, `qwen3.5:3b` ottherwise: 

- VRAM >= 8 GB: ` ollama pull qwen3.5:9b`
- VRAM < 8 GB: ` ollama pull qwen3.5:3b`

`qwen3.5:4b` is fine for basic spell check, but may be too limited for text transformative tasks..

**A paragraph takes a few seconds** on a mid-range GPU. That is why the extension checks only the paragraph you are working in, caches every result, and re-sends only what you changed. If it feels much slower than that, something is wrong outside the extension —see [everything is slow](#51-everything-is-slow), which on a laptop is usually the power profile.

---

### 2.3. Let Ollama accept requests from the extension  ⚠️ required

Ollama refuses requests whose `Origin` is a browser extension unless you allow it.
Firefox **does** send `Origin: moz-extension://…`, so without this step every check fails.

You need to set the environment variable `OLLAMA_ORIGINS` **for the Ollama server
process**, then restart Ollama. Use the value for the browsers you use:

| Browser | Value |
| --- | --- |
| Firefox | `moz-extension://*` |
| Chrome | `chrome-extension://*` |
| both | `moz-extension://*,chrome-extension://*` |

The examples below use the Firefox value; substitute as needed. How you set it depends on
the platform.

<details open>
<summary><b>Linux</b> (systemd — the only platform this has been tested on)</summary>

```bash
sudo mkdir -p /etc/systemd/system/ollama.service.d
printf '[Service]\nEnvironment="OLLAMA_ORIGINS=moz-extension://*"\n' \
  | sudo tee /etc/systemd/system/ollama.service.d/laita.conf
sudo systemctl daemon-reload && sudo systemctl restart ollama
```

A *drop-in* is a small file that adds settings to a service without editing the file the
package manager owns. Verify it took effect:

```bash
systemctl show ollama -p Environment | tr ' ' '\n' | grep ORIGINS
```
</details>

<details>
<summary><b>macOS</b> (not tested — please report whether it works)</summary>

For the menu-bar app, set the variable for your login session and restart Ollama:

```bash
launchctl setenv OLLAMA_ORIGINS "moz-extension://*"
```

Then quit Ollama from the menu bar and start it again. `launchctl setenv` does not survive
a reboot; to make it permanent, add it to a LaunchAgent.

If you run `ollama serve` yourself from a terminal instead, just export the variable in
that shell:

```bash
export OLLAMA_ORIGINS="moz-extension://*"
ollama serve
```
</details>

<details>
<summary><b>Windows</b> (not tested — please report whether it works)</summary>

Ollama reads user environment variables at startup.

1. Quit Ollama from the system tray.
2. Press `Win`, type *environment variables*, open **Edit the system environment
   variables** → **Environment Variables…**
3. Under **User variables**, add `OLLAMA_ORIGINS` with the value `moz-extension://*`
4. Start Ollama again.

Or from PowerShell, then restart Ollama:

```powershell
setx OLLAMA_ORIGINS "moz-extension://*"
```
</details>

> **Only the Linux instructions above have been tested.** The macOS and Windows steps
> follow Ollama's documented behaviour but have not been verified on those platforms. If
> you try one, [an issue](https://github.com/sylvaticus/laita/issues) saying whether
> it worked would be welcome.

#### Why the wildcard, and how to narrow it safely

The `moz-extension://…` origin Firefox sends is **not** the extension's ID. It is a random
UUID that Firefox generates **per profile**, so it differs on every machine and every
profile, and there is no value you can publish that would work for everyone. Four runs on
one machine during development produced four different origins for the same extension.

So `moz-extension://*` is the only setting that works out of the box. It does mean *any*
extension can reach Ollama. To close that, pin **your own** profile's UUID once LAITA is
permanently installed:

1. Open `about:config` and search for `extensions.webextensions.uuids`
2. Find `locaispell@lobianco.org` in the JSON and copy the UUID next to it
3. Use `OLLAMA_ORIGINS=moz-extension://<that-uuid>` and restart Ollama

⚠️ Do **not** use the extension ID there — `moz-extension://locaispell@lobianco.org` looks
plausible and is silently wrong: Ollama accepts the setting and then rejects every real
request with `403`. The variable takes a comma-separated list, so a second profile or
machine needs its own UUID added.

**Chrome is the opposite, and easier.** Its extension ID is assigned by the Web Store and
is the same for everyone, so it can simply be written down. If you installed LAITA from
the Chrome Web Store, use this instead of the wildcard:

```
OLLAMA_ORIGINS=chrome-extension://kkonkblgjafnampabmfflabkdkggpnjn
```

Ollama then accepts LAITA and refuses every other extension, with nothing to look up.

Whichever you pin, remember what `OLLAMA_ORIGINS` is: a browser rule. It stops other
*extensions* from reaching your model — not other programs on the same machine, which
send no `Origin` at all and are never checked.

Keep the wildcard while loading temporary development builds: those get a fresh UUID on
every load.

**Chrome is different and easier.** Its origin is `chrome-extension://<id>`, where the id
is stable for an installed extension (derived from the store listing, or from the folder
path for an unpacked one). So once LAITA is installed you can read the id from
`chrome://extensions` and narrow to `chrome-extension://<that-id>` permanently.

Whatever your platform, this check should return something other than `403`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H "Origin: moz-extension://11111111-2222-3333-4444-555555555555" \
  -H "Content-Type: application/json" -d '{"model":"qwen3.5:9b"}' \
  http://localhost:11434/api/show
```

`200` means you are set. `403` means Ollama did not pick up the variable — it almost always
means Ollama was not restarted.

### 2.4. Install the extension

#### 2.4.1. Firefox

**From Firefox Add-ons** — the normal way, and it updates itself:

> **[LAITA on addons.mozilla.org](https://addons.mozilla.org/firefox/addon/local-ai-text-assistant/)**
>
> The listing is awaiting Mozilla's review. Until it is approved that link will not
> resolve — use the direct download below in the meantime.

**Or install the signed file directly**, which works today and needs no listing:

1. Download the latest `.xpi` from the
   [releases page](https://github.com/sylvaticus/laita/releases).
2. Open `about:addons`
3. Click the **gear icon** → **Install Add-on From File…**
4. Choose the `.xpi` you downloaded

Either way the file is signed by Mozilla, so it installs permanently and survives
restarts. The options page opens the first time. The one difference is updates: a copy
installed from the directory updates itself, a `.xpi` installed by hand does not, so you
would download a newer one when you want it.

#### 2.4.2. Chrome

**From the Chrome Web Store** — the short way, and it updates itself:

> **[Install LAITA](https://chromewebstore.google.com/detail/kkonkblgjafnampabmfflabkdkggpnjn)**

Then tighten Ollama to just this extension, since the Web Store ID is the same for
everyone:

```
OLLAMA_ORIGINS=chrome-extension://kkonkblgjafnampabmfflabkdkggpnjn
```

**Or load it from a folder** — for a version that is not in the store yet, or to avoid the
store entirely. **You do not need to build anything:**

1. Download **`laita-chrome-<version>.zip`** from
   [the latest release](https://github.com/sylvaticus/laita/releases/latest) and unzip it
2. Open `chrome://extensions`
3. Turn on **Developer mode** (top right)
4. Click **Load unpacked** and select the unzipped folder

That zip is the same package the Chrome Web Store receives, so what you load by hand is
what the store reviewed.

For this route Chrome needs the **wildcard** `chrome-extension://*` in `OLLAMA_ORIGINS`,
not the pinned ID above: an extension loaded unpacked gets its own local ID.

Two things to know about loading unpacked, neither of which is a fault:

- Chrome shows *"Disable developer mode extensions"* warnings on startup. That is Chrome's
  standard notice for anything not installed from the Web Store.
- It does not update itself. To upgrade, download the new zip, replace the folder, and
  press **Reload** on the extension's card.

> Working from a clone instead? `cd browser && ./tools/build-chrome.sh` assembles the same
> folder at `browser/dist-chrome/`. It is not in the repository — it is generated, and the
> tests generate it themselves. It is a plain copy of `src/` with the Chrome manifest; no
> compilation happens anywhere in this project.

> Building it yourself, or working on the code? See
> [`doc/dev_doc.md`](doc/dev_doc.md) — a development build loads straight from
> `manifest.json` via `about:debugging`, with no signing.

#### 2.4.3. Check the connection

On the options page press **Test connection**. You should see
*"Connected. N models available, "qwen3.5:9b" is one of them."*

That test deliberately performs a `POST`, because a plain `GET` carries no `Origin` header
and would report success even while real checks were being refused.

---

## 3. Using it

LAITA is the same idea in two very different hosts. The browser extension draws its own
highlights because a web page offers nothing better; in VS Code the suggestions are
ordinary diagnostics, so they behave like every other linter you already use.

### 3.1. In Firefox and Chrome

#### 3.1.1. Text spell check

Click into any text box and type. Roughly 1.5 seconds after you stop, **the paragraph you
are working in** is checked and problems get a coloured wavy underline. Paragraphs you
visit later are checked as you reach them, and each one keeps its highlights once found —
so opening a long post does not set off a request per paragraph before you have typed
anything. Press **Alt+Shift+C** to check the whole field at once, or change *How much to
check* in the options. A small translucent pill just below the field
shows progress; click its **×** to hide it and abandon the check that is running.

- **Click a highlight** to open a card with the explanation and the suggested text.
  - **Apply** — replaces just that span. Your undo history (`Ctrl+Z`) still works.
  - **Dismiss** — hides this one for now.
  - **Never suggest** — remembers the suggestion and never offers it again.
  - **Add to dictionary** — for a single word, adds it to your personal dictionary.
- **Alt+Shift+C** — check the focused field immediately.
- **Alt+Shift+X** — pause (or resume) proofreading on the current site. The same thing is
  in the right-click menu as **LAITA: pause / resume spell check on …**, and on the
  toolbar button. See [pausing on a site](#313-pausing-on-a-site).
- The **toolbar button** shows the issue count, the connection status, and per-site and
  global on/off switches.

Both plain `<textarea>` / `<input>` fields and rich `contenteditable` editors (webmail,
wikis, most WYSIWYG editors) are supported.

#### 3.1.2. Transforming a selection

Proofreading suggests small fixes and never rewrites wholesale. When you *want* a rewrite,
select the text, right-click and choose **Local AI Text Assistant → Transform…** (or press
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

#### 3.1.3. Pausing on a site

Three places do the same thing — the right-click menu, **Alt+Shift+X**, and the toolbar
button's per-site switch. The menu entry names the site and says which way it will go, so
you can see the current state before clicking:

> LAITA: pause spell check on **news.ycombinator.com**

A pause set this way is an **override**: it wins over the allowlist/denylist in the
options, so it holds whatever the standing policy says for that hostname. It applies to
that exact hostname, not its subdomains, and it survives a restart until you lift it —
either by resuming from the same menu, or with **Clear per-site pauses** under
*Maintenance* in the options.

Resuming a site while the extension is switched off globally turns the global switch back
on too, since otherwise "resume" would appear to do nothing.

Pausing only stops the automatic proofreading. **Local AI Text Assistant → Transform…** is something you
ask for explicitly, so it keeps working on a paused site.

#### 3.1.4. What LAITA will not touch

Passwords, payment fields, one-time codes, and any field whose type, `autocomplete`, name,
id, placeholder or class hints at a secret are skipped outright — they are never read and
never sent anywhere. Fields shorter than 12 characters are ignored too.

To exclude anything else, add `data-laita="off"` to it or to any ancestor. The older
`data-locaispell="off"` still works, so pages that already use it keep their exclusion.

---

### 3.2. In VS Code

Search for **LAITA** in the Extensions panel, or from a terminal:

```bash
code --install-extension sylvaticus.laita
```

It is on the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=sylvaticus.laita).
To build it yourself instead, see [`vscode/`](vscode/):

```bash
cd vscode && npm run package
code --install-extension laita-vscode-0.3.9.vsix
```

Then write. Prose files are checked **as you type**, a paragraph at a time:

- **Squiggles** in the editor and entries in the **Problems** panel, rather than a custom
  overlay. Severity follows the category — error → Warning, style and rephrase →
  Information — and each is a setting, so you can raise or lower any of them.
- **`Ctrl+.`** on a squiggle offers *LAITA: change to "…"*, plus *add to the dictionary*,
  *never make this suggestion again*, and *dismiss for this session*. Every entry says
  LAITA, because that menu also holds VS Code's own and any AI assistant's.
- **`Alt+Shift+T`** transforms the selection, with the same instruction box as the
  browser; the result can replace the selection or be inserted after it.
- **`Alt+Shift+C`** checks the paragraph at the cursor on demand.
- The **status bar** item opens everything: proofread, transform, the dictionary,
  settings.

Which file types are checked automatically is `laita.languages` — Markdown, Quarto,
LaTeX, AsciiDoc, reStructuredText, HTML, plain text and commit messages by default. Code
fences inside them are never sent.

**No `OLLAMA_ORIGINS` setting is needed here.** Requests come from Node rather than a
page, so they carry no `Origin` header and Ollama does not refuse them — step 2.3 above
is only for the browsers.

---

## 4. Options

Open them from the toolbar popup, or from `about:addons` → Local AI Text Assistant → Preferences.

| Setting | Default | Notes |
| --- | --- | --- |
| Ollama endpoint | `http://localhost:11434` | |
| Model | `qwen3.5:9b` | The field autocompletes from your installed models. |
| Temperature | `0` | Keep at 0 for repeatable corrections. |
| Context window (tokens) | `0` | `0` follows Ollama's own setting. Pinning a different number makes Ollama unload another app's model and load a second copy of the same weights. See [sharing Ollama](#52-sharing-ollama-with-other-apps). |
| Parallel requests | `1` | Raise only if you have set `OLLAMA_NUM_PARALLEL` higher. Ollama serves one request at a time by default, so extra ones just queue — and a queued request's timeout is already running. |
| Request timeout | `90 s` | The floor. A transform is allowed longer in proportion to the selection, because a rewrite emits about as much text as it consumes: a paragraph takes seconds, ten pages took over three minutes on the machine this was developed on. |
| Keep model loaded for | `10m` | Avoids a slow reload on every check. Needs a unit (`30m`, `8h`); `-1m` — or any negative value — keeps it loaded indefinitely, while a bare `-1` is rejected by Ollama. Sent with every request, so it overrides the server's `OLLAMA_KEEP_ALIVE`. |
| Allow the model to "think" | off | Reasoning traces make checks several times slower. |
| Trigger | automatic | Or manual only, via `Alt+Shift+C`. |
| How much to check | the paragraph I am working in | `The whole field` checks every paragraph as soon as you focus it — one request each, which is slow on a long document. `Alt+Shift+C` and the toolbar button sweep everything either way. |
| Typing pause | `1500 ms` | |
| Ignore fields shorter than | `12` characters | |
| Maximum chunk size | `700` characters | Longer paragraphs are split on sentence boundaries. |
| Maximum characters per check | `12000` | How much one check may send, **not** how long a field may be. A paragraph is far under this however long the document is, so only a whole-field check can exceed it. Also caps a single *Transform*. |
| Language | detect | Or pin one. |
| Categories and colours | all on | Turn off a category to stop paying for it. |
| House style rules | empty | Free text appended to the prompt, e.g. *"Prefer British spelling."* |
| Personal dictionary | empty | One word per line, never flagged. |
| Sites | run everywhere | Or switch to an allowlist. A per-site pause overrides this. |
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
| *"Ollama could not start the model"* | The model does not fit in the GPU next to whatever else is using it. See [errors that come and go](#53-errors-that-come-and-go). |
| *"was reloaded or updated, so this page is still running the old copy"* | Exactly that: reload the page. Pages open while you reload the extension in `about:debugging` keep the old content scripts, which can no longer reach it. |
| *"the background page did not answer"* | Firefox unloaded the extension's background page. Long requests hold it open, so if you see this, reload the tab and report it. |
| Nothing happens at all | The site may be disabled (check the toolbar popup), the field may be too short, or it may look like a password field. |
| Highlights sit slightly off | Report it — the field probably uses a layout the mirror does not yet copy. |
| Checks feel slow | **Check your laptop's power profile first** — see [everything is slow](#51-everything-is-slow). Otherwise: lower *maximum chunk size*, turn off the *rephrase* category, or use a smaller model. The first check after an idle period also pays for reloading the model. |

### 5.1. Everything is slow

On a laptop, check the power profile before anything else. Measured on one machine with
an RTX 2000 Ada, the same model and the same 149-word request:

| Profile | GPU clock under load | Power | Generation | Request |
| --- | --- | --- | --- | --- |
| `power-saver` | 210 MHz | 1.9 W | 1.8 tok/s | 86 s |
| `balanced` | 480–615 MHz | 30 W | 20.1 tok/s | 8.2 s |
| `performance` | 930–1155 MHz | 35 W | 30.2 tok/s | 5.3 s |

Seventeen times, from one setting. `power-saver` pins the dGPU to its floor even on mains
power, and the symptom is not "a bit slow" — it is checks that run for a minute and time
out, which looks like a broken extension.

```bash
powerprofilesctl get                 # what you are on
powerprofilesctl set performance
nvidia-smi --query-gpu=utilization.gpu,clocks.sm,power.draw --format=csv -l 1
```

Run that last one *while a check is happening*. At idle every GPU sits at its floor, so an
idle reading tells you nothing. If the clock stays near the floor at 100% utilisation, the
GPU is being clamped. `nvidia-smi -q -d PERFORMANCE` names the reason; `SW Power Cap`
while power draw sits exactly at the limit is normal and just means the card is at its
designed TGP.

Anything else competing for the machine matters too, because a laptop shares a power and
thermal budget between CPU and GPU. A runaway process pinning a couple of cores costs GPU
clocks directly.

Rough guide once the GPU is running properly: **a paragraph is a few seconds.** If a
paragraph takes half a minute, something is wrong outside the extension.

### 5.2. Sharing Ollama with other apps

Ollama identifies a loaded model by its weights **and its runtime options**. Ask for the
same model with a different `num_ctx` and it does not reuse what is resident: it unloads
that runner and starts a second one. On a machine where the model only just fits, that
unload-and-reload is where load failures come from.

So if you also use Open WebUI, or anything else on the same Ollama, the context window
must agree everywhere. The extension therefore sends **no** context size by default and
inherits whatever the server is set to. Set it once, on the server:

```bash
# /etc/systemd/system/ollama.service.d/override.conf
Environment="OLLAMA_CONTEXT_LENGTH=16384"
```

and leave *Context window* at `0` here. `ollama ps` should then stay put when you switch
between apps — if the `CONTEXT` column changes, or `UNTIL` says `Stopping...`, something
is still asking for its own size.

Pin a number only to override the server deliberately. If you do, a transform bigger than
that window is refused rather than silently truncated.

Two related settings work the same way — a mismatch costs a reload:

| | Where to set it |
| --- | --- |
| Context length | `OLLAMA_CONTEXT_LENGTH` on the server |
| How long the model stays loaded | `OLLAMA_KEEP_ALIVE=-1`, plus *keep model loaded for* here, since a value sent with a request overrides the server's |
| Only one model resident | `OLLAMA_MAX_LOADED_MODELS=1` |

`think` and `temperature` are *request* options, not runner options, so those never cause
a reload. A model made with `ollama create` is a different model and does get its own
runner, even when the weights on disk are shared.

### 5.3. Errors that come and go

An error on a page that worked a minute ago almost always means the model had to be
**loaded again** and the load failed. Ollama unloads a model after the *keep model loaded
for* period, and reloading it needs the whole model to fit in the GPU at once — so a model
that is a tight fit works while it is resident and fails when it has to come back.

Local AI Text Assistant retries once automatically, which hides most of these. If you still
see them:

```bash
nvidia-smi --query-gpu=memory.total,memory.free --format=csv   # what you have
ollama list                                                    # what the model needs
journalctl -u ollama -n 200 | grep -iE "load failed|llama-server"
```

If the model size is close to the card's memory, that is the answer. Three fixes, in order
of effectiveness:

1. **Use a smaller model.** A 6.6 GB model on an 8 GB card leaves nothing for the context
   and fails as soon as anything else touches the GPU. A 3–4 GB model has room.
2. **Raise *keep model loaded for*** (options → Model) to something long, `8h` or `-1`.
   Every reload is a chance to fail, so the fix is to stop reloading.
3. **Do not alternate between models.** Switching evicts one and loads the other, which
   is a reload each way.

If you stay on the large model, also raise the request timeout: a load that takes longer
than the timeout is abandoned by the extension, which Ollama logs as a cancelled load.

Turn on **Log debug output to the page console** in the options to see what Local AI Text Assistant is
doing, then open the web console on the page (`Ctrl+Shift+K`). When the pill shows an
error, its **?** button opens the full message.

---
---

## 6. Privacy

LAITA talks to exactly one place: the Ollama endpoint in its options. There is no
telemetry, no analytics, no remote service and no second destination.
`manifest.json` declares `data_collection_permissions: { "required": ["none"] }`, which is
accurate for the extension itself.

### What "nothing leaves your machine" depends on

It is worth being exact, because the sentence is true of the default configuration rather
than of the software in the abstract. **Two things have to hold, and you control both:**

1. **The endpoint is on your machine.** It defaults to `http://localhost:11434`, and the
   extension holds permission to reach *only* loopback addresses. Pointing it at anything
   else — a beefier machine on your own network, say — is a legitimate thing to want, and
   it is treated as the decision it is: the options page names the host and asks you to
   confirm, the browser asks separately for permission to contact it, and for as long as
   the endpoint is not local both the options page and the toolbar popup say so in plain
   words. If you never changed it, it is local, and the extension cannot reach anywhere
   else even if something rewrote the setting behind your back.
2. **The model is a local one.** Ollama can serve cloud-hosted models as well as ones on
   your disk. If you configure LAITA with such a model, Ollama forwards your text to that
   provider — LAITA cannot tell the difference and would not stop you. `ollama list` shows
   what is actually on your machine.

Put plainly: LAITA adds no network destination of its own. It sends your text to whatever
you told Ollama to be, and the defaults are entirely local.

### What it reads

It reads what you type, which is what proofreading is — but only in fields it is allowed
to touch, and only to send to the endpoint above.

Excluded in code, and never read: password, email, telephone and other non-prose input
types; fields whose autocomplete marks them as credentials, payment details or one-time
codes; and any field — including rich-text and `contenteditable` ones — whose own name,
id, placeholder, label or class, **or that of an enclosing container**, suggests a secret,
a payment, a bank, a recovery phrase, or medical or identity data.

Two honest caveats about that list. It is a denylist of suspicious words, so it fails open
on anything it has not been taught: a field with a neutral name holding sensitive text is
read like any other. And it protects fields, not content — if you paste a password into a
comment box, LAITA proofreads it.

To exclude anything else, add `data-laita="off"` to the field or to any ancestor. Per-site
pausing is in the toolbar popup, and the checks stop entirely when the extension is
paused.

---

## 7. Development

This repository is a monorepo. The Firefox extension is in [`browser/`](browser/); it is
self-contained and has no build step.

- [`doc/dev_doc.md`](doc/dev_doc.md) — running a development build, tests, signing,
  architecture
- [`doc/agent_context.md`](doc/agent_context.md) — handover note for an LLM assistant:
  current state, what is untested, and this machine's quirks
- [`doc/roadmap.md`](doc/roadmap.md) — Chrome, VS Code and LibreOffice: what can be
  shared and what cannot

LAITA is short for *Local AI Text Assistant*, and is the name used throughout the code.

---

## 8. Licence

MIT — see [LICENSE](LICENSE).


## 9. Acknowledgements

The development of this software at the Bureau d'Economie Théorique et Appliquée (BETA, Nancy) was supported by the French National Research Agency through the ARTEMIS (Advanced Research and Education on the biology, the Ecology, the Management and the biomonitoring of forest ecosystems in a changing world) interdisciplinary program.

![BETA, Université de Strasbourg, CNRS, Université de Lorraine, INRAE, AgroParisTech](assets/imgs/logos_betaumr.png)

Implemented using Claude Code by Anthropic, designed and checked by a human.
