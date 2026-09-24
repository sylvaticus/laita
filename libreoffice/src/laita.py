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
import threading
import time
import traceback
from collections import OrderedDict

import uno
import unohelper

from com.sun.star.linguistic2 import XProofreader, XSupportedLocales
from com.sun.star.linguistic2 import XLinguServiceEventBroadcaster, LinguServiceEvent
from com.sun.star.linguistic2.LinguServiceEventFlags import PROOFREAD_AGAIN
from com.sun.star.lang import XServiceInfo, XServiceName, XServiceDisplayName, Locale
from com.sun.star.frame import XDispatchProvider, XDispatch
from com.sun.star.task import XJob
from com.sun.star.datatransfer import XTransferable
from com.sun.star.ui import XContextMenuInterceptor
from com.sun.star.awt import XContainerWindowEventHandler, XDialogEventHandler, XCallback
from com.sun.star.datatransfer import XTransferable, DataFlavor

import laita_anchor as anchor
import laita_ollama as ollama
import laita_segment as segment
import laita_settings as settings_store
from laita_engine import Engine, EditTracker, same_stream

PROOFREADER_IMPL = "org.lobianco.laita.Proofreader"
DISPATCHER_IMPL = "org.lobianco.laita.Dispatcher"
OPTIONS_IMPL = "org.lobianco.laita.OptionsHandler"
JOB_IMPL = "org.lobianco.laita.StartupJob"
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
        self.edits = EditTracker()
        # (text, issues) for the paragraph whose sentences LibreOffice is walking.
        self._answer = None
        # Paragraph texts edited while checking as you type was off, oldest first.
        self._missed = OrderedDict()
        # Set by the Check the whole document button, for one sweep. Opening a long file
        # otherwise means LibreOffice asks about every visible paragraph at once, and
        # each of those is a request to a local model that answers in seconds.
        self.sweep = False
        self._sweep_timer = None
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
        """LibreOffice's own "Ignore All", wired to LAITA's persistent ignore list.

        No UI of ours is involved: the entry is already in the context menu, and the
        rule identifier we put on the error comes back here. Its last field is the
        issue fingerprint, which is what the browser stores too - so the two surfaces
        agree on what "never suggest this again" means.
        """
        try:
            fp = str(rule).split(":")[-1]
            if not fp:
                return
            s = settings_store.read(self.ctx)
            if fp in s["ignored"]:
                return
            settings_store.write(self.ctx, ignored=(list(s["ignored"]) + [fp])[-500:])
            log("ignoring %s from now on" % fp)
            self.engine.forget()
            self._answer_ready("")
        except Exception:
            log("ignoreRule failed\n%s" % traceback.format_exc())

    def resetIgnoreRules(self):
        """Called when LibreOffice wants a clean slate for a document.

        Deliberately does NOT clear the stored list: "never suggest this again" outlives
        a document, exactly as it does in the browser. Only the cache is dropped, so the
        next look re-applies the list.
        """
        try:
            self.engine.forget()
        except Exception:
            pass

    # --- asking LibreOffice to look again -------------------------------------------------
    def addLinguServiceEventListener(self, listener):
        self.listeners.append(listener)
        return True

    def removeLinguServiceEventListener(self, listener):
        if listener in self.listeners:
            self.listeners.remove(listener)
        return True

    def caret_paragraph(self):
        """The text of the paragraph the cursor is in, or None.

        No longer how "only what I am editing" is decided - EditTracker does that from
        the text. Used only by _pasted_here, for the one case text cannot settle.
        """
        try:
            desktop = self.ctx.ServiceManager.createInstanceWithContext(
                "com.sun.star.frame.Desktop", self.ctx)
            controller = desktop.getCurrentComponent().getCurrentController()
            cursor = controller.getViewCursor()
            para = getattr(cursor, "TextParagraph", None)
            return para.getString() if para is not None else None
        except Exception:
            return None

    def _pasted_here(self, text):
        """Is a paragraph never seen before an edit? True if it was pasted or typed here.

        Text alone cannot tell pasting a whole paragraph from opening a document: both are
        paragraphs never seen before. Two facts can. After opening, the document is
        unmodified; and a paste lands where the cursor is. Both are required - the cursor
        alone would bring back checking whatever paragraph a file opens on.
        """
        try:
            desktop = self.ctx.ServiceManager.createInstanceWithContext(
                "com.sun.star.frame.Desktop", self.ctx)
            doc = desktop.getCurrentComponent()
            if doc is None or not doc.isModified():
                return False
        except Exception:
            return False
        caret = self.caret_paragraph()
        return caret is not None and (text == caret or same_stream(text, caret) > 0)

    def start_sweep(self):
        """Allow every paragraph to be checked, until the work stops arriving."""
        self.sweep = True
        self.engine.start()
        self.engine.forget()
        self._answer_ready("")
        state_changed(self.ctx)

    def stop_sweep(self):
        """End the whole-document check. Checking as you type carries on untouched."""
        self.sweep = False
        if self._sweep_timer is not None:
            self._sweep_timer.cancel()
            self._sweep_timer = None
        self.engine.cancel_queue()
        state_changed(self.ctx)

    def typing_changed(self, on):
        """Checking as you type was switched. The setting is already written.

        Off keeps every underline already shown, and applying them keeps working:
        a right-click makes LibreOffice ask this checker again, which answers from the
        cache and never needs the model. On asks LibreOffice to look again, so the
        paragraphs edited while it was off (remembered in _missed) are checked now.
        """
        if on:
            self.engine.start()
            self._answer_ready("")
        else:
            self.engine.cancel_pending()

    def _maybe_end_sweep(self):
        """A sweep is over when the engine has been idle for a moment.

        There is no event for "LibreOffice has finished walking the document", so this
        watches for the work running out instead. Without it the override would stay on
        for the rest of the session and quietly undo the setting.
        """
        if self._sweep_timer is not None:
            self._sweep_timer.cancel()
        if not self.sweep:
            return

        def check():
            if self.sweep and not self.engine.busy:
                self.sweep = False
                log("sweep finished; back to checking only the current paragraph")
                state_changed(self.ctx)
        # Pure Python state, no UNO, so a plain timer is safe here - noted because
        # every other timer in this file must not be one.
        self._sweep_timer = threading.Timer(4.0, check)
        self._sweep_timer.daemon = True
        self._sweep_timer.start()

    def _answer_ready(self, text):
        """An answer landed. Ask LibreOffice to proofread again; the next call hits cache."""
        self._maybe_end_sweep()
        log("ready: %d chars, asking %d listener(s) for a re-check"
            % (len(text), len(self.listeners)))
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
        timeout = float(s["requestTimeoutMs"]) / 1000.0

        # One request per chunk, not one per paragraph. Splitting costs in proportion to
        # what it finds (measured - browser/tools/measure-chunking.mjs), and one request
        # stops at twelve issues, so on a long paragraph splitting is the only way to see
        # the rest.
        #
        # The chunks' raw answers are simply concatenated. That works because the model
        # answers with QUOTES rather than offsets: a quote from chunk three is still a
        # quote from the paragraph, and anchoring locates it against the whole paragraph
        # afterwards. No offset arithmetic is needed and none is done.
        chunks = segment.chunk_text(text, s["chunkMaxChars"])
        raw = []
        for _, chunk in chunks:
            raw.extend(ollama.request_issues(chunk, lang, s, timeout=timeout))
        log("model: %d chars in %d chunk(s), %d issues, %.1fs  %r"
            % (len(text), len(chunks), len(raw), time.time() - started, text[:60]))
        return raw

    # --- the hot path -----------------------------------------------------------------------
    def doProofreading(self, docId, text, locale, startOfSentence, suggestedEnd, properties):
        """Answer for ONE sentence of the paragraph, the way LibreOffice asks.

        LibreOffice's iterator calls this once per sentence, and it ignores any claim that
        a sentence runs further than it thinks: it recomputes where the next sentence
        starts from nBehindEndOfSentencePosition, substituting its own suggested end when
        that is unset (gciterator.cxx, the "work-around to prevent looping"). This used to
        answer the whole paragraph on the first call and return nothing for the rest -
        and each empty answer made LibreOffice clear that sentence's range, wiping the
        errors just reported there. Only a paragraph's first sentence ever kept its
        underlines, which is why short or split paragraphs worked and long ones did not.

        So the model is still asked about the whole paragraph, once (it needs the context),
        but each call returns only the errors that begin inside the sentence asked about.
        """
        res = uno.createUnoStruct("com.sun.star.linguistic2.ProofreadingResult")
        res.aDocumentIdentifier = docId
        res.aText = text
        res.aLocale = locale
        res.nStartOfSentencePosition = startOfSentence
        # Set it, so LibreOffice's fallback never has to guess. Its own suggestion is the
        # right boundary: the errors below are filtered to exactly this range.
        res.nBehindEndOfSentencePosition = suggestedEnd
        res.nStartOfNextSentencePosition = suggestedEnd
        res.aProperties = ()
        res.xProofreader = self
        res.aErrors = ()

        try:
            if startOfSentence == 0:
                # The first sentence of a pass: decide about the whole paragraph (cache,
                # model, provisional) and remember the answer for the sentences that follow.
                self._answer = (text, self._paragraph_issues(text, locale))
            elif self._answer is None or self._answer[0] != text:
                # A pass that did not start at sentence 0 - LibreOffice resumes mid
                # paragraph sometimes. Show what is known; never ask the model from here.
                self._answer = (text, self._known_issues(text))
            issues = self._answer[1]
            if issues:
                start = segment.from_utf16_index(text, startOfSentence)
                end = segment.from_utf16_index(text, suggestedEnd)
                mine = segment.sentence_slice(text, issues, start, end)
                res.aErrors = tuple(self._to_uno(text, i) for i in mine)
        except Exception:
            # Never let this escape: LibreOffice turns it into a modal dialog.
            log("doProofreading failed\n%s" % traceback.format_exc())
        return res

    def _known_issues(self, text):
        """Anchored issues for `text` from the cache or the nearest edit, without asking."""
        s = settings_store.read(self.ctx)
        raw = self.engine.lookup(text)
        if raw is None:
            raw = self.engine.provisional(text)
        if not raw:
            return []
        return anchor.anchor_issues(text, raw, categories=s["categories"],
                                    ignored=s["ignored"])

    def _paragraph_issues(self, text, locale):
        """Every anchored issue for the whole paragraph, deciding whether to ask the model.

        Called once per pass, on sentence 0. Returns [] whenever there is nothing to show.
        """
        s = settings_store.read(self.ctx)
        self.engine.cache_max = s["cacheMax"]
        if not s["enabled"] or self.engine.stopped:
            return []
        stripped = text.strip()
        if len(stripped) < s["minChars"] or len(text) > s["maxChars"]:
            return []

        lang = locale.Language or None
        change = self.edits.note(text)
        raw = self.engine.lookup(text)
        source = "cache"
        if raw is None:
            # Only ask about the paragraph being edited, unless the whole document
            # was asked for. Opening a long file makes LibreOffice offer every
            # visible paragraph at once, and each one is a request to a local model
            # that takes seconds.
            if self.sweep:
                # A sweep queues every paragraph. Debouncing here would cancel each
                # one as the next arrived and only the last would be asked about.
                self.engine.enqueue(text, lang, s)
                log("check: %d chars, queued for the sweep" % len(text))
                return []
            # Ask the model only about a paragraph somebody EDITED. The evidence is
            # the text, not the caret: the caret lands on paragraphs nobody touches -
            # opening a file, clicking to read - and checking those was reported as
            # "it proofreads text I never touched". EditTracker says whether this text
            # changes a paragraph already seen (an edit) or repeats one exactly (a
            # re-display: reopening, scrolling, the re-check after each answer).
            if s["scope"] == "document":
                edited, why = True, "document scope"
            elif change == EditTracker.CHANGED:
                edited, why = True, "edited"
            elif change == EditTracker.NEW and self._pasted_here(text):
                edited, why = True, "new, typed or pasted here"
            elif text in self._missed:
                edited, why = True, "edited while checking as you type was off"
            else:
                edited, why = False, "%s, not edited" % change
            if edited:
                if s["checkAsYouType"]:
                    self._missed.pop(text, None)
                    self.engine.request(text, lang, s)
                else:
                    # Remembered, so switching checking back on checks what was typed
                    # meanwhile - EditTracker will call it a re-display by then.
                    self._missed[text] = True
                    while len(self._missed) > 200:
                        self._missed.popitem(last=False)
                    why += ", not asked: checking as you type is off"
                source = "provisional (%s)" % why
            else:
                # Never ask the model about it. But do NOT return nothing: LibreOffice
                # reads an empty answer as "no errors" and clears the underlines, so an
                # already-checked paragraph's marks would blink out on every re-check.
                source = why
            # Show the previous answer for this paragraph (cached, or the nearest edit
            # of it) rather than blanking every underline on each keystroke or sweep.
            # Anchoring below is against the CURRENT text, so anything the edit
            # invalidated drops out by itself.
            raw = self.engine.provisional(text)
            if raw is None:
                log("check: %d chars, %s, nothing yet  %r"
                    % (len(text), source, text[:50]))
                return []
        issues = anchor.anchor_issues(text, raw, categories=s["categories"],
                                      ignored=s["ignored"])
        # The interesting line. A raw answer that anchors to nothing is the
        # difference between "the model said nothing" and "the model quoted text
        # that is no longer there" - and only the second explains a vanishing
        # underline.
        log("check: %d chars, %s, %d raw -> %d anchored  %r"
            % (len(text), source, len(raw), len(issues), text[:50]))
        return issues

    def _to_uno(self, text, issue):
        err = uno.createUnoStruct("com.sun.star.linguistic2.SingleProofreadingError")
        # Python indexes code points, LibreOffice indexes UTF-16. They agree until an
        # emoji appears, and then every offset after it is one too small.
        start = anchor.to_utf16_index(text, issue["start"])
        end = anchor.to_utf16_index(text, issue["end"])
        err.nErrorStart = start
        err.nErrorLength = end - start
        err.nErrorType = uno.getConstantByName("com.sun.star.text.TextMarkupType.PROOFREADING")
        # The fingerprint, not the category. LibreOffice passes this back to
        # ignoreRule() when the user picks "Ignore All", so making it identify the
        # SUGGESTION means that menu entry does what it says. A category id here would
        # have silenced every error in the document instead.
        err.aRuleIdentifier = "LAITA:%s:%s" % (issue["type"], issue["fp"])
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


