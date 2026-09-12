#!/usr/bin/env bash
# Assemble the Chrome build in dist-chrome/.
#
# This copies files and swaps in manifest.chrome.json; it does not transform any code.
# The JavaScript in the Chrome package is byte-identical to src/, exactly as it is for
# Firefox, which is what lets both stores' "did you generate this code?" questions be
# answered with No.
set -e
cd "$(dirname "$0")/.."
OUT=dist-chrome

rm -rf "$OUT"
mkdir -p "$OUT"
cp -r src icons LICENSE "$OUT/"
rm -f "$OUT/icons/icon.svg"          # Chrome does not accept SVG icons
cp manifest.chrome.json "$OUT/manifest.json"

# Fail loudly rather than shipping a manifest that points at a missing file.
python3 - "$OUT" <<'PY'
import json, sys, pathlib
out = pathlib.Path(sys.argv[1])
m = json.loads((out / "manifest.json").read_text())
refs = [m["background"]["service_worker"], m["options_ui"]["page"], m["action"]["default_popup"]]
refs += m["content_scripts"][0]["js"]
refs += list(m["icons"].values()) + list(m["action"]["default_icon"].values())
missing = [r for r in refs if not (out / r).exists()]
if missing:
    sys.exit("manifest references missing files: " + ", ".join(missing))
print(f"  {len(refs)} manifest references all present")
PY

echo "Chrome build ready: $(pwd)/$OUT"
echo "Load it with chrome://extensions -> Developer mode -> Load unpacked -> $OUT"
