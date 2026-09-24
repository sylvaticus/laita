# -*- encoding: UTF-8 -*-
"""
Splitting a paragraph into pieces small enough to be worth sending.

A port of the chunking half of browser/src/content/segment.js. Chunking is ON here,
splitting paragraphs longer than 700 characters, and getting there took two measurements
because the first one was wrong.

The first, recorded here as "splitting is nearly four times slower", timed the wall clock
only:

    paragraph   whole            in 700-char chunks
    551 chars    7.9s  3 issues    9.4s  3 issues
    1379 chars  41.0s  3 issues   98.4s  6 issues
    2483 chars  49.5s  3 issues  191.9s 12 issues

The second read Ollama's own token counters (browser/tools/measure-chunking.mjs) and
found the slowdown was not the splitting. Reading the input is nearly free - a second or
less for hundreds of tokens; all the time goes on the model WRITING its answer, at a
near-constant ~55 output tokens per issue found. Split or whole, the cost per issue is
the same. The "four times" was two artifacts: this is a laptop GPU, and sustained
generation drove it into thermal throttling (22 tok/s falling to 4), and the whole run
always measured whole-then-split, so the split arm inherited the hotter card. Measuring
by tokens instead of seconds, and running the comparison ABBA, both disappear.

So splitting is not a penalty; it is a proportional trade that also buys COVERAGE. One
request stops at twelve issues (the schema caps it), so on a long paragraph a
whole-paragraph check silently misses everything past the twelfth - splitting is the only
way to find them. That is why the default is 700 rather than 0. A limit of 0 is still
accepted, for anyone who would rather send whole paragraphs and live with the cap.

One deliberate difference from the JavaScript. The browser uses Intl.Segmenter for
sentence boundaries and falls back to a regular expression where it is unavailable;
Python has no equivalent in the standard library, so this is the fallback, always. The
consequence is only WHERE a long paragraph is divided - never whether a suggestion is
correct, because the model quotes text and anchoring finds the quote wherever it lands.
test_segment.py measures the divergence rather than assuming it away.
"""
import re

MIN_LIMIT = 120

# The same expression the JavaScript falls back to: run to a sentence-ending mark, then
# take any closing quotes or brackets with it.
_SENTENCE = re.compile(r"[^.!?…]*[.!?…]+[\s\"'”»)]*|[^.!?…]+$")


def sentences(text):
    """[(start, text)] for each sentence, offsets relative to `text`."""
    out = []
    for m in _SENTENCE.finditer(text):
        if not m.group(0):
            break
        out.append((m.start(), m.group(0)))
    return out


def chunk_text(text, max_chars=0):
    """[(start, text)] - pieces of `text` no larger than the limit where possible.

    A limit of 0 means do not chunk. The default is 700, not 0 - see the note at the top
    of this file for why the earlier "off by default" was withdrawn.

    Offsets are absolute within `text`, and leading or trailing blank space is trimmed
    off the piece while the offset still points at the first real character. That is
    what lets an anchored issue be reported against the paragraph rather than the chunk.
    """
    if not max_chars:
        chunks = []
        lead = len(text) - len(text.lstrip())
        if len(text.strip()) >= 2:
            chunks.append((lead, text.strip()))
        return chunks
    limit = max(MIN_LIMIT, int(max_chars))
    chunks = []

    def push(start, body):
        lead = len(body) - len(body.lstrip())
        trimmed = body.strip()
        if len(trimmed) >= 2:
            chunks.append((start + lead, trimmed))

    if len(text.strip()) <= limit:
        push(0, text)
        return chunks

    # Too long: pack whole sentences until the limit would be exceeded.
    buf_start = None
    buf = ""
    for start, sentence in sentences(text):
        if buf and len(buf) + len(sentence) > limit:
            push(buf_start, buf)
            buf, buf_start = "", None
        if not buf:
            buf_start = start
        buf += sentence
        # A single sentence longer than the limit goes out on its own.
        if len(buf) >= limit:
            push(buf_start, buf)
            buf, buf_start = "", None
    if buf:
        push(buf_start, buf)
    return chunks


# --- answering LibreOffice one sentence at a time ------------------------------------------
# No JavaScript twin: this exists only because of how LibreOffice's grammar-checking
# iterator (linguistic/source/gciterator.cxx) consumes a proofreader's answer.

def from_utf16_index(text, u16):
    """Code-point index for a UTF-16 index into `text`. LibreOffice counts UTF-16 units,
    Python counts code points; they differ once a character outside the BMP appears."""
    units = 0
    for i, ch in enumerate(text):
        if units >= u16:
            return i
        units += 2 if ord(ch) > 0xFFFF else 1
    return len(text)


def sentence_slice(text, issues, start, suggested_end):
    """The part of a paragraph's answer that belongs to the sentence LibreOffice asked about.

    LibreOffice does not take a proofreader's word for where a sentence ends. After every
    doProofreading call it recomputes nStartOfNextSentencePosition from
    nBehindEndOfSentencePosition - substituting its own suggested end when that is unset -
    and then asks again for the next sentence. So the old trick of answering the whole
    paragraph on the first call and claiming the sentence ran to the end of the text did
    nothing, and worse: each later sentence was answered with no errors, and LibreOffice's
    ClearGrammarList() for that sentence wiped the errors just committed there. Only
    errors in a paragraph's FIRST sentence ever survived - which is why short or split
    paragraphs worked and long ones never did.

    `start` and `suggested_end` are code-point indexes. Returns the issues that begin
    inside this sentence: from `start` up to where LibreOffice will begin the next one,
    i.e. after the whitespace that follows the sentence end.
    """
    n = len(text)
    end = suggested_end if start < suggested_end <= n else n
    nxt = end
    while nxt < n and text[nxt].isspace():
        nxt += 1
    upto = nxt if nxt < n else n + 1
    return [i for i in issues if start <= i["start"] < upto]