# --- which command of each pair is showing ---------------------------------------------
# The checking commands come in two pairs and only one of each is visible at a time. The
# toolbar (GenericToolbarController) and the menu (MenuBarManager) both honour a
# frame.status.Visibility state by showing or hiding the entry, so all it takes is to
# answer LibreOffice's status listeners - which the dispatcher used to ignore, which is
# why the buttons never changed. LibreOffice registers one listener per command per
# window; the state is global (one Proofreader), so every registration is told.
PAIRED = ("checkdocument", "stopdocument", "typingon", "typingoff")
_status_listeners = []            # [(listener, url.Complete, url)]
_status_lock = threading.Lock()


def _visible(ctx):
    """{command: shown?} for the paired commands, from the state right now."""
    pr = Proofreader.instance
    sweeping = bool(pr and pr.sweep)
    typing = bool(settings_store.read(ctx)["checkAsYouType"])
    return {"checkdocument": not sweeping, "stopdocument": sweeping,
            "typingon": not typing, "typingoff": typing}


def _tell(listener, url, shown, source=None):
    ev = uno.createUnoStruct("com.sun.star.frame.FeatureStateEvent")
    ev.FeatureURL = url
    ev.IsEnabled = True
    ev.Requery = False
    vis = uno.createUnoStruct("com.sun.star.frame.status.Visibility")
    vis.bVisible = bool(shown)
    ev.State = vis
    if source is not None:
        ev.Source = source
    listener.statusChanged(ev)


