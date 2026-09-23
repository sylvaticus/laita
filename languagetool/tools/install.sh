#!/usr/bin/env bash
#
# Install the LAITA LanguageTool server as a systemd service.
#
# It COPIES what it needs into --prefix rather than running out of this checkout, so the
# clone is disposable and an update is an explicit act. Two directories are copied,
# because the server deliberately has no copy of its own of the prompts, the anchoring,
# the chunking or the cache - those live in libreoffice/src/pythonpath/ and there is
# exactly one of them:
#
#     languagetool/src/            the server
#     libreoffice/src/pythonpath/  the shared modules it imports
#
# Run with --dry-run to see every file and unit it would write, touching nothing.
set -e
cd "$(dirname "$0")/.."
SRC="$(pwd)"
REPO="$(dirname "$SRC")"

PREFIX=/opt/laita
CONF=/etc/laita/languagetool.json
UNIT=/etc/systemd/system/laita-languagetool.service
SERVICE_USER=laita
HOST=127.0.0.1
PORT=8181
MODEL=qwen3.5:9b
ENDPOINT=http://127.0.0.1:11434
DRY=0
UNINSTALL=0

usage() {
  cat <<USAGE
usage: sudo $0 [options]

  --host ADDR     address to bind (default $HOST)
                  use 172.17.0.1 to serve a Collabora container over docker0
  --port N        port to bind (default $PORT)
  --model NAME    Ollama model (default $MODEL)
  --endpoint URL  Ollama endpoint (default $ENDPOINT)
  --prefix DIR    where to install the code (default $PREFIX)
  --user NAME     system account to run as (default $SERVICE_USER, created if absent)
  --config PATH   configuration file (default $CONF)
  --dry-run       print what would happen and change nothing
  --uninstall     stop and remove the service, keeping $CONF
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --endpoint) ENDPOINT="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --user) SERVICE_USER="$2"; shift 2 ;;
    --config) CONF="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

run() {
  if [ "$DRY" = "1" ]; then echo "  would: $*"; else "$@"; fi
}

# Past tense only when it actually happened. A dry run that reports things it did not do
# is worse than no dry run, and this is the mode people are told to trust.
did() {
  [ "$DRY" = "1" ] || echo "$*"
}

if [ "$DRY" = "0" ] && [ "$(id -u)" != "0" ]; then
  echo "run me with sudo (or pass --dry-run to see what it would do)" >&2
  exit 1
fi

# ---------------------------------------------------------------- uninstall
if [ "$UNINSTALL" = "1" ]; then
  run systemctl disable --now laita-languagetool.service || true
  run rm -f "$UNIT"
  run systemctl daemon-reload
  run rm -rf "$PREFIX"
  echo "removed. $CONF was kept; delete it by hand if you want it gone."
  exit 0
fi

# ---------------------------------------------------------------- checks first
command -v python3 >/dev/null || { echo "python3 is not installed" >&2; exit 1; }
for d in "$SRC/src" "$REPO/libreoffice/src/pythonpath"; do
  [ -d "$d" ] || { echo "missing: $d - run this from a full LAITA checkout" >&2; exit 1; }
done

echo "installing from $REPO"
echo "  prefix   $PREFIX"
echo "  config   $CONF"
echo "  service  $SERVICE_USER, ${HOST}:${PORT}, model $MODEL"
echo

# A dedicated unprivileged account. Everything anyone types passes through this process,
# and it needs nothing at all: no home, no shell, no login.
if id "$SERVICE_USER" >/dev/null 2>&1; then
  echo "user $SERVICE_USER exists"
else
  run useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  did "created system user $SERVICE_USER"
fi

# ---------------------------------------------------------------- the code
run mkdir -p "$PREFIX/languagetool" "$PREFIX/libreoffice/src"
run rm -rf "$PREFIX/languagetool/src" "$PREFIX/libreoffice/src/pythonpath"
run cp -a "$SRC/src" "$PREFIX/languagetool/src"
run cp -a "$REPO/libreoffice/src/pythonpath" "$PREFIX/libreoffice/src/pythonpath"
run find "$PREFIX" -name __pycache__ -type d -exec rm -rf {} +
did "copied the server and the shared modules into $PREFIX"

# ---------------------------------------------------------------- the config
if [ -f "$CONF" ]; then
  echo "keeping the existing $CONF (delete it to get a fresh one)"
else
  run mkdir -p "$(dirname "$CONF")"
  if [ "$DRY" = "1" ]; then
    echo "  would write $CONF"
  else
    cat > "$CONF" <<JSON
{
  "host": "$HOST",
  "port": $PORT,
  "model": "$MODEL",
  "endpoint": "$ENDPOINT"
}
JSON
  fi
  run chown root:"$SERVICE_USER" "$CONF"
  run chmod 640 "$CONF"
  did "wrote $CONF"
fi

# ---------------------------------------------------------------- the unit
if [ "$DRY" = "1" ]; then
  echo "  would write $UNIT"
else
  cat > "$UNIT" <<UNITEOF
[Unit]
Description=LAITA LanguageTool server (proofreading from a local Ollama)
Documentation=file://$PREFIX/languagetool/README.md
After=network.target ollama.service
Wants=ollama.service

[Service]
Type=simple
User=$SERVICE_USER
ExecStart=/usr/bin/python3 $PREFIX/languagetool/src/laita_lt_server.py --config $CONF
# ProtectSystem=strict makes $PREFIX read-only, and Python would try to write .pyc files
# into it on every start. Harmless but noisy; this stops it trying.
Environment=PYTHONDONTWRITEBYTECODE=1
Restart=on-failure
RestartSec=5
# The default logFile is "", so the server writes to stderr and the journal keeps it:
#   journalctl -u laita-languagetool -f
StandardOutput=journal
StandardError=journal

# It reads a config file and talks to Ollama over the loopback. Nothing else.
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6
RestrictNamespaces=true
LockPersonality=true
MemoryDenyWriteExecute=true

[Install]
WantedBy=multi-user.target
UNITEOF
fi
run cp "$SRC/README.md" "$SRC/DEPLOY.md" "$PREFIX/languagetool/"
did "wrote $UNIT"

if [ "$DRY" = "1" ]; then
  echo
  echo "dry run: nothing was changed."
  exit 0
fi

systemctl daemon-reload
systemctl enable --now laita-languagetool.service
sleep 3
systemctl --no-pager --lines=20 status laita-languagetool.service || true

cat <<NOTE

------------------------------------------------------------------------
Bound to ${HOST}:${PORT}.  Check it answers:

    curl -s http://${HOST}:${PORT}/status

NOTE

case "$HOST" in
  127.0.0.1|localhost|::1) ;;
  *)
    cat <<NOTE
${HOST} is not loopback: everything anyone types reaches this port, so make
sure only the intended clients can. On a host whose INPUT chain ends in a
catch-all DROP, the docker0 bridge also needs letting through - and note the
packets are DROPPED, not refused, so the symptom is a ten-second hang that
looks exactly like a slow model:

    iptables -A INPUT -i docker0 -d ${HOST} -p tcp --dport ${PORT} -j ACCEPT

Then point Collabora at it, on the coolwsd command line (extra_params in the
container):

    --o:languagetool.enabled=true
    --o:languagetool.base_url=http://${HOST}:${PORT}/v2

NOTE
    ;;
esac
