# -*- encoding: UTF-8 -*-
"""
The engine exists for one measured reason: LibreOffice calls doProofreading on every
keystroke, and the probe showed that asking the model each time means 17 inferences for
a 17-character sentence. These tests replay that exact typing pattern and assert the
model is asked once.

Time is injected, so nothing here sleeps.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "src", "pythonpath"))

from laita_engine import Engine, EditTracker, _shared_ends  # noqa: E402

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

    @classmethod
    def run_all(cls):
        due, cls.pending = cls.pending, []
        for t in due:
            if not t.cancelled:
                t.fn(*t.args)

    @classmethod
    def reset(cls):
        cls.pending = []


SETTINGS = {"debounceMs": 1500}


def engine(answers=None, **kw):
    FakeTimer.reset()
    asked = []

    def proofread(text, lang):
        asked.append(text)
        if isinstance(answers, Exception):
            raise answers
        return (answers or {}).get(text, [{"original": text, "start": 0, "end": 1}])

    ready = []
    e = Engine(proofread, on_ready=ready.append, timer_factory=FakeTimer, **kw)
    return e, asked, ready


def main():
    # --- the measured problem: one inference for a sentence, not one per keystroke ----
    e, asked, ready = engine()
    typed = "This is the test."
    for i in range(1, len(typed) + 1):
        check("while typing, lookup has nothing for %r" % typed[:i], e.lookup(typed[:i]), None)
        e.request(typed[:i], "en", SETTINGS)
    check("no model call while the text is still moving", asked, [])
    FakeTimer.run_all()
    check("exactly one model call once it settles", len(asked), 1)
    check("...and it was for the final text", asked[0], typed)
    check("the answer is cached", e.lookup(typed) is not None, True)
    check("on_ready fired once, for that text", ready, [typed])

    # --- a cached answer is instant and never re-asked --------------------------------
    e.request(typed, "en", SETTINGS)
    FakeTimer.run_all()
    check("a cached text is not asked about again", len(asked), 1)

    # --- an intermediate prefix must not be answered with the final text's issues -----
    check("a prefix is still unknown", e.lookup("This is the"), None)

    # --- failure is swallowed: a raise would become a modal dialog --------------------
    boom = RuntimeError("ollama is down")
    e2, asked2, ready2 = engine(answers=boom)
    e2.request("hello world", "en", SETTINGS)
    FakeTimer.run_all()
    check("a failure does not propagate", isinstance(e2.last_error, RuntimeError), True)
    check("...and is cached as no issues, so it is not retried in a loop",
          e2.lookup("hello world"), [])
    check("...and still reports ready", ready2, ["hello world"])

    # --- stop / start -----------------------------------------------------------------
    e3, asked3, _ = engine()
    e3.request("some text here", "en", SETTINGS)
    e3.stop()
    FakeTimer.run_all()
    check("stop cancels pending work", asked3, [])
    e3.start()
    e3.request("some text here", "en", SETTINGS)
    FakeTimer.run_all()
    check("start resumes it", len(asked3), 1)

    # --- forget ------------------------------------------------------------------------
    check("cached before forget", e3.lookup("some text here") is not None, True)
    e3.forget()
    check("forget empties the cache", e3.lookup("some text here"), None)

    # --- eviction keeps the cache bounded ---------------------------------------------
    # cache_max is set here rather than left at the default, which is 20000 - sized in
    # megabytes rather than for a test, and it is the caller's to set anyway.
    e4, asked4, _ = engine()
    e4.cache_max = 200
    for i in range(260):
        e4.request("text number %d" % i, "en", SETTINGS)
        FakeTimer.run_all()
    check("the cache is bounded", len(e4._cache) <= 200, True)
    check("the newest is kept", e4.lookup("text number 259") is not None, True)
    check("the oldest is evicted", e4.lookup("text number 0"), None)

    # The cap is the caller's to set, and the caller changes it as its settings change.
    e4b, _, _ = engine()
    e4b.cache_max = 3
    for i in range(10):
        e4b.request("paragraph number %d" % i, "en", SETTINGS)
        FakeTimer.run_all()
    check("a smaller cap is honoured", len(e4b._cache), 3)
    check("...keeping the newest", e4b.lookup("paragraph number 9") is not None, True)
    check("...and dropping the oldest", e4b.lookup("paragraph number 0"), None)

    # --- busy reports honestly ----------------------------------------------------------
    e5, _, _ = engine()
    check("idle to begin with", e5.busy, False)
    e5.request("pending text", "en", SETTINGS)
    check("busy once something is pending", e5.busy, True)
    FakeTimer.run_all()
    check("idle again afterwards", e5.busy, False)

    # --- provisional answers: the underlines must not blink out on every keystroke -----
    # Without this, an edited paragraph is a cache miss and doProofreading returns no
    # errors until the new answer lands a second and a half later.
    e6, asked6, _ = engine(answers={"The cat sat on the mat.": ["ANSWER-A"]})
    e6.request("The cat sat on the mat.", "en", SETTINGS)
    FakeTimer.run_all()
    check("the settled text is cached", e6.lookup("The cat sat on the mat."), ["ANSWER-A"])

    typed_on = "The cat sat on the mat. And"
    check("the edited text is not in the cache", e6.lookup(typed_on), None)
    check("...but the previous answer is offered while it is re-checked",
          e6.provisional(typed_on), ["ANSWER-A"])
    check("deleting from the end also finds it",
          e6.provisional("The cat sat on the"), ["ANSWER-A"])
    check("an exact hit is preferred over a prefix match",
          e6.provisional("The cat sat on the mat."), ["ANSWER-A"])

    # A different paragraph must not borrow it.
    check("an unrelated paragraph borrows nothing",
          e6.provisional("Completely different words entirely here"), None)
    check("a short shared opening is not enough",
          e6.provisional("The dog"), None)
    check("nothing cached, nothing provisional", engine()[0].provisional("anything"), None)

    # The closest of several is the one used.
    e7, _, _ = engine(answers={"Alpha beta gamma delta epsilon": ["A"],
                               "Alpha beta gamma delta epsilon zeta eta": ["B"]})
    for t in ("Alpha beta gamma delta epsilon", "Alpha beta gamma delta epsilon zeta eta"):
        e7.request(t, "en", SETTINGS)
        FakeTimer.run_all()
    check("the longest shared prefix wins",
          e7.provisional("Alpha beta gamma delta epsilon zeta eta theta"), ["B"])

    # --- applying a fix mid-paragraph must not blank the other underlines --------------
    # Reported from real use: correcting one word made every other suggestion in that
    # paragraph vanish for a few seconds. A shared PREFIX is not the right measure - an
    # edit in the middle leaves a short prefix and a long suffix - and the previous
    # answer was rejected as too dissimilar.
    para = "This is a tesst that depend on the underlying architecture of this softwre."
    fixed = "This is a tesst that depends on the underlying architecture of this softwre."
    e8, _, _ = engine(answers={para: ["A"]})
    e8.request(para, "en", SETTINGS)
    FakeTimer.run_all()
    check("after applying a fix in the middle, the answer is still offered",
          e8.provisional(fixed), ["A"])

    late = para.replace("softwre", "software")          # an edit near the end
    check("a fix near the end too", e8.provisional(late), ["A"])
    early = para.replace("This", "That")                # and near the start
    check("a fix near the start too", e8.provisional(early), ["A"])

    # It must still refuse a genuinely different paragraph.
    check("a different paragraph of similar length is refused",
          e8.provisional("Completely unrelated prose about gardening and the weather ok"),
          None)

    # --- the measure itself --------------------------------------------------------------
    check("identical strings share everything", _shared_ends("abcdef", "abcdef"), 6)
    check("one char changed in the middle", _shared_ends("abcdef", "abcXef"), 5)
    check("an insertion in the middle", _shared_ends("abcdef", "abcXdef"), 6)
    check("a deletion in the middle", _shared_ends("abcdef", "abdef"), 5)
    check("nothing in common", _shared_ends("abc", "xyz"), 0)
    check("the two ends never double-count", _shared_ends("aaa", "aaa"), 3)
    check("empty against something", _shared_ends("", "abc"), 0)

    # --- a sweep must ask about every paragraph, not just the last --------------------
    # request() debounces, which is right while one paragraph is being typed and wrong
    # for "check this document": twelve paragraphs arriving at once produced ONE model
    # request, because each cancelled the one before it.
    import time as _time
    e9, asked9, ready9 = engine()
    paragraphs = ["Paragraph number %d with something wrong in it." % i for i in range(12)]
    for para in paragraphs:
        e9.enqueue(para, "en", SETTINGS)
    for _ in range(100):
        if not e9.busy:
            break
        _time.sleep(0.05)
    check("every queued paragraph was asked about", sorted(asked9), sorted(paragraphs))
    check("...exactly once each", len(asked9), 12)
    check("...and every answer is cached",
          all(e9.lookup(p) is not None for p in paragraphs), True)
    check("...and each reported ready", len(ready9), 12)

    # Queueing the same text twice is not two requests.
    e10, asked10, _ = engine()
    for _ in range(3):
        e10.enqueue("The same paragraph every time.", "en", SETTINGS)
    for _ in range(100):
        if not e10.busy:
            break
        _time.sleep(0.05)
    check("a repeated text is asked about once", len(asked10), 1)

    # Stop must abandon the rest of the queue. The fake model has to be slow enough for
    # stop() to land mid-sweep: with an instant one the whole queue drains before the
    # call, which is a property of the test rather than of the engine.
    FakeTimer.reset()
    asked11 = []

    def slow(text, lang):
        asked11.append(text)
        _time.sleep(0.05)
        return []

    e11 = Engine(slow, timer_factory=FakeTimer)
    for i in range(20):
        e11.enqueue("Paragraph %d." % i, "en", SETTINGS)
    for _ in range(100):                       # let a couple through first
        if len(asked11) >= 2:
            break
        _time.sleep(0.01)
    e11.stop()
    settled = len(asked11)
    _time.sleep(0.3)
    check("stop abandons the rest of the sweep", len(asked11) < 20, True)
    check("...and nothing new starts after it", len(asked11) <= settled + 1, True)

    # --- EditTracker: an edited paragraph, not wherever the caret landed ---------------
    # The rule is the LanguageTool server's, learned from a real bug: a text that CHANGES
    # a paragraph already seen is an edit; one that repeats it exactly is a re-display.
    t = EditTracker()
    doc = [
        "The paper applies several models to estimate the value of forest land use.",
        "Please explain how you have eight years and twenty treatment plants here.",
        "I need to admit to the editor that when I accepted the paper to review it.",
    ]
    check("opening: every paragraph is a first sighting",
          [t.note(p) for p in doc], [EditTracker.NEW] * 3)
    check("reopening offers them again unchanged - a re-display, not an edit",
          [t.note(p) for p in doc], [EditTracker.SAME] * 3)

    para = doc[2]
    typed = [para + " And more"[:i] for i in range(1, 10)]
    check("typing at the end of a paragraph is an edit on every keystroke",
          [t.note(x) for x in typed], [EditTracker.CHANGED] * 9)
    check("the re-check after an answer offers the latest text again: not an edit",
          t.note(typed[-1]), EditTracker.SAME)
    check("...and the paragraphs nobody touched are still just re-displays",
          [t.note(p) for p in doc[:2]], [EditTracker.SAME] * 2)

    middle = doc[0].replace("several", "many")
    check("an edit in the middle is recognised (shared prefix AND suffix)",
          t.note(middle), EditTracker.CHANGED)
    check("the paragraph is remembered where it is now, not where it was",
          t.note(middle), EditTracker.SAME)
    check("going back to the old text (undo) is an edit too, not a re-display",
          t.note(doc[0]), EditTracker.CHANGED)

    check("a genuinely different paragraph is not mistaken for an edit of another",
          t.note("Why does the table in the appendix leave out half of the models?"),
          EditTracker.NEW)

    small = EditTracker(max_paragraphs=2)
    for p in doc:
        small.note(p)
    check("the cap forgets the stalest paragraph first",
          small.note(doc[0]), EditTracker.NEW)
    check("...and keeps the recent ones",
          small.note(doc[2]), EditTracker.SAME)

    # --- stopping one kind of checking must not stop the other ---------------------
    # "Stop" used to be Engine.stop(): as-you-type died with the sweep, and the only way
    # back was a whole new sweep. The two cancels exist so each leaves the other alone.
    e, asked, ready = engine()
    e.request("Typed paragraph that is waiting on its debounce.", "en", SETTINGS)
    e.cancel_pending()
    FakeTimer.run_all()
    check("switching as-you-type off drops the check waiting on its debounce", asked, [])
    check("...and the engine still accepts work afterwards", e.stopped, False)
    e.request("Typed again after it was switched back on.", "en", SETTINGS)
    FakeTimer.run_all()
    check("...so the next edit is checked normally",
          asked, ["Typed again after it was switched back on."])

    import threading as _th
    gate, asked12 = _th.Event(), []

    def held(text, lang):
        asked12.append(text)
        gate.wait(2)
        return []

    e12 = Engine(held, timer_factory=FakeTimer)
    for i in range(5):
        e12.enqueue("Sweep paragraph number %d here." % i, "en", SETTINGS)
    for _ in range(200):                       # wait until the first is in flight
        if asked12:
            break
        _time.sleep(0.005)
    e12.request("A paragraph being typed during the sweep.", "en", SETTINGS)
    e12.cancel_queue()
    gate.set()
    _time.sleep(0.2)
    check("stopping the sweep drops the paragraphs still waiting",
          [t for t in asked12 if t.startswith("Sweep")], ["Sweep paragraph number 0 here."])
    FakeTimer.run_all()
    _time.sleep(0.2)
    check("...but a paragraph being typed is still checked",
          "A paragraph being typed during the sweep." in asked12, True)

    print("%d passed, %d failed" % (passes, len(fails)))
    for f in fails:
        print("  FAIL " + f)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
