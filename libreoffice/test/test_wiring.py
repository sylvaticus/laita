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
    urls = []
    for prop in addons.getElementsByTagName("prop"):
        if prop.getAttribute("oor:name") == "URL":
            for v in prop.getElementsByTagName("value"):
                if v.firstChild:
                    urls.append(v.firstChild.data)
    check("the toolbar has four buttons", len(urls), 4)
    handled = set(re.findall(r'command == "(\w+)"', py))
    for url in urls:
        check("Addons.xcu URL %r uses our protocol" % url,
              url.startswith("org.lobianco.laita.command:"), True)
        command = url.split(":", 1)[1]
        check("...and the dispatcher handles %r" % command, command in handled, True)

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