def broadcast_state(ctx):
    """Tell every registered button and menu entry which of its pair is showing.
    Main thread only: the listeners are VCL toolbars and menus. Use state_changed()."""
    shown = _visible(ctx)
    with _status_lock:
        registered = list(_status_listeners)
    for listener, complete, url in registered:
        try:
            _tell(listener, url, shown[url.Path])
        except Exception:
            # Its window closed without unregistering; do not try it again.
            with _status_lock:
                _status_listeners[:] = [e for e in _status_listeners
                                        if not (e[1] == complete and e[0] == listener)]


def state_changed(ctx):
    """Safe from any thread - the sweep ends on a timer - so it always goes through
    the main thread, the same route every other UI touch in this file takes."""
    later_on_main(ctx, 0.0, lambda: broadcast_state(ctx), "toolbar state")


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
        if url.Path not in PAIRED:
            return
        with _status_lock:
            _status_listeners.append((listener, url.Complete, url))
        try:
            # Called on the main thread by the toolbar or menu being built, so it can be
            # answered at once - otherwise all four entries show until the first change.
            _tell(listener, url, _visible(self.ctx)[url.Path], self)
        except Exception:
            log("status for %s failed\n%s" % (url.Path, traceback.format_exc()))

    def removeStatusListener(self, listener, url):
        with _status_lock:
            _status_listeners[:] = [e for e in _status_listeners
                                    if not (e[1] == url.Complete and e[0] == listener)]

    def dispatch(self, url, args):
        try:
            self._run(url.Path)
        except Exception:
            log("dispatch %r failed\n%s" % (url.Path, traceback.format_exc()))

    def _run(self, command):
        pr = Proofreader.instance
        if command == "checkdocument":
            # LibreOffice owns the proofreading pass, so "check this document" means
            # forget what we know, allow every paragraph for one sweep, and ask it to
            # walk the document again - which makes it call us for each of them.
            if pr:
                pr.start_sweep()
            self._say("LAITA is checking the whole document.")
        elif command in ("stopdocument", "stop"):     # "stop" was its name before 0.4.4
            # Stops the sweep and nothing else. It used to stop the engine outright, so
            # checking as you type died with it and the only way back was another
            # whole-document sweep.
            if pr:
                pr.stop_sweep()
            self._say("LAITA stopped checking the document. Checking as you type is unchanged.")
        elif command in ("typingon", "typingoff"):
            on = command == "typingon"
            # The same setting as the Check as you type box in the options, so the two
            # can never disagree - and it survives a restart, like the box does.
            settings_store.write(self.ctx, checkAsYouType=on)
            if pr:
                pr.typing_changed(on)
            state_changed(self.ctx)
            self._say("LAITA is checking as you type." if on else
                      "LAITA stopped checking as you type. Suggestions already shown stay "
                      "and can still be applied.")
        elif command == "transform":
            self._transform()
        elif command == "adddictionary":
            self._add_to_dictionary()
        elif command == "options":
            self._open_options()

    def _where(self, handle):
        """Enough to identify what was written to, for the log."""
        try:
            desktop = self.ctx.ServiceManager.createInstanceWithContext(
                "com.sun.star.frame.Desktop", self.ctx)
            doc = desktop.getCurrentComponent()
            title = getattr(doc, "Title", "?")
            address = getattr(handle, "CellAddress", None)
            if address is not None:
                return "%s sheet %d cell (%d,%d)" % (title, address.Sheet,
                                                     address.Column, address.Row)
            return "%s" % title
        except Exception:
            return "?"

    def _recheck_later(self, resolve, expected, what, delay=3.0, was=None, retries=1):
        """Read the text back after the dust settles, and put it back if it was undone.

        Something in Calc restores the cell's previous content shortly after the write -
        reported, and confirmed by this check. Every component was tested in isolation
        against a real window and each one keeps the write: edit mode, a modal dialog,
        writing from inside a dispatch, either ordering, the editor committing
        afterwards. Driving the whole thing end to end needs a window manager, which
        this machine has not got.

        So this is a workaround rather than a diagnosis, and it is written to be a safe
        one. It only rewrites when the text has gone back to EXACTLY what was there
        before - if anything else is in the cell, that is the user's and it is left
        alone.
        """
        def look():
            try:
                now = resolve().getString()
            except Exception:
                log("%s: could not re-read the text\n%s" % (what, traceback.format_exc()))
                return
            if now == expected:
                log("%s: still there after %.0fs" % (what, delay))
                return
            log("%s: GONE after %.0fs - something reverted it. Now holds %r"
                % (what, delay, now[:60]))
            if retries <= 0:
                return
            if was is not None and now != was:
                log("%s: not restoring - the text is neither ours nor the original"
                    % what)
                return

            # Already on the main thread here, because look() was marshalled there.
            try:
                resolve().setString(expected)
                log("%s: put back after the revert" % what)
            except Exception:
                log("%s: could not put it back\n%s" % (what, traceback.format_exc()))
                return
            self._recheck_later(resolve, expected, what, delay=2.0, was=was,
                                retries=retries - 1)
        later_on_main(self.ctx, delay, look, "delayed re-check")

    def _to_clipboard(self, text):
        """Last resort when the document will not take the text back."""
        try:
            clip = self.ctx.ServiceManager.createInstanceWithContext(
                "com.sun.star.datatransfer.clipboard.SystemClipboard", self.ctx)
            clip.setContents(_PlainText(text), None)
        except Exception:
            log("could not reach the clipboard\n%s" % traceback.format_exc())

    def _add_to_dictionary(self):
        word = selected_word(self.ctx)
        if not word:
            self._tell("LAITA", "Select a single word first, then add it to the "
                                "dictionary.")
            return
        s = settings_store.read(self.ctx)
        if word in s["dictionary"]:
            self._tell("LAITA", '"%s" is already in the dictionary.' % word)
            return
        settings_store.write(self.ctx, dictionary=(list(s["dictionary"]) + [word])[-300:])
        log("added %r to the dictionary" % word)
        # The dictionary goes into the prompt, so every cached answer was produced
        # without it and is now out of date.
        pr = Proofreader.instance
        if pr:
            pr.engine.forget()
            pr._answer_ready("")
        self._tell("LAITA", '"%s" will no longer be flagged.' % word)

    def _leave_edit_mode(self):
        """Come out of a cell or shape's text editor before writing to the document.

        While a cell or a shape is being EDITED, the editing engine holds the text and
        the model object we captured is a copy of it. Writing to that copy succeeds and
        even reads back correctly - which is exactly what the log showed - and then the
        editor writes its own buffer over the top when editing ends. Escape ends the
        edit and leaves the cell or shape selected.
        """
        try:
            desktop = self.ctx.ServiceManager.createInstanceWithContext(
                "com.sun.star.frame.Desktop", self.ctx)
            frame = desktop.getCurrentComponent().getCurrentController().getFrame()
            helper = self.ctx.ServiceManager.createInstanceWithContext(
                "com.sun.star.frame.DispatchHelper", self.ctx)
            helper.executeDispatch(frame, ".uno:Escape", "", 0, ())
        except Exception:
            log("could not leave edit mode\n%s" % traceback.format_exc())

    def _survey(self, note):
        """Every open document and what its first cell holds.

        The log has now said "wrote it" and "it is still there" about a document the
        user was looking at unchanged. Either we are writing to a different document
        than the visible one, or to a different cell. This says which, instead of
        inviting a sixth guess.
        """
        try:
            desktop = self.ctx.ServiceManager.createInstanceWithContext(
                "com.sun.star.frame.Desktop", self.ctx)
            current = desktop.getCurrentComponent()
            components = desktop.getComponents().createEnumeration()
            n = 0
            while components.hasMoreElements():
                doc = components.nextElement()
                n += 1
                title = getattr(doc, "Title", "?")
                mark = " <- getCurrentComponent()" if doc == current else ""
                cell = ""
                try:
                    if hasattr(doc, "Sheets"):
                        cell = " A1=%r" % doc.Sheets.getByIndex(0) \
                            .getCellByPosition(0, 0).getString()[:40]
                except Exception:
                    pass
                log("  survey/%s: [%d] %r%s%s" % (note, n, title, cell, mark))
            if not n:
                log("  survey/%s: no documents open" % note)
        except Exception:
            log("survey failed\n%s" % traceback.format_exc())

    def _write_model(self, read, handle, new_text, what, was):
        """Write the document model, and if that will not take, paste instead.

        The order matters and is the opposite of Calc's. A Draw or Impress SHAPE takes
        setString happily, and pasting onto a selected shape inserts a new object and
        empties it - measured. But when the selection is a text range INSIDE a shape,
        because the user went into the shape's text editor, the same editor problem
        as Calc's applies and only pasting goes through it.

        Rather than try to tell those two apart by type - the guesses in this feature
        have not gone well - write the model, check, and paste only if it did not take.
        A shape that accepted setString never reaches the paste, so it can never be
        emptied by one.
        """
        try:
            handle.setString(new_text)
            failed = None
        except Exception as err:
            failed = err
            log("%s: setString raised: %r" % (what, err))
        if failed is None:
            if self._present(read, handle, new_text):
                log("%s: wrote %d characters into %s"
                    % (what, len(new_text), self._where(handle)))
                self._recheck_later(read, new_text, what, was=was)
                return True
            log("%s: the model write did not take" % what)

        # Second route: the editor, via a paste. Only reached when writing the model
        # did not work, which is exactly the case where an editor is in the way.
        if self._paste_over_selection(new_text):
            def confirm():
                if self._present(read, handle, new_text):
                    log("%s: pasted %d characters" % (what, len(new_text)))
                    return
                log("%s: neither writing nor pasting took" % what)
                self._offer_clipboard(new_text, what)
            later_on_main(self.ctx, 1.5, confirm, "paste check")
            return True

        self._offer_clipboard(new_text, what)
        return False
        log("%s: wrote %d characters into %s"
            % (what, len(new_text), self._where(handle)))
        self._recheck_later(read, new_text, what, was=was)
        return True

    def _present(self, read, handle, new_text):
        """Is the text in the document? Not "does this object still return it".

        Writing to a TEXT RANGE replaces the text and leaves the range no longer
        spanning it, so reading the range back gives something else and the write looks
        like it failed. That false negative is why Draw and Impress wrote the text
        correctly and then announced they could not - and why they went on to paste on
        top of a write that had already worked.

        So ask the enclosing text as well, which is what a person would look at.
        """
        try:
            if read().getString() == new_text:
                return True
        except Exception:
            pass
        for holder in ("getText", "TextFrame", "Text"):
            try:
                container = getattr(handle, holder)
                container = container() if callable(container) else container
                if container is not None and new_text in container.getString():
                    return True
            except Exception:
                continue
        return False

    def _offer_clipboard(self, text, what):
        log("%s: offering the text on the clipboard instead" % what)
        self._to_clipboard(text)
        self._tell("LAITA", "The rewritten text could not be put back into the "
                            "document. It is on your clipboard instead.")

    def _paste_over_selection(self, text):
        """Replace the selection by pasting, which is how a person would do it.

        Everything else writes the document MODEL underneath a cell or shape editor
        that still holds the old string, and the editor puts it back when it commits -
        that is what six rounds of logs show, most clearly the one where the text was
        written, confirmed present, and reverted three seconds later with only one
        document open and the right cell named.

        Paste goes through the editor rather than around it, so there is no staler
        buffer left to win. The clipboard is put back afterwards, because quietly
        eating it would be its own bug.
        """
        clip = None
        previous = None
        try:
            clip = self.ctx.ServiceManager.createInstanceWithContext(
                "com.sun.star.datatransfer.clipboard.SystemClipboard", self.ctx)
            # Copy the previous contents out as a STRING rather than keeping the
            # transferable. That object belongs to whoever put it there - another
            # document, or another application - and handing it back two seconds later,
            # after it may have gone, is a plausible way to take LibreOffice down with
            # it. Anything that is not text is simply not restored.
            try:
                held = clip.getContents()
                for flavor in held.getTransferDataFlavors():
                    if flavor.MimeType.startswith("text/plain"):
                        previous = str(held.getTransferData(flavor))
                        break
            except Exception:
                previous = None
            clip.setContents(_PlainText(text), None)

            desktop = self.ctx.ServiceManager.createInstanceWithContext(
                "com.sun.star.frame.Desktop", self.ctx)
            frame = desktop.getCurrentComponent().getCurrentController().getFrame()
            helper = self.ctx.ServiceManager.createInstanceWithContext(
                "com.sun.star.frame.DispatchHelper", self.ctx)
            helper.executeDispatch(frame, ".uno:Paste", "", 0, ())
            return True
        except Exception:
            log("paste failed\n%s" % traceback.format_exc())
            return False
        finally:
            if clip is not None and previous is not None:
                # After the paste has been consumed, not before - and on the main
                # thread, because the clipboard is UNO like everything else.
                def restore():
                    try:
                        clip.setContents(_PlainText(previous), None)
                    except Exception:
                        pass
                later_on_main(self.ctx, 2.0, restore, "clipboard restore")

    def _enter_string(self, text):
        """Write the current Calc cell the way typing does.

        setString writes the model directly, and the cell editor holds its own buffer
        which it puts back afterwards - four rounds of evidence say something restores
        the previous content a moment after our write lands. .uno:EnterString goes
        through the same path as typing into the cell, so there is no staler buffer left
        to win.
        """
        try:
            desktop = self.ctx.ServiceManager.createInstanceWithContext(
                "com.sun.star.frame.Desktop", self.ctx)
            frame = desktop.getCurrentComponent().getCurrentController().getFrame()
            helper = self.ctx.ServiceManager.createInstanceWithContext(
                "com.sun.star.frame.DispatchHelper", self.ctx)
            arg = uno.createUnoStruct("com.sun.star.beans.PropertyValue")
            arg.Name = "StringName"
            arg.Value = text
            helper.executeDispatch(frame, ".uno:EnterString", "", 0, (arg,))
            return True
        except Exception:
            log("EnterString failed\n%s" % traceback.format_exc())
            return False

    def _stable_handle(self, target):
        """Something that will still refer to the right place after a modal dialog.

        A Calc cell is re-resolved by address, because the object handed out during an
        edit need not be the one the sheet keeps. Everything else is returned as it is;
        a Writer text range and a Draw or Impress shape both survive.
        """
        address = getattr(target, "CellAddress", None)
        if address is None:
            return target, None
        try:
            desktop = self.ctx.ServiceManager.createInstanceWithContext(
                "com.sun.star.frame.Desktop", self.ctx)
            doc = desktop.getCurrentComponent()

            def resolve():
                sheet = doc.Sheets.getByIndex(address.Sheet)
                return sheet.getCellByPosition(address.Column, address.Row)
            return target, resolve
        except Exception:
            return target, None

    def _selection(self):
        """Whatever holds the selected text, or None.

        Returns the OBJECT, not the string: replacing it later needs something to write
        back to, and looking the selection up again afterwards would race with anything
        that moved the cursor.

        The shape differs per application, which is why this is not one line. Writer
        gives a collection of text ranges; Calc gives a cell directly, or a range of
        them; Impress and Draw give a collection of shapes. Each has getString and
        setString once it has been unwrapped, and proofreading may be Writer-only but a
        rewrite is useful in all of them.
        """
        try:
            desktop = self.ctx.ServiceManager.createInstanceWithContext(
                "com.sun.star.frame.Desktop", self.ctx)
            doc = desktop.getCurrentComponent()
            selection = doc.getCurrentSelection()
            if selection is None:
                return None
            # Calc hands back the cell itself; Writer, Impress and Draw hand back a
            # collection of one or more things.
            target = selection
            if not hasattr(selection, "getString") and hasattr(selection, "getCount"):
                if not selection.getCount():
                    return None
                target = selection.getByIndex(0)
            if not hasattr(target, "getString") or not hasattr(target, "setString"):
                return None
            if not target.getString().strip():
                return None
            log("selection: %s  (from %s, %d chars)"
                % (target.getImplementationName()
                   if hasattr(target, "getImplementationName") else type(target).__name__,
                   selection.getImplementationName()
                   if hasattr(selection, "getImplementationName") else type(selection).__name__,
                   len(target.getString())))
            return target
        except Exception:
            log("could not read the selection\n%s" % traceback.format_exc())
            return None

    def _transform(self):
        rng = self._selection()
        if rng is None:
            self._tell("LAITA", "Select some text first, then choose Transform selection.")
            return
        selected = rng.getString()

        # No .uno:Escape here any more. executeDispatch POSTS the command, and from
        # inside a dispatch there is no way to know when it runs - it may well have been
        # cancelling the cell edit, and restoring its pre-edit content, after our write.
        # Every scripted scenario writes successfully without it.

        s = settings_store.read(self.ctx)
        if len(selected) > s["maxChars"]:
            self._tell("LAITA", "That selection is %d characters, over the %d limit in "
                                "the options." % (len(selected), s["maxChars"]))
            return

        # Ollama answers one request at a time. A transform started while paragraphs
        # are being proofread waits behind them, which from the outside is a dialog
        # that does nothing for a while and then suddenly works - reported exactly that
        # way, and more often after an append, because an append changes the paragraph
        # and sets the checker off again.
        pr = Proofreader.instance
        was_checking = bool(pr) and not pr.engine.stopped
        if pr and was_checking:
            pr.engine.stop()
            log("transform: proofreading paused so the model is free")

        state = {"output": ""}

        def run(dialog):
            """Start the model on a worker thread and return at once.

            The first version called the model right here. On the UI thread, for a
            one-page selection, that froze the whole of LibreOffice long enough for the
            desktop to offer Force Quit - not just the dialog. A transform is a
            deliberate act and waiting for it is fine; hanging the application is not.
            """
            if state.get("running"):
                return
            instruction = (dialog.getControl("Instruction").getText().strip()
                           or s["transformDefault"])
            state["running"] = True
            dialog.getControl("btnRun").setEnable(False)
            dialog.getControl("Status").setText(
                "Asking the model... roughly %d seconds for this much text. Proofreading "
                "is paused meanwhile, because Ollama answers one request at a time."
                % max(2, int(len(selected) / 45)))

            def deliver(out, err):
                """Runs back on the main thread, via AsyncCallback."""
                state["running"] = False
                try:
                    dialog.getControl("btnRun").setEnable(True)
                    if err is not None:
                        dialog.getControl("Status").setText(ollama.describe_error(err))
                        return
                    if ollama.looks_truncated_transform(selected, out, instruction):
                        dialog.getControl("Status").setText(
                            "The model returned %d characters for a %d-character "
                            "selection - too short to be a rewrite. Nothing changed."
                            % (len(out.strip()), len(selected.strip())))
                        return
                    state["output"] = out
                    dialog.getControl("Result").setText(out)
                    dialog.getControl("Status").setText(
                        "Done. Accept & replace, Accept & append, or Reject.")
                    remember_instruction(self.ctx, instruction)
                except Exception:
                    log("delivering the transform failed\n%s" % traceback.format_exc())

            def work():
                out, err = "", None
                try:
                    out = ollama.request_transform(
                        selected, instruction, None, s,
                        timeout=max(90.0, len(selected) / 3.0))
                except Exception as caught:
                    err = caught
                    log("transform request failed: %s" % ollama.describe_error(caught))
                # Hop back to the main thread. Touching dialog controls from a worker is
                # what the SolarMutex exists to prevent, and it fails as a crash rather
                # than an exception.
                try:
                    async_cb = self.ctx.ServiceManager.createInstanceWithContext(
                        "com.sun.star.awt.AsyncCallback", self.ctx)
                    async_cb.addCallback(MainThreadCall(lambda: deliver(out, err)), None)
                except Exception:
                    log("could not marshal back to the main thread\n%s"
                        % traceback.format_exc())

            threading.Thread(target=work, daemon=True).start()

        def write_back(new_text, what):
            """Put the result into the document.

            Two different problems, so two different routes, and the choice is made on
            evidence rather than symmetry:

            A spreadsheet cell is edited by an editor that holds its own buffer and
            commits it over anything written to the model. Only pasting goes through
            that editor. The paste is DISPATCHED, so it completes in a later turn of
            the main loop - which means it cannot be waited for by sleeping here, since
            this runs on the main loop too and sleeping is what stops it happening.
            Checking later, and falling back only then, is the whole of the fix.

            A Writer range or an Impress or Draw shape has no such editor. setString
            works, holds, and is what they had before; deferring and second-guessing it
            is what left shapes reporting failure and offering the clipboard.
            """
            handle, resolve = self._stable_handle(rng)
            read = resolve if resolve else (lambda: handle)

            # Who owns the text decides the route, and the selection's type says who.
            #
            #   ScCellObj      a spreadsheet cell, whose editor reverts model writes
            #   SvxUnoText*    a cursor inside a Draw or Impress shape's text editor,
            #                  which reverts them in exactly the same way - the log
            #                  showed "wrote 23 characters" and then "GONE, now holds
            #                  ''" for precisely this type
            #
            # Both are editors, so both need pasting, and pasting is safe in both
            # because the editor is open to receive it. It is only unsafe when a SHAPE
            # is selected rather than its text, and that case never reaches here: a
            # shape takes setString and is done.
            name = (handle.getImplementationName()
                    if hasattr(handle, "getImplementationName") else "")
            is_cell = getattr(handle, "CellAddress", None) is not None
            in_editor = is_cell or name.startswith("SvxUnoText")

            if in_editor and self._paste_over_selection(new_text):
                def confirm():
                    if self._present(read, handle, new_text):
                        log("%s: pasted %d characters" % (what, len(new_text)))
                        return
                    # The paste did not take. NOW write the model, having given the
                    # dispatch its turn rather than racing it.
                    log("%s: the paste did not take; writing the cell instead" % what)
                    self._write_model(read, handle, new_text, what, selected)
                later_on_main(self.ctx, 1.5, confirm, "paste check")
                return True

            return self._write_model(read, handle, new_text, what, selected)

        def append(dialog):
            # Remember what to write and let execute() return; the write happens after
            # the dialog is gone, for the same reason as Accept & replace.
            state["append"] = dialog.getControl("Result").getText()
            dialog.endExecute()

        def copy(dialog):
            # Does NOT close the dialog: the point of copying is often to keep the result
            # while trying another instruction.
            text = dialog.getControl("Result").getText()
            if not text.strip():
                dialog.getControl("Status").setText("There is nothing to copy yet.")
                return
            ok = copy_to_clipboard(self.ctx, text)
            dialog.getControl("Status").setText(
                "Copied %d characters." % len(text) if ok
                else "Could not reach the clipboard. See ~/laita-libreoffice.log")

        try:
            provider = self.ctx.ServiceManager.createInstanceWithContext(
                "com.sun.star.awt.DialogProvider", self.ctx)
            dialog = provider.createDialogWithHandler(
                "vnd.sun.star.extension://org.lobianco.laita/dialog/transform.xdl",
                DialogHandler(self.ctx, on_run=run, on_append=append, on_copy=copy))
            dialog.getControl("Selected").setText(selected)
            combo = dialog.getControl("Instruction")
            offered = list(dict.fromkeys(list(s["transformHistory"]) +
                                         [s["transformDefault"]]))
            combo.addItems(tuple(offered), 0)
            combo.setText(offered[0] if offered else s["transformDefault"])
            verdict = dialog.execute()
            # The Result field is editable, so what gets written is whatever is in it NOW,
            # not the model's answer. Read it BEFORE dispose() - a disposed dialog has no
            # controls. Accept & append already did this in its own handler; Accept &
            # replace did not, and silently threw away every edit the user had made.
            state["output"] = dialog.getControl("Result").getText()
            log("transform dialog closed with %r, %d characters of output"
                % (verdict, len(state["output"])))
            self._survey("at close")
            # Dispose BEFORE writing. Disposing a modal dialog hands focus back to the
            # document, and if that happens after we have written, a cell editor that
            # regains focus can put its own stale buffer over the top. Driven from a
            # script the write survives in this order and was reverted in the other,
            # which is the only difference the two had.
            dialog.dispose()

            # Written here, not deferred. Deferring was a guess, and it cost Impress
            # and Draw the write that had been working: by the time a later turn of the
            # main loop ran, the shape was no longer the thing being written to and the
            # result went to the clipboard instead. The cell's paste needs a later turn,
            # and gets one of its own inside write_back, which is the only place that
            # actually needs it.
            if state.get("append", "").strip():
                write_back(selected + " " + state["append"], "append")
            elif verdict == 1 and state["output"].strip():
                write_back(state["output"], "replace")
        except Exception:
            log("transform failed\n%s" % traceback.format_exc())
            self._tell("LAITA", "The transform dialog could not open. See "
                                "~/laita-libreoffice.log")
        finally:
            if pr and was_checking:
                pr.engine.start()
                log("transform: proofreading resumed")

    def _open_options(self):
        """Our own dialog, rather than a page in the Tools > Options tree.

        The tree route is registered in OptionsDialog.xcu and the handler above still
        backs it, but the page never appeared there - and .uno:OptionsTreeDialog then
        opens the tree wherever it was last, which looks like the button going to the
        wrong place. A dialog we create ourselves cannot fail that quietly.
        """
        try:
            provider = self.ctx.ServiceManager.createInstanceWithContext(
                "com.sun.star.awt.DialogProvider", self.ctx)
            dialog = provider.createDialogWithHandler(
                "vnd.sun.star.extension://org.lobianco.laita/dialog/options_dialog.xdl",
                DialogHandler(self.ctx))
            load_into(self.ctx, dialog)
            if dialog.execute() == 1:          # 1 is OK, 0 is Cancel or the close box
                save_from(self.ctx, dialog)
            dialog.dispose()
        except Exception:
            log("could not open the options dialog\n%s" % traceback.format_exc())
            self._tell("LAITA", "Could not open the options dialog. See "
                                "~/laita-libreoffice.log")

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


