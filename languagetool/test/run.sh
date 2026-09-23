#!/usr/bin/env bash
#
# Tests for the LanguageTool server. Needs neither Ollama nor LibreOffice, and nothing
# here sleeps: both the debounce and the model are injected.
#
# PYTHONDONTWRITEBYTECODE is not decoration - see libreoffice/test/run.sh for the twenty
# minutes it cost there.
set -u
cd "$(dirname "$0")"
export PYTHONDONTWRITEBYTECODE=1
find .. ../../libreoffice -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null

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
