#!/usr/bin/env bash
# Safely promote the verified Planering feature release to port 3000.
# --inspect never changes a service or a database.
# --promote requires an explicit data source, cold backups, smoke tests and rollback.
set -Eeuo pipefail
umask 077

PROD_SERVICE="resursplanering.service"
TEST_SERVICE="resursplanering-test-access.service"
PROD_APP="/opt/resursplanering"
TEST_APP="/opt/resursplanering-test-access"
PROD_STATE="/var/lib/resursplanering"
TEST_STATE="/var/lib/resursplanering-test-access"
RELEASE_SHA="c8c198ffbfb249b17a87cddeb3f4422ec20ca699"
RELEASE_BRANCH="feature/quick-activities-gantt-proposals"
REPOSITORY="https://github.com/prinzhen/resursplanering.git"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="/var/backups/resursplanering-promotion/$STAMP"
STAGE="/opt/.resursplanering-release-$STAMP"
OLD_APP="/opt/resursplanering.before-$STAMP"
FAILED_APP="$BACKUP/failed-code"
FAILED_DATA="$BACKUP/failed-data"
MODE=""
SOURCE=""
LOCK="/run/lock/resursplanering-promotion.lock"
SERVICES_STOPPED=0
BACKUP_READY=0
CODE_REPLACED=0
DATABASE_MAY_HAVE_CHANGED=0
SUCCESS=0