# The controls, named once. Both the embedded page and the standalone dialog use these
# ids, so neither can drift from the other - and test_wiring.py checks both .xdl files
# define every one of them.
FIELDS = [
        ("endpoint", "Endpoint", "Text"),
        ("model", "Model", "Text"),
        ("debounceMs", "DebounceMs", "Text"),
        ("minChars", "MinChars", "Text"),
        ("maxChars", "MaxChars", "Text"),
        ("cacheMax", "CacheMax", "Text"),
        ("keepAlive", "KeepAlive", "Text"),
    ("extraInstructions", "ExtraInstructions", "Text"),
]
CHECKS = [
    ("enabled", "Enabled"),
    ("checkAsYouType", "CheckAsYouType"),
    ("think", "Think"),
]
CATEGORIES = [("error", "CatError"), ("style", "CatStyle"), ("rephrase", "CatRephrase")]


def fill_models(ctx, window, settings=None):
    """Offer the models Ollama actually has, without losing what is configured.

    The combobox stays editable on purpose: a model can be pulled while the dialog is
    open, and Ollama may be unreachable when it opens - in which case the list is empty
    and the configured name is still shown rather than blanked.
    """
    combo = window.getControl("Model")
    if not combo:
        return None
    settings = settings or settings_store.read(ctx)
    try:
        models = ollama.list_models(settings)
    except Exception as err:
        log("could not list models: %s" % ollama.describe_error(err))
        return None
    try:
        combo.removeItems(0, combo.getItemCount())
        combo.addItems(tuple(models), 0)
    except Exception:
        pass
    return models


