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
import laita_settings                                      # noqa: E402


# Settings the extension has that mean nothing without a user interface.
#
#   checkAsYouType  there is no other kind of check here
#   scope           there is no caret, so no paragraph "under" it
#   transform*      the transform is not reachable through this protocol at all
IRRELEVANT = ("checkAsYouType", "scope", "transformDefault", "transformHistory")

SERVER_DEFAULTS = {
    # 127.0.0.1 by default. The document text of everyone using the server passes through
    # here, so it must be a deliberate act to put it on an address anything else can
    # reach - see README.md for the Collabora case, which is 172.17.0.1.
    "host": "127.0.0.1",
    "port": 8181,
    # Advertised by /v2/languages. Does not restrict what will be checked: the prompt
    # names whatever language the client asked for.
    "languages": ["en-US", "en-GB", "fr-FR", "it-IT", "de-DE", "es-ES"],
    # Sent as `username`/`apiKey` by a LanguageTool client. Empty means no check. The
    # protocol has no better authentication, and Collabora can supply both.
    "apiKey": "",
    "userName": "",
    # "" logs to stderr, which is what a systemd unit wants.
    "logFile": "",
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
        if key not in SERVER_DEFAULTS:
            out[key] = laita_settings.clamp(key, out[key])
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
