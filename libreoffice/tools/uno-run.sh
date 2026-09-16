#!/usr/bin/env bash
#
# Run a Python script against a live, headless LibreOffice.
#
#   ./tools/uno-run.sh myscript.py
#
# This is the difference between guessing at UNO and testing it. The script is handed a
# connected component context as `ctx`, with the extension's pythonpath/ importable, so
# anything the extension does at the UNO boundary can be exercised without a window, a
# document, or a human clicking.
#
# It is how the options dialog was fixed: createDialogWithHandler threw
# WrappedTargetRuntimeException with nothing naming the cause, and bisecting .xdl
# variants against a running instance found it in three rounds - the event binding needs
# script:language="UNO" and no script:location.
#
# Not a replacement for a human: this cannot type, click, or see an underline. Use it for
# the boundary, and test/run.sh for everything above it.
set -u
cd "$(dirname "$0")/.."
SCRIPT=${1:?usage: uno-run.sh <script.py>}
PORT=${PORT:-2083}

started=0
if ! pgrep -x soffice.bin >/dev/null 2>&1; then
  # A virtualenv on PATH breaks pyuno here exactly as it does for unopkg.
  env -u VIRTUAL_ENV PATH=/usr/bin:/bin setsid /usr/lib/libreoffice/program/soffice \
      --headless --norestore --nologo \
      --accept="socket,host=127.0.0.1,port=$PORT;urp;" >/dev/null 2>&1 &
  started=1
  for _ in $(seq 1 30); do
    (echo > "/dev/tcp/127.0.0.1/$PORT") 2>/dev/null && break
    sleep 1
  done
fi

PYTHONPATH=/usr/lib/libreoffice/program /usr/bin/python3 - "$SCRIPT" "$PORT" <<'PY'
import sys, os
sys.path.insert(0, "/usr/lib/libreoffice/program")
sys.path.insert(0, os.path.join(os.getcwd(), "src", "pythonpath"))
import uno
script, port = sys.argv[1], sys.argv[2]
local = uno.getComponentContext()
ctx = local.ServiceManager.createInstanceWithContext(
    "com.sun.star.bridge.UnoUrlResolver", local).resolve(
    "uno:socket,host=127.0.0.1,port=%s;urp;StarOffice.ComponentContext" % port)
g = {"ctx": ctx, "uno": uno, "__name__": "__main__", "__file__": script}
exec(compile(open(script, encoding="utf-8").read(), script, "exec"), g)
PY
status=$?

[ "$started" = "1" ] && pkill -x soffice.bin 2>/dev/null
exit $status
