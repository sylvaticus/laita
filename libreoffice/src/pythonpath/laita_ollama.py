# -*- encoding: UTF-8 -*-
"""
Prompt construction, Ollama transport, and validation of what the model gives back.
A port of browser/src/background/ollama.js.

The prompts must stay byte-identical to the JavaScript. A quietly diverging prompt would
give LibreOffice users subtly worse suggestions than the browser, and nothing would ever
flag it - so test_prompts.py compares the generated strings against the JavaScript rather
than against expectations written here.

The transport is the one part that cannot be shared: urllib instead of fetch, a worker
thread instead of an AbortController.
"""
import json
import os
import re
import urllib.error
import urllib.request

# Bump when the prompt changes so stale cache entries are discarded.
PROMPT_VERSION = 4

LANGUAGE_NAMES = {
    "en": "English", "fr": "French", "it": "Italian", "es": "Spanish", "de": "German",
    "pt": "Portuguese", "nl": "Dutch", "ca": "Catalan", "ro": "Romanian", "pl": "Polish",
    "sv": "Swedish", "da": "Danish", "nb": "Norwegian", "no": "Norwegian", "fi": "Finnish",
    "cs": "Czech", "el": "Greek", "ru": "Russian", "tr": "Turkish", "ja": "Japanese",
    "zh": "Chinese", "ko": "Korean", "ar": "Arabic", "he": "Hebrew", "hi": "Hindi",
}

RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "issues": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "original": {"type": "string"},
                    "replacement": {"type": "string"},
                    "type": {"type": "string", "enum": ["error", "style", "rephrase"]},
                    "message": {"type": "string"},
                },
                "required": ["original", "replacement", "type", "message"],
            },
            # The "at most 12 issues" rule is otherwise prompt-only, and a chatty model's
            # 200-issue reply was accepted and anchored in full.
            "maxItems": 12,
        }
    },
    "required": ["issues"],
}

ISSUES_PREDICT_TOKENS = 2048


def language_name(code):
    if not code:
        return "the language of the text"
    return LANGUAGE_NAMES.get(str(code).lower().split("-")[0], code)


def build_system_prompt(settings, lang):
    L = language_name(lang)
    categories = settings.get("categories") or {}
    wanted = [k for k, on in categories.items() if on]

    cat_docs = {
        "error":
            '- "error": objectively wrong. Spelling, agreement, conjugation, wrong preposition, '
            "punctuation, capitalisation, doubled words, missing words.",
        "style":
            '- "style": not wrong, but weak. Wordiness, redundancy, needless passive voice, '
            "register mismatch, run-on sentences, clumsy repetition.",
        "rephrase":
            '- "rephrase": a better word or a clearer formulation. Vocabulary upgrade, '
            "more idiomatic or more natural phrasing.",
    }

    lines = [
        "You are a meticulous proofreader working in %s. You receive a fragment of text that a" % L,
        "user is typing into a web form. You report writing problems as JSON.",
        "",
        "Report only these categories:",
    ]
    lines += [cat_docs[c] for c in wanted if c in cat_docs]
    lines += [
        "",
        "Hard rules:",
        '- "original" MUST be an exact, verbatim, contiguous substring of the input, copied',
        "  character for character including its capitalisation and accents. Keep it as short as",
        "  possible while still unambiguous, normally a few words.",
        '- "replacement" MUST be a drop-in replacement for "original": substituting one for the',
        "  other must produce correct text. If you cannot give a concrete replacement, drop the issue.",
        '- "message" is a short explanation, at most 12 words, written in %s.' % L,
        "- Never flag proper nouns, brand names, technical jargon, URLs, code, placeholders, or a",
        "  missing full stop at the very end of the fragment.",
        "- The fragment may start or end mid-thought because it was cut out of a longer text. Never",
        "  flag that as an error.",
        "- Never rewrite the whole text, never translate it, never add content of your own.",
        "- Report at most 12 issues, the most important ones first.",
        '- If the text is fine, return {"issues": []}.',
    ]

    dictionary = settings.get("dictionary") or []
    if dictionary:
        lines += ["", "Always treat these as correctly spelled and never flag them: "
                  + ", ".join(dictionary[:300])]
    extra = (settings.get("extraInstructions") or "").strip()
    if extra:
        lines += ["", "Additional house rules:", extra]
    return "\n".join(lines)


def fence_tag():
    """A per-request nonce, so page text cannot close the fence and be read as prompt."""
    return os.urandom(6).hex()


def defuse(text, tag):
    marker = re.compile("(<<<TEXT_%s|TEXT_%s>>>)" % (re.escape(tag), re.escape(tag)))
    return marker.sub("​\\1", str(text))


