# -*- encoding: UTF-8 -*-
"""
LAITA for LibreOffice: the UNO components.

Three services live here, because a .oxt registers Python components file by file:

  Proofreader     the grammar checker LibreOffice calls on every keystroke
  Dispatcher      the toolbar buttons
  OptionsHandler  the page under Tools > Options

Everything that can be tested without LibreOffice lives in pythonpath/ instead, and is
covered by libreoffice/test/. This file is the wiring, deliberately thin.

The one rule that shapes all of it: **never raise across the UNO boundary**. LibreOffice
answers an exception from a grammar checker with a blocking modal dialog on the first
keystroke - demonstrated by the probe, with a "could not connect" box over a document
containing one letter. So every entry point below swallows, logs, and returns something
harmless.
"""
import os
import time
import traceback

import uno
import unohelper

from com.sun.star.linguistic2 import XProofreader, XSupportedLocales
from com.sun.star.linguistic2 import XLinguServiceEventBroadcaster, LinguServiceEvent
from com.sun.star.linguistic2.LinguServiceEventFlags import PROOFREAD_AGAIN
from com.sun.star.lang import XServiceInfo, XServiceName, XServiceDisplayName, Locale
from com.sun.star.frame import XDispatchProvider, XDispatch
from com.sun.star.awt import XContainerWindowEventHandler

import laita_anchor as anchor
import laita_ollama as ollama
import laita_settings as settings_store
from laita_engine import Engine

PROOFREADER_IMPL = "org.lobianco.laita.Proofreader"
DISPATCHER_IMPL = "org.lobianco.laita.Dispatcher"
OPTIONS_IMPL = "org.lobianco.laita.OptionsHandler"
PROOFREADER_SERVICE = "com.sun.star.linguistic2.Proofreader"
PROTOCOL = "org.lobianco.laita.command:"

LOG = os.path.expanduser("~/laita-libreoffice.log")

# Which languages LibreOffice may hand us. Must agree with Linguistic.xcu: this list is
# fixed at install time, and a document in any other language is never checked at all.
LOCALES = [("en", "US"), ("en", "GB"), ("en", ""), ("fr", "FR"), ("fr", ""),
           ("it", "IT"), ("it", ""), ("de", "DE"), ("de", ""), ("es", "ES"), ("es", ""),
           ("pt", "PT"), ("pt", "BR"), ("pt", ""), ("nl", "NL"), ("nl", "")]

# LAITA's palette, as the browser draws it.
LINE_COLOUR = {"error": 0xE5484D, "style": 0xE2A336, "rephrase": 0x3E7BFA}


def log(msg):
    """print() goes nowhere from inside LibreOffice; a file is the only reliable channel."""
    try:
        with open(LOG, "a", encoding="utf-8") as fh:
            fh.write("%.3f  %s\n" % (time.time(), msg))
    except Exception:
        pass


