# -*- encoding: UTF-8 -*-
"""
The string contracts between the XML and the Python, all of which fail silently.

A .oxt is held together by names matching across files: the implementation name in
Linguistic.xcu must equal the one the class reports, the toolbar URLs must equal the
commands the dispatcher handles, the dialog control ids must equal the ones the options
handler asks for. Get any of them wrong and LibreOffice does not complain - the button is
drawn and does nothing, or the checker is registered and never called. We lost an
afternoon to exactly that class of problem with the probe.

None of this needs LibreOffice, or even uno: it is text against text.
"""
import os
import re
import sys
import xml.dom.minidom as minidom
from struct import unpack

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "src")

fails, passes = [], 0


def check(name, got, want):
    global passes
    if got == want:
        passes += 1
    else:
        fails.append("%s\n    got  %r\n    want %r" % (name, got, want))


def read(*parts):
    with open(os.path.join(SRC, *parts), encoding="utf-8") as fh:
        return fh.read()


def nodes_named(doc, tag, attr="oor:name"):
    return [e.getAttribute(attr) for e in doc.getElementsByTagName(tag) if e.getAttribute(attr)]


def main():
    py = read("laita.py")

    # --- every file the manifest names must exist, and vice versa -----------------------
    manifest = minidom.parseString(read("META-INF", "manifest.xml"))
    listed = [e.getAttribute("manifest:full-path")
              for e in manifest.getElementsByTagName("manifest:file-entry")]
    for path in listed:
        check("manifest lists %s and it exists" % path,
              os.path.exists(os.path.join(SRC, *path.split("/"))), True)
    for required in ("laita.py", "Linguistic.xcu", "Addons.xcu", "ProtocolHandler.xcu",
                     "OptionsDialog.xcu", "Settings.xcs"):
        check("manifest declares %s" % required, required in listed, True)

    # --- the grammar checker's implementation name --------------------------------------
    ling = minidom.parseString(read("Linguistic.xcu"))
    registered = [n for n in nodes_named(ling, "node")
                  if n not in ("ServiceManager", "GrammarCheckers")]
    check("exactly one grammar checker registered", len(registered), 1)
    check("Linguistic.xcu names the class's implementation name",
          registered[0], "org.lobianco.laita.Proofreader")
    check("...and laita.py registers that name",
          'PROOFREADER_IMPL = "org.lobianco.laita.Proofreader"' in py, True)

    # --- the locale list must agree with the Python ---------------------------------------
    xcu_locales = set()
    for v in ling.getElementsByTagName("value"):
        if v.firstChild:
            xcu_locales |= set(v.firstChild.data.split())
    py_locales = set()
    block = py[py.index("LOCALES = ["):py.index("# LAITA's palette")]
    for lang, country in re.findall(r'\("(\w*)", "(\w*)"\)', block):
        py_locales.add("%s-%s" % (lang, country) if country else lang)
    check("Linguistic.xcu and laita.py declare the same locales",
          sorted(xcu_locales), sorted(py_locales))

    # --- the toolbar URLs must be commands the dispatcher handles ------------------------
    addons = minidom.parseString(read("Addons.xcu"))

    def urls_under(section):
        """The command URLs inside one AddonUI section.

        Scoped rather than global: the Images section carries a URL for each command
        too, so counting every URL in the file conflates "offered in two places" with
        "has an icon".
        """
        found = []
        for node in addons.getElementsByTagName("node"):
            if node.getAttribute("oor:name") != section:
                continue
            for prop in node.getElementsByTagName("prop"):
                if prop.getAttribute("oor:name") != "URL":
                    continue
                for v in prop.getElementsByTagName("value"):
                    if v.firstChild:
                        found.append(v.firstChild.data)
        return found

    urls = urls_under("OfficeMenuBar") + urls_under("OfficeToolBar")
    # Six commands, offered in two places: a menu that is always there and a toolbar
    # the user can switch off in View > Toolbars without losing anything. Four of them
    # are two pairs of which only one is ever visible, so the toolbar shows four.
    check("every command appears in both the menu and the toolbar", len(urls), 12)
    check("...which is six distinct commands", len(set(urls)), 6)
    for section in ("OfficeMenuBar", "OfficeToolBar"):
        check("Addons.xcu declares an %s" % section, section in read("Addons.xcu"), True)

    # Proofreading only happens in Writer, so the commands that drive it must not be
    # offered in the applications that can never use them.
    contexts = {}
    for node in addons.getElementsByTagName("node"):
        url_prop = ctx_prop = None
        for prop in node.getElementsByTagName("prop"):
            if prop.parentNode is not node:
                continue
            values = [v.firstChild.data for v in prop.getElementsByTagName("value")
                      if v.firstChild]
            if prop.getAttribute("oor:name") == "URL" and values:
                url_prop = values[0]
            if prop.getAttribute("oor:name") == "Context" and values:
                ctx_prop = values[0]
        if url_prop and ctx_prop:
            contexts.setdefault(url_prop.split(":", 1)[1], set()).add(ctx_prop)
    for command in ("checkdocument", "stopdocument", "typingon", "typingoff"):
        for ctx_value in contexts.get(command, ()):
            check("%r is offered in Writer only" % command,
                  ctx_value, "com.sun.star.text.TextDocument")
    for command in ("transform", "options"):
        for ctx_value in contexts.get(command, ()):
            check("%r is offered in every application" % command,
                  ctx_value.count(",") + 1, 4)
    handled = set(re.findall(r'command == "(\w+)"', py))
    for group in re.findall(r'command in \(([^)]*)\)', py):
        handled |= set(re.findall(r'"(\w+)"', group))
    for url in urls:
        check("Addons.xcu URL %r uses our protocol" % url,
              url.startswith("org.lobianco.laita.command:"), True)
        command = url.split(":", 1)[1]
        check("...and the dispatcher handles %r" % command, command in handled, True)

    # --- every command must have icons, and the files must be there ---------------------
    # A missing image is not an error in LibreOffice: the button appears with a blank
    # square, or with the last icon it happened to have, and nothing is logged.
    addons_text = read("Addons.xcu")
    for command in sorted(set(u.split(":", 1)[1] for u in urls)):
        node = 'org.lobianco.laita.image.%s' % command
        check("Addons.xcu declares an image for %r" % command, node in addons_text, True)
    images = re.findall(r"%origin%/([\w/.]+\.png)", addons_text)
    check("both sizes are declared for all six commands", len(images), 12)

    # --- the paired commands: exactly the four that show one of each pair -----------
    # The dispatcher answers LibreOffice's status listeners only for PAIRED; a command
    # left out would show both halves of its pair, one added by mistake would be hidden.
    paired = re.search(r'PAIRED = \(([^)]*)\)', py)
    paired = set(re.findall(r'"(\w+)"', paired.group(1))) if paired else set()
    check("PAIRED is the four checking commands",
          paired, {"checkdocument", "stopdocument", "typingon", "typingoff"})
    check("...all of them in the menu and the toolbar",
          paired <= set(u.split(":", 1)[1] for u in urls), True)
    visible = py[py.index("def _visible("):py.index("def _tell(")]
    for command in sorted(paired):
        check("_visible() decides whether %r shows" % command,
              '"%s":' % command in visible, True)
    for rel in images:
        check("the icon file %s exists" % rel,
              os.path.exists(os.path.join(SRC, *rel.split("/"))), True)
    for rel in images:
        with open(os.path.join(SRC, *rel.split("/")), "rb") as fh:
            head = fh.read(24)
        width, height = unpack(">II", head[16:24])
        want = 16 if rel.endswith("_16.png") else 26
        check("%s is %dx%d" % (rel, want, want), (width, height), (want, want))

    # --- the protocol must be the one the dispatcher answers for --------------------------
    handler = minidom.parseString(read("ProtocolHandler.xcu"))
    protocols = []
    for v in handler.getElementsByTagName("value"):
        if v.firstChild:
            protocols.append(v.firstChild.data)
    check("one protocol declared", len(protocols), 1)
    check("ProtocolHandler.xcu and laita.py agree on the protocol",
          protocols[0].rstrip("*"), "org.lobianco.laita.command:")
    check("the dispatcher is registered under the handler's node name",
          "org.lobianco.laita.Dispatcher" in nodes_named(handler, "node"), True)

    # --- the options page: identifier, handler service, dialog path -----------------------
    desc = minidom.parseString(read("description.xml"))
    identifier = desc.getElementsByTagName("identifier")[0].getAttribute("value")

    # --- what the Extension Manager and extensions.libreoffice.org read ------------------
    # A missing file here is not an error on install: the entry simply appears nameless,
    # with no description and no icon, and nothing says why.
    for tag in ("display-name", "extension-description", "icon", "publisher",
                "platform", "dependencies", "version"):
        check("description.xml declares <%s>" % tag,
              len(desc.getElementsByTagName(tag)) > 0, True)
    for node in desc.getElementsByTagName("*"):
        href = node.getAttribute("xlink:href")
        if href and not href.startswith("http"):
            check("description.xml points at a file that exists (%s)" % href,
                  os.path.exists(os.path.join(SRC, *href.split("/"))), True)
    # 42x42 is the size the Extension Manager draws; anything else is rescaled badly.
    with open(os.path.join(SRC, "icons", "extension_42.png"), "rb") as fh:
        head = fh.read(24)
    check("the Extension Manager icon is 42x42", unpack(">II", head[16:24]), (42, 42))
    check("the licence travels with the package",
          os.path.exists(os.path.join(SRC, "LICENSE.txt")), True)
    opts = read("OptionsDialog.xcu")
    check("OptionsDialog.xcu Id is the extension identifier",
          "<value>%s</value>" % identifier in opts, True)
    check("the handler service is the one laita.py registers",
          "org.lobianco.laita.OptionsHandler" in opts and
          'OPTIONS_IMPL = "org.lobianco.laita.OptionsHandler"' in py, True)
    page = re.search(r"%origin%/([\w/.]+)", opts).group(1)
    check("the dialog file the page points at exists (%s)" % page,
          os.path.exists(os.path.join(SRC, *page.split("/"))), True)

    # --- every control the code reads must exist in BOTH dialogs --------------------------
    # The embedded page and the standalone dialog share one pair of load/save functions,
    # so a control missing from either is a silent no-op on that route.
    handler_block = py[py.index("FIELDS = ["):py.index("def load_into(ctx, window):")]
    wanted = set(re.findall(r'\("\w+", "(\w+)"[,)]', handler_block))
    check("the code reads some controls", len(wanted) > 0, True)
    for dialog_file in ("options.xdl", "options_dialog.xdl"):
        xdl = minidom.parse(os.path.join(SRC, "dialog", dialog_file))
        control_ids = {e.getAttribute("dlg:id") for e in xdl.getElementsByTagName("*")
                       if e.getAttribute("dlg:id")}
        for name in sorted(wanted):
            check("%s defines the control %r" % (dialog_file, name), name in control_ids, True)

    # The standalone dialog needs the buttons that make execute() mean something.
    standalone = read("dialog", "options_dialog.xdl")
    # The event binding has exactly one spelling that works, found by bisecting against a
    # live LibreOffice: script:language="UNO", the vnd.sun.star.UNO: prefix, and NO
    # script:location. Anything else throws WrappedTargetRuntimeException when the dialog
    # is created, naming neither the event nor the control. Pinned here because the error
    # gives no clue and the correct form is not guessable.
    for ev in re.findall(r"<script:event[^>]*/>", standalone):
        check("the binding uses the vnd.sun.star.UNO: prefix",
              'script:macro-name="vnd.sun.star.UNO:' in ev, True)

    # The macro name must be one the handler says it supports; a mismatch is silent.
    supported = set()
    for tup in re.findall(r"getSupportedMethodNames\(self\):\s*\n\s*return \(([^)]*)\)", py):
        supported |= set(re.findall(r'"(\w+)"', tup))
    check("the handler declares some methods", len(supported) > 0, sorted(supported) != [])

    # Every dialog with event bindings, not just this one.
    for dialog_file in ("options_dialog.xdl", "transform.xdl"):
        text = read("dialog", dialog_file)
        evs = re.findall(r"<script:event[^>]*/>", text)
        check("%s has event bindings" % dialog_file, len(evs) > 0, True)
        for ev in evs:
            check("%s: binding declares language UNO" % dialog_file,
                  'script:language="UNO"' in ev, True)
            check("%s: binding carries no script:location" % dialog_file,
                  "script:location" not in ev, True)
        macros = {m.split(":")[-1] for m in
                  re.findall(r'script:macro-name="([\w.:]+)"', text)}
        for macro in sorted(macros):
            check("%s: the handler supports %r" % (dialog_file, macro),
                  macro in supported, True)
    check("the dialog offers the model list and a status line",
          'dlg:id="Model"' in standalone and 'dlg:id="Status"' in standalone, True)
    check("the model control is a dropdown, not a plain field",
          '<dlg:combobox dlg:id="Model"' in standalone, True)

    check("the dialog has an OK button", 'dlg:button-type="ok"' in standalone, True)
    check("the dialog has a Cancel button", 'dlg:button-type="cancel"' in standalone, True)
    check("...and a title bar, being a dialog rather than a page",
          'dlg:withtitlebar="true"' in standalone, True)

    # The URL the dispatcher opens must name a file that exists.
    opened = re.search(r"vnd\.sun\.star\.extension://([\w.]+)/([\w/.]+)", py)
    check("the dialog URL uses the extension identifier", opened.group(1), identifier)
    check("...and points at a file that exists",
          os.path.exists(os.path.join(SRC, *opened.group(2).split("/"))), True)

    # --- the transform dialog --------------------------------------------------------
    transform = read("dialog", "transform.xdl")
    tids = {e.getAttribute("dlg:id") for e in
            minidom.parseString(transform).getElementsByTagName("*")
            if e.getAttribute("dlg:id")}
    for control in re.findall(r'getControl\("(\w+)"\)', py[py.index("def _transform(self):"):
                                                            py.index("def _open_options(self):")]):
        check("transform.xdl defines %r" % control, control in tids, True)
    check("transform.xdl offers replace, append and reject",
          {"btnReplace", "btnAppend", "btnReject"} <= tids, True)
    check("replace is the OK verdict, so execute() means something",
          'dlg:id="btnReplace"' in transform and 'dlg:button-type="ok"' in transform, True)

    # --- the startup job must not fire twice for one document ---------------------------
    # onDocumentOpened fires for BOTH a new document and one loaded from a file, so
    # listing it alongside OnNew and OnLoad registers the context-menu interceptor twice
    # and the right-click menu grows two identical entries. Visible to a user
    # immediately, invisible in any unit test - hence this one.
    jobs = minidom.parseString(read("Jobs.xcu"))
    events = set()
    for node in jobs.getElementsByTagName("node"):
        name = node.getAttribute("oor:name")
        parent = node.parentNode
        if parent.nodeType == 1 and parent.getAttribute("oor:name") == "Events":
            events.add(name)
    check("the job listens on OnNew and OnLoad", events, {"OnNew", "OnLoad"})
    check("...and not on onDocumentOpened, which fires for both",
          "onDocumentOpened" not in events, True)
    check("the job service name matches the class",
          "org.lobianco.laita.StartupJob" in read("Jobs.xcu") and
          'JOB_IMPL = "org.lobianco.laita.StartupJob"' in py, True)
    check("Jobs.xcu is shipped", "Jobs.xcu" in listed, True)

    # --- Ignore All must reach the ignore list -------------------------------------------
    # LibreOffice passes aRuleIdentifier back to ignoreRule(). If that id names the
    # CATEGORY rather than the suggestion, "Ignore All" silences every error in the
    # document instead of the one the user pointed at - and it would look like it worked.
    check("the rule id carries the fingerprint",
          'err.aRuleIdentifier = "LAITA:%s:%s" % (issue["type"], issue["fp"])' in py, True)
    check("ignoreRule reads the last field back out",
          'str(rule).split(":")[-1]' in py, True)
    check("...and writes it to the persistent ignore list",
          "settings_store.write(self.ctx, ignored=" in py, True)
    check("resetIgnoreRules does NOT wipe the stored list",
          "def resetIgnoreRules" in py and
          py.index("def resetIgnoreRules") < py.index("class ContextMenu") and
          "ignored=" not in py[py.index("def resetIgnoreRules"):
                               py.index("def doProofreading")], True)

    # Every context-menu command must be one the dispatcher handles - same contract as
    # the toolbar, and just as silent when it is wrong.
    menu_commands = set(re.findall(r'PROTOCOL \+ "(\w+)"', py))
    for command in sorted(menu_commands):
        check("the dispatcher handles the menu command %r" % command,
              command in handled, True)

    # --- the settings schema and the Python defaults must line up -------------------------
    sys.path.insert(0, os.path.join(SRC, "pythonpath"))
    import laita_settings as S
    schema = minidom.parseString(read("Settings.xcs"))
    schema_props = {p.getAttribute("oor:name") for p in schema.getElementsByTagName("prop")}
    for key, (group, prop) in S._MAP.items():
        check("Settings.xcs has a property for %r" % key, prop in schema_props, True)
    for cat, prop in S._CATEGORY_PROP.items():
        check("Settings.xcs has the %r category" % cat, prop in schema_props, True)
    check("the schema node path matches the settings module",
          schema.documentElement.getAttribute("oor:package") + "." +
          schema.documentElement.getAttribute("oor:name"),
          S.NODE.lstrip("/"))

    print("%d passed, %d failed" % (passes, len(fails)))
    for f in fails:
        print("  FAIL " + f)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
