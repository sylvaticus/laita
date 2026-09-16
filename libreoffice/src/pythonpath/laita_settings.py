# -*- encoding: UTF-8 -*-
"""
Settings, read from and written to LibreOffice's own configuration.

Values live in the user profile under org.lobianco.laita.Settings (see Settings.xcs), so
they survive restarts, appear in the options page, and need no file of ours. The probe
read a dotfile in $HOME; that was right for a probe and wrong for users.

Everything here degrades to the defaults rather than raising. A grammar checker that
throws gets a blocking modal dialog from LibreOffice on the first keystroke, so nothing
in this module is allowed to fail loudly.
"""

NODE = "/org.lobianco.laita.Settings"

DEFAULTS = {
    "endpoint": "http://localhost:11434",
    "model": "qwen3.5:9b",
    "temperature": 0.0,
    "numCtx": 0,
    "keepAlive": "10m",
    "requestTimeoutMs": 90000,
    "think": False,
    "enabled": True,
    "checkAsYouType": True,
    "debounceMs": 1500,
    "minChars": 25,
    "maxChars": 12000,
    "chunkMaxChars": 700,
    "categories": {"error": True, "style": True, "rephrase": True},
    "dictionary": [],
    "ignored": [],
    "extraInstructions": "",
    "transformDefault": "polish",
}

# setting key -> (group in Settings.xcs, property name)
_MAP = {
    "endpoint": ("Ollama", "Endpoint"),
    "model": ("Ollama", "Model"),
    "temperature": ("Ollama", "Temperature"),
    "numCtx": ("Ollama", "NumCtx"),
    "keepAlive": ("Ollama", "KeepAlive"),
    "requestTimeoutMs": ("Ollama", "RequestTimeoutMs"),
    "think": ("Ollama", "Think"),
    "enabled": ("Checking", "Enabled"),
    "checkAsYouType": ("Checking", "CheckAsYouType"),
    "debounceMs": ("Checking", "DebounceMs"),
    "minChars": ("Checking", "MinChars"),
    "maxChars": ("Checking", "MaxChars"),
    "chunkMaxChars": ("Checking", "ChunkMaxChars"),
    "dictionary": ("Suggestions", "Dictionary"),
    "ignored": ("Suggestions", "Ignored"),
    "extraInstructions": ("Suggestions", "ExtraInstructions"),
    "transformDefault": ("Suggestions", "TransformDefault"),
}
_CATEGORY_PROP = {"error": "CategoryError", "style": "CategoryStyle",
                  "rephrase": "CategoryRephrase"}

# Bounds, because a number typed into an options page is not a promise. The browser
# learned this: concurrency 100 and debounce 0 were both accepted without comment.
_CLAMP = {
    "temperature": (0.0, 2.0),
    "numCtx": (0, 1048576),
    "requestTimeoutMs": (5000, 3600000),
    "debounceMs": (300, 20000),
    "minChars": (1, 500),
    "maxChars": (500, 200000),
    "chunkMaxChars": (120, 4000),
}


def clamp(key, value):
    """Keep a setting inside the range its consumers can survive."""
    if key not in _CLAMP:
        return value
    low, high = _CLAMP[key]
    try:
        n = type(low)(value)
    except (TypeError, ValueError):
        return DEFAULTS[key]
    return max(low, min(high, n))


def _access(ctx, updatable=False):
    service = ("com.sun.star.configuration.ConfigurationUpdateAccess" if updatable
               else "com.sun.star.configuration.ConfigurationAccess")
    provider = ctx.ServiceManager.createInstanceWithContext(
        "com.sun.star.configuration.ConfigurationProvider", ctx)
    import uno
    arg = uno.createUnoStruct("com.sun.star.beans.PropertyValue")
    arg.Name = "nodepath"
    arg.Value = NODE
    return provider.createInstanceWithArguments(service, (arg,))


def read(ctx):
    """Every setting, with defaults for anything missing or unreadable."""
    out = dict(DEFAULTS)
    out["categories"] = dict(DEFAULTS["categories"])
    try:
        root = _access(ctx)
    except Exception:
        return out                      # configuration unavailable: defaults will do

    for key, (group, prop) in _MAP.items():
        try:
            value = root.getByName(group).getByName(prop)
            if isinstance(DEFAULTS[key], list):
                out[key] = [v for v in (value or ()) if v]
            else:
                out[key] = clamp(key, value)
        except Exception:
            pass
    try:
        suggestions = root.getByName("Suggestions")
        for cat, prop in _CATEGORY_PROP.items():
            out["categories"][cat] = bool(suggestions.getByName(prop))
    except Exception:
        pass
    return out


def write(ctx, **changes):
    """Persist named settings. Unknown keys are ignored rather than raising."""
    try:
        root = _access(ctx, updatable=True)
    except Exception:
        return False
    touched = False
    for key, value in changes.items():
        if key == "categories":
            try:
                node = root.getByName("Suggestions")
                for cat, prop in _CATEGORY_PROP.items():
                    if cat in value:
                        node.setPropertyValue(prop, bool(value[cat]))
                touched = True
            except Exception:
                pass
            continue
        if key not in _MAP:
            continue
        group, prop = _MAP[key]
        try:
            node = root.getByName(group)
            if isinstance(DEFAULTS[key], list):
                node.setPropertyValue(prop, tuple(value))
            else:
                node.setPropertyValue(prop, clamp(key, value))
            touched = True
        except Exception:
            pass
    if touched:
        try:
            root.commitChanges()
        except Exception:
            return False
    return touched