class Proofreader(unohelper.Base, XProofreader, XServiceInfo, XServiceName,
                  XServiceDisplayName, XSupportedLocales, XLinguServiceEventBroadcaster):

    def __init__(self, ctx, *args):
        self.ctx = ctx
        self.ServiceName = PROOFREADER_SERVICE
        self.ImplementationName = PROOFREADER_IMPL
        self.SupportedServiceNames = (PROOFREADER_SERVICE,)
        self.locales = tuple(Locale(l, c, "") for l, c in LOCALES)
        self.listeners = []
        self.engine = Engine(self._ask_the_model, on_ready=self._answer_ready, log=log)
        Proofreader.instance = self
        log("proofreader loaded")

    # --- identity -----------------------------------------------------------------------
    def getServiceName(self):
        return self.ImplementationName

    def getImplementationName(self):
        return self.ImplementationName

    def supportsService(self, name):
        return name in self.SupportedServiceNames

    def getSupportedServiceNames(self):
        return self.SupportedServiceNames

    def getServiceDisplayName(self, locale):
        return "LAITA - Local AI Text Assistant"

    def hasLocale(self, locale):
        for i in self.locales:
            if i.Language == locale.Language and (i.Country == locale.Country or not i.Country):
                return True
        return False

    def getLocales(self):
        return self.locales

    def isSpellChecker(self):
        return False

    def ignoreRule(self, rule, locale):
        pass

    def resetIgnoreRules(self):
        pass

    # --- asking LibreOffice to look again -------------------------------------------------
    def addLinguServiceEventListener(self, listener):
        self.listeners.append(listener)
        return True

    def removeLinguServiceEventListener(self, listener):
        if listener in self.listeners:
            self.listeners.remove(listener)
        return True

    def _answer_ready(self, text):
        """An answer landed. Ask LibreOffice to proofread again; the next call hits cache."""
        try:
            ev = LinguServiceEvent(self, PROOFREAD_AGAIN)
            for li in list(self.listeners):
                li.processLinguServiceEvent(ev)
        except Exception:
            log("could not ask for a re-check\n%s" % traceback.format_exc())

    # --- the model ------------------------------------------------------------------------
    def _ask_the_model(self, text, lang):
        """Runs on a worker thread. Blocking is fine here: nothing is waiting on it.

        Returns the model's RAW answer. Anchoring happens later, against whatever the
        paragraph says at the moment it is drawn."""
        s = settings_store.read(self.ctx)
        started = time.time()
        raw = ollama.request_issues(text, lang, s,
                                    timeout=float(s["requestTimeoutMs"]) / 1000.0)
        log("model: %d chars, %d issues, %.1fs  %r"
            % (len(text), len(raw), time.time() - started, text[:60]))
        return raw

    # --- the hot path -----------------------------------------------------------------------
    def doProofreading(self, docId, text, locale, startOfSentence, suggestedEnd, properties):
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
            # LibreOffice asks sentence by sentence. Answer once for the whole paragraph:
            # the model needs the surrounding sentences to judge any of them, and one
            # request per sentence would multiply an already expensive call.
            if startOfSentence != 0:
                return res
            res.nStartOfNextSentencePosition = len(text)

            s = settings_store.read(self.ctx)
            if not s["enabled"] or self.engine.stopped:
                return res
            stripped = text.strip()
            if len(stripped) < s["minChars"] or len(text) > s["maxChars"]:
                return res

            lang = locale.Language or None
            raw = self.engine.lookup(text)
            if raw is None:
                if s["checkAsYouType"]:
                    self.engine.request(text, lang, s)
                # Show the previous answer for this paragraph while the new one is
                # computed, rather than blanking every underline on each keystroke.
                # Anchoring below is against the CURRENT text, so anything the edit
                # invalidated drops out by itself.
                raw = self.engine.provisional(text)
                if raw is None:
                    return res
            issues = anchor.anchor_issues(text, raw, categories=s["categories"],
                                          ignored=s["ignored"])
            res.aErrors = tuple(self._to_uno(text, i) for i in issues)
        except Exception:
            # Never let this escape: LibreOffice turns it into a modal dialog.
            log("doProofreading failed\n%s" % traceback.format_exc())
        return res

    def _to_uno(self, text, issue):
        err = uno.createUnoStruct("com.sun.star.linguistic2.SingleProofreadingError")
        # Python indexes code points, LibreOffice indexes UTF-16. They agree until an
        # emoji appears, and then every offset after it is one too small.
        start = anchor.to_utf16_index(text, issue["start"])
        end = anchor.to_utf16_index(text, issue["end"])
        err.nErrorStart = start
        err.nErrorLength = end - start
        err.nErrorType = uno.getConstantByName("com.sun.star.text.TextMarkupType.PROOFREADING")
        err.aRuleIdentifier = "LAITA_%s" % issue["type"].upper()
        err.aShortComment = issue["message"] or "LAITA suggestion"
        err.aFullComment = "%s\n\n%s -> %s" % (issue["message"], issue["original"],
                                               issue["replacement"])
        err.aSuggestions = (issue["replacement"],)
        colour = uno.createUnoStruct("com.sun.star.beans.PropertyValue")
        colour.Name = "LineColor"
        colour.Value = LINE_COLOUR.get(issue["type"], LINE_COLOUR["error"])
        err.aProperties = (colour,)
        return err


