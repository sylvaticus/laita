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

CACHE_MAX = 200

# How much of a paragraph must match before a previous answer is reused while the new one
# is computed. Below this, two short paragraphs starting "The " would borrow each other's
# suggestions.
MIN_SHARED_PREFIX = 20


class Engine:
    def __init__(self, proofread, on_ready=None, log=None, timer_factory=None):
        """
        proofread(text, lang) -> list of anchored issues. May block; it runs on a worker.
        on_ready(text)        -> called after an answer is cached.
        timer_factory         -> injected for tests, so they need not sleep in real time.
        """
        self._proofread = proofread
        self._on_ready = on_ready or (lambda text: None)
        self._log = log or (lambda msg: None)
        self._timer_factory = timer_factory or threading.Timer

        self._lock = threading.RLock()
        self._cache = {}                 # text -> issues
        self._order = []                 # insertion order, for eviction
        self._timer = None
        self._pending_text = None        # what the pending timer will ask about
        self._inflight = None            # what a worker is asking about right now
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
                shared = 0
                for a, b in zip(candidate, text):
                    if a != b:
                        break
                    shared += 1
                shortest = min(len(candidate), len(text))
                # Two conditions, and the floor must never exceed the text itself:
                # deleting the end of a paragraph makes it shorter than MIN_SHARED_PREFIX,
                # and it would then be unable to match the answer it just had.
                floor = min(MIN_SHARED_PREFIX, shortest)
                if shortest and shared >= floor and shared >= shortest * 0.6 \
                        and shared > best_len:
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
        while len(self._order) > CACHE_MAX:
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

    def start(self):
        with self._lock:
            self.stopped = False

    def forget(self):
        """Drop every cached answer, so the next look at a paragraph asks again."""
        with self._lock:
            self._cache.clear()
            self._order = []

    @property
    def busy(self):
        with self._lock:
            return self._inflight is not None or self._timer is not None
