# -*- encoding: UTF-8 -*-
"""
The Python anchor must agree with the JavaScript one, case for case.

anchor.js carries four guards that were each paid for with corrupted text in the wild.
Porting it to Python creates a second place for them to be wrong, and hand-written
assertions on the copy would only prove the copy is self-consistent. So this runs the
SAME inputs through both implementations and compares the output exactly - if the two
ever diverge, this says which case and how.

    python3 libreoffice/test/test_anchor.py
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "src", "pythonpath"))

import laita_anchor as A  # noqa: E402

fails = []
passes = 0


def check(name, got, want):
    global passes
    if got == want:
        passes += 1
    else:
        fails.append("%s\n    got  %r\n    want %r" % (name, got, want))


def main():
    with open(os.path.join(HERE, "cases.json"), encoding="utf-8") as fh:
        cases = json.load(fh)

    node = subprocess.run(
        ["node", os.path.join(HERE, "js_reference.mjs")],
        capture_output=True, text=True,
    )
    if node.returncode != 0:
        print("could not run the JavaScript reference:\n" + node.stderr)
        return 1
    reference = {r["name"]: r for r in json.loads(node.stdout)}

    for case in cases:
        ref = reference[case["name"]]
        got = A.anchor_issues(case["text"], case["issues"])
        want = ref["anchored"]

        check("%s: issue count" % case["name"], len(got), len(want))
        for i, (g, w) in enumerate(zip(got, want)):
            for field in ("original", "replacement", "type", "message", "fp"):
                check("%s: issue %d .%s" % (case["name"], i, field), g[field], w[field])

            # Offsets are compared IN UTF-16, because that is the only unit the two
            # languages share. Python indexes code points and JavaScript indexes code
            # units; they agree until a character outside the BMP appears, and then one
            # emoji shifts everything after it by one. Comparing g["start"] directly
            # would demand that the Python port be wrong in the same way JavaScript is.
            # This asserts the bridge instead - and it is the same call the UNO component
            # makes before handing an offset to LibreOffice.
            check("%s: issue %d .start (as UTF-16)" % (case["name"], i),
                  A.to_utf16_index(case["text"], g["start"]), w["start"])
            check("%s: issue %d .end (as UTF-16)" % (case["name"], i),
                  A.to_utf16_index(case["text"], g["end"]), w["end"])

        # The fingerprint hash walks UTF-16 code units in JavaScript; the Python port
        # encodes to UTF-16 so that the same issue produces the same id on both.
        check("%s: hash of the text" % case["name"], A.hash_(case["text"]), ref["hash"])

    # --- the UTF-16 boundary, which has no JavaScript counterpart ------------------------
    # anchor.py works in Python code points; LibreOffice wants UTF-16 indices. They agree
    # until something outside the BMP appears.
    check("BMP text: indices are unchanged", A.to_utf16_index("hello world", 6), 6)
    check("after an emoji: one more UTF-16 unit", A.to_utf16_index("\U0001F600 hi", 2), 3)
    check("two emoji: two more", A.to_utf16_index("\U0001F600\U0001F600 hi", 3), 5)
    check("index 0 is always 0", A.to_utf16_index("\U0001F600", 0), 0)

    print("%d passed, %d failed" % (passes, len(fails)))
    for f in fails:
        print("  FAIL " + f)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
