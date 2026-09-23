# -*- encoding: UTF-8 -*-
"""
The part-typed word, from the session that produced it.

    08:41:43  model: 69 chars  'Sorry, I don't speak very good English. I would wish that  I can spea'

The model reported "Missing letter 'k' and incomplete word", quoting a fragment. The
answer was cached, reused while the next one computed, and the fragment then matched
inside a correctly spelled `speak` EARLIER IN THE SENTENCE - offering to replace a
perfectly good word with itself.

anchor.py's own guards do not catch it. `already_there` drops the shapes where the
replacement contains the quote, which is most of them; these tests pin the two that get
through, because those are the ones that reached a user.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "src"))

import laita_lt_shared                                      # noqa: E402
laita_lt_shared.install()

import laita_lt_typing as typing_                           # noqa: E402
from laita_anchor import anchor_issues                      # noqa: E402

fails, passes = [], 0

FULL = ("Sorry, I don’t speak very good English. I would wish that  "
        "I can speak more languages....")


def check(name, got, want):
    global passes
    if got == want:
        passes += 1
    else:
        fails.append("%s\n    got  %r\n    want %r" % (name, got, want))


def anchored(text, original, replacement):
    return anchor_issues(text, [{"type": "error", "original": original,
                                 "replacement": replacement, "message": "m"}])


def main():
    # --- the case that reached a user -------------------------------------------------
    for original, replacement in (("I can spea", "speak"), ("spea", "speak more")):
        got = anchored(FULL, original, replacement)
        check("anchor.py alone still accepts %r" % original, len(got), 1)
        check("...and the guard drops it",
              [i for i in got
               if not typing_.inside_a_word(FULL, i["start"], i["end"])], [])

    # anchor.py already catches these; if that ever changes the guard is the backstop.
    for original, replacement in (("spea", "speak"), ("can spea", "can speak")):
        check("already_there still covers %r" % original, anchored(FULL, original, replacement), [])

    # --- a whole word must survive ------------------------------------------------------
    got = anchored(FULL, "wish", "hope")
    check("a real suggestion anchors", len(got), 1)
    check("...and is kept",
          typing_.inside_a_word(FULL, got[0]["start"], got[0]["end"]), False)
    check("a multi-word quote is kept",
          typing_.inside_a_word(FULL, FULL.index("very good"), FULL.index("very good") + 9), False)

    # --- boundaries --------------------------------------------------------------------
    t = "the cat sat"
    check("a whole word is not inside one", typing_.inside_a_word(t, 4, 7), False)
    check("a prefix of a word is", typing_.inside_a_word(t, 4, 6), True)
    check("a suffix of a word is", typing_.inside_a_word(t, 5, 7), True)
    check("the first word is fine", typing_.inside_a_word(t, 0, 3), False)
    check("the last word is fine", typing_.inside_a_word(t, 8, 11), False)
    check("an empty range is refused", typing_.inside_a_word(t, 4, 4), True)
    check("a range past the end is refused", typing_.inside_a_word(t, 4, 99), True)

    # Punctuation and apostrophes do not join words.
    check("a quote ending before an apostrophe is fine",
          typing_.inside_a_word("I don’t know", 2, 5), False)
    check("a hyphen does not join", typing_.inside_a_word("well-known fact", 0, 4), False)

    # Scripts without spaces: every character abuts another, so the guard must not fire
    # or nothing in Japanese would ever be suggested.
    jp = "これはテストです"
    check("japanese is not treated as one long word", typing_.inside_a_word(jp, 3, 6), False)
    check("chinese likewise", typing_.inside_a_word("我喜歡吃苹果", 2, 4), False)

    # --- what gets sent to the model ----------------------------------------------------
    check("a word in progress is not sent",
          typing_.without_part_typed_word(FULL[:69]),
          "Sorry, I don’t speak very good English. I would wish that  I can")
    check("a finished sentence is sent whole",
          typing_.without_part_typed_word(FULL), FULL)
    check("trailing punctuation means finished",
          typing_.without_part_typed_word("Bonjour tout le monde."), "Bonjour tout le monde.")
    check("a trailing space means the word is finished",
          typing_.without_part_typed_word("Bonjour tout le monde "),
          "Bonjour tout le monde ")
    check("an unpunctuated ending loses its last word - the known cost",
          typing_.without_part_typed_word("Maybe it's too bad"), "Maybe it's too")
    check("a single word is left alone rather than emptied",
          typing_.without_part_typed_word("Bonjour"), "Bonjour")
    check("a script without spaces is left alone",
          typing_.without_part_typed_word(jp), jp)
    check("a long trailing run is not a word in progress",
          typing_.without_part_typed_word("text " + "x" * 50), "text " + "x" * 50)
    check("empty stays empty", typing_.without_part_typed_word(""), "")

    print("%d passed, %d failed" % (passes, len(fails)))
    for f in fails:
        print("  FAIL " + f)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
