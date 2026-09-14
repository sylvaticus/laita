#!/usr/bin/env bash
# Copy the shared, platform-neutral modules from the browser extension into vscode/core/.
#
# These files contain no DOM and no WebExtension API: prompt construction, the Ollama
# transport, error classification, and the anchoring that turns a model's quoted
# substring into exact offsets. They are copied rather than imported across directories
# because a packaged .vsix may only contain files from inside vscode/.
#
# Nothing is transformed. core.test.mjs fails if a copy drifts from its source.
set -e
cd "$(dirname "$0")/.."
SRC=../browser/src/background

for f in anchor.js ollama.js; do
  cp "$SRC/$f" "core/$f"
  echo "  synced core/$f"
done
