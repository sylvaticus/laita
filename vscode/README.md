# LAITA — Local AI Text Assistant

Proofread and rewrite prose with a language model running **locally** in
[Ollama](https://ollama.com). Nothing leaves your machine.

Built for Markdown, LaTeX, AsciiDoc, reStructuredText and plain text — the files where
you write prose rather than code.

## What it does

**Proofreads.** Mistakes appear as ordinary VS Code diagnostics: squiggles in the editor,
entries in the Problems panel, and a quick fix (`Ctrl+.`) that applies the suggestion.

| Severity | Category | Meaning |
| --- | --- | --- |
| Warning | error | Objectively wrong: spelling, agreement, punctuation |
| Information | style | Wordy, redundant, needlessly passive |
| Hint | rephrase | A better word or a more natural formulation |

**Rewrites a selection.** Select text, press `Alt+Shift+T`, and type what you want done —
`polish`, `translate to French`, `shorten it`, `turn into bullet points`. The result can
replace the selection or be inserted after it.

Code fences are treated as opaque and never sent to the model.

## Running it from source

Open the `vscode/` folder in VS Code and press **F5**. A second window opens with the
extension loaded; edit a Markdown file there.

Or from a terminal, without touching your normal setup:

```bash
cd vscode
code --user-data-dir=/tmp/laita-ud --extensions-dir=/tmp/laita-ext \
     --extensionDevelopmentPath="$PWD" --new-window somefile.md
```

To install it properly instead: `npx @vscode/vsce package --no-dependencies`, then
**Extensions → … → Install from VSIX**.

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
| Proofread the whole document | — |
| Transform the selection… | `Alt+Shift+T` |
| Clear suggestions | — |

**Checking is automatic**, shortly after you stop typing, for the file types in
`laita.languages` — Markdown, LaTeX, AsciiDoc, reStructuredText, plain text. It looks at
the paragraph you are working in, not the whole file, so a long document does not fire a
request per paragraph. Opening a document checks its first real paragraph, skipping the
title.

Turn that off with `laita.checkOnType` and use the commands instead, or set
`laita.checkOnSave` to sweep the whole document when you save.

## Settings

All under `laita.` — endpoint, model, language, temperature, context window, timeout,
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