def load_into(ctx, window):
    s = settings_store.read(ctx)
    fill_models(ctx, window, s)
    for key, name, _ in FIELDS:
        ctrl = window.getControl(name)
        if ctrl:
            ctrl.setText(str(s[key]))
    for key, name in CHECKS:
        ctrl = window.getControl(name)
        if ctrl:
            ctrl.setState(1 if s[key] else 0)
    for cat, name in CATEGORIES:
        ctrl = window.getControl(name)
        if ctrl:
            ctrl.setState(1 if s["categories"].get(cat) else 0)


def save_from(ctx, window):
    changes = {}
    for key, name, _ in FIELDS:
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
    for key, name in CHECKS:
        ctrl = window.getControl(name)
        if ctrl:
            changes[key] = bool(ctrl.getState())
    cats = {}
    for cat, name in CATEGORIES:
        ctrl = window.getControl(name)
        if ctrl:
            cats[cat] = bool(ctrl.getState())
    if cats:
        changes["categories"] = cats
    settings_store.write(ctx, **changes)
    # Anything that changes what the model is asked makes every cached answer wrong.
    if Proofreader.instance:
        Proofreader.instance.engine.forget()
    # Check as you type may have changed here; the toolbar pair must follow the box.
    state_changed(ctx)
    log("settings saved: %s" % sorted(changes))


