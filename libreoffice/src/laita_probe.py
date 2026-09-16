# -*- encoding: UTF-8 -*-
"""
A measuring instrument, not a port.

Before writing a LibreOffice extension there are four things worth knowing that no amount
of reading the API tells you, because they are about behaviour rather than signatures:

  1. How much text arrives per call - a sentence, a paragraph, the document?
  2. How often, and on what - every keystroke, a pause, only on demand?
  3. What Writer does while doProofreading is slow. It is a SYNCHRONOUS call, and LAITA's
     model takes 0.7s for a short paragraph and 19.4s for a long one. LibreOffice's own
     LanguageTool client also blocks on a network request, so blocking is expected - but
     it answers in milliseconds and we will not.
  4. Whether the underline, the context-menu suggestions and the per-category colour all
     work from Python, as they do from the built-in C++ client.

So this returns a fixed fake suggestion, sleeps for a configurable time, and writes a line
per call to a log. Nothing here talks to Ollama.

Tune it without reinstalling by editing ~/.laita-probe:
    delay=3.0          seconds to sleep inside doProofreading
    claim_paragraph=1  whether to claim the whole paragraph (see the note below)
"""
import os
import threading
import time
import traceback

import uno
import unohelper
from com.sun.star.linguistic2 import XProofreader, XSupportedLocales
from com.sun.star.linguistic2 import XLinguServiceEventBroadcaster, LinguServiceEvent
from com.sun.star.linguistic2.LinguServiceEventFlags import PROOFREAD_AGAIN
from com.sun.star.lang import XServiceInfo, XServiceName, XServiceDisplayName, Locale

IMPL_NAME = "org.lobianco.laita.Probe"
SERVICE = "com.sun.star.linguistic2.Proofreader"

LOG = os.path.expanduser("~/laita-probe.log")
CONF = os.path.expanduser("~/.laita-probe")

# The word the probe pretends is wrong, so the underline and the context menu can be seen.
#
# "the", deliberately. The obvious choice was a misspelling like "teh" - but that is in
# LibreOffice's AutoCorrect replacement table, so it is silently fixed on the next space
# and a grammar checker never sees it. A correctly spelled, extremely common word avoids
# both AutoCorrect and the red spell-check underline competing with ours.
TARGET = "the"
REPLACEMENTS = ("THE (from the LAITA probe)", "thee")

LOCALES = [("en", "US"), ("en", "GB"), ("en", ""), ("fr", "FR"), ("fr", ""),
           ("it", "IT"), ("it", ""), ("de", "DE"), ("de", ""), ("es", "ES"), ("es", "")]


def log(msg):
    # print() goes nowhere useful from inside LibreOffice - the same lesson the VS Code
    # port taught. A file is the only reliable channel.
    try:
        with open(LOG, "a", encoding="utf-8") as fh:
            fh.write("%.3f  %s\n" % (time.time(), msg))
    except Exception:
        pass


def conf(key, default):
    try:
        with open(CONF, encoding="utf-8") as fh:
            for line in fh:
                k, _, v = line.partition("=")
                if k.strip() == key:
                    return float(v.strip())
    except Exception:
        pass
    return default


