# -*- encoding: UTF-8 -*-
"""
The Python chunker against the JavaScript one - and an honest account of where they
cannot agree.

The browser uses Intl.Segmenter for sentence boundaries; Python has no equivalent in
the standard library, so the port uses the regular-expression fallback that the
JavaScript itself falls back to. The two therefore need not agree on every boundary, and
pretending otherwise would mean either a test that fails for a good reason or one
weakened until it proves nothing.

So this asserts the properties that MUST hold on both, compares chunk-for-chunk, and
prints any divergence rather than hiding it.

Measured result, and it is worth knowing: the two segmenters DO differ - the regex
splits "U.S." into two sentences and Intl.Segmenter does not - but across 243
text/limit combinations the CHUNKS came out identical every time. Packing is why:
chunk_text concatenates consecutive sentences until the limit, so a split inside an
abbreviation is reassembled unless a flush happens to land exactly between the halves.
The expected number of divergent cases is therefore pinned at zero, and a change there
should be examined rather than accepted.

Were they to diverge, it would change only WHERE a long paragraph is divided - never
whether a suggestion is right, because the model quotes text and anchoring finds the
quote wherever it lands.
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "src", "pythonpath"))

from laita_segment import chunk_text, MIN_LIMIT  # noqa: E402

fails, passes = [], 0


def check(name, got, want):
    global passes
    if got == want:
        passes += 1
    else:
        fails.append("%s\n    got  %r\n    want %r" % (name, got, want))


def main():
    with open(os.path.join(HERE, "segment_cases.json"), encoding="utf-8") as fh:
        cases = json.load(fh)
    node = subprocess.run(["node", os.path.join(HERE, "segment_reference.mjs")],
                          capture_output=True, text=True)
    if node.returncode != 0:
        print("could not run the JavaScript reference:\n" + node.stderr)
        return 1
    reference = {r["name"]: r for r in json.loads(node.stdout)}

    identical = 0
    divergent = []
    for case in cases:
        text, limit, name = case["text"], case["limit"], case["name"]
        got = chunk_text(text, limit)
        want = [tuple(c) for c in reference[name]["chunks"]]

        # --- properties that must hold whatever the segmenter does ---------------------
        effective = max(MIN_LIMIT, limit)
        for start, chunk in got:
            check("%s: the chunk is really at that offset" % name,
                  text[start:start + len(chunk)], chunk)
            check("%s: no leading or trailing blank space" % name, chunk, chunk.strip())
            check("%s: nothing shorter than two characters" % name, len(chunk) >= 2, True)
        check("%s: chunks are in order" % name,
              [s for s, _ in got], sorted(s for s, _ in got))
        # A chunk may exceed the limit only when one sentence does.
        for start, chunk in got:
            if len(chunk) > effective:
                check("%s: an oversized chunk is a single unsplittable sentence" % name,
                      len(chunk_text(chunk, effective)), 1)
        # Nothing may be silently dropped: every chunk's text appears in the original.
        check("%s: every chunk comes from the text" % name,
              all(c in text for _, c in got), True)
        # And the pieces must cover the text's non-blank content.
        check("%s: nothing substantial is lost" % name,
              len("".join(c for _, c in got).split()) >= len(text.split()) - 1, True)

        if got == want:
            identical += 1
        else:
            divergent.append((name, got, want))

    print("  %d of %d cases identical to the JavaScript" % (identical, len(cases)))
    for name, got, want in divergent:
        print("  DIVERGES  %s" % name)
        print("    python (regex)          : %s" % [(s, t[:40]) for s, t in got])
        print("    javascript (Segmenter)  : %s" % [(s, t[:40]) for s, t in want])

    # The count itself is pinned: a change here should be a decision, not a surprise.
    check("the number of divergent cases is what was last agreed", len(divergent), 0)

    # --- 0 means do not chunk, which is the default -------------------------------------
    # Measured against a real model, splitting a paragraph is up to four times slower.
    # The setting stays for anyone who wants the extra coverage it buys.
    long_text = "One sentence here. " * 40
    check("a limit of 0 returns the paragraph whole", len(chunk_text(long_text, 0)), 1)
    check("...with the text intact", chunk_text(long_text, 0)[0][1], long_text.strip())
    check("...and the offset past any leading space",
          chunk_text("   padded text here.", 0)[0][0], 3)
    check("a real limit still splits", len(chunk_text(long_text, 200)) > 1, True)
    check("nothing at all gives nothing", chunk_text("", 0), [])
    check("blank gives nothing", chunk_text("    ", 0), [])

    print("%d passed, %d failed" % (passes, len(fails)))
    for f in fails:
        print("  FAIL " + f)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
