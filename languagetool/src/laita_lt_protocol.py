# -*- encoding: UTF-8 -*-
"""
LAITA's issues expressed as LanguageTool API matches.

Pure translation: no network, no threads, no clock. Everything that decides WHEN the
model runs is in laita_lt_server.py; everything about WHAT the wire looks like is here,
so it can be tested against the reading half without starting anything.

The reading half is LibreOffice core, lingucomponent/source/spellcheck/languagetool/
languagetoolimp.cxx, and four details of it are not guessable:

  * nErrorStart and nErrorLength are taken straight from `offset` and `length`. They index
    a UNO string, which is UTF-16, and LanguageTool's own offsets are UTF-16 too (the
    reference implementation is Java). Python indexes code points. They agree until a
    character outside the BMP appears - one emoji shifts everything after it by one - so
    the conversion is explicit here, exactly as the extension does it at the UNO boundary.

  * The underline colour comes from `rule.category.id`, through a fixed table:
    "TYPOS" and "orth" are red, "STYLE" is blue, and everything else is orange. There is
    no way to send a colour. So LAITA's three categories are spelled with whichever
    category id produces the colour the extension already uses - which is why `style`
    below is sent as "GRAMMAR". It looks like a mistranslation and is the opposite: it is
    what keeps a style suggestion the same orange in Collabora as in LibreOffice.

  * aShortComment is filled from `message`. `shortMessage` is read into the same variable
    first and overwritten, so sending only `shortMessage` would produce an empty tooltip;
    both are sent, identical.

  * aRuleIdentifier is never set on this path. The extension puts a suggestion's
    fingerprint there so that "Ignore All" silences one suggestion rather than a whole
    category - that cannot work here, and the rule id below is informational only. An
    ignore list is therefore server-wide, set in the configuration file, and there is no
    per-user equivalent. Said plainly in README.md rather than discovered.
"""

# LAITA category -> the LanguageTool category id that yields the extension's own colour.
# LINE_COLOUR in libreoffice/src/laita.py: error red, style orange, rephrase blue.
CATEGORY_ID = {
    "error": "TYPOS",       # -> COL_LIGHTRED
    "style": "GRAMMAR",     # -> COL_ORANGE   (anything not TYPOS/orth/STYLE)
    "rephrase": "STYLE",    # -> COL_LIGHTBLUE
}
CATEGORY_NAME = {
    "error": "Error",
    "style": "Style",
    "rephrase": "Rephrase",
}

# The reader keeps at most ten replacements per match. LAITA produces exactly one - the
# model is asked for a drop-in replacement, not a list - so the limit is never in play.
# It is noted here only so that nobody goes looking for where we truncate.


def language_tag(raw):
    """The language to prompt in, from whatever the client sent.

    LibreOffice sends a full tag such as "fr-FR"; laita_ollama.language_name already takes
    the primary subtag. "auto" means the client wants detection, which this does not do -
    the prompt then simply says "the language of the text".
    """
    tag = (raw or "").strip()
    if not tag or tag.lower() in ("auto", "und"):
        return None
    return tag


def match(text, issue, to_utf16):
    """One anchored LAITA issue as one LanguageTool match.

    `to_utf16` is laita_anchor.to_utf16_index, passed in so this module imports nothing.
    """
    start = to_utf16(text, issue["start"])
    end = to_utf16(text, issue["end"])
    type_ = issue.get("type") or "error"
    message = issue.get("message") or "LAITA suggestion"
    return {
        "message": message,
        "shortMessage": message,
        "offset": start,
        "length": end - start,
        "replacements": [{"value": issue["replacement"]}],
        "context": context(text, issue["start"], issue["end"], to_utf16),
        "rule": {
            # Informational: nothing reads it back. The fingerprint is kept in it anyway
            # so that a log line here can be matched against one from the extension.
            "id": "LAITA_%s_%s" % (type_.upper(), issue.get("fp", "")),
            "description": "LAITA %s" % type_,
            "issueType": {"error": "misspelling", "style": "style",
                          "rephrase": "style"}.get(type_, "style"),
            "category": {"id": CATEGORY_ID.get(type_, "GRAMMAR"),
                         "name": CATEGORY_NAME.get(type_, "LAITA")},
        },
    }


CONTEXT_WINDOW = 40


def context(text, start, end, to_utf16):
    """The snippet a client shows around a match. LibreOffice ignores it; a human
    curling /v2/check to see what the model said does not."""
    left = max(0, start - CONTEXT_WINDOW)
    right = min(len(text), end + CONTEXT_WINDOW)
    snippet = text[left:right]
    return {
        "text": snippet,
        "offset": to_utf16(snippet, start - left),
        "length": to_utf16(text, end) - to_utf16(text, start),
    }


def check_response(text, issues, lang, to_utf16, name="LAITA", version="0"):
    """The whole body of a /v2/check reply."""
    tag = lang or "auto"
    return {
        "software": {
            "name": name,
            "version": version,
            "apiVersion": 1,
            "status": "",
            "premium": False,
        },
        "language": {
            "name": tag,
            "code": tag,
            "detectedLanguage": {"name": tag, "code": tag, "confidence": 1.0},
        },
        "matches": [match(text, i, to_utf16) for i in issues],
    }


def languages_response(codes, names):
    """/v2/languages, advisory only.

    LibreOffice does not read it - it takes its locale list from its own linguistic
    configuration - and nothing here restricts what will be checked: a request naming a
    language absent from this list is proofread in that language regardless, because the
    prompt simply says what the client said. The endpoint exists because it is part of
    the API and a client that asks and gets a 404 may decide the server is not one.

    `names` is laita_ollama.LANGUAGE_NAMES, passed in for the same reason `to_utf16` is:
    this module imports nothing. An unlisted code is shown as itself.
    """
    out = []
    for code in codes:
        primary = code.split("-")[0]
        out.append({"name": names.get(primary, code), "code": primary, "longCode": code})
    return out
