# -*- encoding: UTF-8 -*-
"""
The part that decides when the model actually runs.

LibreOffice calls doProofreading on every keystroke, with the whole paragraph each time,
and waits for the answer before calling again. Measured: 33 calls for a 27-character
sentence, a median of 190 ms apart. Asking the model on each of those would be 33
inferences on a paragraph that is still being typed - the probe demonstrated exactly that
by starting a worker per call and producing 17 workers for a 17-character sentence.

So:

    lookup()      the model's answer for exactly this text, or None
    provisional() the answer for the nearest text we have seen, to show while typing
    request()     starts a debounce; only when the text has been still for debounce_ms
                  does a worker call the model, and only the newest text wins
    on_ready      is called once an answer lands, so the caller can fire PROOFREAD_AGAIN

What is cached is the model's RAW answer, not anchored ranges. Anchoring happens against
whatever the paragraph says right now, which is the whole point: "never trust the model's
view of the text over the text". It is also what makes provisional() safe - a quote that
no longer exists simply fails to anchor and the suggestion disappears by itself.

Without provisional(), every underline vanishes on each keystroke and reappears a second
and a half later, because the edited paragraph is a cache miss. That reads as suggestions
flickering and changing their mind.

Nothing here imports uno, which is what lets it be tested without LibreOffice.
"""
import threading
import time
from collections import OrderedDict

# Paragraphs kept, when the caller does not say. Measured with tracemalloc against
# realistic content: 2.2 KB for a typical prose paragraph of ~550 characters with three
# issues, 4.3 KB for a long one, 0.7 KB for a short one. So this is about 10 MB, and
# roughly twice that if every paragraph is long. It was 200 - a quarter of a megabyte -
# which threw away answers still worth having. A server sets its own, much larger.
CACHE_MAX = 4500

# How much of a paragraph must match before a previous answer is reused while the new one
# is computed. Below this, two short paragraphs starting "The " would borrow each other's
# suggestions.
MIN_SHARED_PREFIX = 20


def _shared_ends(a, b):
    """How much of two strings is unchanged, counting from both ends.

    A shared prefix alone is not enough, and getting this wrong was visible: applying a
    suggestion in the MIDDLE of a paragraph leaves a long shared suffix but only a short
    shared prefix, so the previous answer was rejected and every underline in that
    paragraph blinked out until the model answered again. One edit anywhere leaves the
    text either side of it intact, which is what this measures.
    """
    prefix = 0
    for x, y in zip(a, b):
        if x != y:
            break
        prefix += 1
    # Do not let the two ends count the same characters twice on a short string.
    limit = min(len(a), len(b)) - prefix
    suffix = 0
    while suffix < limit and a[len(a) - 1 - suffix] == b[len(b) - 1 - suffix]:
        suffix += 1
    return prefix + suffix


def same_stream(a, b):
    """How much two texts share, if they are the same paragraph one edit apart; else 0.

    Pulled out of provisional() so that the LanguageTool server can ask the same question
    for a different reason. It debounces per paragraph rather than globally, because it
    serves several people at once and the protocol carries nothing to tell them apart -
    two texts this call says are related are one person still typing, and must supersede
    each other; two it says are not are two people, and must not.
    """
    shared = _shared_ends(a, b)
    shortest = min(len(a), len(b))
    if not shortest:
        return 0
    # Two conditions, and the floor must never exceed the text itself: deleting from a
    # paragraph makes it shorter than MIN_SHARED_PREFIX, and it would then be unable to
    # match the answer it had a moment earlier.
    floor = min(MIN_SHARED_PREFIX, shortest)
    if shared >= floor and shared >= shortest * 0.6:
        return shared
    return 0


# Paragraphs remembered by EditTracker. One entry per paragraph, not per keystroke - an
# edit replaces the text it came from - so this is a document's worth, not a history.
EDIT_TRACKER_MAX = 5000


