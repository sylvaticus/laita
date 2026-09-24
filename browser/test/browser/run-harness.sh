#!/usr/bin/env bash
#
# Run the browser harness: the real extension in headless Firefox against a fake Ollama.
#
#   ./test/browser/run-harness.sh
#
# It copies the extension to $HOME (Firefox here is a snap and cannot read /tmp), applies
# the test-build edits described in test/README.md, starts the mock, drives the page and
# prints one line per step. Every step must report its expectations as true.
#
# Chrome cannot be driven this way: Chrome 137+ refuses --load-extension. Chrome's half of
# the compatibility layer is covered by test/unit/chrome-compat.test.mjs instead.
set -e
SRC="$(cd "$(dirname "$0")/../.." && pwd)"          # browser/
RUN=${RUN:-$HOME/laita-testrun}
PORT=${PORT:-11499}
LOG=$RUN/requests.json

# Firefox is a snap, and its AppArmor profile refuses signals from outside the snap - even
# from root: `sudo pkill` answers "Permission denied". A shell started INSIDE the snap is
# allowed to signal it, so that is where the kill has to come from. The bracket keeps
# pgrep from matching this script's own command line. Run before a harness as well as
# after one: a Firefox left over from the last run would otherwise beacon into this one.
kill_leftovers() {
  local pids
  pids=$(pgrep -f "[l]aita-testrun/prof" | tr '\n' ' ')
  [ -n "$pids" ] && snap run --shell firefox -c "kill $pids" 2>/dev/null
  sleep 1
  pgrep -f "[l]aita-testrun/prof" >/dev/null && echo "leftover Firefox still running: $pids"
  return 0
}
kill_leftovers

rm -rf "$RUN"; mkdir -p "$RUN/prof"
cp -r "$SRC" "$RUN/ext"
rm -rf "$RUN/ext/web-ext-artifacts" "$RUN/ext/dist-chrome"

# --- the test build: four edits, none of which may reach a release ------------------
sed -i "s|endpoint: \"http://localhost:11434\"|endpoint: \"http://localhost:$PORT\"|;
        s|model: \"qwen3.5:9b\"|model: \"mock:test\"|;
        s|triggerMode: \"auto\"|triggerMode: \"manual\"|" "$RUN/ext/src/common/settings.js"
sed -i 's/mode: "closed"/mode: "open"/' "$RUN/ext/src/content/overlay.js"
sed -i 's|if (reason === "install") browser.runtime.openOptionsPage().catch(() => {});|if (reason === "install") {}|' \
       "$RUN/ext/src/background/main.js"
sed -i 's|^LAITA.Transform = {|document.addEventListener("laita-test-transform", () => LAITA.Transform.open());\nLAITA.Transform = {|' \
       "$RUN/ext/src/content/transform.js"
sed -i 's|^  // ---------------------------------------------------------------- boot|  document.documentElement.dataset.laitaAlive = "1";\n  document.addEventListener("laita-test-check", () => runCheck(true));\n  document.addEventListener("laita-test-check-auto", () => runCheck(false));\n  document.addEventListener("laita-test-clear", () => LAITA.send({ cmd: "clearSiteOverrides" }));\n\n  // ---------------------------------------------------------------- boot|' \
       "$RUN/ext/src/content/main.js"

for marker in 'laita-test-transform' 'laitaAlive' 'mode: "open"'; do
  grep -qr "$marker" "$RUN/ext/src" || { echo "TEST-BUILD EDIT FAILED: $marker"; exit 1; }
done

cp "$SRC/test/browser/page-transform.html" "$RUN/page.html"

# CHAT_DELAY_MS slows proofreading so the pill can be caught mid-flight; SLOW_DELAY_MS
# applies only to text containing SLOWME, to outlast Firefox's 30s background idle timeout.
PORT=$PORT PAGE=$RUN/page.html LOGFILE=$LOG CHAT_DELAY_MS=3000 SLOW_DELAY_MS=45000 \
  node "$SRC/test/browser/mock-ollama.mjs" & MOCK=$!
sleep 1

cd "$RUN"
# Do NOT lower extensions.background.idle.timeout: the slow-request step must run against
# Firefox's real 30 second timeout, which is the thing it exists to test.
MOZ_HEADLESS=1 timeout 400 npx --yes web-ext@latest run \
  --source-dir "$RUN/ext" --firefox=/usr/bin/firefox \
  --firefox-profile "$RUN/prof" --keep-profile-changes \
  --start-url "http://localhost:$PORT/" --no-input --no-reload > "$RUN/webext.log" 2>&1 || true

kill $MOCK 2>/dev/null || true
fuser -k -n tcp "$PORT" 2>/dev/null || true

python3 - "$LOG" <<'PY'
import json, sys, os
if not os.path.exists(sys.argv[1]):
    sys.exit("no requests logged at all - the extension never ran")
chat, withctx = 0, []
for e in json.load(open(sys.argv[1])):
    if e["url"] == "/api/beacon":
        b = json.loads(e["bodyPreview"])
        print("STEP", b["step"], "->", json.dumps(b["data"], ensure_ascii=False)[:220])
    elif e["url"] == "/api/chat":
        chat += 1
        if "num_ctx" in json.loads(e["bodyPreview"])["options"]:
            withctx.append(chat)
print("total /api/chat:", chat)
print("VERDICT num_ctx absent from every request:", not withctx)
PY

kill_leftovers
