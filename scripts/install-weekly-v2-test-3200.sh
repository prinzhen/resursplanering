#!/usr/bin/env bash
# Fristående testmiljö för XLSX v2. Kräver rätt produktionsdatakatalog.
set -Eeuo pipefail
umask 077
[[ $EUID -eq 0 ]] || { echo "Kör med sudo." >&2; exit 1; }
BRANCH="feature/weekly-xlsx-v2-bf8e928-base"
RELEASE_SHA="90ba2336e5fdcbe6a4aeea56e456bd759246fb3e"
PRODUCTION_SHA="bf8e928c4f63c30d7b46be530479bd61ee83a9aa"
SOURCE="/var/lib/resursplanering/data"
if [[ -v SOURCE_DATA_DIR ]]; then SOURCE="$SOURCE_DATA_DIR"; fi
ROOT="/opt/resursplanering-weekly-v2"
BASE="/var/lib/resursplanering-weekly-v2"
DATA="$BASE/data"
CONFIG="$BASE/config"
SERVICE="resursplanering-weekly-v2.service"
RUN_USER="prinzhen"
if [[ -v SUDO_USER && "$SUDO_USER" != root ]]; then RUN_USER="$SUDO_USER"; fi
for bin in git node pnpm python3 ss systemctl runuser curl id getent; do
 command -v "$bin" >/dev/null || { echo "Saknar $bin" >&2; exit 1; }
done
id "$RUN_USER" >/dev/null || { echo "Saknar användare $RUN_USER" >&2; exit 1; }
[[ -d "$SOURCE" && ! -L "$SOURCE" ]] || { echo "Saknar giltig källdatabas $SOURCE" >&2; exit 1; }
[[ "$SOURCE" != "$BASE"* ]] || { echo "Testkatalog får inte vara källdatabas." >&2; exit 1; }
[[ -d /opt/resursplanering ]] || { echo "Saknar produktionskatalog." >&2; exit 1; }
current_prod="$(git -c safe.directory=/opt/resursplanering -C /opt/resursplanering rev-parse HEAD)"
[[ "$current_prod" == "$PRODUCTION_SHA" ]] || { echo "Produktion har en annan revision: $current_prod. Datakopian kräver ny granskning." >&2; exit 1; }
[[ ! -e "$ROOT" && ! -e "$BASE" && ! -e "/etc/systemd/system/$SERVICE" ]] ||
 { echo "Testinstallation finns redan. Avbryter utan ändring." >&2; exit 1; }
if ss -lntH '( sport = :3200 )' | grep -q .; then
 echo "Port 3200 används redan. Avbryter utan ändring." >&2; exit 1
fi
[[ -t 0 ]] || { echo "Kör i en interaktiv terminal." >&2; exit 1; }
echo "Endast testkatalogerna $ROOT och $BASE samt $SERVICE skapas."
echo "Produktion 3000, /opt/resursplanering och dess databas berörs inte."
read -r -p "Skriv INSTALLERA TEST för att fortsätta: " answer
[[ "$answer" == "INSTALLERA TEST" ]] || { echo "Avbrutet."; exit 0; }
echo "[1/6] Klonar produktionsbaserad utvecklingsgren."
git clone --single-branch --branch "$BRANCH" https://github.com/prinzhen/resursplanering.git "$ROOT"
git -C "$ROOT" checkout --quiet --detach "$RELEASE_SHA"
[[ "$(git -C "$ROOT" rev-parse HEAD)" == "$RELEASE_SHA" ]] || { echo "Fel GitHub-version." >&2; exit 1; }
cd "$ROOT"
echo "[2/6] Bygger och kör tester före installation."
pnpm install --frozen-lockfile
pnpm build
pnpm exec tsc --noEmit
node scripts/test-weekly-v2.mjs
node scripts/test-weekly-load.mjs
node scripts/test-weekly-v2-integration.mjs
echo "[3/6] Konsistent ONLINEBACKUP av SQLite till egen katalog."
mkdir -p "$DATA" "$CONFIG"
python3 - "$SOURCE" "$DATA" <<'PY'
import pathlib,sqlite3,shutil,sys
src,dst=map(pathlib.Path,sys.argv[1:])
databases=sorted(p for p in src.rglob("*.sqlite") if p.name!="metadata.sqlite")
if not databases:raise SystemExit("Ingen SQLite-fil hittades, avbryter.")
for item in src.rglob("*"):
 target=dst/item.relative_to(src)
 if item.is_dir():target.mkdir(parents=True,exist_ok=True)
 elif not item.name.endswith((".sqlite",".sqlite-wal",".sqlite-shm")):
  target.parent.mkdir(parents=True,exist_ok=True)
  shutil.copy2(item,target)
for original in databases:
 target=dst/original.relative_to(src)
 target.parent.mkdir(parents=True,exist_ok=True)
 connection=sqlite3.connect("file:"+str(original)+"?mode=ro",uri=True,timeout=30)
 copy=sqlite3.connect(str(target),timeout=30)
 try:
  connection.backup(copy,pages=100,sleep=0.1)
  if copy.execute("PRAGMA integrity_check").fetchone()[0]!="ok":
   raise RuntimeError("Integritetsfel: "+str(original))
 finally:copy.close();connection.close()
print("Kopierade",len(databases),"databaser med SQLite online backup.")
PY
chown -R "$RUN_USER:$(id -gn "$RUN_USER")" "$ROOT" "$BASE"
echo "[4/6] Migrerar ENDAST kopian."
runuser -u "$RUN_USER" -- env \
 HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)" \
 XDG_CONFIG_HOME="$CONFIG" CI=true \
 node "$ROOT/node_modules/wrangler/bin/wrangler.js" d1 migrations apply DB \
 --local --config "$ROOT/selfhost/wrangler.jsonc" --persist-to "$DATA"
echo "[5/6] Skapar isolerad systemd-tjänst på 127.0.0.1:3200."
cat > "/etc/systemd/system/$SERVICE" <<EOF
[Unit]
Description=Resursplanering veckoplanering v2 – test
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$(id -gn "$RUN_USER")
WorkingDirectory=$ROOT
Environment=DATA_DIR=$DATA
Environment=XDG_CONFIG_HOME=$CONFIG
Environment=HOST=127.0.0.1
Environment=PORT=3200
Environment=CI=true
ExecStart=/usr/bin/node $ROOT/scripts/start-selfhosted.mjs
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now "$SERVICE"
echo "[6/6] Verifierar lokalt API-skydd."
ready=false
for attempt in {1..45}; do
 if curl -fsS --max-time 2 http://127.0.0.1:3200/api/auth >/dev/null 2>&1;then
  ready=true;break
 fi
 sleep 1
done
if [[ "$ready" != true ]];then
 journalctl -u "$SERVICE" -n 60 --no-pager
 echo "Testtjänsten svarade inte. Produktion ändrades inte." >&2;exit 1
fi
status="$(curl --max-time 5 -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3200/api/weekly-v2)"
[[ "$status" == 401 ]] || { echo "Fel: anonymt API svarade HTTP $status" >&2;exit 1; }
echo "KLART – testtjänsten använder separat kod och separat SQLite-databas."
echo "SSH-tunnel: ssh -L 3200:127.0.0.1:3200 $RUN_USER@PLANERING-IP"
echo "Webbläsare: http://localhost:3200/weekly-v2"
echo "Installerad Git-revision: $RELEASE_SHA"
