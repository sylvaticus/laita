#!/usr/bin/env bash
# Unit tests for the VS Code extension. No dependencies beyond node.
set -e
cd "$(dirname "$0")/unit"
for t in *.test.mjs; do
  printf '%-24s ' "$t"
  node "$t"
done
