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
OUT="$PWD/laita-probe.oxt"
rm -f "$OUT"
(cd src && zip -qr "$OUT" . -x '.*' '*/.*')
echo "built: $OUT"
unzip -l "$OUT" | sed -n '3,12p'
