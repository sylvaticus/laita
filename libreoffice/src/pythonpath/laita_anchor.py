# -*- encoding: UTF-8 -*-
"""
Turn the model's quoted substrings back into exact ranges. A port of
browser/src/background/anchor.js, kept deliberately close to it.

Every guard here was paid for with corrupted text in the browser or in VS Code, so this
is a transcription rather than a reimplementation: same order, same thresholds, same
names. test_anchor.py is the browser's anchor.test.mjs ported alongside, and the two must
agree - a second implementation is a second place for these to be wrong.

Two things differ from JavaScript and neither is cosmetic:

  * JS strings are sequences of UTF-16 code units; Python strings are code points. The
    fingerprint hash walks code units, so it is computed over UTF-16 here too and
    produces the same value as the browser for the same issue.

  * Offsets in this module are PYTHON indices. LibreOffice's nErrorStart/nErrorLength are
    UTF-16 indices, because a UNO string is a UTF-16 string. They agree until a character
    outside the BMP appears - one emoji shifts everything after it by one - so the
    conversion happens at the UNO boundary, in to_utf16_index() below, and not by
    accident.
"""

RANK = {"error": 0, "style": 1, "rephrase": 2}

# JavaScript's \s, spelled out. Python's str.isspace() is not the same set: it includes
# the C1 separators and excludes U+FEFF.
JS_SPACE = set("\f\n\r\t\v       　﻿") | {
    chr(c) for c in range(0x2000, 0x200B)
}

# Typographic variants that should not stop us from finding a quote.
CHAR_FOLD = {
    "‘": "'", "’": "'", "‛": "'", "ʼ": "'",
    "“": '"', "”": '"', "„": '"', "«": '"', "»": '"',
    "–": "-", "—": "-", "−": "-",
}

ELLIPSIS_CHARS = ("...", "…")
LONG_QUOTE = 60


def js_trim(s):
    """str.strip() over JavaScript's whitespace set, so both ports agree on the edges."""
    return "".join(s).strip("".join(JS_SPACE))


def hash_(text):
    """FNV-1a over UTF-16 code units, matching anchor.js exactly.

    charCodeAt() yields code units, so a character outside the BMP contributes two
    values. Encoding to UTF-16 here rather than iterating code points is what keeps a
    fingerprint computed in LibreOffice equal to one computed in Firefox.
    """
    h = 0x811C9DC5
    data = text.encode("utf-16-le")
    for i in range(0, len(data), 2):
        unit = data[i] | (data[i + 1] << 8)
        h ^= unit
        h = (h * 0x01000193) & 0xFFFFFFFF
    return "%08x" % h


def fingerprint(issue):
    return hash_("%s %s %s" % (issue["type"], issue["original"], issue["replacement"]))


def to_utf16_index(text, index):
    """A Python index into `text` as the UTF-16 index LibreOffice expects.

    Equal to `index` for any text that stays inside the BMP, which is nearly all of it -
    and quietly wrong by one per emoji otherwise. Called at the UNO boundary.
    """
    return len(text[:index].encode("utf-16-le")) // 2


def _fold(src, lower=False):
    """Fold typographic variants and collapse whitespace runs, keeping a map from each
    character of the folded string back to its index in the source."""
    out = []
    mapping = []
    pending_space = False
    for i, raw in enumerate(src):
        ch = CHAR_FOLD.get(raw, raw)
        if ch in JS_SPACE:
            pending_space = True
            continue
        if pending_space and out:
            out.append(" ")
            mapping.append(i - 1 if i > 0 else i)
        pending_space = False
        # Case folding is NOT length-preserving: "İ".lower() is two characters. One
        # source character can contribute several folded ones, and the map needs an entry
        # for each or every index after it is wrong.
        if lower:
            ch = ch.lower()
        out.append(ch)
        mapping.extend([i] * len(ch))
    return "".join(out), mapping


def _all_indices(hay, needle):
    out = []
    if not needle:
        return out
    i = hay.find(needle)
    while i != -1:
        out.append(i)
        i = hay.find(needle, i + 1)
    return out