class Probe(unohelper.Base, XProofreader, XServiceInfo, XServiceName,
            XServiceDisplayName, XSupportedLocales, XLinguServiceEventBroadcaster):

    def __init__(self, ctx, *args):
        self.ctx = ctx
        self.ServiceName = SERVICE
        self.ImplementationName = IMPL_NAME
        self.SupportedServiceNames = (SERVICE,)
        self.locales = tuple(Locale(l, c, "") for l, c in LOCALES)
        self.calls = 0
        # --- the async experiment -------------------------------------------------------
        # LibreOffice calls doProofreading on every keystroke and only when the text
        # changes. A checker that declines while you type therefore never gets a second
        # chance once you stop - unless it can ask for one. That is what this tests.
        self.listeners = []
        self.cache = {}        # text -> tuple of errors, the answer we already computed
        self.pending = set()   # texts a worker thread is currently "thinking" about
        self.lock = threading.Lock()
        log("=== probe loaded ===")

    # --- XServiceName / XServiceInfo ----------------------------------------------------
    def getServiceName(self):
        return self.ImplementationName

    def getImplementationName(self):
        return self.ImplementationName

    def supportsService(self, name):
        return name in self.SupportedServiceNames

    def getSupportedServiceNames(self):
        return self.SupportedServiceNames

    def getServiceDisplayName(self, locale):
        return "LAITA probe"

    # --- XSupportedLocales ---------------------------------------------------------------
    def hasLocale(self, locale):
        for i in self.locales:
            if i.Language == locale.Language and (i.Country == locale.Country or i.Country == ""):
                log("hasLocale(%s-%s) -> True" % (locale.Language, locale.Country))
                return True
        # The interesting case: LibreOffice is asking about a language we did not declare,
        # so the document's language is not what we assumed and nothing will ever be checked.
        log("hasLocale(%s-%s) -> FALSE  <- this document will never be checked"
            % (locale.Language, locale.Country))
        return False

    def getLocales(self):
        log("getLocales() -> %d locales" % len(self.locales))
        return self.locales

    # --- XProofreader ---------------------------------------------------------------------
    def isSpellChecker(self):
        log("isSpellChecker()")
        return False

    # --- XLinguServiceEventBroadcaster ---------------------------------------------------
    def addLinguServiceEventListener(self, listener):
        with self.lock:
            self.listeners.append(listener)
        log("addLinguServiceEventListener -> %d listener(s)" % len(self.listeners))
        return True

    def removeLinguServiceEventListener(self, listener):
        with self.lock:
            if listener in self.listeners:
                self.listeners.remove(listener)
        log("removeLinguServiceEventListener -> %d left" % len(self.listeners))
        return True

    def _ask_for_a_recheck(self):
        """Tell LibreOffice the answers changed, so it proofreads again."""
        with self.lock:
            listeners = list(self.listeners)
        if not listeners:
            log("  !! no listeners registered - cannot ask for a re-check")
            return
        ev = LinguServiceEvent(self, PROOFREAD_AGAIN)
        for li in listeners:
            try:
                li.processLinguServiceEvent(ev)
                log("  fired PROOFREAD_AGAIN")
            except Exception:
                log("  firing FAILED\n%s" % traceback.format_exc())

    def _think_then_recheck(self, text, delay):
        """Stands in for the model: sleep, cache an answer, ask for a re-check."""
        try:
            time.sleep(delay)
            with self.lock:
                self.cache[text] = self._errors_for(text)
                self.pending.discard(text)
            log("  worker finished for %d chars, asking for a re-check" % len(text))
            self._ask_for_a_recheck()
        except Exception:
            log("  worker EXCEPTION\n%s" % traceback.format_exc())

    def _errors_for(self, text):
        errors = []
        low = text.lower()
        at = low.find(TARGET)
        while at != -1:
            err = uno.createUnoStruct("com.sun.star.linguistic2.SingleProofreadingError")
            err.nErrorStart = at
            err.nErrorLength = len(TARGET)
            err.nErrorType = uno.getConstantByName(
                "com.sun.star.text.TextMarkupType.PROOFREADING")
            err.aRuleIdentifier = "LAITA_PROBE"
            err.aShortComment = "LAITA probe: a fake suggestion"
            err.aFullComment = ("This is the measurement extension, not the real one. "
                                "It flags every %r so the underline and this menu can "
                                "be seen." % TARGET)
            err.aSuggestions = REPLACEMENTS
            err.aProperties = ()
            errors.append(err)
            at = low.find(TARGET, at + 1)
        return tuple(errors)

    def ignoreRule(self, rule, locale):
        pass

    def resetIgnoreRules(self):
        pass

    def doProofreading(self, docId, text, locale, startOfSentence, suggestedEnd, properties):
        self.calls += 1
        n = self.calls
        started = time.time()

        res = uno.createUnoStruct("com.sun.star.linguistic2.ProofreadingResult")
        res.aDocumentIdentifier = docId
        res.aText = text
        res.aLocale = locale
        res.nStartOfSentencePosition = startOfSentence
        res.nStartOfNextSentencePosition = suggestedEnd
        res.aProperties = ()
        res.xProofreader = self
        res.aErrors = ()

        try:
            log("call %d  chars=%d  start=%d  suggestedEnd=%d  locale=%s-%s  props=%d  text=%r"
                % (n, len(text), startOfSentence, suggestedEnd,
                   locale.Language, locale.Country, len(properties), text[:70]))

            # Lightproof carries a comment calling this "PATCH FOR LO 4": LibreOffice asks
            # sentence by sentence, and a checker that wants the whole paragraph answers
            # only the first call and claims everything to the end. Worth measuring both
            # ways, because it decides what one request to Ollama can see.
            if conf("claim_paragraph", 1.0) >= 1.0:
                if startOfSentence != 0:
                    log("call %d  -> declined (not the start of the paragraph)" % n)
                    return res
                res.nStartOfNextSentencePosition = len(text)

            delay = conf("delay", 0.0)

            if conf("async", 0.0) >= 1.0:
                # The shape the real extension needs: answer instantly from the cache, and
                # when we have nothing, think in the background and ask to be called again.
                with self.lock:
                    known = self.cache.get(text)
                    thinking = text in self.pending
                if known is not None:
                    res.aErrors = known
                    log("call %d  -> %d errors FROM CACHE (instant)" % (n, len(known)))
                    return res
                if not thinking and text.strip():
                    with self.lock:
                        self.pending.add(text)
                    threading.Thread(target=self._think_then_recheck,
                                     args=(text, delay), daemon=True).start()
                    log("call %d  -> 0 errors, worker started (%.1fs)" % (n, delay))
                else:
                    log("call %d  -> 0 errors, already thinking" % n)
                return res

            if delay > 0:
                time.sleep(delay)
            res.aErrors = self._errors_for(text)
            log("call %d  -> %d errors in %.3fs (claimed to %d)"
                % (n, len(errors), time.time() - started, res.nStartOfNextSentencePosition))
        except Exception:
            log("call %d  EXCEPTION\n%s" % (n, traceback.format_exc()))
        return res


g_ImplementationHelper = unohelper.ImplementationHelper()
g_ImplementationHelper.addImplementation(Probe, IMPL_NAME, (SERVICE,),)
