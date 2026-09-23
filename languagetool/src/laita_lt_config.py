# -*- encoding: UTF-8 -*-
"""
Configuration for the server.

The extension keeps its settings in LibreOffice's own configuration and shows them on an
options page. A server has neither, and the people it serves cannot be asked - so the
settings that decide how the model is prompted come from one JSON file, read once at
start, and apply to everybody.

DEFAULTS is imported from the extension rather than restated, so that changing the
default model or chunk size in one place changes it in both. The keys that only make
sense with a cursor and a window are dropped instead of being quietly ignored.
"""
import json
import os

import laita_lt_shared

laita_lt_shared.install()
import laita_ollama                                        # noqa: E402
import laita_settings                                      # noqa: E402


# Settings the extension has that mean nothing without a user interface.
#
#   checkAsYouType  there is no other kind of check here
#   transform*      the transform is not reachable through this protocol at all
#
# `scope` is NOT in this list. It means the same thing as the extension's - what to check -
# but its values differ, because there is no caret to name. See SERVER_DEFAULTS.
IRRELEVANT = ("checkAsYouType", "transformDefault", "transformHistory")

SERVER_DEFAULTS = {
    # 127.0.0.1 by default. The document text of everyone using the server passes through
    # here, so it must be a deliberate act to put it on an address anything else can
    # reach - see README.md for the Collabora case, which is 172.17.0.1.
    "host": "127.0.0.1",
    "port": 8181,
    # Advertised by /v2/languages, and advisory only - nothing here restricts what will
    # be checked, because the prompt names whatever language the client asked for and an
    # unknown code is passed through as itself. Derived from the model prompts' own table
    # rather than being a second, shorter list that drifts away from it. Override it to
    # advertise region variants ("fr-FR", "en-GB") if some client insists on them.
    "languages": sorted(laita_ollama.LANGUAGE_NAMES),
    # Sent as `username`/`apiKey` by a LanguageTool client. Empty means no check. The
    # protocol has no better authentication, and Collabora can supply both.
    "apiKey": "",
    "userName": "",
    # What to check.
    #
    #   "typed"     only paragraphs somebody is working in. The default.
    #   "document"  every paragraph the client offers.
    #
    # Opening a long document makes the client offer EVERY paragraph at once, and under
    # "document" each one is a model call: start typing on page five and your answer
    # queues behind fifty paragraphs nobody asked about. The extension avoids this with
    # checkScope "caret", naming the paragraph under the cursor. Nothing in this protocol
    # says where the cursor is, so "typed" uses the only evidence there is - a paragraph
    # being edited arrives again and again, a character apart, while one merely displayed
    # arrives once and never changes. First sightings are remembered but not sent, so the
    # first keystroke in a paragraph is recognised immediately.
    #
    # The cost: a document nobody types in is never checked, and a brand-new paragraph
    # costs one keystroke before it is recognised. "caret" is accepted as a synonym for
    # "typed", so a configuration copied from the extension means what it looks like.
    "scope": "typed",
    # The translation endpoint, which Collabora reaches by having deepl.api_url point at
    # it. false makes it hand every fragment back untranslated - never an error, because
    # an error deletes the user's selection. See laita_lt_translate.
    "translate": True,
    # Translation has no ceiling to respect: core sets no timeout at all on that call,
    # unlike the ten seconds it allows a grammar check. This is only a backstop against a
    # model that has hung.
    "translateTimeoutMs": 300000,
    # "" logs to stderr, which is what a systemd unit wants.
    "logFile": "",
    # How long a check may hold its request open waiting for the model. It must cover
    # debounceMs AND the model's own time, and must stay clear of the 10 SECONDS at which
    # LibreOffice gives up - that limit is compiled into the client and cannot be raised.
    #
    # 0 restores the original behaviour: never wait, answer empty, let the next check
    # collect the answer. That reads well and does not work, because the client stops
    # asking when the user stops typing; it is kept only for a client that does poll.
    "waitMs": 7000,
}

# Bounds for the server's own settings. laita_settings.clamp covers the shared ones.
_CLAMP = {
    # 9000 rather than 10000: the answer still has to be serialised and sent.
    "waitMs": (0, 9000),
    "port": (1, 65535),
    "translateTimeoutMs": (5000, 3600000),
}


def defaults():
    out = {k: v for k, v in laita_settings.DEFAULTS.items() if k not in IRRELEVANT}
    out["categories"] = dict(laita_settings.DEFAULTS["categories"])
    out.update(SERVER_DEFAULTS)
    out["languages"] = list(SERVER_DEFAULTS["languages"])
    return out


def load(path=None):
    """Defaults, overlaid with the JSON file if there is one, clamped.

    A missing file is not an error: the defaults are a working configuration against a
    local Ollama. A malformed one IS an error, and is raised rather than shrugged off -
    the extension degrades to defaults because a grammar checker that raises inside
    LibreOffice becomes a modal dialog on every keystroke, but a server that silently
    ignores the file it was pointed at is worse than one that refuses to start.
    """
    out = defaults()
    if path:
        with open(path, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
        if not isinstance(raw, dict):
            raise ValueError("%s: expected a JSON object" % path)
        dropped = sorted(k for k in raw if k in IRRELEVANT)
        if dropped:
            raise ValueError(
                "%s: %s cannot apply to a server - there is no cursor and no window here. "
                "Remove it." % (path, ", ".join(dropped)))
        unknown = sorted(k for k in raw if k not in out)
        if unknown:
            raise ValueError("%s: unknown setting(s): %s" % (path, ", ".join(unknown)))
        for key, value in raw.items():
            if key == "categories" and isinstance(value, dict):
                out["categories"].update({k: bool(v) for k, v in value.items()})
            else:
                out[key] = value
    for key in out:
        if key in _CLAMP:
            low, high = _CLAMP[key]
            try:
                out[key] = max(low, min(high, type(low)(out[key])))
            except (TypeError, ValueError):
                out[key] = SERVER_DEFAULTS[key]
        elif key not in SERVER_DEFAULTS:
            out[key] = laita_settings.clamp(key, out[key])
    out["scope"] = {"caret": "typed"}.get(out["scope"], out["scope"])
    if out["scope"] not in ("typed", "document"):
        raise ValueError(
            "scope must be \"typed\" (only paragraphs somebody is working in) or "
            "\"document\" (every paragraph the client offers), not %r" % (out["scope"],))
    if out["waitMs"] and out["waitMs"] <= out["debounceMs"]:
        # Otherwise every check waits, times out and answers empty: the budget is spent
        # before the model is even asked. Worth refusing rather than debugging.
        raise ValueError(
            "waitMs (%s) must exceed debounceMs (%s), or no check can ever be answered "
            "in time - the wait covers the debounce as well as the model."
            % (out["waitMs"], out["debounceMs"]))
    return out


def from_env(cfg, environ=None):
    """LAITA_LT_HOST, LAITA_LT_PORT, LAITA_LT_MODEL, LAITA_LT_ENDPOINT, LAITA_LT_API_KEY.

    Only the handful worth setting from a unit file or a container; everything else
    belongs in the JSON, where it can carry a comment about why.
    """
    env = os.environ if environ is None else environ
    for var, key, cast in (("LAITA_LT_HOST", "host", str),
                           ("LAITA_LT_PORT", "port", int),
                           ("LAITA_LT_MODEL", "model", str),
                           ("LAITA_LT_ENDPOINT", "endpoint", str),
                           ("LAITA_LT_API_KEY", "apiKey", str)):
        if env.get(var):
            cfg[key] = cast(env[var])
    return cfg
