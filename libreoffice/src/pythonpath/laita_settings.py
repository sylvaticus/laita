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
    "keepAlive": "1h",
    "requestTimeoutMs": 90000,
    "think": False,
    "enabled": True,
    "checkAsYouType": True,
    "debounceMs": 1500,
    "minChars": 25,
    "maxChars": 12000,
    "chunkMaxChars": 700,
    "scope": "caret",
    "categories": {"error": True, "style": True, "rephrase": True},
    "dictionary": [],
    "ignored": [],
    "extraInstructions": "",
    "transformDefault": "polish",
    "transformHistory": [],
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
    "scope": ("Checking", "Scope"),
    "dictionary": ("Suggestions", "Dictionary"),
    "ignored": ("Suggestions", "Ignored"),
    "extraInstructions": ("Suggestions", "ExtraInstructions"),
    "transformDefault": ("Suggestions", "TransformDefault"),
    "transformHistory": ("Suggestions", "TransformHistory"),
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
    "chunkMaxChars": (0, 4000),
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


# Anything that went wrong in the last write, for a caller that wants to know.
_problems = []


def _set_string_list(node, prop, value):
    """Write an oor:string-list.

    A plain Python list or tuple is refused with "configmgr inappropriate property
    value": the configuration wants a typed sequence, and pyuno will not accept a
    uno.Any as a normal argument - hence uno.invoke. Nothing about the error says any of
    this, and the failure looks exactly like a value that did not stick.
    """
    import uno
    uno.invoke(node, "setPropertyValue",
               (prop, uno.Any("[]string", tuple(str(v) for v in value))))


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
    del _problems[:]
    touched = False
    for key, value in changes.items():
        if key == "categories":
            try:
                node = root.getByName("Suggestions")
                for cat, prop in _CATEGORY_PROP.items():
                    if cat in value:
                        node.setPropertyValue(prop, bool(value[cat]))
                touched = True
            except Exception as err:
                _problems.append("categories: %r" % (err,))
            continue
        if key not in _MAP:
            continue
        group, prop = _MAP[key]
        try:
            node = root.getByName(group)
            if isinstance(DEFAULTS[key], list):
                _set_string_list(node, prop, value)
            else:
                node.setPropertyValue(prop, clamp(key, value))
            touched = True
        except Exception as err:
            # Logged rather than swallowed. A silent failure here reported success and
            # then read back an empty list, which is how the dictionary and the ignore
            # list appeared to save and did not.
            _problems.append("%s: %r" % (key, err))
    if touched:
        try:
            root.commitChanges()
        except Exception as err:
            _problems.append("commit: %r" % (err,))
            return False
    return touched and not _problems


def last_write_problems():
    """Why the last write did not do what was asked, if it did not."""
    return list(_problems)
