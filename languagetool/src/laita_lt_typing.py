# -*- encoding: UTF-8 -*-
"""
Text that is still being typed, and the two things that go wrong because of it.

Every other LAITA surface checks text a moment after it stopped changing. This one is
asked on every keystroke and answers about whatever snapshot it was given, so it sees
half-written words constantly - and a half-written word is a trap at both ends.

Measured, from a real session:

    08:41:43  model: 69 chars  'Sorry, I don't speak very good English. I would wish that  I can spea'

The model did exactly as asked and reported "Missing letter 'k' and incomplete word",
quoting `spea` and replacing it with `speak`. Both halves of that then went wrong:

  1. It was shown to the user, underlining the word they were in the middle of typing and
     telling them a letter was missing. A spell checker does not do that, and neither
     should this: the word under the cursor is not finished yet.

  2. Worse, the answer was cached and reused while the next answer computed, and `spea`
     is a substring of the finished `speak`. It anchored at character 15 - inside a
     COMPLETELY DIFFERENT, correctly spelled `speak` earlier in the sentence - and offered
     to replace it with itself.

So: do not ask about the part-typed word (1), and never let a quote match inside a longer
word (2). The second guard is what makes stale answers safe, and it is the load-bearing
one; the first only stops the model wasting an issue on a word that is not finished.

Nothing here is in laita_anchor.py on purpose. That file is a transcription of
browser/src/background/anchor.js and the two are tested against each other; a guard added
to one and not the other breaks the parity that keeps them honest. If this proves right
here, it belongs in the JavaScript first and in the port after.
"""

# Ranges in which a character abutting a word does not mean the word continues, because
# the script does not put spaces between words in the first place. Without this the guard
# below would reject every suggestion in Japanese, Chinese and Korean.
_NO_WORD_SPACES = (
    (0x3040, 0x30FF),    # hiragana, katakana
    (0x3400, 0x4DBF),    # CJK extension A
    (0x4E00, 0x9FFF),    # CJK unified ideographs
    (0xF900, 0xFAFF),    # CJK compatibility ideographs
    (0xAC00, 0xD7AF),    # hangul syllables
    (0x20000, 0x2FA1F),  # CJK extensions B and beyond
)

# A fragment longer than this is not somebody midway through a word.
MAX_FRAGMENT = 40


def continues_a_word(ch):
    """Would this character be part of the same word as the one next to it?"""
    if not ch or not ch.isalnum():
        return False
    point = ord(ch)
    return not any(low <= point <= high for low, high in _NO_WORD_SPACES)


def inside_a_word(text, start, end):
    """Is [start, end) only a PART of a longer word in `text`?

    This is the guard that makes a cached answer safe to reuse against edited text. A
    quote the model made about an older version of a paragraph may still be findable in
    the new one - as a fragment of something else.
    """
    if start >= end or start < 0 or end > len(text):
        return True
    if text[start].isalnum() and continues_a_word(text[start - 1] if start else ""):
        return True
    if text[end - 1].isalnum() and continues_a_word(text[end] if end < len(text) else ""):
        return True
    return False


def without_part_typed_word(text):
    """`text` with a final, unfinished word removed - or unchanged if there is not one.

    "unfinished" means only "ends in a letter or digit", which is also true of a paragraph
    somebody has finished writing and not punctuated. That is the cost: the last word of
    such a paragraph is not checked until a space or a full stop follows it. It is the
    same bargain every spell checker makes, and the alternative - telling people a letter
    is missing from the word they are still typing - is worse.
    """
    if not text or not text[-1].isalnum():
        return text                     # ends in space or punctuation: nothing in flight
    cut = max(text.rfind(" "), text.rfind("\n"), text.rfind("\t"), text.rfind(" "))
    if cut < 0:
        return text                     # one word, or a script that uses no spaces
    if len(text) - cut - 1 > MAX_FRAGMENT:
        return text                     # too long to be a word in progress
    trimmed = text[:cut].rstrip()
    return trimmed or text
