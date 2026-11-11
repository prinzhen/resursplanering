#!/usr/bin/env bash
# Install a dedicated systemd test service on Debian/Ubuntu. Never touch 3000.
set -Eeuo pipefail
TEST_DIR="${TEST_DIR:-/opt/resursplanering-test}"
TEST_DATA_DIR="${TEST_DATA_DIR:-$HOME/resursplanering-fulltest-data}"
SERVICE="resursplanering-test.service"
[[ "${EUID}" != 0 ]] || { echo "Kör som vanlig testanvändare, inte root." >&2; exit 1; }
[[ -d "$TEST_DIR/.git" ]] || { echo "Saknar Git-testkatalog: $TEST_DIR" >&2; exit 1; }
[[ -d "$TEST_DATA_DIR" ]] || { echo "Testdata saknas: $TEST_DATA_DIR. Ange korrekt TEST_DATA_DIR innan installation." >&2; exit 1; }
[[ "$TEST_DATA_DIR" != "/var/lib/resursplanering/data" && "$TEST_DIR" != "/opt/resursplanering" ]] || { echo "Produktionssökväg förbjuden." >&2; exit 1; }
[[ "$TEST_DIR" = /* && "$TEST_DATA_DIR" = /* ]] || { echo "Använd absoluta sökvägar." >&2; exit 1; }
if sudo systemctl cat "$SERVICE" >/dev/null 2>&1; then
 echo "$SERVICE finns redan; inget skrivs över. Kontrollera med: sudo systemctl cat $SERVICE" >&2
 exit 1
fi
if ss -ltnH '( sport = :3200 )' | grep -q .; then
 echo "Port 3200 körs redan manuellt. Stoppa den med Ctrl+C innan installation." >&2
 exit 1
fi
ACCOUNT="$(id -un)"
GROUP="$(id -gn)"
install -d -m 0700 "$TEST_DATA_DIR"
UNIT="$(mktemp)"
trap 'rm -f "$UNIT"' EXIT
cat >"$UNIT" <<EOF
[Unit]
Description=Resursplanering – isolerad testversion port 3200
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$ACCOUNT
Group=$GROUP
WorkingDirectory=$TEST_DIR
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=3200
Environment=DATA_DIR=$TEST_DATA_DIR
Environment=HOME=$HOME
Environment=CI=true
ExecStart=/usr/bin/node $TEST_DIR/scripts/start-selfhosted.mjs
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
echo "Installerar $SERVICE utan att ändra produktionen."
sudo install -m 0644 "$UNIT" "/etc/systemd/system/$SERVICE"
sudo systemctl daemon-reload
sudo systemctl enable --now "$SERVICE"
sudo systemctl status "$SERVICE" --no-pager
echo "Testversion: http://127.0.0.1:3200 (via SSH-tunnel)"