message() { printf '\n==> %s\n' "$*"; }
fail() { printf 'FEL: %s\n' "$*" >&2; exit 1; }
usage() {
 cat <<'USAGE'
Kör på Planering-servern:
  sudo bash promote-test-to-production.sh --inspect
  sudo bash promote-test-to-production.sh --promote --source=test
  sudo bash promote-test-to-production.sh --promote --source=production

--inspect visar antal poster i respektive databas utan att ändra någonting.
--source=test       använder medarbetare, projekt och tidposter från port 3200.
--source=production behåller befintlig produktionsdata från port 3000.
Ingen sammanslagning sker. Välj datakälla efter granskning av --inspect.
Samma Tailscale Funnel och Nginx-konfiguration behålls.
USAGE
}
[[ $# -ge 1 ]] || { usage; exit 2; }
MODE="$1"
if [[ "$MODE" == "--promote" ]]; then
 [[ $# -eq 2 ]] || { usage; exit 2; }
 case "$2" in
  --source=test) SOURCE=test;;
  --source=production) SOURCE=production;;
  *) usage; exit 2;;
 esac
elif [[ "$MODE" == "--inspect" ]]; then
 [[ $# -eq 1 ]] || { usage; exit 2; }
else
 usage; exit 2
fi
[[ "$EUID" -eq 0 ]] || fail "Skriptet måste köras med sudo."
command -v flock >/dev/null || fail "Saknar flock."
exec 9>"$LOCK"
flock -n 9 || fail "En annan uppgradering pågår redan."
for tool in python3 systemctl curl git node pnpm runuser cp mv; do
 command -v "$tool" >/dev/null || fail "Saknar kommando: $tool"
done
id resursplanering >/dev/null || fail "Tjänstanvändaren resursplanering finns inte."
for path in "$PROD_APP" "$TEST_APP" "$PROD_STATE/data" "$TEST_STATE/data"; do
 [[ -d "$path" && ! -L "$path" ]] || fail "Saknad katalog eller symlänk (avbryter): $path"
done
systemctl cat "$PROD_SERVICE" >/dev/null || fail "Produktionssystemd saknas."
systemctl cat "$TEST_SERVICE" >/dev/null || fail "Testsystemd saknas."

inspect() {
 python3 - "$PROD_STATE/data" "$TEST_STATE/data" <<'PY'
import pathlib, sqlite3, sys
TABLES = ("employees","projects","work_packages","activities","assignments",
          "user_accounts","project_members","time_entries","time_entry_audit",
          "individual_form_items","individual_import_runs")
def inspect_one(label, location):
    directory=pathlib.Path(location)
    candidates=[]
    for path in directory.rglob("*.sqlite"):
        if not path.is_file():
            continue
        try:
            conn=sqlite3.connect(path.as_uri()+"?mode=ro",uri=True,timeout=10)
            tables={r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if {"employees","projects","activities"} <= tables:
                candidates.append(path)
            conn.close()
        except sqlite3.Error:
            pass
    print("\n"+label+": "+str(directory))
    if len(candidates)!=1:
        raise SystemExit("FEL: förväntade exakt EN applikationsdatabas; hittade "+
                         str(len(candidates))+". Ingenting har ändrats.")
    db=candidates[0]
    conn=sqlite3.connect(db.as_uri()+"?mode=ro",uri=True,timeout=10)
    try:
        print("  SQLite:",db.relative_to(directory))
        valid=conn.execute("PRAGMA integrity_check").fetchone()[0]
        print("  SQLite integrity_check:",valid)
        if valid!="ok":
            raise SystemExit("FEL: databasen är inte hel. Avbryter.")
        available={r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        for table in TABLES:
            if table in available:
                print("  {:25s} {:>8d}".format(table,conn.execute('SELECT COUNT(*) FROM "'+table+'"').fetchone()[0]))
            else:
                print("  {:25s} {:>8s}".format(table,"saknas"))
        if "user_accounts" in available:
            columns={r[1] for r in conn.execute("PRAGMA table_info(user_accounts)")}
            if {"is_admin","is_disabled"} <= columns:
                admins=conn.execute("SELECT COUNT(*) FROM user_accounts WHERE is_admin=1 AND is_disabled=0").fetchone()[0]
                print("  Aktiva administratörer:    ",admins)
    finally:
        conn.close()
inspect_one("PRODUKTION (3000)",sys.argv[1])
inspect_one("TEST (3200)",sys.argv[2])
PY
}

validate_source() {
 local chosen="$PROD_STATE/data"
 [[ "$SOURCE" == test ]] && chosen="$TEST_STATE/data"
 python3 - "$chosen" <<'PY'
import pathlib,sqlite3,sys
root=pathlib.Path(sys.argv[1])
matched=[]
for path in root.rglob("*.sqlite"):
    try:
        db=sqlite3.connect(path.as_uri()+"?mode=ro",uri=True)
        tables={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if {"employees","projects","activities","user_accounts"}<=tables:
            matched.append(path)
        db.close()
    except sqlite3.Error:
        continue
if len(matched)!=1:
    raise SystemExit("Datakällan måste ha en unik SQLite-databas med personliga inloggningar.")
db=sqlite3.connect(matched[0].as_uri()+"?mode=ro",uri=True)
try:
    admins=db.execute("SELECT COUNT(*) FROM user_accounts WHERE is_admin=1 AND is_disabled=0").fetchone()[0]
    if admins<1:
        raise SystemExit("Datakällan saknar aktiva administratörer; ingen uppgradering utförs.")
    if db.execute("PRAGMA integrity_check").fetchone()[0]!="ok":
        raise SystemExit("Datakällans SQLite integritetskontroll misslyckades.")
finally:
    db.close()
print("VALD DATABAS: administratörskonton och integritet verifierade.")
PY
}
rollback() {
 local previous="$1"
 set +e
 trap - EXIT
 if [[ "$SUCCESS" -eq 1 ]]; then return; fi
 printf '\n!!! UPPGRADERINGEN AVBRÖTS (exit %s). !!!\n' "$previous" >&2
 if [[ "$SERVICES_STOPPED" -eq 1 ]]; then
   systemctl stop "$PROD_SERVICE" >/dev/null 2>&1
   systemctl stop "$TEST_SERVICE" >/dev/null 2>&1
   if [[ -d "$OLD_APP" ]]; then
     if [[ -d "$PROD_APP" ]]; then mv "$PROD_APP" "$FAILED_APP"; fi
     mv "$OLD_APP" "$PROD_APP" || printf 'KRITISKT: kunde inte återställa applikationskoden\n' >&2
   fi
   if [[ "$DATABASE_MAY_HAVE_CHANGED" -eq 1 && "$BACKUP_READY" -eq 1 ]]; then
     if [[ -d "$PROD_STATE/data" ]]; then mv "$PROD_STATE/data" "$FAILED_DATA"; fi
     cp -a "$BACKUP/production-data" "$PROD_STATE/data" ||
       printf 'KRITISKT: databasen kunde inte återställas från %s\n' "$BACKUP/production-data" >&2
   fi
   systemctl start "$PROD_SERVICE" ||
     printf 'KRITISKT: produktionstjänsten startade inte efter återställning\n' >&2
   systemctl start "$TEST_SERVICE" ||
     printf 'VARNING: testtjänsten startade inte efter återställning\n' >&2
 fi
 printf 'Backup och eventuella felsökningsfiler finns i: %s\n' "$BACKUP" >&2
 printf 'Produktionsstatus: '; systemctl is-active "$PROD_SERVICE"
 printf 'Teststatus: '; systemctl is-active "$TEST_SERVICE"
 return "$previous"
}
trap 'rollback $?' EXIT

message "Inventering före uppgradering (endast läsning)"
inspect
if [[ "$MODE" == "--inspect" ]]; then
 message "Inventering klar. Ingen tjänst, kod eller data har ändrats."
 SUCCESS=1
 exit 0
fi

# If a separate sync to Tidrapport has already been enabled, never
# accidentally have two competing writers or duplicate identities.
if systemctl is-active --quiet tidrapport-sync.timer ||
   systemctl is-active --quiet tidrapport-sync.service; then
 fail "Tidrapport-synkronisering är redan aktiv. Stoppa och granska den före serverbytet."
fi
validate_source
systemctl is-active --quiet "$PROD_SERVICE" || fail "Produktionen körs inte. Kräver manuell kontroll."
systemctl is-active --quiet "$TEST_SERVICE" || fail "Testversionen körs inte. Kräver manuell kontroll."
[[ -r /dev/tty && -w /dev/tty ]] || fail "Kör i interaktiv terminal så datakällan kan bekräftas."
cat <<CONFIRM

Du har valt datakälla: $SOURCE
* Port 3000 får den testade kodversionen $RELEASE_SHA.
* Endast den VALDA databasens medarbetare, projekt och historik används.
* Inga databaser slås ihop.
* Tailscale Funnel + Nginx behålls.
* Port 3200 stoppas och inaktiveras EFTER lyckad kontroll.
* Både gamla och nya databaser behålls i en återställningsbackup.

CONFIRM
read -r -p "Skriv exakt JA UPPGRADERA för att fortsätta: " ACCEPT </dev/tty
[[ "$ACCEPT" == "JA UPPGRADERA" ]] || fail "Ingen uppgradering genomförd."

message "Hämtar EXAKT testad kodrevision i en separat katalog"
[[ ! -e "$STAGE" && ! -e "$OLD_APP" ]] || fail "Staging- eller backupkod-katalog finns redan."
git clone --quiet --single-branch --branch "$RELEASE_BRANCH" "$REPOSITORY" "$STAGE"
git -C "$STAGE" checkout --quiet --detach "$RELEASE_SHA"
[[ "$(git -C "$STAGE" rev-parse HEAD)" == "$RELEASE_SHA" ]] ||
 fail "Fel kodversion efter kloning."
chown -R resursplanering:resursplanering "$STAGE"
message "Bygger release och typkontrollerar medan port 3000 fortfarande är igång"
runuser -u resursplanering -- env HOME="$PROD_STATE" CI=true pnpm --dir "$STAGE" install --frozen-lockfile
runuser -u resursplanering -- env HOME="$PROD_STATE" CI=true pnpm --dir "$STAGE" build
(
 cd "$STAGE"
 runuser -u resursplanering -- env HOME="$PROD_STATE" CI=true pnpm exec tsc --noEmit
 runuser -u resursplanering -- env HOME="$PROD_STATE" CI=true node scripts/test-role-access.mjs
 runuser -u resursplanering -- env HOME="$PROD_STATE" CI=true node scripts/test-tidrapport-sync.mjs
)

message "Stoppar BÅDA applikationerna kort för konsekventa kalla databasbackuper"
SERVICES_STOPPED=1
systemctl stop "$TEST_SERVICE"
systemctl stop "$PROD_SERVICE"
# Check process exit explicitly; a stale worker must not write to a copied D1 DB.
if ss -lntH '( sport = :3000 or sport = :3200 )' | grep -q .; then
 fail "Port 3000 eller 3200 lyssnar fortfarande efter stopp. Avbryter säkert."
fi
install -d -m 0700 "$BACKUP"
cp -a "$PROD_STATE/data" "$BACKUP/production-data"
cp -a "$PROD_STATE/config" "$BACKUP/production-config"
cp -a "$TEST_STATE/data" "$BACKUP/test-data"
cp -a "$TEST_STATE/config" "$BACKUP/test-config"
cp -a "/etc/systemd/system/$PROD_SERVICE" "$BACKUP/production.service"
cp -a "/etc/systemd/system/$TEST_SERVICE" "$BACKUP/test.service"
if [[ -f /etc/nginx/sites-available/resursplanering ]]; then
 cp -a /etc/nginx/sites-available/resursplanering "$BACKUP/nginx-site"
fi
BACKUP_READY=1
message "Kalla databaskopior sparade i $BACKUP"

if [[ "$SOURCE" == test ]]; then
 message "Använder den valda, bevarade testdatabasen som ny skarp databas"
 DATABASE_MAY_HAVE_CHANGED=1
 mv "$PROD_STATE/data" "$BACKUP/production-data-original"
 cp -a "$TEST_STATE/data" "$PROD_STATE/data"
 chown -R resursplanering:resursplanering "$PROD_STATE/data"
fi

message "Växlar kodrelease atomiskt"
mv "$PROD_APP" "$OLD_APP"
mv "$STAGE" "$PROD_APP"
CODE_REPLACED=1
DATABASE_MAY_HAVE_CHANGED=1
# Same existing systemd service: HOST=127.0.0.1 PORT=3000 DATA_DIR=/var/lib/resursplanering/data.
systemctl start "$PROD_SERVICE"

message "Verifierar ny skarp app, autentisering och tids-API"
HEALTHY=0
for attempt in $(seq 1 45); do
 if curl -fsS --connect-timeout 1 --max-time 3 http://127.0.0.1:3000/api/auth >/dev/null 2>&1; then
  CODE_DATA="$(curl -sS --connect-timeout 1 --max-time 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/data || true)"
  CODE_TIME="$(curl -sS --connect-timeout 1 --max-time 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/time-entries || true)"
  if [[ "$CODE_DATA" == 401 && "$CODE_TIME" == 401 ]]; then
   HEALTHY=1
   break
  fi
 fi
 sleep 2
done
[[ "$HEALTHY" -eq 1 ]] || {
 journalctl -u "$PROD_SERVICE" -n 50 --no-pager >&2 || true
 fail "Skärpt hälsokontroll misslyckades: autentisering eller tidrapport-API saknas."
}
# Verify integrity AFTER automatic migration by start-selfhosted.
python3 - "$PROD_STATE/data" <<'PY'
import pathlib,sqlite3,sys
matched=[]
for p in pathlib.Path(sys.argv[1]).rglob("*.sqlite"):
    try:
        c=sqlite3.connect(p.as_uri()+"?mode=ro",uri=True,timeout=20)
        ts={r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if {"employees","projects","activities","user_accounts","time_entries","time_entry_audit"}<=ts:
            matched.append(p)
        c.close()
    except sqlite3.Error:
        pass
if len(matched)!=1:
    raise SystemExit("FEL: ny skarp databas saknar en unik tids- och autentiseringsdatabas.")
conn=sqlite3.connect(matched[0].as_uri()+"?mode=ro",uri=True,timeout=30)
try:
    integrity=conn.execute("PRAGMA integrity_check").fetchone()[0]
    foreign_keys=conn.execute("PRAGMA foreign_key_check").fetchall()
    admins=conn.execute("SELECT COUNT(*) FROM user_accounts WHERE is_admin=1 AND is_disabled=0").fetchone()[0]
    if integrity!="ok" or foreign_keys or admins<1:
        raise SystemExit("FEL: integritetskontroll, foreign keys eller admin-konton misslyckades.")
    print("Skärpt databaskontroll godkänd. Aktiva administratörer:",admins)
finally:
    conn.close()
PY
NGINX_CODE="$(curl -sS --connect-timeout 1 --max-time 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/ || true)"
[[ "$NGINX_CODE" == 401 ]] || fail "Nginx skyddar inte ingången (väntat HTTP 401, fick $NGINX_CODE)."

message "Nya skarpa tjänsten svarar. Stoppar och inaktiverar 3200."
systemctl disable "$TEST_SERVICE" >/dev/null
SUCCESS=1
message "KLART: endast skarp Planering på port 3000 är aktiv."
printf '%s\n' "Release: $RELEASE_SHA" "Datakälla: $SOURCE"  "Säkerhetskopior: $BACKUP" "Tidigare kod: $OLD_APP"  "Adress: https://planering.tail323ccb.ts.net"  "Testtjänsten finns kvar avstängd för enklare återställning."
printf '%s\n' "Kontrollera: sudo systemctl status resursplanering --no-pager"
printf '%s\n' "Kontrollera: sudo ss -lntp | grep -E ':3000|:3001|:3200'"
