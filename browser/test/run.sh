#!/usr/bin/env bash
#
# Unit tests. No dependencies beyond node.
#
# Deliberately NOT `set -e`: aborting on the first failing file hides every file after it,
# so one broken test made the suite look like one problem when it might be five. Every file
# runs, and the exit status is the number of files that failed.
cd "$(dirname "$0")/unit" || exit 1

failed=0
total=0
for t in *.test.mjs; do
  total=$((total + 1))
  printf '%-24s ' "$t"
  if ! node "$t"; then
    failed=$((failed + 1))
    echo "  ^^ $t FAILED"
  fi
done

echo "------------------------------------------------------------"
if [ "$failed" -eq 0 ]; then
  echo "$total test files passed"
else
  echo "$failed of $total test files FAILED"
fi
exit "$failed"
