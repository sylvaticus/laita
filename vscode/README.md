# LAITA — Local AI Text Assistant

Proofread and rewrite prose with a language model running **locally** in
[Ollama](https://ollama.com). Nothing leaves your machine.

Built for Markdown, LaTeX, AsciiDoc, reStructuredText and plain text — the files where
you write prose rather than code.

## What it does

**Proofreads.** Mistakes appear as ordinary VS Code diagnostics: squiggles in the editor,
entries in the Problems panel, and a quick fix (`Ctrl+.`) that applies the suggestion.

| Default severity | Category | Meaning |
| --- | --- | --- |
| Warning | error | Objectively wrong: spelling, agreement, punctuation |
| Information | style | Wordy, redundant, needlessly passive |
| Information | rephrase | A better word or a more natural formulation |

Change any of them with `laita.severity.error`, `.style` and `.rephrase`. Avoid `hint`
unless you want suggestions to be nearly invisible: VS Code draws a hint as three dots
at the start of the phrase rather than underlining it, so a suggestion covering several
words looks like it covers one letter.

On the lightbulb (`Ctrl+.`) every LAITA action is named, because that menu pools
suggestions from every extension that has an opinion — VS Code's own *View Problem*, and
any AI assistant offering to fix it. Ours are:

| Action | What it does |
| --- | --- |
| **LAITA: change to "…"** | applies the suggestion. Preferred, so `Ctrl+.` then Enter does it |
| **LAITA: add "…" to the dictionary** | the word is never flagged again, anywhere |
| **LAITA: never make this suggestion again** | that exact suggestion is dropped for good |
| **LAITA: dismiss this one for this session** | hides it until the next check |

### Managing the dictionary

Run **LAITA: Show the personal dictionary** from the command palette (`Ctrl+Shift+P`). It
lists every word you have added; the bin icon beside a word removes it, and the first
entry adds one.

Both lists are ordinary settings, so you can also see and edit them under
**Settings → Extensions → LAITA**, or directly in `settings.json`:

```jsonc
"laita.dictionary": ["Lobianco", "Ollama", "quarto"],
"laita.ignored": ["a1b2c3d4"]          // fingerprints, not readable by design
```

They are written to your *user* settings rather than the workspace, because a personal
dictionary follows you rather than the project, and they sync with Settings Sync.
*LAITA: Forget suggestions I told it never to make* empties the second list.

**Rewrites a selection.** Select text, press `Alt+Shift+T`, and type what you want done —
`polish`, `translate to French`, `shorten it`, `turn into bullet points`. The result can
replace the selection or be inserted after it.

Code fences are treated as opaque and never sent to the model.

## Installing

Search for **LAITA** in the Extensions panel, or from a terminal:

```bash
code --install-extension sylvaticus.laita
```

## Requirements

[Ollama](https://ollama.com) running locally with a model pulled:

```bash
ollama pull qwen3.5:9b
```

Unlike the browser extension, **no `OLLAMA_ORIGINS` setting is needed**: requests come
from Node and carry no `Origin` header, so Ollama does not refuse them.

## Commands

| Command | Keybinding |
| --- | --- |
| Proofread the paragraph at the cursor | `Alt+Shift+C` |
| Check the whole document (may take a while…) / Stop checking the whole document | — |
| Check as you type / Stop checking as you type | — |
| Transform the selection… | `Alt+Shift+T` |
| Clear suggestions | — |

**Checking is automatic**, shortly after you stop typing, for the file types in
`laita.languages` — Markdown, LaTeX, AsciiDoc, reStructuredText, plain text. It looks at the part of the paragraph you are working in, not the whole file. A
paragraph longer than `laita.chunkMaxChars` is split on sentence boundaries and only the
piece holding the cursor is sent: the model's time goes on writing its answer, roughly in
proportion to the problems it finds, so a smaller piece answers sooner - and one request
stops at twelve suggestions, so splitting a long paragraph also finds more. Opening a
document checks its first real paragraph, skipping the title.

Turn that off with **Stop checking as you type** (or `laita.checkOnType`) and use the
commands instead, or set `laita.checkOnSave` to sweep the whole document when you save.
Each pair of commands offers only the action that applies, in the Command Palette and in
the status-bar menu. Stopping a whole-document check keeps the suggestions of the
paragraphs it had not reached yet; with checking as you type off, every suggestion already
shown stays, and its quick fix still works.

### Which file types, and what those names are

`laita.languages` holds **VS Code language identifiers**, not file extensions or the
names shown in menus:

| Your file | Status bar shows | The identifier is |
| --- | --- | --- |
| `notes.md` | Markdown | `markdown` |
| `paper.tex` | LaTeX | `latex` |
| `readme.txt` | Plain Text | `plaintext` |
| `report.qmd` | Quarto | `quarto` |

The identifier is assigned by VS Code from the file extension, or by whichever extension
handles that language, and you can override it per file with `files.associations`.

**The easy way to find one:** open the file and run **LAITA: Also check this file**. It
tells you the identifier and offers either "just this file, this session" or "always
check these files", which adds it to the setting for you — so you never have to look it
up. Clicking the language name at the right of the status bar also shows it, and there
is an [official list](https://code.visualstudio.com/docs/languages/identifiers).

For a one-off file whose type is not in the list — a `.txt` opened as something else, a
config file with a long prose comment — run **LAITA: Also check this file**. That lasts
for the session. To make it permanent, add the language id to `laita.languages`.

## Settings

Three ways in, whichever you reach for first:

- Click **LAITA** in the status bar (bottom right) → **Settings**
- `Ctrl+Shift+P` → **LAITA: Settings**
- `Ctrl+,` and type `laita`

The status bar item also opens everything else: proofread, transform, the dictionary,
clear suggestions.



Settings are grouped into **Ollama connection** (endpoint, model, context window,
timeout, keep-alive), **When to check** (as you type, on save, which file types, size
caps) and **What to suggest** (language, categories, dictionary, house rules).

All are under `laita.` — endpoint, model, language, temperature, context window, timeout,
which categories to report, a personal dictionary, and house style rules appended to the
prompt. See the Settings UI for the full list.

Two worth knowing:

- **`laita.numCtx` defaults to `0`**, meaning "follow Ollama's own setting". Naming a
  different context size makes Ollama unload whatever model another application has
  loaded and start a second copy.
- **`laita.maxChars`** caps how much one check or transform may send, not how long a file
  may be. Proofreading a paragraph is far below it however long the document is.

## Part of LAITA

The same tool exists as a Firefox and Chrome extension:
<https://github.com/sylvaticus/laita>. The prompts and the anchoring logic are shared
code; the interface is native to each host.

MIT licensed.