HISTORY_MAX = 20


def remember_instruction(ctx, instruction):
    """Keep the last instructions, most recent first, for the dropdown."""
    if not instruction:
        return
    s = settings_store.read(ctx)
    history = [instruction] + [h for h in s["transformHistory"] if h != instruction]
    settings_store.write(ctx, transformHistory=history[:HISTORY_MAX])


def test_connection(ctx, window):
    """Answer the Test button, in the dialog rather than in a message box."""
    status = window.getControl("Status")

    def say(text):
        if status:
            status.setText(text)
        log("connection test: %s" % text)

    # Test what is on screen, not what was last saved: the point is to try a change.
    probe_settings = dict(settings_store.read(ctx))
    for key, name, _ in FIELDS:
        ctrl = window.getControl(name)
        if ctrl and key in ("endpoint", "model"):
            probe_settings[key] = ctrl.getText()

    say("Contacting Ollama...")
    try:
        result = ollama.probe(probe_settings)
    except Exception as err:
        say(ollama.describe_error(err))
        return
    models = result["models"]
    if result["hasModel"]:
        say("Connected. %d model%s available, \"%s\" is one of them."
            % (len(models), "" if len(models) == 1 else "s", probe_settings["model"]))
    else:
        say("Connected, but \"%s\" is not installed. Available: %s"
            % (probe_settings["model"], ", ".join(models) or "none"))
    fill_models(ctx, window, probe_settings)


