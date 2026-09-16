#!/usr/bin/env bash
#
# Rebuild and reinstall the probe, refusing to do it while LibreOffice is running.
#
# LibreOffice keeps a background soffice.bin alive after the last window closes, and a
# newly registered extension is not picked up until that process exits. Installing over a
# running instance appears to succeed - unopkg says "is registered: yes" - and then the
# component is simply never instantiated, with nothing anywhere saying why.
set -e
cd "$(dirname "$0")/.."

if pgrep -x soffice.bin >/dev/null 2>&1; then
  echo "LibreOffice is still running:"
  ps -eo pid,etimes,args --no-headers | grep '[s]office.bin' | awk '{printf "  pid %s, up %ss\n",$1,$2}'
  echo
  echo "Close every LibreOffice window (save your work first), then run this again."
  echo "If no window is open, the background process is lingering - end it with:"
  echo "    pkill -x soffice.bin"
  exit 1
fi

# A Python virtualenv on PATH breaks the registration of Python UNO components, and the
# only symptom is "C++ code threw St9bad_alloc: std::bad_alloc" - no mention of Python,
# no mention of the environment. The venv's python3 comes first on PATH; it is usually a
# symlink to the system one, but its pyvenv.cfg changes sys.prefix, so pyuno is not
# importable and the component loader dies.
#
# Verified by bisection on this machine: with ~/.venvs/jupyter/bin on PATH it fails every
# time, with it removed it works every time. ~/.local/bin, ~/bin and ~/.npm-global/bin are
# all harmless.
#
# The same applies to LibreOffice itself: launch it from a shell with a venv active and
# the extension may fail to load. Starting it from the desktop menu is safe.
for d in $(printf '%s' "$PATH" | tr ':' '\n'); do
  if [ -f "$d/../pyvenv.cfg" ] || [ -f "$d/activate" ]; then
    echo "  dropping virtualenv from PATH for this install: $d"
  else
    CLEAN_PATH="${CLEAN_PATH:+$CLEAN_PATH:}$d"
  fi
done
export PATH="$CLEAN_PATH"

./tools/build-oxt.sh >/dev/null
UNOPKG=/usr/lib/libreoffice/program/unopkg
"$UNOPKG" remove org.lobianco.laita.probe >/dev/null 2>&1 || true
"$UNOPKG" add -f laita-probe.oxt
echo -n "  "; "$UNOPKG" list 2>&1 | grep -m1 'is registered'
rm -f ~/laita-probe.log
printf 'delay=0\nclaim_paragraph=1\n' > ~/.laita-probe
echo "  log cleared, delay=0"
echo
echo "Now open Writer and type a sentence containing the word 'the'."
echo "Then: cat ~/laita-probe.log"
