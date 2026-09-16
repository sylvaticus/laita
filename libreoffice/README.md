# LAITA for LibreOffice

A `.oxt` extension: a grammar checker that asks your own Ollama, plus a toolbar and an
options page. The reasoning behind the design, and the measurements that decided it, are
in the LibreOffice section of [`../doc/roadmap.md`](../doc/roadmap.md).

## Installing

```bash
./tools/install.sh          # refuses to run while LibreOffice is open
```

**Then enable it for your language**, which installing does not do:

> Tools ▸ Options ▸ Languages and Locales ▸ Writing Aids ▸ *Available Language Modules*
> ▸ **Edit…** ▸ choose your language ▸ tick **LAITA**

Settings are under Tools ▸ Options ▸ **LAITA - Local AI Text Assistant**, and the toolbar
has *Check this document*, *Stop checking*, *Transform selection* and *LAITA options*.

The log is `~/laita-libreoffice.log`.

## How it is put together

| | |
| --- | --- |
| `src/laita.py` | the three UNO services: proofreader, toolbar dispatcher, options handler |
| `src/pythonpath/laita_anchor.py` | quotes to ranges - a port of `browser/src/background/anchor.js` |
| `src/pythonpath/laita_ollama.py` | prompts and transport - a port of `ollama.js` |
| `src/pythonpath/laita_engine.py` | the cache and the debounce |
| `src/pythonpath/laita_settings.py` | reads and writes LibreOffice's own configuration |
| `src/*.xcu`, `Settings.xcs`, `dialog/options.xdl` | registration: grammar checker, toolbar, protocol, options page |

`test/run.sh` needs neither LibreOffice nor Ollama. The two ported modules are compared
against the JavaScript they came from rather than against expectations written beside
them, and `test_wiring.py` checks every name that has to match across the XML and the
Python - the class of mistake that makes a button do nothing with no error anywhere.

## Things that cost time here

- **A Python virtualenv on `PATH` breaks the install.** `unopkg` fails with
  `C++ code threw St9bad_alloc: std::bad_alloc` — no mention of Python or the
  environment. The venv's `python3` comes first on `PATH`; it is usually a symlink to the
  system one, but its `pyvenv.cfg` changes `sys.prefix`, so pyuno is not importable.
  `install.sh` strips virtualenvs from `PATH` for this reason. The same applies to
  launching LibreOffice itself from a shell with a venv active.
- **LibreOffice must be fully closed to pick up a reinstall**, including the background
  `soffice.bin` that outlives the last window. Installing over a running instance reports
  `is registered: yes` and then never instantiates the component.
- **Installing the extension is not enough.** It must also be enabled for the document's
  language in Tools ▸ Options ▸ Languages and Locales ▸ Writing Aids ▸ *Available Language
  Modules* ▸ **Edit…**, which is a per-language list behind a button.
- **A document with no language set is never checked**, and the extension is never called,
  so it cannot report why. `Text language: [None]` in the spelling dialog is the symptom.
- **Do not test with a misspelling.** AutoCorrect rewrites `teh` to `the` on the next
  space, so a grammar checker never sees it. Test with something AutoCorrect leaves
  alone.
- **`print()` goes nowhere.** A log file is the only reliable channel, the same lesson the
  VS Code port taught.
