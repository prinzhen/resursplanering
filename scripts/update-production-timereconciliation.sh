#!/usr/bin/env bash
# Apply admin time reconciliation and safe deletion to the ONLY production Planering instance.
# Keeps port 3000, Nginx 3001, Tailscale Funnel, the live database and user accounts.
# Performs build/tests before short downtime and uses a cold backup with rollback.
set -Eeuo pipefail
umask 077
VERSION="ce755a623b234a5c83768f52155f327bfef27ca2"
BRANCH="feature/quick-activities-gantt-proposals"
APP="/opt/resursplanering"
STATE="/var/lib/resursplanering"
SERVICE="resursplanering.service"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
STAGE="/opt/.resursplanering-timereconcile-$STAMP"
PREV="/opt/resursplanering.before-timereconcile-$STAMP"
BACKUP="/var/backups/resursplanering-timereconcile/$STAMP"
LOCK=/run/lock/resursplanering-timereconcile.lock
STOPPED=0
BACKUP_READY=0
SWAPPED=0
SUCCESS=0
info(){ printf '\n==> %s\n' "$*"; }
fail(){ printf '\nFEL: %s\n' "$*" >&2; exit 1; }
rollback(){
  local status="$?"
  if [[ "$SUCCESS" -eq 1 ]]; then return; fi
  trap - EXIT
  printf '\nUppgraderingen avbröts (status %s).\n' "$status" >&2
  if [[ "$STOPPED" -eq 1 ]]; then
    systemctl stop "$SERVICE" >/dev/null 2>&1 || true
    if [[ -d "$PREV" ]]; then
      if [[ -d "$APP" ]]; then mv "$APP" "$BACKUP/failed-code" || true; fi
      mv "$PREV" "$APP" || printf 'KRITISKT: den gamla koden finns i %s\n' "$PREV" >&2
    fi
    if [[ "$BACKUP_READY" -eq 1 ]]; then
      if [[ -d "$STATE/data" ]]; then mv "$STATE/data" "$BACKUP/failed-data" || true; fi
      cp -a "$BACKUP/production-data" "$STATE/data" || printf 'KRITISKT: kopiera databasbackupen manuellt från %s\n' "$BACKUP/production-data" >&2
    fi
    systemctl start "$SERVICE" || printf 'KRITISKT: kunde inte starta tidigare produktionstjänst\n' >&2
  fi
  printf 'Uppgraderingsbackup: %s\n' "$BACKUP" >&2
  exit "$status"
}
trap rollback EXIT
[[ "$EUID" -eq 0 ]] || fail "Kör med sudo på Planering-servern."
for tool in git node pnpm runuser systemctl curl python3 flock ss; do command -v "$tool" >/dev/null || fail "Saknar $tool"; done
exec 9>"$LOCK"
flock -n 9 || fail "En annan installation pågår redan."
[[ -d "$APP" && -d "$STATE/data" && ! -L "$APP" && ! -L "$STATE/data" ]] || fail "Kände inte igen produktionens installations- och datakatalog."
[[ ! -e "$STAGE" && ! -e "$PREV" && ! -e "$BACKUP" ]] || fail "Katalog finns redan; avbryter."
systemctl is-active --quiet "$SERVICE" || fail "Produktionen är inte aktiv. Kontrollera tjänsten manuellt."
CONFIG="$(systemctl show -p Environment --value "$SERVICE")"
[[ " $CONFIG " == *" PORT=3000 "* && " $CONFIG " == *" DATA_DIR=$STATE/data "* ]] ||
 fail "Tjänsten använder inte förväntad port 3000 och databas."
[[ "$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 6 http://127.0.0.1:3000/api/data)" == 401 ]] ||
 fail "Inbyggda API-sessioner är inte aktiva på port 3000."
echo "Väljaren påverkar endast applikationen på port 3000."
echo "Planering-konto, databas, Nginx och Tailscale kommer att bevaras."
echo "Ny administratörsdialog för flytt eller borttagning av tid före projektradering."
echo "Tidrapporter flyttas eller arkiveras bara efter ett separat val i dialogen."
[[ -r /dev/tty ]] || fail "Kör från en interaktiv SSH-terminal."
read -r -p 'Skriv JA TID för att installera uppdateringen: ' answer </dev/tty
[[ "$answer" == "JA TID" ]] || fail "Avbrutet utan ändringar."

