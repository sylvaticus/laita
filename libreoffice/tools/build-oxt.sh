#!/usr/bin/env bash
# An .oxt is a zip with a manifest. Nothing is compiled.
#
#   ./tools/build-oxt.sh            -> laita.oxt, for installing locally
#   ./tools/build-oxt.sh --release  -> dist/laita-<version>.oxt, for uploading
#
# The two archives have identical contents. --release only names the file after the
# version in description.xml and puts it somewhere it will not be overwritten by the
# next local build, because the file you upload to extensions.libreoffice.org is the
# file users download and must stay pinned to its version number.
#
# manifest.xml must be at META-INF/manifest.xml INSIDE the archive, and the paths it names
# must be relative to the archive root - so this zips the contents of src/, never src/
# itself. The same mistake as the Chrome zip, with the same silent rejection.
set -e
cd "$(dirname "$0")/.."

VERSION=$(sed -n 's/.*<version value="\([^"]*\)".*/\1/p' src/description.xml)
[ -n "$VERSION" ] || { echo "no <version> in src/description.xml" >&2; exit 1; }

# Every file description.xml points at has to be in the archive, or the Extension
# Manager shows a nameless entry with no description and says nothing about why.
for f in $(sed -n 's/.*xlink:href="\([^"]*\)".*/\1/p' src/description.xml | grep -v '^http'); do
  [ -f "src/$f" ] || { echo "description.xml points at a missing file: $f" >&2; exit 1; }
done

if [ "$1" = "--release" ]; then
  mkdir -p dist
  OUT="$PWD/dist/laita-$VERSION.oxt"
else
  OUT="$PWD/laita.oxt"
fi
rm -f "$OUT"
# __pycache__ must not ship: it is build output, and a .pyc compiled here for one
# Python version is useless or misleading on another machine.
find src -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null
(cd src && zip -qr "$OUT" . -x '.*' '*/.*' '*__pycache__*' '*.pyc')
echo "built: $OUT"
unzip -l "$OUT" | tail -1