class EditTracker:
    """Tells a paragraph somebody edited from one LibreOffice is only showing again.

    LibreOffice offers a paragraph for proofreading when a document opens, when it scrolls
    into view, after every answer (PROOFREAD_AGAIN) and when it is edited - and only the
    last is worth a model call. The caret is the wrong evidence for that: it lands on
    paragraphs nobody touches (opening a file, clicking to read), and the user saw exactly
    that as "it proofreads text I never touched". The text is the right evidence. A
    paragraph being typed arrives again SIMILAR but DIFFERENT; a re-display arrives
    IDENTICAL.

    The LanguageTool server made the same distinction first - StreamDebouncer.note, and
    the reopen-swept-the-whole-document bug that taught it "changed" rather than
    "matched". This is that classification without the timers, because Engine.request
    already debounces.

    note() answers:
      SAME     offered before, unchanged - a re-display, not an edit
      CHANGED  a remembered paragraph, one edit apart - somebody is editing it
      NEW      nothing similar remembered - a first sighting (opening, scrolling, or a
               paragraph pasted in whole); the caller decides, because text alone cannot
               tell a paste from an open
    """
    SAME, CHANGED, NEW = "same", "changed", "new"

    def __init__(self, max_paragraphs=EDIT_TRACKER_MAX):
        self.max_paragraphs = max_paragraphs
        self._lock = threading.Lock()
        # OrderedDict, not dict: eviction needs the oldest, and plain dicts only keep
        # order from Python 3.7 - older than the LibreOffice this still claims to run on.
        self._texts = OrderedDict()   # id -> the paragraph's latest text, oldest first
        self._ids = {}          # text -> id, so a re-display is found without a scan
        self._next = 0

    def note(self, text):
        with self._lock:
            sid = self._ids.get(text)
            if sid is not None:
                self._touch(sid)
                return self.SAME
            best, best_shared = None, 0
            for sid, seen in self._texts.items():
                shared = same_stream(seen, text)
                if shared > best_shared:
                    best, best_shared = sid, shared
            if best is not None:
                # The paragraph moved on: remember where it is now, not where it was,
                # so the next keystroke compares against this text and the stale one
                # cannot be mistaken for a second paragraph.
                old = self._texts.pop(best)
                if self._ids.get(old) == best:
                    del self._ids[old]
                self._texts[best] = text
                self._ids[text] = best
                return self.CHANGED
            self._next += 1
            self._texts[self._next] = text
            self._ids[text] = self._next
            while len(self._texts) > self.max_paragraphs:
                oldest, gone = self._texts.popitem(last=False)
                if self._ids.get(gone) == oldest:
                    del self._ids[gone]
            return self.NEW

    def _touch(self, sid):
        """Caller holds the lock. Move to the young end, so the cap drops the stalest."""
        self._texts.move_to_end(sid)


