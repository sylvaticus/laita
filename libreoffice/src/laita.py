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

import uno
import unohelper

from com.sun.star.linguistic2 import XProofreader, XSupportedLocales
from com.sun.star.linguistic2 import XLinguServiceEventBroadcaster, LinguServiceEvent
from com.sun.star.linguistic2.LinguServiceEventFlags import PROOFREAD_AGAIN
from com.sun.star.lang import XServiceInfo, XServiceName, XServiceDisplayName, Locale
from com.sun.star.frame import XDispatchProvider, XDispatch
from com.sun.star.task import XJob
from com.sun.star.ui import XContextMenuInterceptor
from com.sun.star.awt import XContainerWindowEventHandler, XDialogEventHandler, XCallback

import laita_anchor as anchor
import laita_ollama as ollama
import laita_segment as segment
import laita_settings as settings_store
from laita_engine import Engine

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

        # One request per chunk, not one per paragraph. Latency grows faster than the
        # text - 0.7s at 139 characters, 19.4s at 1119 - so two small requests beat one
        # large one, and a large one also produces worse suggestions.
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
            source = "cache"
            if raw is None:
                if s["checkAsYouType"]:
                    self.engine.request(text, lang, s)
                # Show the previous answer for this paragraph while the new one is
                # computed, rather than blanking every underline on each keystroke.
                # Anchoring below is against the CURRENT text, so anything the edit
                # invalidated drops out by itself.
                raw = self.engine.provisional(text)
                source = "provisional"
                if raw is None:
                    log("check: %d chars, nothing yet, queued  %r" % (len(text), text[:50]))
                    return res
            issues = anchor.anchor_issues(text, raw, categories=s["categories"],
                                          ignored=s["ignored"])
            # The interesting line. A raw answer that anchors to nothing is the
            # difference between "the model said nothing" and "the model quoted text
            # that is no longer there" - and only the second explains a vanishing
            # underline.
            log("check: %d chars, %s, %d raw -> %d anchored  %r"
                % (len(text), source, len(raw), len(issues), text[:50]))
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
            self._transform()
        elif command == "options":
            self._open_options()

    def _selection(self):
        """The selected text range in the current document, or None.

        Returns the RANGE, not the string: replacing it later needs the range, and
        looking it up again afterwards would race with anything that moved the cursor.
        """
        try:
            desktop = self.ctx.ServiceManager.createInstanceWithContext(
                "com.sun.star.frame.Desktop", self.ctx)
            doc = desktop.getCurrentComponent()
            selection = doc.getCurrentSelection()
            if selection is None or not selection.getCount():
                return None
            rng = selection.getByIndex(0)
            return rng if rng.getString().strip() else None
        except Exception:
            log("could not read the selection\n%s" % traceback.format_exc())
            return None

    def _transform(self):
        rng = self._selection()
        if rng is None:
            self._tell("LAITA", "Select some text first, then choose Transform selection.")
            return
        selected = rng.getString()

        s = settings_store.read(self.ctx)
        if len(selected) > s["maxChars"]:
            self._tell("LAITA", "That selection is %d characters, over the %d limit in "
                                "the options." % (len(selected), s["maxChars"]))
            return

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
                "Asking the model... roughly %d seconds for this much text. The window "
                "stays usable; Reject cancels." % max(2, int(len(selected) / 45)))

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

        def append(dialog):
            text = dialog.getControl("Result").getText()
            if text.strip():
                rng.setString(selected + " " + text)
            dialog.endExecute()

        try:
            provider = self.ctx.ServiceManager.createInstanceWithContext(
                "com.sun.star.awt.DialogProvider", self.ctx)
            dialog = provider.createDialogWithHandler(
                "vnd.sun.star.extension://org.lobianco.laita/dialog/transform.xdl",
                DialogHandler(self.ctx, on_run=run, on_append=append))
            dialog.getControl("Selected").setText(selected)
            combo = dialog.getControl("Instruction")
            history = [s["transformDefault"]] + [h for h in s.get("ignored", []) if False]
            for item in dict.fromkeys(history):
                combo.addItems((item,), combo.getItemCount())
            combo.setText(s["transformDefault"])
            if dialog.execute() == 1 and state["output"].strip():
                # Accept & replace. The range was captured before the dialog opened, so
                # this replaces what the user selected even if the cursor has moved.
                rng.setString(state["output"])
            dialog.dispose()
        except Exception:
            log("transform failed\n%s" % traceback.format_exc())
            self._tell("LAITA", "The transform dialog could not open. See "
                                "~/laita-libreoffice.log")

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
    log("settings saved: %s" % sorted(changes))


def remember_instruction(ctx, instruction):
    """Keep the last few instructions, most recent first, for the dropdown."""
    if not instruction:
        return
    s = settings_store.read(ctx)
    if instruction == s["transformDefault"]:
        return
    settings_store.write(ctx, transformDefault=instruction)


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


class DialogHandler(unohelper.Base, XDialogEventHandler):
    """Button clicks inside our dialogs."""

    def __init__(self, ctx, on_run=None, on_append=None):
        self.ctx = ctx
        self._on_run = on_run
        self._on_append = on_append

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
        except Exception:
            log("dialog handler failed\n%s" % traceback.format_exc())
        return False

    def getSupportedMethodNames(self):
        return ("onTest", "onRun", "onAppend")


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
            item = factory.createInstance("com.sun.star.ui.ActionTrigger")
            item.setPropertyValue("Text", "LAITA: Transform selection")
            item.setPropertyValue("CommandURL", PROTOCOL + "transform")

            container.insertByIndex(container.getCount(), sep)
            container.insertByIndex(container.getCount(), item)
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
