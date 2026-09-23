# -*- encoding: UTF-8 -*-
"""
The two things this server has to get right that the extension never had to.

  1. It must answer within 10 seconds, always, because that is where LibreOffice gives
     up (CURLOPT_TIMEOUT in languagetoolimp.cxx) and a paragraph takes this model 8-50.
     So check() must never wait for the model - not on a miss, not on a slow model, not
     on a model that is down.

  2. It serves several people at once through a protocol that carries nothing to tell
     them apart. One debounce slot - which is what the extension has, correctly, for one
     cursor - means two typists cancel each other and the timer fires for whoever paused
     last, or for nobody. StreamDebouncer must keep them separate using the text alone.

Neither Ollama nor LibreOffice is needed, and nothing here sleeps: time is injected.
"""
import os
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "src"))

import laita_lt_shared                                      # noqa: E402
laita_lt_shared.install()

import laita_lt_config                                      # noqa: E402
from laita_lt_server import Checker, StreamDebouncer         # noqa: E402

fails, passes = [], 0


def check(name, got, want):
    global passes
    if got == want:
        passes += 1
    else:
        fails.append("%s\n    got  %r\n    want %r" % (name, got, want))


class FakeTimer:
    """A threading.Timer that fires only when a test says so."""
    pending = []

    def __init__(self, delay, fn, args=()):
        self.delay, self.fn, self.args, self.cancelled = delay, fn, list(args), False
        self.daemon = True

    def start(self):
        FakeTimer.pending.append(self)

    def cancel(self):
        self.cancelled = True

    def is_alive(self):
        return not self.cancelled and self in FakeTimer.pending

    @classmethod
    def fire_all(cls):
        due, cls.pending = list(cls.pending), []
        for t in due:
            if not t.cancelled:
                t.fn(*t.args)

    @classmethod
    def reset(cls):
        cls.pending = []


def settings(**over):
    s = laita_lt_config.defaults()
    s.update(over)
    return s


def wait_for(predicate, seconds=5.0):
    """The Engine drains on a real thread; give it a moment, but never a fixed sleep."""
    deadline = time.time() + seconds
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.005)
    return False