Proofreader.instance = None


class Dispatcher(unohelper.Base, XDispatchProvider, XDispatch, XServiceInfo):
    """The toolbar buttons. Each is a URL in our own protocol, routed here by
    ProtocolHandler.xcu."""

    def __init__(self, ctx, *args):
        self.ctx = ctx

    def getImplementationName(self):
        return DISPATCHER_IMPL

    def supportsService(self, name):
        return name == "com.sun.star.frame.ProtocolHandler"

    def getSupportedServiceNames(self):
        return ("com.sun.star.frame.ProtocolHandler",)

    def queryDispatch(self, url, target, flags):
        return self if url.Protocol == PROTOCOL else None

    def queryDispatches(self, requests):
        return tuple(self.queryDispatch(r.FeatureURL, r.FrameName, r.SearchFlags)
                     for r in requests)

    def addStatusListener(self, listener, url):
        pass

    def removeStatusListener(self, listener, url):
        pass

    def dispatch(self, url, args):
        try:
            self._run(url.Path)
        except Exception:
            log("dispatch %r failed\n%s" % (url.Path, traceback.format_exc()))

    def _run(self, command):
        pr = Proofreader.instance
        if command == "checkdocument":
            # LibreOffice owns the proofreading pass, so "check this document" means
            # forget what we know and ask it to walk the document again - which makes it
            # call us for every paragraph.
            if pr:
                pr.engine.start()
                pr.engine.forget()
                pr._answer_ready("")
            self._say("LAITA is checking the document.")
        elif command == "stop":
            if pr:
                pr.engine.stop()
            self._say("LAITA has stopped checking. Use Check document to resume.")
        elif command == "transform":
            # Not built yet. Say so where it can be seen: a status-bar note is easy to
            # miss, and "the button does nothing" is indistinguishable from a broken
            # dispatch - which is exactly what we spent an afternoon on with the probe.
            self._tell("LAITA", "Transform is not implemented yet.\n\n"
                                "Proofreading works; the rewrite-a-selection feature is "
                                "still to come.")
        elif command == "options":
            self._open_options()

    def _open_options(self):
        """Open Tools > Options ON our page.

        The argument is the point: .uno:OptionsTreeDialog with no arguments opens the
        tree wherever it was last, which is how this first shipped - the button worked
        and landed the user on the general Language settings.
        """
        try:
            desktop = self.ctx.ServiceManager.createInstanceWithContext(
                "com.sun.star.frame.Desktop", self.ctx)
            frame = desktop.getCurrentFrame()
            helper = self.ctx.ServiceManager.createInstanceWithContext(
                "com.sun.star.frame.DispatchHelper", self.ctx)
            arg = uno.createUnoStruct("com.sun.star.beans.PropertyValue")
            arg.Name = "OptionsPageURL"
            arg.Value = "%origin%/dialog/options.xdl"
            helper.executeDispatch(frame, ".uno:OptionsTreeDialog", "", 0, (arg,))
        except Exception:
            log("could not open the options page\n%s" % traceback.format_exc())

    def _tell(self, title, message):
        """A plain message box, only ever from a button the user just pressed.

        Never from the proofreading path: LibreOffice already shows a modal when a
        checker fails, and one of those arriving mid-sentence is what made the probe's
        first run unusable.
        """
        try:
            toolkit = self.ctx.ServiceManager.createInstanceWithContext(
                "com.sun.star.awt.Toolkit", self.ctx)
            desktop = self.ctx.ServiceManager.createInstanceWithContext(
                "com.sun.star.frame.Desktop", self.ctx)
            parent = desktop.getCurrentFrame().getContainerWindow()
            box = toolkit.createMessageBox(
                parent, uno.Enum("com.sun.star.awt.MessageBoxType", "INFOBOX"),
                1, title, message)
            box.execute()
            box.dispose()
        except Exception:
            log("%s: %s" % (title, message))

    def _say(self, message):
        """A non-modal note in the status bar. Never a message box: LibreOffice already
        shows one of those when a checker fails, and it interrupts typing."""
        try:
            desktop = self.ctx.ServiceManager.createInstanceWithContext(
                "com.sun.star.frame.Desktop", self.ctx)
            frame = desktop.getCurrentFrame()
            frame.getController().getStatusIndicator().start(message, 0)
        except Exception:
            log("status: %s" % message)


