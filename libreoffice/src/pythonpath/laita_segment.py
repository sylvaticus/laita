# -*- encoding: UTF-8 -*-
"""
Splitting a paragraph into pieces small enough to be worth sending.

A port of the chunking half of browser/src/content/segment.js. **Chunking is off by default here, and the reason is worth reading before turning it
on.** It was ported on the browser's rationale - that latency grows faster than the text
- and measuring it against a real model contradicted that:

    paragraph   whole            in 700-char chunks
    551 chars    7.9s  3 issues    9.4s  3 issues
    1379 chars  41.0s  3 issues   98.4s  6 issues
    2483 chars  49.5s  3 issues  191.9s 12 issues

Splitting is nearly four times SLOWER, and the gap widens with length: the cost is
dominated by generating the answer and by re-processing the system prompt once per
request, not by the length of the input. 1379 to 2483 characters cost 41s to 49s whole,
which is sub-linear.

What splitting does buy is coverage - twelve issues instead of three, because the model
caps itself at twelve per request. That is a real choice between thoroughness and speed,
so it is a setting rather than a default.

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

    A limit of 0 means do not chunk, which is the default and, on the evidence, the
    right one - see the note at the top of this file.

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
