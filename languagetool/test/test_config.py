# -*- encoding: UTF-8 -*-
"""
Configuration. Two things matter here and both have bitten this project before:

  * the defaults are the extension's, not a second opinion - a model name that drifts
    apart between the two is a support question nobody can answer from the code;
  * a setting the file names but the server does not understand is an ERROR. The
    extension degrades to defaults on purpose (raising inside LibreOffice becomes a modal
    dialog on every keystroke); a server has no such excuse, and silently ignoring a
    typo in a config file is how someone spends an afternoon wondering why `chunkMaxChar`
    changed nothing.
"""
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "src"))

import laita_lt_shared                                      # noqa: E402
laita_lt_shared.install()

import laita_lt_config as config                            # noqa: E402
import laita_ollama                                         # noqa: E402
import laita_settings                                       # noqa: E402

fails, passes = [], 0


def check(name, got, want):
    global passes
    if got == want:
        passes += 1
    else:
        fails.append("%s\n    got  %r\n    want %r" % (name, got, want))


def wrote(payload):
    fh = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
    json.dump(payload, fh)
    fh.close()
    return fh.name


def main():
    d = config.defaults()

    # --- shared with the extension, not restated ---------------------------------------
    for key in ("model", "endpoint", "chunkMaxChars", "debounceMs", "minChars", "maxChars",
                "requestTimeoutMs", "temperature", "numCtx", "keepAlive"):
        check("%s comes from the extension" % key, d[key], laita_settings.DEFAULTS[key])

    # --- and the ones that need a window are gone rather than ignored -------------------
    for key in config.IRRELEVANT:
        check("%s is not offered" % key, key in d, False)

    # The advertised list is derived, not a second shorter list that drifts away from the
    # one the prompts use.
    check("every language LAITA can name is advertised",
          d["languages"], sorted(laita_ollama.LANGUAGE_NAMES))

    # --- server defaults are safe ------------------------------------------------------
    check("binds to loopback by default", d["host"], "127.0.0.1")
    check("no api key by default", d["apiKey"], "")
    check("logs to stderr by default", d["logFile"], "")

    # --- the file ----------------------------------------------------------------------
    path = wrote({"model": "qwen3.5:27b", "port": 9999,
                  "categories": {"rephrase": False}})
    c = config.load(path)
    check("the file overrides a model", c["model"], "qwen3.5:27b")
    check("the file overrides a port", c["port"], 9999)
    check("categories merge rather than replace",
          c["categories"], {"error": True, "style": True, "rephrase": False})
    check("untouched settings keep their default", c["chunkMaxChars"], 700)
    os.unlink(path)

    check("no file at all is fine", config.load()["model"], laita_settings.DEFAULTS["model"])

    # --- a typo is refused, not shrugged off --------------------------------------------
    path = wrote({"chunkMaxChar": 700})
    try:
        config.load(path)
        check("an unknown setting is refused", "no error", "ValueError")
    except ValueError as err:
        check("an unknown setting is refused", "chunkMaxChar" in str(err), True)
    os.unlink(path)

    path = wrote({"scope": "document"})
    try:
        config.load(path)
        check("a setting that cannot work here is refused too", "no error", "ValueError")
    except ValueError as err:
        check("a setting that cannot work here says so, not 'unknown'",
              "no cursor" in str(err), True)
    os.unlink(path)

    # --- clamped, because a number in a file is not a promise ---------------------------
    path = wrote({"debounceMs": 0, "chunkMaxChars": 99999, "temperature": 50})
    c = config.load(path)
    check("debounce is clamped up", c["debounceMs"], 300)
    check("chunk size is clamped down", c["chunkMaxChars"], 4000)
    check("temperature is clamped", c["temperature"], 2.0)
    os.unlink(path)

    # --- the budget must be able to cover the debounce -------------------------------------
    # waitMs spans the debounce AND the model. A budget smaller than the debounce means
    # every check waits, times out and answers empty - the exact failure this whole
    # mechanism was added to fix, reintroduced by a plausible-looking config file.
    check("the budget clears the debounce by default",
          d["waitMs"] > d["debounceMs"], True)
    path = wrote({"waitMs": 1000, "debounceMs": 1500})
    try:
        config.load(path)
        check("a budget under the debounce is refused", "no error", "ValueError")
    except ValueError as err:
        check("a budget under the debounce is refused", "must exceed" in str(err), True)
    os.unlink(path)

    path = wrote({"waitMs": 30000})
    check("the budget is clamped below the client's 10s limit",
          config.load(path)["waitMs"], 9000)
    os.unlink(path)

    path = wrote({"waitMs": 0})
    check("0 is allowed, and means never wait", config.load(path)["waitMs"], 0)
    os.unlink(path)

    # --- environment ---------------------------------------------------------------------
    c = config.from_env(config.defaults(),
                        {"LAITA_LT_HOST": "172.17.0.1", "LAITA_LT_PORT": "8181",
                         "LAITA_LT_MODEL": "llama3:8b"})
    check("host from the environment", c["host"], "172.17.0.1")
    check("port from the environment is an int", c["port"], 8181)
    check("model from the environment", c["model"], "llama3:8b")
    c = config.from_env(config.defaults(), {})
    check("an empty environment changes nothing", c["host"], "127.0.0.1")

    print("%d passed, %d failed" % (passes, len(fails)))
    for f in fails:
        print("  FAIL " + f)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
