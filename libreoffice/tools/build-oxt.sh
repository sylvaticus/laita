#!/usr/bin/env bash
# An .oxt is a zip with a manifest. Nothing is compiled.
#
#   ./tools/build-oxt.sh            -> laita-probe.oxt
#
# manifest.xml must be at META-INF/manifest.xml INSIDE the archive, and the paths it names
# must be relative to the archive root - so this zips the contents of src/, never src/
# itself. The same mistake as the Chrome zip, with the same silent rejection.
set -e
cd "$(dirname "$0")/.."
OUT="$PWD/laita.oxt"
rm -f "$OUT"
# __pycache__ must not ship: it is build output, and a .pyc compiled here for one
# Python version is useless or misleading on another machine.
find src -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null
(cd src && zip -qr "$OUT" . -x '.*' '*/.*' '*__pycache__*' '*.pyc')
echo "built: $OUT"
unzip -l "$OUT" | sed -n '3,12p'
