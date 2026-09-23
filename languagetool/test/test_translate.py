# -*- encoding: UTF-8 -*-
"""
Translation: the markup handling, and the rule that must never break.

Collabora pastes whatever comes back over the user's selection, and pastes an EMPTY
STRING when the request fails - a reported bug in the real DeepL integration, which is
why "never return nothing" is asserted here from every direction it can fail from.

The markup half is the other risk. The model is never shown a tag and never asked to
write one, so it cannot invent, drop or reorder one; these tests pin that the tags
survive the round trip untouched while the text goes through the model.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "src"))

import laita_lt_shared                                      # noqa: E402
laita_lt_shared.install()

import laita_lt_config                                      # noqa: E402
import laita_lt_translate as tr                             # noqa: E402
from laita_lt_server import Checker                         # noqa: E402
from laita_ollama import LANGUAGE_NAMES                     # noqa: E402

fails, passes = [], 0


def check(name, got, want):
    global passes
    if got == want:
        passes += 1
    else:
        fails.append("%s\n    got  %r\n    want %r" % (name, got, want))


def settings(**over):
    s = laita_lt_config.defaults()
    s.update(over)
    return s


def translated(html, model=lambda text: "[%s]" % text, **over):
    """Run html through the real Checker with the model replaced."""
    c = Checker(settings(**over), log=lambda m: None)
    import laita_ollama
    real = laita_ollama.request_transform
    laita_ollama.request_transform = lambda text, instr, lang, s, timeout=None: model(text)
    try:
        return c.translate(html, over.pop("target", "FR"))
    finally:
        laita_ollama.request_transform = real


def main():
    # --- the markup survives, the model never sees it ---------------------------------
    seen = []

    def spy(text):
        seen.append(text)
        return "TRANSLATED"

    out, _ = translated("<p>Le <b>chat</b> dort</p>", spy)
    check("inline tags are dropped", out, "<p>TRANSLATED</p>")
    check("...and their text joins the sentence around them", seen, ["Le chat dort"])

    del seen[:]
    out, _ = translated("<ul><li>Pommes</li><li>Poires</li></ul>", spy)
    check("block structure is kept", out, "<ul><li>TRANSLATED</li><li>TRANSLATED</li></ul>")
    check("...one run per block", seen, ["Pommes", "Poires"])

    # A single paragraph arrives wrapped in <span>, which is how Collabora avoids
    # inserting a paragraph break. Dropping it keeps that property.
    out, _ = translated("<span>Bonjour</span>")
    check("a single-paragraph span leaves no tag behind", out, "[Bonjour]")

    # The model's answer is escaped on the way out. It is never asked for markup, so
    # anything tag-shaped in its reply is either a mistake or an injection, and either
    # way it must land as text rather than as structure - this result is PASTED.
    out, _ = translated("<p>Salut</p>", lambda t: '<script>alert(1)</script>')
    check("markup from the model is escaped, not pasted as markup",
          out, "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>")

    del seen[:]
    out, _ = translated(
        "<html><head><style>p{color:red}</style></head><body><p>Salut</p></body></html>", spy)
    check("a stylesheet is not translated", seen, ["Salut"])
    check("...and is passed through untouched",
          "<style>p{color:red}</style>" in out, True)

    out, _ = translated("<p>Bonjour &amp; merci</p>", lambda t: t.upper())
    check("entities are decoded for the model and re-escaped after",
          out, "<p>BONJOUR &amp; MERCI</p>")

    del seen[:]
    translated("<p>  Bonjour  </p>", spy)
    check("the model sees the text with its spacing", seen, ["  Bonjour  "])
    out, _ = translated("<p>  Bonjour  </p>", lambda t: "Hello")
    check("...and the space around it is preserved, not translated",
          out, "<p>  Hello  </p>")

    out, _ = translated("texte sans balises", lambda t: "plain text")
    check("text with no markup at all works", out, "plain text")

    # --- NEVER return nothing ------------------------------------------------------------
    # Each of these pastes over the user's selection if it comes back empty.
    original = "<p>Ne me supprimez pas</p>"
    for name, model in (("the model returns an empty string", lambda t: ""),
                        ("the model returns only whitespace", lambda t: "   \n "),
                        ("the model returns None", lambda t: None)):
        out, why = translated(original, model)
        check("%s -> the original is returned" % name, out, original)
        check("   ...and it says why", "unchanged" in why, True)

    def explode(text):
        raise RuntimeError("ollama is down")

    out, why = translated(original, explode)
    check("a model that raises returns the original", out, original)
    check("   ...and it says why", "unchanged" in why, True)

    out, why = translated(original, target="")
    check("no target language leaves the text alone", out, original)
    out, why = translated(original, lambda t: "x", translate=False)
    check("switched off leaves the text alone", out, original)
    check("...and says so", "switched off" in why, True)
    out, why = translated("<p>   </p>", lambda t: "x")
    check("nothing worth translating leaves the text alone", out, "<p>   </p>")

    # --- language naming ------------------------------------------------------------------
    check("a plain code", tr.language_name("FR", LANGUAGE_NAMES), "French")
    check("lower case too", tr.language_name("fr", LANGUAGE_NAMES), "French")
    check("a regional variant is named in full",
          tr.language_name("EN-GB", LANGUAGE_NAMES), "British English")
    check("and the other one", tr.language_name("PT-BR", LANGUAGE_NAMES),
          "Brazilian Portuguese")
    check("an unknown variant falls back to the primary subtag",
          tr.language_name("de-AT", LANGUAGE_NAMES), "German")
    check("an unknown code is passed through", tr.language_name("xx", LANGUAGE_NAMES), "xx")
    check("nothing means nothing", tr.language_name("", LANGUAGE_NAMES), None)

    check("the instruction names the language",
          "French" in tr.instruction("French"), True)

    print("%d passed, %d failed" % (passes, len(fails)))
    for f in fails:
        print("  FAIL " + f)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