def locate(text, needle):
    """Candidate [start, end) ranges for a quote, best strategy first: exact, then
    whitespace/typography-insensitive, then case-insensitive."""
    exact = [(i, i + len(needle)) for i in _all_indices(text, needle)]
    if exact:
        return exact

    def matches(lower):
        f_text, f_map = _fold(text, lower)
        n_text, _ = _fold(needle, lower)
        if not n_text:
            return []
        found = []
        for i in _all_indices(f_text, n_text):
            if i >= len(f_map) or i + len(n_text) - 1 >= len(f_map):
                continue
            found.append((f_map[i], f_map[i + len(n_text) - 1] + 1))
        return found

    folded = matches(False)
    if folded:
        return folded
    return matches(True)


def _ends_with_ellipsis(s):
    stripped = js_trim(s)
    return stripped.endswith(ELLIPSIS_CHARS)


def looks_truncated(original, replacement):
    """Has the model abbreviated its own replacement instead of writing it out?

    Asked to add a comma to a long sentence it once answered with the sentence's opening
    followed by "...", and applying that deleted the rest of the paragraph.
    """
    if _ends_with_ellipsis(replacement) and not _ends_with_ellipsis(original):
        return True
    return len(original) >= LONG_QUOTE and len(replacement) < len(original) * 0.5


def already_there(text, start, end, replacement):
    """Would applying this just duplicate what is already in the document?

    Models quote a substring stopping short of the character they want to add: for
    "Sorry, I don't speak very well English." one reliably answers original "English",
    replacement "English.", and applying it gives "English..".
    """
    quoted = text[start:end]
    at = replacement.find(quoted)
    if at == -1:
        return False                       # a real rewrite, not an insertion
    before = replacement[:at]
    after = replacement[at + len(quoted):]
    if not before and not after:
        return False                       # identical, handled elsewhere
    before_is_there = not before or text[max(0, start - len(before)):start] == before
    after_is_there = not after or text.startswith(after, end)
    return before_is_there and after_is_there


def anchor_issues(text, raw_issues, categories=None, ignored=(), offset=0):
    """Anchored issues, sorted by position and guaranteed not to overlap."""
    if categories is None:
        categories = {"error": True, "style": True, "rephrase": True}
    ignored = set(ignored or ())
    trimmed_len = len(js_trim(text))

    candidates = []
    seen = set()

    for raw in raw_issues or []:
        if not isinstance(raw, dict):
            continue
        type_ = str(raw.get("type") or "").lower()
        if type_ not in RANK or not categories.get(type_):
            continue

        original = js_trim(str(raw.get("original") or ""))
        replacement = js_trim(str(raw.get("replacement") or ""))
        message = js_trim(str(raw.get("message") or ""))

        if not original or original == replacement:
            continue
        if looks_truncated(original, replacement):
            continue
        # A suggestion that restates the entire chunk is a rewrite, not a correction.
        if trimmed_len > 120 and len(original) >= trimmed_len * 0.95:
            continue

        fp = fingerprint({"type": type_, "original": original, "replacement": replacement})
        if fp in ignored:
            continue

        key = "%s %s %s" % (type_, original, replacement)
        if key in seen:
            continue
        seen.add(key)

        ranges = locate(text, original)
        if not ranges:
            continue

        candidates.append({
            "type": type_, "original": original, "replacement": replacement,
            "message": message, "fp": fp, "ranges": ranges, "rank": RANK[type_],
        })

    # Higher-priority and longer spans claim their territory first.
    candidates.sort(key=lambda c: (c["rank"], -len(c["original"])))

    accepted = []

    def overlaps(s, e):
        return any(s < x["end"] - offset and e > x["start"] - offset for x in accepted)

    for c in candidates:
        free = None
        for s, e in c["ranges"]:
            if not overlaps(s, e) and not already_there(text, s, e, c["replacement"]):
                free = (s, e)
                break
        if free is None:
            continue
        accepted.append({
            "start": free[0] + offset,
            "end": free[1] + offset,
            # Store what actually sits in the document, not what the model claimed.
            "original": text[free[0]:free[1]],
            "replacement": c["replacement"],
            "type": c["type"],
            "message": c["message"],
            "fp": c["fp"],
        })

    accepted.sort(key=lambda a: a["start"])
    return accepted