def main():
    global passes

    # --- 1. the debouncer keeps typists apart -----------------------------------------
    FakeTimer.reset()
    fired = []
    d = StreamDebouncer(1.5, lambda t, l, s: fired.append(t), timer_factory=FakeTimer)

    # One person typing: each keystroke supersedes the last, so the model is asked once.
    for n in range(1, 18):
        d.note("The quick brown fox"[:n], "en", {})
    FakeTimer.fire_all()
    check("17 keystrokes in one paragraph ask once", len(fired), 1)
    check("...about the final text", fired, ["The quick brown fox"[:17]])

    # Two people. Their paragraphs share nothing, so neither may cancel the other - this
    # is the case a single pending slot gets wrong.
    FakeTimer.reset()
    del fired[:]
    a = "Le chat dort sur le canape du salon."
    b = "Die Katze schlaeft auf dem Sofa im Wohnzimmer."
    for n in range(10, len(a)):
        d.note(a[:n], "fr", {})
        if n - 10 < len(b) - 10:
            d.note(b[:n], "de", {})
    FakeTimer.fire_all()
    check("two typists both get asked about", sorted(fired), sorted([a[:len(a) - 1], b[:len(a) - 1]]))

    # Editing at the START of a paragraph. A stream key built from a prefix would call
    # every keystroke a new person and fire a request for each; same_stream counts both
    # ends, so the long unchanged tail keeps it one stream.
    FakeTimer.reset()
    del fired[:]
    tail = " walked into the room and sat down without saying anything at all."
    for lead in ("H", "He", "He ", "He s", "He sl", "He slo", "He slow"):
        d.note(lead + tail, "en", {})
    FakeTimer.fire_all()
    check("editing the start of a paragraph is still one stream", len(fired), 1)
    check("...and it is the newest text", fired, ["He slow" + tail])

    # --- 2. check() never waits for the model ------------------------------------------
    FakeTimer.reset()
    asked, release = [], threading.Event()

    def slow_model(text, lang):
        asked.append(text)
        release.wait(10)                      # a model that has not answered yet
        return [{"type": "error", "original": "teh", "replacement": "the", "message": "typo"}]

    s = settings(minChars=5)
    c = Checker(s, log=lambda m: None, timer_factory=FakeTimer, ask=slow_model)

    para = "I saw teh cat sitting on the mat this morning."
    started = time.time()
    issues, why = c.check(para, "en")
    check("a miss answers at once", time.time() - started < 0.5, True)
    check("...with nothing", issues, [])
    check("...and says why", why, "queued")

    FakeTimer.fire_all()                      # the paragraph has settled; the model runs
    check("the model is now being asked", wait_for(lambda: asked == [para]), True)

    started = time.time()
    issues, why = c.check(para, "en")
    check("a check while the model is running still answers at once",
          time.time() - started < 0.5, True)
    check("...and does not ask a second time", asked, [para])

    release.set()
    check("the answer lands", wait_for(lambda: c.engine.lookup(para) is not None), True)

    issues, why = c.check(para, "en")
    check("the next check serves it from cache", len(issues), 1)
    check("...anchored to the text", para[issues[0]["start"]:issues[0]["end"]], "teh")
    check("...and says so", why.startswith("cache"), True)

    # A one-character edit is a cache miss, and must not blank the underline.
    edited = para + " "
    issues, why = c.check(edited, "en")
    check("an edit keeps the previous underlines", len(issues), 1)
    check("...from the provisional answer", why.startswith("provisional"), True)

    # --- a model that fails must not take the server with it ----------------------------
    FakeTimer.reset()
    def broken_model(text, lang):
        raise RuntimeError("ollama is down")

    c2 = Checker(settings(minChars=5), log=lambda m: None, timer_factory=FakeTimer,
                 ask=broken_model)
    other = "Another paragraph entirely, with different words in it."
    c2.check(other, "en")
    FakeTimer.fire_all()
    check("a failing model is recorded", wait_for(lambda: c2.engine.last_error is not None), True)
    started = time.time()
    issues, why = c2.check(other, "en")
    check("...and the next check still answers at once", time.time() - started < 0.5, True)
    check("...with nothing rather than an error", issues, [])

    # --- a language nobody advertised is still checked -----------------------------------
    # /v2/languages is advisory. Nothing in the check path consults it, and a client
    # asking for a language absent from it must be served, not refused.
    FakeTimer.reset()
    asked_lang = []
    c5 = Checker(settings(minChars=5), log=lambda m: None, timer_factory=FakeTimer,
                 ask=lambda text, lang: asked_lang.append(lang) or [])
    c5.check("Jeg gikk til butikken i gar for a kjope melk.", "nn-NO")
    FakeTimer.fire_all()
    check("an unadvertised language reaches the model",
          wait_for(lambda: asked_lang == ["nn-NO"]), True)

    # --- the guards --------------------------------------------------------------------
    FakeTimer.reset()
    c3 = Checker(settings(minChars=25, maxChars=100), log=lambda m: None,
                 timer_factory=FakeTimer, ask=lambda text, lang: [])
    check("too short is not sent", c3.check("Hello.", "en")[1], "out of range")
    check("too long is not sent", c3.check("x" * 200, "en")[1], "out of range")
    check("nothing was queued", FakeTimer.pending, [])

    c4 = Checker(settings(enabled=False), log=lambda m: None, timer_factory=FakeTimer,
                 ask=lambda text, lang: [])
    check("disabled answers nothing", c4.check("A sentence long enough to pass.", "en")[1],
          "disabled")

    print("%d passed, %d failed" % (passes, len(fails)))
    for f in fails:
        print("  FAIL " + f)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