def fence_text(text, tag=None):
    tag = tag or fence_tag()
    return "<<<TEXT_%s\n%s\nTEXT_%s>>>" % (tag, defuse(text, tag), tag)


def build_user_prompt(text, lang, tag=None):
    return "Proofread this %s text:\n" % language_name(lang) + fence_text(text, tag)


_THINK = re.compile(r"<think>.*?</think>", re.IGNORECASE | re.DOTALL)


def parse_issues(content):
    raw = _THINK.sub("", str(content)).strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.IGNORECASE)
    raw = re.sub(r"```\s*$", "", raw).strip()

    obj = None
    try:
        obj = json.loads(raw)
    except ValueError:
        start = raw.find("{")
        end = raw.rfind("}")
        if start >= 0 and end > start:
            try:
                obj = json.loads(raw[start:end + 1])
            except ValueError:
                pass
    if obj is None:
        raise ValueError("Could not parse the model's answer as JSON.")
    issues = obj if isinstance(obj, list) else obj.get("issues")
    return issues if isinstance(issues, list) else []


def runner_options(settings, predict_tokens=None):
    options = {"temperature": float(settings.get("temperature") or 0)}
    pinned = int(settings.get("numCtx") or 0)
    if pinned > 0:
        options["num_ctx"] = pinned
    if predict_tokens and predict_tokens > 0:
        options["num_predict"] = int(predict_tokens)
    return options


def request_issues(text, lang, settings, timeout=None):
    """One blocking POST to /api/chat. Blocking is correct here: this runs on a worker
    thread, and LibreOffice is never waiting on it."""
    base = str(settings.get("endpoint") or "").rstrip("/")
    body = {
        "model": settings.get("model"),
        "stream": False,
        "think": bool(settings.get("think")),
        "format": RESPONSE_SCHEMA,
        "keep_alive": settings.get("keepAlive"),
        "options": runner_options(settings, ISSUES_PREDICT_TOKENS),
        "messages": [
            {"role": "system", "content": build_system_prompt(settings, lang)},
            {"role": "user", "content": build_user_prompt(text, lang)},
        ],
    }
    req = urllib.request.Request(
        base + "/api/chat",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout or 90) as res:
        payload = json.loads(res.read().decode("utf-8"))
    return parse_issues((payload.get("message") or {}).get("content", ""))


def list_models(settings, timeout=10):
    """Every model Ollama has, for the options dialog to offer.

    Separate from probe() because the dialog wants the list even when the configured
    model is not in it - that is precisely the case worth showing.
    """
    base = str(settings.get("endpoint") or "").rstrip("/")
    req = urllib.request.Request(base + "/api/tags", method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as res:
        payload = json.loads(res.read().decode("utf-8"))
    return sorted(m.get("name", "") for m in payload.get("models", []) if m.get("name"))


def probe(settings, timeout=10):
    """Can we reach Ollama, and does it have the configured model?

    Deliberately a POST for the second half: a GET carries no Origin header, so on the
    browser it reported success while real checks were refused. It carries no Origin
    here either, but the same reasoning applies to anything proxying in between - and
    asking the way the real request asks is the only test worth trusting.
    """
    models = list_models(settings, timeout)
    wanted = settings.get("model")
    base = str(settings.get("endpoint") or "").rstrip("/")
    req = urllib.request.Request(
        base + "/api/show",
        data=json.dumps({"model": wanted}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout):
            pass
    except urllib.error.HTTPError as err:
        if err.code != 404:                     # 404 just means the model is missing
            raise
    return {"models": models, "hasModel": wanted in models}


def describe_error(err):
    """Turn a transport failure into something a person can act on.

    Never raised at the caller: a grammar checker that lets an exception escape gets a
    blocking modal dialog from LibreOffice on the first keystroke.
    """
    if isinstance(err, urllib.error.HTTPError):
        if err.code == 404:
            return "Ollama does not have that model. Run `ollama pull <model>`."
        if err.code == 403:
            return ("Ollama refused the request. LibreOffice sends no Origin header, so "
                    "OLLAMA_ORIGINS is not the cause - check whether something is proxying.")
        return "Ollama answered HTTP %d." % err.code
    if isinstance(err, urllib.error.URLError):
        return "Cannot reach Ollama at this endpoint. Is it running?"
    if isinstance(err, TimeoutError):
        return "The request to Ollama timed out."
    return "Ollama request failed: %s" % err


def is_transient(err):
    """Worth one retry: a model runner that failed to start, or a connection hiccup."""
    if isinstance(err, urllib.error.HTTPError):
        return err.code >= 500
    return isinstance(err, (urllib.error.URLError, TimeoutError))
