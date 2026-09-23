# -*- encoding: UTF-8 -*-
"""
Where the ported modules live.

The prompts, the anchoring, the chunking and the debounce cache were written for the
LibreOffice extension and none of them import uno. This server reuses those files where
they are rather than copying them, because `doc/roadmap.md` already names the Python port
of `anchor.js` as the thing in this repository most likely to rot: a second copy of the
four guards that cost corrupted text to find would be a third place for them to be wrong.

So there is exactly one copy, under libreoffice/src/pythonpath/, and this module is the
only place that says so. Set LAITA_SHARED_PATH to point somewhere else when the two are
deployed apart.
"""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(os.path.dirname(_HERE))

SHARED_PATH = os.environ.get(
    "LAITA_SHARED_PATH",
    os.path.join(_REPO, "libreoffice", "src", "pythonpath"))


def install():
    """Put the shared modules on sys.path. Safe to call more than once."""
    if not os.path.isdir(SHARED_PATH):
        raise RuntimeError(
            "the shared LAITA modules are not at %s.\n"
            "They live in libreoffice/src/pythonpath/ of the LAITA repository; set\n"
            "LAITA_SHARED_PATH if this server is deployed away from them." % SHARED_PATH)
    if SHARED_PATH not in sys.path:
        sys.path.insert(0, SHARED_PATH)
    return SHARED_PATH