class Engine:
    def __init__(self, proofread, on_ready=None, log=None, timer_factory=None):
        """
        proofread(text, lang) -> list of anchored issues. May block; it runs on a worker.
        on_ready(text)        -> called after an answer is cached.
        timer_factory         -> injected for tests, so they need not sleep in real time.
        """
        self._proofread = proofread
        # Public on purpose: the caller re-reads its settings as they change, and the cap
        # is one of them. Nothing here reads it except _remember.
        self.cache_max = CACHE_MAX
        self._on_ready = on_ready or (lambda text: None)
        self._log = log or (lambda msg: None)
        self._timer_factory = timer_factory or threading.Timer

        self._lock = threading.RLock()
        self._cache = {}                 # text -> issues
        self._order = []                 # insertion order, for eviction
        self._timer = None
        self._pending_text = None        # what the pending timer will ask about
        self._inflight = None            # what a worker is asking about right now
        self._queue = []                 # texts waiting their turn during a sweep
        self._draining = False
        self.stopped = False
        self.last_error = None

    # --- the hot path ---------------------------------------------------------------
    def lookup(self, text):
        """The raw answer for exactly this text, or None. Must be instant."""
        with self._lock:
            return self._cache.get(text)

    def provisional(self, text):
        """The raw answer for the most similar text we have already checked.

        Used while a changed paragraph is being re-checked, so its underlines stay put
        instead of blinking out on every keystroke. Anchoring is done by the caller
        against the current text, so anything the edit invalidated drops out on its own.

        Similarity is a shared prefix, which is what typing produces. A threshold keeps
        one paragraph's answer off another paragraph that happens to be cached.
        """
        with self._lock:
            best, best_len = None, 0
            for candidate, issues in self._cache.items():
                if candidate == text:
                    return issues
                shared = same_stream(candidate, text)
                if shared > best_len:
                    best, best_len = issues, shared
            return best

    def request(self, text, lang, settings):
        """Note that this text wants checking, eventually. Returns at once."""
        if self.stopped:
            return
        with self._lock:
            if text in self._cache or text == self._inflight:
                return
            self._pending_text = text
            if self._timer is not None:
                self._timer.cancel()      # a newer keystroke supersedes the old one
            delay = max(0.0, float(settings.get("debounceMs", 1500)) / 1000.0)
            self._timer = self._timer_factory(delay, self._fire, [text, lang, settings])
            self._timer.daemon = True
            self._timer.start()

    def enqueue(self, text, lang, settings):
        """Ask about this text as well, rather than instead.

        request() debounces, which is right while one paragraph is being typed - each
        keystroke should cancel the last. It is wrong for "check this document", where
        every paragraph arrives at once and cancelling means only the final one is ever
        asked about. That is what happened: a twelve-paragraph sweep produced one
        request.

        These are drained one at a time, because LibreOffice's own proofreading is
        serial and a local model answers one request at a time anyway.
        """
        if self.stopped or not text.strip():
            return
        with self._lock:
            if text in self._cache or text in self._queue or text == self._inflight:
                return
            self._queue.append((text, lang, settings))
            if self._draining:
                return
            self._draining = True
        threading.Thread(target=self._drain, daemon=True).start()

    def _drain(self):
        while True:
            with self._lock:
                if self.stopped or not self._queue:
                    self._draining = False
                    return
                text, lang, settings = self._queue.pop(0)
                if text in self._cache:
                    continue
                self._inflight = text
            try:
                issues = self._proofread(text, lang)
                self.last_error = None
            except Exception as err:
                issues = []
                self.last_error = err
                self._log("proofread failed: %r" % (err,))
            with self._lock:
                self._inflight = None
                if self.stopped:
                    self._draining = False
                    return
                self._remember(text, issues)
            self._on_ready(text)

    # --- the worker ------------------------------------------------------------------
    def _fire(self, text, lang, settings):
        with self._lock:
            # The timer has run; drop the reference or `busy` latches on forever.
            self._timer = None
            if self.stopped or text != self._pending_text:
                return                    # superseded while the timer was running
            if text in self._cache or text == self._inflight:
                return
            self._inflight = text
        try:
            issues = self._proofread(text, lang)
            self.last_error = None
        except Exception as err:          # never propagate: a raise becomes a modal dialog
            issues = []
            self.last_error = err
            self._log("proofread failed: %r" % (err,))
        with self._lock:
            self._inflight = None
            if self.stopped:
                return
            self._remember(text, issues)
        self._on_ready(text)

    def _remember(self, text, issues):
        if text in self._cache:
            self._order.remove(text)
        self._cache[text] = issues
        self._order.append(text)
        while len(self._order) > max(1, self.cache_max):
            del self._cache[self._order.pop(0)]

    # --- control ----------------------------------------------------------------------
    def stop(self):
        """Stop checking: cancel the pending timer and refuse new work. An in-flight
        request is left to finish, because there is no way to interrupt a blocking
        urlopen from here - its result is simply discarded."""
        with self._lock:
            self.stopped = True
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
            self._pending_text = None
            self._queue = []

    def start(self):
        with self._lock:
            self.stopped = False

    def cancel_queue(self):
        """End a whole-document sweep: drop the paragraphs still waiting their turn.

        Checking as you type is untouched - its pending timer stays - which is the whole
        point of having this apart from stop(). The one request already in flight
        finishes and is cached; there is no interrupting a blocking urlopen.
        """
        with self._lock:
            self._queue = []

    def cancel_pending(self):
        """Checking as you type was switched off: drop the check waiting on its debounce.

        The sweep queue is untouched, for the same reason cancel_queue leaves this alone.
        """
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
            self._pending_text = None

    def forget(self):
        """Drop every cached answer, so the next look at a paragraph asks again."""
        with self._lock:
            self._cache.clear()
            self._order = []

    @property
    def busy(self):
        with self._lock:
            return (self._inflight is not None or self._timer is not None
                    or bool(self._queue))
