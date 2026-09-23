# -*- encoding: UTF-8 -*-
"""
The wire format, checked against what LibreOffice core actually reads.

Everything asserted here is a fact about lingucomponent/source/spellcheck/languagetool/
languagetoolimp.cxx, not a preference. Where a value looks wrong - style sent as
"GRAMMAR" - the test says why it is right, because the next person to read it will
otherwise "fix" it and change the colour of every style suggestion.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "src"))

import laita_lt_shared                                      # noqa: E402
laita_lt_shared.install()

import laita_lt_protocol as protocol                        # noqa: E402
from laita_anchor import to_utf16_index, anchor_issues       # noqa: E402

fails, passes = [], 0


def check(name, got, want):
    global passes
    if got == want:
        passes += 1
    else:
        fails.append("%s\n    got  %r\n    want %r" % (name, got, want))


def issue(**kw):
    base = {"start": 0, "end": 4, "original": "Ceci", "replacement": "Cela",
            "type": "error", "message": "m", "fp": "abcd1234"}
    base.update(kw)
    return base


def main():
    # --- offsets are UTF-16, because nErrorStart indexes a UNO string ----------------
    text = "Ceci est un test."
    m = protocol.match(text, issue(), to_utf16_index)
    check("offset of a plain match", m["offset"], 0)
    check("length of a plain match", m["length"], 4)

    # One emoji is two UTF-16 code units. A Python index would be one too small here,
    # and every underline after it would sit one character to the left.
    emoji = "\U0001F600 mistake here"
    start = emoji.index("mistake")
    m = protocol.match(emoji, issue(start=start, end=start + 7, original="mistake"),
                       to_utf16_index)
    check("emoji shifts the offset by one", m["offset"], start + 1)
    check("...and python index would have been", start, 2)
    check("length is unaffected", m["length"], 7)

    # An astral character INSIDE the span must lengthen it too.
    inside = "say \U0001F600 now"
    m = protocol.match(inside, issue(start=4, end=6, original="\U0001F600 "), to_utf16_index)
    check("astral char inside the span counts twice", m["length"], 3)

    # --- category id decides the colour, and there is no other way to send one -------
    # languagetoolimp.cxx: "TYPOS"/"orth" -> red, "STYLE" -> blue, anything else
    # -> orange. LINE_COLOUR in the extension: error red, style orange, rephrase blue.
    for type_, want_id in (("error", "TYPOS"), ("style", "GRAMMAR"), ("rephrase", "STYLE")):
        m = protocol.match(text, issue(type=type_), to_utf16_index)
        check("%s keeps the extension's colour via %s" % (type_, want_id),
              m["rule"]["category"]["id"], want_id)

    # --- both message fields, because the reader overwrites one with the other -------
    m = protocol.match(text, issue(message="Accord du verbe"), to_utf16_index)
    check("message is sent", m["message"], "Accord du verbe")
    check("shortMessage matches it", m["shortMessage"], "Accord du verbe")
    m = protocol.match(text, issue(message=""), to_utf16_index)
    check("an empty message still says something", m["message"], "LAITA suggestion")

    # --- replacements ----------------------------------------------------------------
    m = protocol.match(text, issue(replacement="Cela"), to_utf16_index)
    check("the replacement is offered", m["replacements"], [{"value": "Cela"}])

    # --- language tags ----------------------------------------------------------------
    check("a full tag survives", protocol.language_tag("fr-FR"), "fr-FR")
    check("auto means no language", protocol.language_tag("auto"), None)
    check("und means no language", protocol.language_tag("und"), None)
    check("blank means no language", protocol.language_tag(""), None)
    check("None means no language", protocol.language_tag(None), None)

    # --- the whole body ----------------------------------------------------------------
    body = protocol.check_response(text, [issue()], "fr-FR", to_utf16_index)
    check("matches is a list", isinstance(body["matches"], list), True)
    check("one match", len(body["matches"]), 1)
    check("language echoed", body["language"]["code"], "fr-FR")
    check("no language echoes auto",
          protocol.check_response(text, [], None, to_utf16_index)["language"]["code"], "auto")
    check("no issues is an empty list, not absent",
          protocol.check_response(text, [], "en-US", to_utf16_index)["matches"], [])

    # --- languages listing --------------------------------------------------------------
    langs = protocol.languages_response(["fr-FR", "en-GB"])
    check("longCode is the full tag", [x["longCode"] for x in langs], ["fr-FR", "en-GB"])
    check("code is the primary subtag", [x["code"] for x in langs], ["fr", "en"])

    # --- end to end: a model answer becomes matches --------------------------------------
    # anchor_issues is the extension's, unmodified; this checks the join, not the anchoring.
    para = "Je suis alle au marche hier. Il faisait tres beau."
    raw = [{"type": "error", "original": "alle", "replacement": "allé",
            "message": "Participe passe"}]
    anchored = anchor_issues(para, raw)
    body = protocol.check_response(para, anchored, "fr-FR", to_utf16_index)
    check("an anchored issue produces one match", len(body["matches"]), 1)
    check("and it points at the quote",
          para[body["matches"][0]["offset"]:
               body["matches"][0]["offset"] + body["matches"][0]["length"]], "alle")
    check("a quote that is not in the text produces nothing",
          protocol.check_response(
              para, anchor_issues(para, [{"type": "error", "original": "absent",
                                          "replacement": "x", "message": ""}]),
              "fr-FR", to_utf16_index)["matches"], [])

    print("%d passed, %d failed" % (passes, len(fails)))
    for f in fails:
        print("  FAIL " + f)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
