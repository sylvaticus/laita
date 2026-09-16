# LibreOffice — the measurement probe

**This is not the port.** It is a throwaway `.oxt` built to answer four questions about
how LibreOffice treats a grammar checker, because none of them are in the API docs and all
four decide whether the port is possible. They are answered: see the LibreOffice section
of [`../doc/roadmap.md`](../doc/roadmap.md).

It returns a fixed fake suggestion on every occurrence of the word *the*, logs every call,
and can pretend to be slow. Nothing here talks to Ollama.

## Using it

```bash
./tools/reinstall-probe.sh        # refuses to run while LibreOffice is open
```

Then open Writer and type. Behaviour is controlled by `~/.laita-probe`, read on every
call, so it can be changed without reinstalling:

```
delay=3            seconds to pretend the model is thinking
claim_paragraph=1  answer once for the whole paragraph instead of per sentence
async=1            return nothing, think in a thread, then ask for a re-check
```

The log is `~/laita-probe.log`.

## Things that cost time here

- **A Python virtualenv on `PATH` breaks the install.** `unopkg` fails with
  `C++ code threw St9bad_alloc: std::bad_alloc` — no mention of Python or the
  environment. The venv's `python3` comes first on `PATH`; it is usually a symlink to the
  system one, but its `pyvenv.cfg` changes `sys.prefix`, so pyuno is not importable.
  `reinstall-probe.sh` strips virtualenvs from `PATH` for this reason. The same applies to
  launching LibreOffice itself from a shell with a venv active.
- **LibreOffice must be fully closed to pick up a reinstall**, including the background
  `soffice.bin` that outlives the last window. Installing over a running instance reports
  `is registered: yes` and then never instantiates the component.
- **Installing the extension is not enough.** It must also be enabled for the document's
  language in Tools ▸ Options ▸ Languages and Locales ▸ Writing Aids ▸ *Available Language
  Modules* ▸ **Edit…**, which is a per-language list behind a button.
- **A document with no language set is never checked**, and the extension is never called,
  so it cannot report why. `Text language: [None]` in the spelling dialog is the symptom.
- **Do not use a misspelling as the test word.** AutoCorrect rewrites `teh` to `the` on the
  next space, so a grammar checker never sees it. The probe flags the correctly spelled
  word *the* instead, which also avoids the red spell-check underline.
- **`print()` goes nowhere.** A log file is the only reliable channel, the same lesson the
  VS Code port taught.
