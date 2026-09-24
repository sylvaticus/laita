# What's new in LAITA

User-facing changes, newest first. Design decisions live in
[`CLAUDE.md`](CLAUDE.md); how to build and release is in
[`doc/dev_doc.md`](doc/dev_doc.md). Older releases are on the
[releases page](https://github.com/sylvaticus/laita/releases).

---

## Unreleased

### LibreOffice: long paragraphs are underlined in full

Only the first sentence of a paragraph ever got underlines, so long paragraphs looked
unchecked, and splitting them "fixed" it. Every sentence is underlined now.

### LibreOffice: only what you edit is checked

Opening a document, or clicking into a paragraph to read it, no longer sends anything to
the model. A paragraph is checked when you change it.

### LibreOffice: separate controls for the whole document and for as-you-type

*Stop checking* used to switch everything off, and the only way back was another check of
the whole document. There are now two independent switches, on the toolbar and in the
LAITA menu, each showing only the action that applies:

- **Check the whole document (may take a while...) / Stop checking the whole document** (framed ▶ / ■): one sweep.
- **Check as you type / Stop checking as you type** (plain ▶ / ■): the same setting as in
  the options.

With checking as you type off, the underlines already shown stay and their suggestions
can still be applied. Paragraphs you edit meanwhile are checked as soon as you switch it
back on.

---

## 0.4.3 — 23 September 2026

### LAITA now works in Collabora Online

Collabora Online cannot install extensions, so LAITA reaches it a different way: as a
small server on your own machine speaking the [LanguageTool
API](https://languagetool.org/http-api/), which Collabora already knows how to talk to.
Point it there once, as the administrator, and **every user gets proofreading with nothing
to install and nothing to configure**.

The same server also answers Collabora's *Translate* button, so translation runs on your
local model — no DeepL account, no API key, and nothing leaving your machine.

- Suggestions appear as coloured underlines with the usual right-click menu.
- Translation is under **Tools ▸ Translate** in the compact view, or the **Translate**
  button in the *Review* tab of the tabbed view.
- Formatting *inside* a translated selection (bold, italics, links) is lost; paragraphs,
  lists and tables survive. The model is deliberately never shown the markup, because a
  model that invents a tag here damages the document rather than making a suggestion.
- By default only paragraphs somebody is working in are checked, so opening a long
  document costs nothing. The administrator can change that.

New component: [`languagetool/`](languagetool/). Its
[README](languagetool/README.md) explains the design and
[DEPLOY.md](languagetool/DEPLOY.md) is a step-by-step runbook. It also works with
**LibreOffice desktop 7.4 or newer**, which has the same LanguageTool client.

### You can edit a rewrite before applying it

*Transform selection* used to give you a result and three buttons. The result is now an
**editable field**: fix a stray word, drop a sentence you did not want, then apply. The
model's answer is a draft, and the cheapest moment to correct it is before it lands in your
document rather than afterwards.

In the **browser** the result is a text box you can type in; in **LibreOffice** the Result
field was already editable and now actually behaves like it (see the fix below).

**VS Code is the exception.** Its review is a real side-by-side diff, and both sides are
read-only by construction — there is no way to make one writable without rebuilding how the
diff is served. *Copy* is the way out there for now.

### Copy, wherever there is a result

The browser panel only offered **Copy** when the selected text was somewhere it could not
be replaced, which is backwards — a rewrite you want to paste somewhere else is just as
likely to come from a field you *can* edit. Copy is now offered alongside *Accept &
replace* and *Accept & append*.

LibreOffice gains a **Copy** button beside the Result label. It does not close the dialog,
so you can copy a rewrite and then try another instruction. VS Code gains a **Copy** action
in the review prompt, which likewise leaves the review open.

### Fixed: a stray marker could appear in a rewrite

LAITA wraps the text it sends to the model in a marker so that text in a page cannot
impersonate an instruction. The model occasionally handed that marker back, and it was not
stripped — so a rewrite could arrive with something like `TEXT_3082eae76f9d` on the end of
it. Rare, and it affected the browser, VS Code and LibreOffice alike.

### Fixed (LibreOffice): *Accept & replace* ignored your edits

Editing the Result field and pressing **Accept & replace** wrote the model's original
answer and silently discarded everything you had typed. *Accept & append* was unaffected.

### The answer cache is bigger, and it is now yours to set

LAITA remembers what the model has already said about a paragraph, so going back to text
you wrote earlier costs nothing. That memory was far smaller than it needed to be — 200
paragraphs in LibreOffice, 600 in the browser, 400 in VS Code, which works out at well under
a megabyte.

Measured properly, a typical paragraph with its suggestions costs about 2 KB. The default
is now **4500 paragraphs, roughly 10 MB**, and it is a setting rather than a fixed number:

| | |
| --- | --- |
| Browser | *Paragraphs to remember*, on the options page |
| VS Code | `laita.cacheMax` |
| LibreOffice | *Paragraphs to remember*, in the LAITA options dialog |
| Collabora server | `cacheMax`, or `--cache-max` when installing |

The server default is larger (20000, about 45 MB): it serves everybody and has a machine to
itself, which a browser extension does not.

### Also

- The LibreOffice options dialogs gained the new field, and grew to fit it.
- Five LibreOffice screenshots were added to the README.
- A handful of spelling and grammar corrections in the README.

---

## 0.4.2

**There is no 0.4.2.** The version went from 0.4.1 to 0.4.3; nothing was released in
between.