class OptionsHandler(unohelper.Base, XContainerWindowEventHandler, XServiceInfo):
    """Backs the page under Tools > Options > Language Settings > LAITA."""

    FIELDS = [
        ("endpoint", "Endpoint", "Text"),
        ("model", "Model", "Text"),
        ("debounceMs", "DebounceMs", "Text"),
        ("minChars", "MinChars", "Text"),
        ("maxChars", "MaxChars", "Text"),
        ("keepAlive", "KeepAlive", "Text"),
        ("extraInstructions", "ExtraInstructions", "Text"),
    ]
    CHECKS = [
        ("enabled", "Enabled"),
        ("checkAsYouType", "CheckAsYouType"),
        ("think", "Think"),
    ]
    CATEGORIES = [("error", "CatError"), ("style", "CatStyle"), ("rephrase", "CatRephrase")]

    def __init__(self, ctx, *args):
        self.ctx = ctx

    def getImplementationName(self):
        return OPTIONS_IMPL

    def supportsService(self, name):
        return name == OPTIONS_IMPL

    def getSupportedServiceNames(self):
        return (OPTIONS_IMPL,)

    def getSupportedMethodNames(self):
        return ("external_event",)

    def callHandlerMethod(self, window, event, method):
        try:
            if event == "initialize" or event == "back":
                self._load(window)
            elif event == "ok":
                self._save(window)
        except Exception:
            log("options %r failed\n%s" % (event, traceback.format_exc()))
        return True

    def _load(self, window):
        s = settings_store.read(self.ctx)
        for key, name, _ in self.FIELDS:
            ctrl = window.getControl(name)
            if ctrl:
                ctrl.setText(str(s[key]))
        for key, name in self.CHECKS:
            ctrl = window.getControl(name)
            if ctrl:
                ctrl.setState(1 if s[key] else 0)
        for cat, name in self.CATEGORIES:
            ctrl = window.getControl(name)
            if ctrl:
                ctrl.setState(1 if s["categories"].get(cat) else 0)

    def _save(self, window):
        changes = {}
        for key, name, _ in self.FIELDS:
            ctrl = window.getControl(name)
            if not ctrl:
                continue
            raw = ctrl.getText()
            if isinstance(settings_store.DEFAULTS[key], int):
                try:
                    raw = int(float(raw))
                except ValueError:
                    raw = settings_store.DEFAULTS[key]
            changes[key] = raw
        for key, name in self.CHECKS:
            ctrl = window.getControl(name)
            if ctrl:
                changes[key] = bool(ctrl.getState())
        cats = {}
        for cat, name in self.CATEGORIES:
            ctrl = window.getControl(name)
            if ctrl:
                cats[cat] = bool(ctrl.getState())
        if cats:
            changes["categories"] = cats
        settings_store.write(self.ctx, **changes)
        # Settings that change what the model is asked make every cached answer wrong.
        if Proofreader.instance:
            Proofreader.instance.engine.forget()


g_ImplementationHelper = unohelper.ImplementationHelper()
g_ImplementationHelper.addImplementation(Proofreader, PROOFREADER_IMPL, (PROOFREADER_SERVICE,),)
g_ImplementationHelper.addImplementation(Dispatcher, DISPATCHER_IMPL,
                                         ("com.sun.star.frame.ProtocolHandler",),)
g_ImplementationHelper.addImplementation(OptionsHandler, OPTIONS_IMPL, (OPTIONS_IMPL,),)