def later_on_main(ctx, delay, fn, what="callback"):
    """Run fn after `delay` seconds, ON LIBREOFFICE'S MAIN THREAD.

    A threading.Timer fires on its own thread, and touching the document or the
    clipboard from there does not raise - it crashes the application a moment later.
    That is precisely what happened: the transform worked and LibreOffice fell over a
    few seconds afterwards, which is the delay on these timers.

    So the timer only schedules; the work is handed to the main thread through
    AsyncCallback, the same route the transform result already takes.
    """
    def fire():
        try:
            async_cb = ctx.ServiceManager.createInstanceWithContext(
                "com.sun.star.awt.AsyncCallback", ctx)
            async_cb.addCallback(MainThreadCall(fn), None)
        except Exception:
            log("could not marshal %s to the main thread\n%s"
                % (what, traceback.format_exc()))
    timer = threading.Timer(delay, fire)
    timer.daemon = True
    timer.start()


class _PlainText(unohelper.Base, XTransferable):
    """The simplest possible clipboard payload: one string."""

    def __init__(self, text):
        self._text = text

    def getTransferData(self, flavor):
        return self._text

    def getTransferDataFlavors(self):
        flavor = DataFlavor()
        flavor.MimeType = "text/plain;charset=utf-16"
        flavor.HumanPresentableName = "Unicode text"
        flavor.DataType = uno.getTypeByName("string")
        return (flavor,)

    def isDataFlavorSupported(self, flavor):
        return flavor.MimeType.startswith("text/plain")


class MainThreadCall(unohelper.Base, XCallback):
    """Runs a function on LibreOffice's main thread.

    UNO calls from a worker thread need the SolarMutex, and touching dialog controls
    without it does not raise - it crashes. AsyncCallback is the supported way to hand
    work back, and the modal dialog's own event loop dispatches it.
    """

    def __init__(self, fn):
        self._fn = fn

    def notify(self, _data):
        try:
            self._fn()
        except Exception:
            log("main-thread callback failed\n%s" % traceback.format_exc())