info "Hämtar fastställd release och bygger separat från den skarpa servern"
git clone --quiet --single-branch --branch "$BRANCH" https://github.com/prinzhen/resursplanering.git "$STAGE"
git -C "$STAGE" checkout --quiet --detach "$VERSION"
[[ "$(git -C "$STAGE" rev-parse HEAD)" == "$VERSION" ]] || fail "Fel GitHub-version hämtad."
chown -R resursplanering:resursplanering "$STAGE"
install -d -m 0750 -o resursplanering -g resursplanering "$STAGE/selfhost/.wrangler/tmp"
runuser -u resursplanering -- env HOME="$STATE" CI=true pnpm --dir "$STAGE" install --frozen-lockfile
runuser -u resursplanering -- env HOME="$STATE" CI=true pnpm --dir "$STAGE" build
(
 cd "$STAGE"
 runuser -u resursplanering -- env HOME="$STATE" CI=true pnpm exec tsc --noEmit
 runuser -u resursplanering -- env HOME="$STATE" CI=true node scripts/test-role-access.mjs
 runuser -u resursplanering -- env HOME="$STATE" CI=true node scripts/test-tidrapport-sync.mjs
)

info "Stoppar endast Planering 3000 och tar kall SQLite-databasbackup"
install -d -m 0700 "$BACKUP"
systemctl stop "$SERVICE"
STOPPED=1
if ss -lntH '( sport = :3000 )' | grep -q .; then fail "Port 3000 lyssnar fortfarande; säkerhetsstopp."; fi
cp -a "$STATE/data" "$BACKUP/production-data"
cp -a "$STATE/config" "$BACKUP/production-config"
cp -a "/etc/systemd/system/$SERVICE" "$BACKUP/resursplanering.service"
BACKUP_READY=1
info "Växlar kod men behåller den skarpa databasen"
mv "$APP" "$PREV"
mv "$STAGE" "$APP"
SWAPPED=1
systemctl start "$SERVICE"

info "Kontrollerar att inloggning och dataskydd fungerar"
READY=0
for n in $(seq 1 45); do
  AUTH=$(curl --connect-timeout 1 --max-time 3 -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/auth || true)
  DATA=$(curl --connect-timeout 1 --max-time 3 -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/data || true)
  TIME=$(curl --connect-timeout 1 --max-time 3 -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/time-entries || true)
  LOGIN=$(curl --connect-timeout 1 --max-time 3 -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/login || true)
  if [[ "$AUTH" == 200 && "$DATA" == 401 && "$TIME" == 401 && "$LOGIN" == 200 ]]; then READY=1; break; fi
  sleep 2
done
[[ "$READY" -eq 1 ]] || fail "Hälsokontroll misslyckades: auth=$AUTH data=$DATA time=$TIME login=$LOGIN."

python3 - "$BACKUP/production-data" "$STATE/data" <<'PY'
import pathlib,sqlite3,sys
TABLES=("employees","projects","activities","assignments","work_packages","project_members","user_accounts","time_entries")
def snapshot(root):
    candidates=[]
    for file in pathlib.Path(root).rglob("*.sqlite"):
        try:
            c=sqlite3.connect(file.as_uri()+"?mode=ro",uri=True,timeout=15)
            names={r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if {"employees","projects","activities","user_accounts","time_entries"}<=names:
                assert c.execute("PRAGMA integrity_check").fetchone()[0]=="ok","sqlite integrity_check failed"
                assert not c.execute("PRAGMA foreign_key_check").fetchall(),"foreign key check failed"
                candidates.append({name:c.execute('SELECT COUNT(*) FROM "'+name+'"').fetchone()[0] if name in names else 0 for name in TABLES})
            c.close()
        except sqlite3.Error: pass
    assert len(candidates)==1,"Expected exactly one application SQLite database"
    return candidates[0]
before,after=snapshot(sys.argv[1]),snapshot(sys.argv[2])
assert before==after,f"Unexpected change in business data: {before} -> {after}"
new=sqlite3.connect(next(pathlib.Path(sys.argv[2]).rglob("*.sqlite")).as_uri()+"?mode=ro",uri=True)
try:
    tables={x[0] for x in new.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"time_entry_relocations","time_entry_removal_archive"} <= tables,"Time-reconciliation migration 0015 missing"
finally:new.close()
print("Datakontroll OK: inga personer, projekt, aktiviteter eller tidposter förlorade. Tidflytts- och revisionsarkiv finns.")
PY
SUCCESS=1
info "KLART: Port 3000 kör administratörsfunktionen för tidflytt och radering."
printf 'Tidigare kod: %s\nSäkerhetskopia: %s\nGit-version: %s\n' "$PREV" "$BACKUP" "$VERSION"
printf 'Inga Nginx- eller Tailscale-inställningar har ändrats.\n'
