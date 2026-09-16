"""
A smoke test at the UNO boundary. Run with: ./tools/uno-run.sh test/uno_smoke.py

Everything here needs a live LibreOffice, which is why it is not in test/run.sh. It
covers the two things unit tests structurally cannot reach: that the dialogs actually
build, and that settings survive a round trip through LibreOffice's configuration.
"""
import laita_settings as S

fails = []


def check(name, got, want=True):
    if got == want:
        print("  ok   %s" % name)
    else:
        fails.append(name)
        print("  FAIL %s: got %r, want %r" % (name, got, want))


provider = ctx.ServiceManager.createInstanceWithContext(  # noqa: F821 - from uno-run.sh
    "com.sun.star.awt.DialogProvider", ctx)               # noqa: F821

for name in ("options.xdl", "options_dialog.xdl", "transform.xdl"):
    url = "vnd.sun.star.extension://org.lobianco.laita/dialog/" + name
    try:
        dlg = provider.createDialog(url)
        dlg.dispose()
        check("%s builds" % name, True)
    except Exception as err:
        check("%s builds" % name, "%s" % err, True)

# The standalone dialog must build WITH a handler; every wrong event binding fails here.
import unohelper                                          # noqa: E402
from com.sun.star.awt import XDialogEventHandler          # noqa: E402


class Handler(unohelper.Base, XDialogEventHandler):
    def callHandlerMethod(self, dialog, event, method):
        return True

    def getSupportedMethodNames(self):
        return ("onTest", "onRun", "onAppend")


for name, controls in (
        ("options_dialog.xdl", ("Endpoint", "Model", "Status", "btnTest", "btnOk", "btnCancel")),
        ("transform.xdl", ("Selected", "Instruction", "Result", "Status",
                           "btnRun", "btnReplace", "btnAppend", "btnReject"))):
    try:
        dlg = provider.createDialogWithHandler(
            "vnd.sun.star.extension://org.lobianco.laita/dialog/" + name, Handler())
        for control in controls:
            check("%s exposes %s" % (name, control), dlg.getControl(control) is not None)
        dlg.dispose()
    except Exception as err:
        check("%s builds with a handler" % name, "%s" % err, True)

# Settings, round-tripped through LibreOffice's own configuration.
original = S.read(ctx)                                    # noqa: F821
check("defaults read back", original["model"] != "", True)
S.write(ctx, minChars=33)                                 # noqa: F821
check("a write survives a re-read", S.read(ctx)["minChars"], 33)   # noqa: F821
S.write(ctx, debounceMs=5)                                # noqa: F821
check("clamping applies through the real store", S.read(ctx)["debounceMs"], 300)  # noqa: F821
S.write(ctx, minChars=original["minChars"], debounceMs=original["debounceMs"])    # noqa: F821
check("restored", S.read(ctx)["minChars"], original["minChars"])   # noqa: F821

# String lists need a typed uno.Any through uno.invoke; a plain list is refused with
# "configmgr inappropriate property value", and for a while that failure was swallowed
# so the dictionary appeared to save and read back empty.
for key in ("dictionary", "ignored", "transformHistory"):
    S.write(ctx, **{key: ["alpha", "beta"]})                       # noqa: F821
    check("%s round-trips" % key, S.read(ctx)[key], ["alpha", "beta"])  # noqa: F821
    check("...without a recorded problem", S.last_write_problems(), [])
    S.write(ctx, **{key: original[key]})                           # noqa: F821
    check("%s restored" % key, S.read(ctx)[key], original[key])    # noqa: F821

print("%s" % ("all passed" if not fails else "%d FAILED" % len(fails)))
raise SystemExit(1 if fails else 0)