class TextTransferable(unohelper.Base, XTransferable):
    """The clipboard takes a transferable, not a string, and there is no ready-made one.

    text/plain;charset=utf-16 is the flavour LibreOffice itself puts plain text on the
    clipboard as, and the DataType must be the UNO string type rather than Python's -
    getTypeByName is the only way to say so from here.
    """

    def __init__(self, text):
        self.text = text
        self.flavor = uno.createUnoStruct("com.sun.star.datatransfer.DataFlavor")
        self.flavor.MimeType = "text/plain;charset=utf-16"
        self.flavor.HumanPresentableName = "Unicode text"
        self.flavor.DataType = uno.getTypeByName("string")

    def getTransferData(self, flavor):
        return self.text

    def getTransferDataFlavors(self):
        return (self.flavor,)

    def isDataFlavorSupported(self, flavor):
        return flavor.MimeType == self.flavor.MimeType


def copy_to_clipboard(ctx, text):
    """True if the text reached the clipboard. Never raises: a failed copy is a message,
    not a broken dialog."""
    try:
        clip = ctx.ServiceManager.createInstanceWithContext(
            "com.sun.star.datatransfer.clipboard.SystemClipboard", ctx)
        clip.setContents(TextTransferable(text), None)
        return True
    except Exception:
        log("copy to clipboard failed\n%s" % traceback.format_exc())
        return False


class DialogHandler(unohelper.Base, XDialogEventHandler):
    """Button clicks inside our dialogs."""

    def __init__(self, ctx, on_run=None, on_append=None, on_copy=None):
        self.ctx = ctx
        self._on_run = on_run
        self._on_append = on_append
        self._on_copy = on_copy

    def callHandlerMethod(self, dialog, event, method):
        try:
            if method == "onTest":
                test_connection(self.ctx, dialog)
                return True
            if method == "onRun" and self._on_run:
                self._on_run(dialog)
                return True
            if method == "onAppend" and self._on_append:
                self._on_append(dialog)
                return True
            if method == "onCopy" and self._on_copy:
                self._on_copy(dialog)
                return True
        except Exception:
            log("dialog handler failed\n%s" % traceback.format_exc())
        return False

    def getSupportedMethodNames(self):
        return ("onTest", "onRun", "onAppend", "onCopy")


def selected_word(ctx):
    """The selection, if it is a single word worth putting in a dictionary."""
    try:
        desktop = ctx.ServiceManager.createInstanceWithContext(
            "com.sun.star.frame.Desktop", ctx)
        doc = desktop.getCurrentComponent()
        selection = doc.getCurrentSelection()
        if selection is None or not selection.getCount():
            return None
        text = selection.getByIndex(0).getString().strip()
        if not text or len(text) > 48 or " " in text or "\n" in text:
            return None
        return text
    except Exception:
        return None


class ContextMenu(unohelper.Base, XContextMenuInterceptor):
    """Adds LAITA's entry to the right-click menu.

    Addons.xcu can put items in the menu bar and on a toolbar, but not into the text
    context menu - that needs an interceptor, registered per document controller, which
    is what the Job below does as each document opens.
    """

    def __init__(self, ctx):
        self.ctx = ctx

    def notifyContextMenuExecute(self, event):
        try:
            container = event.ActionTriggerContainer
            factory = container  # the container is also the factory for its own entries

            sep = factory.createInstance("com.sun.star.ui.ActionTriggerSeparator")
            container.insertByIndex(container.getCount(), sep)

            item = factory.createInstance("com.sun.star.ui.ActionTrigger")
            item.setPropertyValue("Text", "LAITA: Transform selection")
            item.setPropertyValue("CommandURL", PROTOCOL + "transform")
            container.insertByIndex(container.getCount(), item)

            # Offered only for something that looks like a single word, because that is
            # all a dictionary entry can usefully be.
            word = selected_word(self.ctx)
            if word:
                add = factory.createInstance("com.sun.star.ui.ActionTrigger")
                add.setPropertyValue("Text", 'LAITA: add "%s" to the dictionary' % word)
                add.setPropertyValue("CommandURL", PROTOCOL + "adddictionary")
                container.insertByIndex(container.getCount(), add)
            # CONTINUE_MODIFIED: keep our addition and let everyone else contribute too.
            return uno.Enum("com.sun.star.ui.ContextMenuInterceptorAction",
                            "CONTINUE_MODIFIED")
        except Exception:
            log("context menu failed\n%s" % traceback.format_exc())
            return uno.Enum("com.sun.star.ui.ContextMenuInterceptorAction", "IGNORED")


class StartupJob(unohelper.Base, XJob, XServiceInfo):
    """Registers the context menu on each document as it opens.

    An interceptor lives on a controller, not on the application, so there is nowhere to
    register it once. Jobs.xcu fires this on OnLoad and OnNew.
    """

    # Documents we have already hooked, by RuntimeUID. Belt as well as braces: the
    # duplicate entries were caused by listening on one event too many, but a reload or
    # a second view would do the same, and a duplicated menu entry is the kind of thing
    # a user sees long before a developer does.
    hooked = set()

    def __init__(self, ctx, *args):
        self.ctx = ctx

    def getImplementationName(self):
        return JOB_IMPL

    def supportsService(self, name):
        return name == JOB_IMPL

    def getSupportedServiceNames(self):
        return (JOB_IMPL,)

    def execute(self, args):
        try:
            model = None
            for arg in args or ():
                if arg.Name == "Environment":
                    for env in arg.Value:
                        if env.Name == "Model":
                            model = env.Value
            if model is None:
                return None
            uid = getattr(model, "RuntimeUID", None) or repr(model)
            if uid in StartupJob.hooked:
                log("context menu already registered for %s, skipping" % uid)
                return None
            controller = model.getCurrentController()
            if controller and hasattr(controller, "registerContextMenuInterceptor"):
                controller.registerContextMenuInterceptor(ContextMenu(self.ctx))
                StartupJob.hooked.add(uid)
                log("context menu registered on %s" % uid)
        except Exception:
            log("could not register the context menu\n%s" % traceback.format_exc())
        return None


class OptionsHandler(unohelper.Base, XContainerWindowEventHandler, XServiceInfo):
    """Backs the page under Tools > Options, if LibreOffice ever shows it."""

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
            if event in ("initialize", "back"):
                load_into(self.ctx, window)
            elif event == "ok":
                save_from(self.ctx, window)
        except Exception:
            log("options %r failed\n%s" % (event, traceback.format_exc()))
        return True


g_ImplementationHelper = unohelper.ImplementationHelper()
g_ImplementationHelper.addImplementation(Proofreader, PROOFREADER_IMPL, (PROOFREADER_SERVICE,),)
g_ImplementationHelper.addImplementation(Dispatcher, DISPATCHER_IMPL,
                                         ("com.sun.star.frame.ProtocolHandler",),)
g_ImplementationHelper.addImplementation(OptionsHandler, OPTIONS_IMPL, (OPTIONS_IMPL,),)
g_ImplementationHelper.addImplementation(StartupJob, JOB_IMPL, (JOB_IMPL,),)
