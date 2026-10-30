#!/usr/bin/env bash
# Install an isolated TEAM/auth test instance; never touch production or port 3100.
set -Eeuo pipefail
umask 077
[[ ${EUID} -eq 0 ]] || { echo "Kör med sudo: sudo bash $0" >&2; exit 1; }
SOURCE="/var/lib/resursplanering-test-excel/data"
ROOT="/opt/resursplanering-test-access"
BASE="/var/lib/resursplanering-test-access"
DATA="${BASE}/data"
CONFIG="${BASE}/config"
SERVICE="resursplanering-test-access.service"
BRANCH="feature/team-roles-approvals"
RUN_USER="${SUDO_USER:-prinzhen}"
[[ "${RUN_USER}" != root ]] || RUN_USER="prinzhen"
[[ -d "${SOURCE}" ]] || { echo "Saknar källdatabas: ${SOURCE}" >&2; exit 1; }
id "${RUN_USER}" >/dev/null || { echo "Användaren ${RUN_USER} finns inte." >&2; exit 1; }
for tool in git node pnpm python3 systemctl ss runuser getent curl; do command -v "${tool}" >/dev/null || { echo "Saknar kommando: ${tool}" >&2; exit 1; }; done
[[ ! -e "${ROOT}" && ! -e "${BASE}" && ! -e "/etc/systemd/system/${SERVICE}" ]] || {
 echo "Avbryter: testinstallationens katalog eller tjänst finns redan. Ingenting skrivs över." >&2; exit 1;
}
if ss -lntH '( sport = :3200 )' | grep -q .; then echo "Port 3200 används redan." >&2; exit 1; fi
if [[ ! -t 0 ]]; then echo "Kör från en interaktiv terminal så ett administratörslösenord kan anges säkert." >&2; exit 1; fi
read -r -p "E-postadress för testadministratör: " ADMIN_EMAIL
[[ "${ADMIN_EMAIL}" =~ ^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$ ]] || {
 echo "Ogiltig e-postadress." >&2; exit 1;
}
echo "[1/6] Hämtar separat kodgren."
git clone --single-branch --branch "${BRANCH}" "https://github.com/prinzhen/resursplanering.git" "${ROOT}"
cd "${ROOT}"
echo "[2/6] Installerar beroenden, bygger och typkontrollerar."
pnpm install --frozen-lockfile
pnpm build
pnpm exec tsc --noEmit
echo "[3/6] Kopierar testdata med SQLite online backup; port 3100 fortsätter köras."
mkdir -p "${DATA}" "${CONFIG}"
python3 - "${SOURCE}" "${DATA}" <<'PY'
import pathlib, shutil, sqlite3, sys
src, dst = map(pathlib.Path, sys.argv[1:])
for item in src.rglob("*"):
    relative = item.relative_to(src)
    target = dst / relative
    if item.is_dir():
        target.mkdir(parents=True, exist_ok=True)
    elif item.name.endswith((".sqlite", ".sqlite-wal", ".sqlite-shm")):
        continue
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(item, target)
database_paths = sorted(src.rglob("*.sqlite"))
if not database_paths:
    raise SystemExit("Hittade inga SQLite-filer. Avbryter.")
for original in database_paths:
    target = dst / original.relative_to(src)
    target.parent.mkdir(parents=True, exist_ok=True)
    source_db = sqlite3.connect("file:" + str(original) + "?mode=ro", uri=True, timeout=30)
    dest_db = sqlite3.connect(str(target), timeout=30)
    try:
        source_db.backup(dest_db, pages=100, sleep=0.1)
        status = dest_db.execute("PRAGMA integrity_check").fetchone()[0]
        if status != "ok":
            raise RuntimeError("SQLite integrity_check misslyckades: " + str(target))
    finally:
        dest_db.close()
        source_db.close()
print("Kopierade", len(database_paths), "SQLite-databaser med konsistenta backups.")
PY
chown -R "${RUN_USER}:$(id -gn "${RUN_USER}")" "${ROOT}" "${BASE}"
echo "[4/6] Migrerar endast kopian till TEAM och personliga konton."
runuser -u "${RUN_USER}" -- env HOME="$(getent passwd "${RUN_USER}" | cut -d: -f6)" XDG_CONFIG_HOME="${CONFIG}" CI=true \
  node "${ROOT}/node_modules/wrangler/bin/wrangler.js" d1 migrations apply DB \
  --local --config "${ROOT}/selfhost/wrangler.jsonc" --persist-to "${DATA}"
echo "[5/6] Skapar administratör för denna testinstans. Lösenord efterfrågas utan visning."
python3 "${ROOT}/scripts/provision-account.py" --data-dir "${DATA}" --email "${ADMIN_EMAIL}" --admin
chown -R "${RUN_USER}:$(id -gn "${RUN_USER}")" "${BASE}"
echo "[6/6] Skapar en separat tjänst som ENDAST lyssnar på 127.0.0.1:3200."
cat >"/etc/systemd/system/${SERVICE}" <<EOF
[Unit]
Description=Resursplanering TEAM/Auth – isolerad testinstans
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
Group=$(id -gn "${RUN_USER}")
WorkingDirectory=${ROOT}
Environment=DATA_DIR=${DATA}
Environment=XDG_CONFIG_HOME=${CONFIG}
Environment=HOST=127.0.0.1
Environment=PORT=3200
Environment=CI=true
ExecStart=/usr/bin/node ${ROOT}/scripts/start-selfhosted.mjs
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now "${SERVICE}"
ready=false
for attempt in {1..45}; do
 if curl --connect-timeout 1 --max-time 2 -fsS http://127.0.0.1:3200/api/auth >/dev/null 2>&1; then
  ready=true
  break
 fi
 sleep 1
done
if [[ "${ready}" != true ]]; then
 echo "Testservern svarade inte på port 3200." >&2
 journalctl -u "${SERVICE}" -n 70 --no-pager
 exit 1
fi
code="$(curl --connect-timeout 2 --max-time 5 -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3200/api/data)"
[[ "${code}" == 401 ]] || { echo "Säkerhetskontroll misslyckades: anonymt API gav HTTP ${code} (väntat 401)." >&2; exit 1; }
echo "KLART. 3200 använder separat kod och konsistent databaskopia. 3100 har inte stoppats."
echo "På din dator: ssh -L 3200:127.0.0.1:3200 ${RUN_USER}@PLANERING-IP"
echo "Öppna därefter http://localhost:3200/login"
