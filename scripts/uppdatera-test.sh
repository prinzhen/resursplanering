#!/usr/bin/env bash
# Updates only the systemd-managed test checkout. Always keeps production untouched.
set -Eeuo pipefail
umask 077
TEST_DIR="${TEST_DIR:-/opt/resursplanering-test}"
SERVICE="resursplanering-test.service"
BRANCH="feature/full-production-project-hierarchy-and-excel-renames-20261111"
[[ "$EUID" != 0 ]] || { echo "Kör som vanlig användare, utan sudo." >&2; exit 1; }
for cmd in git pnpm node python3 sudo systemctl ss curl flock cp; do
 command -v "$cmd" >/dev/null || { echo "Saknar kommando: $cmd" >&2; exit 1; }
done
[[ "$TEST_DIR" = /* && "$TEST_DIR" != "/opt/resursplanering" ]] || { echo "Ogiltig testkatalog." >&2; exit 1; }
[[ -d "$TEST_DIR/.git" ]] || { echo "Saknar testklon: $TEST_DIR" >&2; exit 1; }
[[ -z "$(git -C "$TEST_DIR" status --porcelain)" ]] || {
 echo "Testklonen har lokala ändringar. Spara dem innan uppdateringen." >&2; exit 1;
}
UNIT_DIR="$(sudo systemctl show "$SERVICE" -p WorkingDirectory --value)"
UNIT_ENV="$(sudo systemctl show "$SERVICE" -p Environment --value)"
[[ "$UNIT_DIR" == "$TEST_DIR" ]] || { echo "Testtjänsten måste vara installerad för $TEST_DIR." >&2; exit 1; }
[[ " $UNIT_ENV " == *" PORT=3200 "* && " $UNIT_ENV " == *" HOST=127.0.0.1 "* ]] || { echo "Fel port/host för testtjänsten." >&2; exit 1; }
DATA_DIR=""
for token in $UNIT_ENV; do
 case "$token" in DATA_DIR=*) DATA_DIR="${token#DATA_DIR=}";; esac
done
[[ -n "$DATA_DIR" && "$DATA_DIR" = /* && "$DATA_DIR" != "/var/lib/resursplanering/data" && -d "$DATA_DIR" ]] || { echo "Kunde inte verifiera separat testdatakatalog." >&2; exit 1; }
[[ "$DATA_DIR" != /var/lib/resursplanering/* ]] || { echo "Testdata får inte ligga i produktionens katalog." >&2; exit 1; }
[[ -n "$(sudo systemctl show "$SERVICE" -p User --value)" ]] || { echo "Testtjänsten saknar separat User." >&2; exit 1; }
LOCK="$HOME/.resursplanering-test-upgrade.lock"
exec 9>"$LOCK"
flock -n 9 || { echo "En testuppdatering kör redan." >&2; exit 1; }

echo "Hämtar kod, utan att stoppa testservern..."
git -C "$TEST_DIR" fetch --prune origin "$BRANCH"
TARGET="$(git -C "$TEST_DIR" rev-parse "origin/$BRANCH")"
OLD="$(git -C "$TEST_DIR" rev-parse HEAD)"
echo "Tidigare: $OLD"
echo "Ny:      $TARGET"
if [[ "$TARGET" == "$OLD" ]]; then
 echo "Testversionen är redan uppdaterad."
 exit 0
fi
# Only update by moving forward in the branch, not by a destructive reset.
git -C "$TEST_DIR" merge-base --is-ancestor "$OLD" "$TARGET" || {
 echo "Testklonen ligger inte på en föregångare till målrevisionen. Avbryter utan ändringar." >&2; exit 1;
}
sudo systemctl is-active --quiet "$SERVICE" || {
 echo "Testtjänsten körs inte. Kontrollera tjänsten före uppgradering." >&2; exit 1;
}
BACKUP_ROOT="$HOME/resursplanering-test-backuper"
mkdir -p -m 0700 "$BACKUP_ROOT"
BACKUP="$BACKUP_ROOT/$(date -u +%Y%m%dT%H%M%SZ)-$OLD"
[[ ! -e "$BACKUP" ]] || { echo "Backupsökvägen finns redan." >&2; exit 1; }
mkdir -m 0700 "$BACKUP"
printf '%s\n' "$OLD" > "$BACKUP/previous-commit"
printf '%s\n' "$DATA_DIR" > "$BACKUP/data-path"
STOPPED=0
COMPLETED=0
restore(){
 local status=$?
 trap - EXIT
 if ((COMPLETED)); then return; fi
 if ((STOPPED)); then
  echo "FEL: Uppdateringen misslyckades. Försöker återställa testversionen..." >&2
  sudo systemctl stop "$SERVICE" || true
  if [[ -f "$BACKUP/data.tar" ]]; then
   # Keep failed test data for diagnosis, without touching production.
   mv "$DATA_DIR" "$BACKUP/failed-data" 2>/dev/null || true
   mkdir -p "$DATA_DIR"
   tar -C "$DATA_DIR" -xf "$BACKUP/data.tar" || true
  fi
  (cd "$TEST_DIR" && git switch --detach "$OLD" && pnpm install --frozen-lockfile && pnpm build) || true
  sudo systemctl start "$SERVICE" || true
 fi
 echo "Testbackup: $BACKUP" >&2
 exit "$status"
}
trap restore EXIT

echo "Stoppar endast $SERVICE för en konsekvent testbackup..."
sudo systemctl stop "$SERVICE"
STOPPED=1
if ss -ltnH '( sport = :3200 )' | grep -q .; then
 echo "Port 3200 är fortfarande upptagen. Rör inte den processen manuellt; kontrollera tjänsten." >&2
 exit 1
fi
tar -C "$DATA_DIR" -cpf "$BACKUP/data.tar" .
tar -tf "$BACKUP/data.tar" >/dev/null

echo "Installerar ny testkod..."
git -C "$TEST_DIR" switch "$BRANCH" 2>/dev/null || git -C "$TEST_DIR" switch -c "$BRANCH" --track "origin/$BRANCH"
git -C "$TEST_DIR" merge --ff-only "$TARGET"
(cd "$TEST_DIR" &&
 pnpm install --frozen-lockfile &&
 pnpm build &&
 pnpm exec tsc --noEmit &&
 node scripts/test-project-effort.mjs &&
 node scripts/test-chef-filter.mjs &&
 node scripts/test-effort-history.mjs &&
 node scripts/test-individual-xlsx-layout.mjs &&
 node scripts/test-individual-integration.mjs &&
 node scripts/test-role-access.mjs &&
 node scripts/test-tidrapport-sync.mjs)

echo "Startar testtjänsten..."
sudo systemctl start "$SERVICE"
READY=0
for i in $(seq 1 45); do
 if curl -fsS --max-time 3 http://127.0.0.1:3200/api/auth >/dev/null 2>&1; then
  READY=1; break
 fi
 sleep 2
done
[[ "$READY" == 1 ]] || { echo "Testservern svarar inte på /api/auth." >&2; exit 1; }
for endpoint in data time-entries; do
 code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:3200/api/$endpoint")"
 [[ "$code" == 401 ]] || { echo "Fel HTTP-status $code för /api/$endpoint." >&2; exit 1; }
done
python3 - "$DATA_DIR" <<'PY'
import pathlib,sqlite3,sys
root=pathlib.Path(sys.argv[1])
matches=[]
for f in root.rglob("*.sqlite"):
 try:
  db=sqlite3.connect(f.as_uri()+"?mode=ro",uri=True)
  tables={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
  if {"employees","projects","activities","user_accounts"} <= tables: matches.append(f)
  db.close()
 except sqlite3.Error: pass
if len(matches)!=1: raise SystemExit("Förväntade en testdatabas; hittade "+str(len(matches)))
db=sqlite3.connect(matches[0])
try:
 assert db.execute("PRAGMA integrity_check").fetchone()[0]=="ok"
 assert not db.execute("PRAGMA foreign_key_check").fetchall()
finally: db.close()
print("Testdatabasens integritet OK")
PY
COMPLETED=1
trap - EXIT
echo "KLART: Testuppdatering till $(git -C "$TEST_DIR" rev-parse --short HEAD)"
echo "Testbackup: $BACKUP"
echo "Produktion på 3000 har inte ändrats."
