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

    # --- every control the handler reads must exist in the dialog -------------------------
    xdl = minidom.parse(os.path.join(SRC, "dialog", "options.xdl"))
    control_ids = {e.getAttribute("dlg:id") for e in xdl.getElementsByTagName("*")
                   if e.getAttribute("dlg:id")}
    handler_block = py[py.index("    FIELDS = ["):py.index("    def __init__(self, ctx, *args):\n        self.ctx = ctx\n\n    def getImplementationName(self):\n        return OPTIONS_IMPL")]
    wanted = set(re.findall(r'\("\w+", "(\w+)"[,)]', handler_block))
    check("the handler reads some controls", len(wanted) > 0, True)
    for name in sorted(wanted):
        check("options.xdl defines the control %r" % name, name in control_ids, True)

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
