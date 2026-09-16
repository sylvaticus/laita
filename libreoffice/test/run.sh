#!/usr/bin/env bash
#
# Tests for the LibreOffice port. Pure Python plus node for the reference implementation;
# LibreOffice itself is not needed and is not started.
#
# PYTHONDONTWRITEBYTECODE is not decoration. Python validates a cached .pyc on (mtime,
# size), and an edit that changes neither - swapping `if lower:` for `if False:`, say, or
# restoring a backup within the same second - is served from the stale cache. That
# happened here and cost twenty minutes of debugging a file that was already correct.
set -u
cd "$(dirname "$0")"
export PYTHONDONTWRITEBYTECODE=1
find .. -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null

failed=0
total=0
for t in test_*.py; do
  total=$((total + 1))
  printf '%-24s ' "$t"
  if ! python3 "$t"; then
    failed=$((failed + 1))
    echo "  ^^ $t FAILED"
  fi
done

echo "------------------------------------------------------------"
if [ "$failed" -eq 0 ]; then echo "$total test files passed"; else echo "$failed of $total test files FAILED"; fi
exit "$failed"
