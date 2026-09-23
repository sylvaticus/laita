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
from concurrent.futures import ThreadPoolExecutor

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

    # --- 2. a check waits for the answer, within a budget -------------------------------
    # The first draft answered empty and relied on the client asking again. Measured
    # against a real Collabora that produced 25 "queued" answers and not one match: the
    # client stops asking when the user stops typing, and there is no PROOFREAD_AGAIN
    # here to tell it otherwise. The last check of a paragraph is the one that matters
    # and it is the one with no answer yet.
    FakeTimer.reset()
    asked, release = [], threading.Event()

    def model(text, lang):
        asked.append(text)
        release.wait(10)
        return [{"type": "error", "original": "teh", "replacement": "the", "message": "typo"}]

    s = settings(minChars=5, waitMs=4000, debounceMs=1500, scope="document")
    c = Checker(s, log=lambda m: None, timer_factory=FakeTimer, ask=model)
    para = "I saw teh cat sitting on the mat this morning."

    pool = ThreadPoolExecutor(2)
    pending = pool.submit(c.check, para, "en")
    check("the check is still holding its request open",
          wait_for(lambda: FakeTimer.pending != []) and not pending.done(), True)

    FakeTimer.fire_all()                      # the paragraph settles; the model is asked
    check("the model is asked", wait_for(lambda: asked == [para]), True)
    check("and the check is still waiting for it", pending.done(), False)
    release.set()

    issues, why = pending.result(timeout=5)
    check("the FIRST check returns the real matches", len(issues), 1)
    check("...anchored to the text", para[issues[0]["start"]:issues[0]["end"]], "teh")
    check("...having waited for them", why.startswith("waited"), True)

    # A second look is a plain cache hit and must not wait at all.
    started = time.time()
    issues, why = c.check(para, "en")
    check("a cached answer is instant", time.time() - started < 0.2, True)
    check("...and says so", why.startswith("cache"), True)

    # A one-character edit is a miss again, and must not blank the underline while the
    # new answer is computed.
    FakeTimer.reset()
    issues, why = c.check(para + " ", "en")
    check("an edit keeps the previous underlines", len(issues), 1)
    check("...from the provisional answer", why.startswith("provisional"), True)

    # --- having something to show beats having the right thing ---------------------------
    # Waiting whenever the cache missed was measured against a real Collabora and was
    # worse than not waiting at all: every answer arrived ~3s after the keystroke that
    # asked for it, the paragraph had moved on, and NO underline appeared - though the
    # log showed matches going out on every request. A result about text the user has
    # already edited is no result. So once there is a previous answer to show, a check
    # must answer from it immediately and never hold the request open.
    FakeTimer.reset()
    edited = para + " It was raining."
    started = time.time()
    issues, why = c.check(edited, "en")
    check("with a provisional to hand, a check does not wait",
          time.time() - started < 0.2, True)
    check("...and still underlines something", len(issues) >= 1, True)
    check("...from the provisional answer", why.startswith("provisional"), True)
    check("...having still queued the real one", FakeTimer.pending != [], True)

    # --- the budget is a promise: never past it, whatever the model does ----------------
    # LibreOffice gives up at 10s. Overrunning the budget is the one failure this design
    # exists to prevent, so it is asserted against a model that never answers at all.
    FakeTimer.reset()
    stuck = threading.Event()
    c2 = Checker(settings(minChars=5, waitMs=400, debounceMs=100, scope="document"),
                 log=lambda m: None, timer_factory=FakeTimer,
                 ask=lambda text, lang: stuck.wait(30) or [])
    other = "A paragraph the model will never answer about, however long we wait."
    started = time.time()
    issues, why = c2.check(other, "en")
    elapsed = time.time() - started
    check("a model that never answers still returns", issues, [])
    check("...within the budget", 0.35 < elapsed < 1.5, True)
    stuck.set()

    # --- waitMs 0 restores the original never-wait behaviour ------------------------------
    FakeTimer.reset()
    c3 = Checker(settings(minChars=5, waitMs=0, scope="document"), log=lambda m: None,
                 timer_factory=FakeTimer, ask=lambda text, lang: [])
    started = time.time()
    issues, why = c3.check("Another paragraph, long enough to be sent off.", "en")
    check("waitMs 0 answers at once", time.time() - started < 0.2, True)
    check("...with nothing", why, "queued")

    # --- a model that fails must not take the server with it ----------------------------
    FakeTimer.reset()
    def broken_model(text, lang):
        raise RuntimeError("ollama is down")

    c4 = Checker(settings(minChars=5, waitMs=4000, debounceMs=1500, scope="document"),
                 log=lambda m: None, timer_factory=FakeTimer, ask=broken_model)
    broke = "A paragraph entirely its own, with quite different words in it."
    started = time.time()
    pending = pool.submit(c4.check, broke, "en")
    wait_for(lambda: FakeTimer.pending != [])
    FakeTimer.fire_all()                      # let the doomed request actually happen
    issues, why = pending.result(timeout=5)
    check("a failing model still answers", issues, [])
    check("...promptly, not after the whole budget", time.time() - started < 3.0, True)
    check("...and the failure is recorded", c4.engine.last_error is not None, True)

    # --- a language nobody advertised is still checked -----------------------------------
    # /v2/languages is advisory. Nothing in the check path consults it, and a client
    # asking for a language absent from it must be served, not refused.
    FakeTimer.reset()
    asked_lang = []
    c5 = Checker(settings(minChars=5, waitMs=400, debounceMs=100, scope="document"),
                 log=lambda m: None, timer_factory=FakeTimer,
                 ask=lambda text, lang: asked_lang.append(lang) or [])
    c5.check("Jeg gikk til butikken i gar for a kjope melk.", "nn-NO")
    FakeTimer.fire_all()
    check("an unadvertised language reaches the model",
          wait_for(lambda: asked_lang == ["nn-NO"]), True)

    # --- 3. only the paragraph somebody is working in --------------------------------
    # Opening a long document makes the client offer every paragraph at once. Under
    # "document" each is a model call, so typing on page five queues the answer behind
    # fifty paragraphs nobody asked about - which is what was reported. There is no caret
    # in this protocol, so the evidence used is that an edited paragraph arrives again
    # and again a character apart, while a displayed one arrives once and never changes.
    FakeTimer.reset()
    swept = []
    c7 = Checker(settings(minChars=5, waitMs=400, debounceMs=100),
                 log=lambda m: None, timer_factory=FakeTimer,
                 ask=lambda text, lang: swept.append(text) or [])

    document = [
        "The wheat harvest came in later than usual this year, and the yields were poor.",
        "Rainfall between April and June was barely half the long term average.",
        "Irrigation would have helped, but the licence was refused in February.",
        "Our neighbours to the south reported much the same thing, in stronger terms.",
        "A second cut of hay looks unlikely unless something changes very soon.",
        "The cooperative has asked everyone to submit their figures before Friday.",
        "Prices at market held up, which is the only cheerful sentence in this report.",
        "Next season we will trial two drought tolerant varieties on the lower field.",
    ]
    started = time.time()
    outcomes = [c7.check(par, "en")[1] for par in document]
    check("opening a document asks the model nothing", swept, [])
    check("...and every paragraph says why", set(outcomes), {"not being edited"})
    check("...without waiting for any of them", time.time() - started < 0.5, True)
    check("...and nothing was even queued", FakeTimer.pending, [])

    # Now type in the middle of it. The first keystroke continues a paragraph already
    # seen, so it is recognised at once rather than costing a round trip.
    edited_para = document[5] + " And now I am writing here."
    c7.check(edited_para, "en")
    check("the first keystroke in a swept paragraph is recognised",
          FakeTimer.pending != [], True)
    FakeTimer.fire_all()
    check("...and that paragraph alone reaches the model",
          wait_for(lambda: swept == [edited_para]), True)

    # A paragraph that never existed before costs one keystroke to recognise.
    FakeTimer.reset()
    del swept[:]
    fresh = "A completely new paragraph, typed from nothing at all."
    check("a brand new paragraph is not sent on sight",
          c7.check(fresh, "en")[1], "not being edited")
    c7.check(fresh + " More.", "en")
    FakeTimer.fire_all()
    check("...but is on the next keystroke",
          wait_for(lambda: swept == [fresh + " More."]), True)

    # Close the document and open it again. Every paragraph is offered a second time,
    # unchanged - and matching a remembered stream is NOT evidence of editing, or a
    # reopen sweeps the whole document, which is what scope "typed" exists to prevent.
    FakeTimer.reset()
    del swept[:]
    outcomes = [c7.check(par, "en")[1] for par in document]
    check("reopening a document asks the model nothing", swept, [])
    check("...and nothing is queued", FakeTimer.pending, [])
    # Not every one says "not being edited": a paragraph similar enough to the one that
    # WAS edited has a previous answer to show, and showing it is right. What matters is
    # that none of them needed the model.
    check("...and every paragraph is answered without it",
          all(o == "not being edited" or o.startswith(("provisional", "cache"))
              for o in outcomes), True)

    # ...but typing in one of them still works, on the first keystroke.
    again = document[2] + " Typed after reopening."
    c7.check(again, "en")
    FakeTimer.fire_all()
    check("typing after a reopen is still recognised at once",
          wait_for(lambda: swept == [again]), True)

    # A paragraph whose answer is already cached needs no stream logic at all: reopening
    # a document - or opening a copy of it, which has the same text - is a cache hit.
    FakeTimer.reset()
    del swept[:]
    cached_para = document[5] + " And now I am writing here."
    issues, why = c7.check(cached_para, "en")
    check("a paragraph answered earlier is served from cache on reopen",
          why.startswith("cache"), True)
    check("...without asking the model again", swept, [])

    # The limitation, pinned rather than discovered: paragraphs that differ only in a
    # word or two read as edits of one another, so a document of near-identical lines -
    # a list, a table of similar entries - degrades towards checking everything. That is
    # the safe direction to fail in, and it is why the test above uses real prose.
    FakeTimer.reset()
    del swept[:]
    c9 = Checker(settings(minChars=5, waitMs=0), log=lambda m: None,
                 timer_factory=FakeTimer, ask=lambda text, lang: [])
    rows = ["Paragraph number %d, which nobody has touched at all today." % n
            for n in range(4)]
    outcomes = [c9.check(r, "en")[1] for r in rows]
    check("near-identical paragraphs are taken for edits of each other",
          outcomes[0] == "not being edited" and "not being edited" not in outcomes[1:],
          True)

    # scope "document" restores checking everything, for anyone who wants it.
    FakeTimer.reset()
    del swept[:]
    c8 = Checker(settings(minChars=5, waitMs=0, scope="document"),
                 log=lambda m: None, timer_factory=FakeTimer,
                 ask=lambda text, lang: swept.append(text) or [])
    for par in document[:3]:
        c8.check(par, "en")
    FakeTimer.fire_all()
    check("scope document asks about every paragraph",
          wait_for(lambda: len(swept) == 3), True)

    # --- the guards --------------------------------------------------------------------
    FakeTimer.reset()
    c3 = Checker(settings(minChars=25, maxChars=100, scope="document"),
                 log=lambda m: None, timer_factory=FakeTimer,
                 ask=lambda text, lang: [])
    check("too short is not sent", c3.check("Hello.", "en")[1], "out of range")
    check("too long is not sent", c3.check("x" * 200, "en")[1], "out of range")
    check("nothing was queued", FakeTimer.pending, [])

    c6 = Checker(settings(enabled=False), log=lambda m: None, timer_factory=FakeTimer,
                 ask=lambda text, lang: [])
    check("disabled answers nothing", c6.check("A sentence long enough to pass.", "en")[1],
          "disabled")

    print("%d passed, %d failed" % (passes, len(fails)))
    for f in fails:
        print("  FAIL " + f)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
