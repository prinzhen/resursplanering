#!/usr/bin/env bash
# Resursplanering production 3000: staged, pinned, backed up and reversible.
# Run as root INSIDE CT 130, not on Proxmox host.
set -Eeuo pipefail
umask 077
export LC_ALL=C

APP="/opt/resursplanering"
DATA="/var/lib/resursplanering/data"
SERVICE="resursplanering.service"
TEST_SERVICE="resursplanering-weekly-v2.service"
OWNER="prinzhen"
BRANCH="feature/admin-account-edit-employee-purge-20261119"
TARGET="26ea27a48cfa94133b27cdd1a8c42c2893b7e926"
EXPECTED_CURRENT="87bcff2d50abc8d16f445cf7a6e2ed71eb53cab9"
TEST_EXPECTED="10cb199e89c3a3c1978e1f2146490b0d104e7e32"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
STAGE="/opt/.resursplanering-prod-stage-$STAMP"
OLD="/opt/resursplanering.before-$STAMP"
BACKUP="/var/backups/resursplanering-production/$STAMP"
STOPPED=0
SWAPPED=0
DB_SNAPSHOT=0
SUCCESS=0

rollback(){
 local rc="$?"
 [[ "$SUCCESS" == 1 ]] && return 0
 trap - EXIT
 echo "UPPDATERING MISSLYCKADES (kod $rc). Försöker återställa produktion." >&2
 if [[ "$STOPPED" == 1 ]];then
  systemctl stop "$SERVICE" >/dev/null 2>&1 || true
  if [[ "$SWAPPED" == 1 && -d "$OLD" ]];then
   if [[ -d "$APP" ]];then
    mkdir -p "$BACKUP"
    mv "$APP" "$BACKUP/failed-code" || true
   fi
   mv "$OLD" "$APP" || echo "KRITISKT: Kunde inte återställa tidigare programkod!" >&2
  fi
  if [[ "$DB_SNAPSHOT" == 1 && -d "$BACKUP/data" ]];then
   if [[ -d "$DATA" ]];then
    mv "$DATA" "$BACKUP/failed-data" || echo "KRITISKT: Kunde inte flytta undan misslyckad data!" >&2
   fi
   cp -a "$BACKUP/data" "$DATA" || echo "KRITISKT: Kunde inte återställa databasbackup!" >&2
  fi
  systemctl start "$SERVICE" || echo "KRITISKT: Produktionsservice startar inte efter rollback!" >&2
 fi
 if [[ -d "$STAGE" && ! -L "$STAGE" ]];then
  rm -rf --one-file-system -- "$STAGE" || true
 fi
 echo "Backup och misslyckad version finns vid behov i $BACKUP." >&2
 exit "$rc"
}
trap rollback EXIT

[[ "$EUID" == 0 ]] || { echo "Kör som root i Planering LXC." >&2;exit 1; }
for tool in git pnpm node python3 curl timeout runuser systemctl df awk;do
 command -v "$tool" >/dev/null || { echo "Saknar $tool" >&2;exit 1; }
done
[[ -d "$APP/.git" && -d "$DATA" && ! -L "$APP" && ! -L "$DATA" ]] ||
 { echo "Produktionskatalog eller DATA_DIR saknas, eller är symlänk." >&2;exit 1; }
[[ "$(systemctl show -P WorkingDirectory "$SERVICE")" == "$APP" ]] ||
 { echo "Produktionsservice använder annan WorkingDirectory." >&2;exit 1; }
ENVIRONMENT="$(systemctl show -P Environment "$SERVICE")"
[[ " $ENVIRONMENT " == *" DATA_DIR=$DATA "* && " $ENVIRONMENT " == *" PORT=3000 "* ]] ||
 { echo "DATA_DIR eller PORT matchar inte produktionsservice: $ENVIRONMENT" >&2;exit 1; }
CURRENT="$(git -c safe.directory="$APP" -C "$APP" rev-parse HEAD)"
[[ "$CURRENT" == "$EXPECTED_CURRENT" ]] ||
 { echo "Avbryter: produktion är $CURRENT, förväntar $EXPECTED_CURRENT." >&2;exit 1; }
systemctl is-active --quiet "$SERVICE" || { echo "Produktion är inte aktiv." >&2;exit 1; }
systemctl is-active --quiet "$TEST_SERVICE" || { echo "Testtjänsten är inte aktiv." >&2;exit 1; }
[[ "$(git -c safe.directory=/opt/resursplanering-weekly-v2 -C /opt/resursplanering-weekly-v2 rev-parse HEAD)" == "$TEST_EXPECTED" ]] || { echo "Testmiljön matchar inte tidigare godkänd version $TEST_EXPECTED. Avbryter." >&2;exit 1; }
[[ ! -e "$STAGE" && ! -e "$OLD" && ! -e "$BACKUP" ]] ||
 { echo "En releasekatalog finns redan; avbryter." >&2;exit 1; }

free_bytes="$(df -PB1 /opt | awk 'NR==2 {print $4}')"
free_inodes="$(df -Pi /opt | awk 'NR==2 {print $4}')"
[[ "$free_bytes" =~ ^[0-9]+$ && "$free_inodes" =~ ^[0-9]+$ ]] ||
 { echo "Kan inte kontrollera ledigt utrymme och inoder." >&2;exit 1; }
if ((free_bytes < 5*1024*1024*1024 || free_inodes < 100000));then
 echo "För lite utrymme för en säker produktionsrelease: $free_bytes byte, $free_inodes inoder." >&2
 exit 1
fi
for check in "3000 /api/auth 200" "3200 /api/auth 200";do
 read -r port uri wanted <<< "$check"
 actual="$(curl -sS --max-time 8 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port$uri" || true)"
 [[ "$actual" == "$wanted" ]] || { echo "Före-kontroll $port$uri gav $actual, väntade $wanted." >&2;exit 1; }
done
echo "PRODUKTION $CURRENT -> $TARGET. TEST och testdatabasen berörs inte."
echo "Downtime för produktion uppstår vid backup, kodbyte och uppstart."
read -r -p "Skriv JA UPPDATERA PRODUKTION: " answer
[[ "$answer" == "JA UPPDATERA PRODUKTION" ]] || { echo "Avbrutet.";SUCCESS=1;exit 0; }

echo "[1/6] Hämtar och bygger låst kodversion i separat staging."
git clone --quiet --single-branch --branch "$BRANCH" https://github.com/prinzhen/resursplanering.git "$STAGE"
git -C "$STAGE" checkout --quiet --detach "$TARGET"
[[ "$(git -C "$STAGE" rev-parse HEAD)" == "$TARGET" ]] || { echo "Fel kodversion.";exit 1; }
chown -R "$OWNER:$(id -gn "$OWNER")" "$STAGE"
# The stage directory inherits umask 077, so only OWNER can enter it
# after cloning. The production service uses a different unprivileged user.
# Grant its primary group read/execute (not write) BEFORE code activation.
SERVICE_USER="$(systemctl show -P User "$SERVICE")"
[[ -n "$SERVICE_USER" && "$SERVICE_USER" != root ]] || { echo "Okänd/osäker produktionsanvändare: $SERVICE_USER" >&2;exit 1; }
SERVICE_GROUP="$(id -gn "$SERVICE_USER")"
[[ -n "$SERVICE_GROUP" ]] || { echo "Kunde inte identifiera produktionsgruppen." >&2;exit 1; }
runuser -u "$OWNER" -- env HOME="/home/$OWNER" CI=true pnpm --dir "$STAGE" install --frozen-lockfile
(
 cd "$STAGE"
 runuser -u "$OWNER" -- env HOME="/home/$OWNER" CI=true pnpm build
 runuser -u "$OWNER" -- env HOME="/home/$OWNER" CI=true pnpm exec tsc --noEmit
 timeout --signal=TERM --kill-after=10s 300s runuser -u "$OWNER" -- env HOME="/home/$OWNER" CI=true node scripts/test-release-readiness.mjs --quick
)

# Grant service access to the built tree. Keep world permissions unchanged.
# This also covers files emitted by pnpm/vinext during the build.
chgrp -R "$SERVICE_GROUP" "$STAGE"
chmod -R g+rX "$STAGE"
# Wrangler dev writes temporary files under selfhost/.wrangler. The entire
# application tree must NOT be writable by the service account; allow only
# this dedicated runtime directory. This prevents EACCES mkdtemp at startup.
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0700 "$STAGE/selfhost/.wrangler"
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0700 "$STAGE/selfhost/.wrangler/tmp"
TEMP_CHECK="$(runuser -u "$SERVICE_USER" -- mktemp -d "$STAGE/selfhost/.wrangler/tmp/dev-XXXXXXXX")" ||
 { echo "Wrangler kan inte skriva till selfhost/.wrangler/tmp." >&2;exit 1; }
rmdir "$TEMP_CHECK"
runuser -u "$SERVICE_USER" -- test -x "$STAGE"
runuser -u "$SERVICE_USER" -- test -r "$STAGE/scripts/start-selfhosted.mjs"
runuser -u "$SERVICE_USER" -- bash -c 'cd "$1" && test -r ./selfhost/wrangler.jsonc && test -r ./dist/server/index.js' _ "$STAGE" ||
 { echo "Tjänstens användare kan inte läsa den färdigbyggda releasen." >&2;exit 1; }
echo "Behörighetskontroll OK: $SERVICE_USER ($SERVICE_GROUP) kan läsa koden och skapa Wranglers temporära filer."

echo "[Förkontroll] Testar produktionsmigrationer mot en online-säkerhetskopia före tjänstestopp."
PREFLIGHT="$STAGE/.prod-migration-preflight"
python3 - "$DATA" "$PREFLIGHT" <<'PY'
import pathlib,sqlite3,shutil,sys
src,dst=map(pathlib.Path,sys.argv[1:])
dst.mkdir(parents=True,exist_ok=False)
dbs=[]
for entry in src.rglob("*"):
 if entry.is_symlink():raise RuntimeError("Symlink i DATA_DIR är inte tillåten i förkontrollen: "+str(entry))
 relative=entry.relative_to(src)
 target=dst/relative
 if entry.is_dir():target.mkdir(parents=True,exist_ok=True)
 elif entry.name.endswith(("-wal","-shm")):continue
 elif entry.suffix==".sqlite":dbs.append((entry,target))
 elif entry.is_file():
  target.parent.mkdir(parents=True,exist_ok=True)
  shutil.copy2(entry,target)
for source,target in dbs:
 target.parent.mkdir(parents=True,exist_ok=True)
 old=sqlite3.connect("file:"+str(source)+"?mode=ro",uri=True,timeout=30)
 new=sqlite3.connect(str(target),timeout=30)
 try:
  old.backup(new,pages=250,sleep=.1)
  assert new.execute("PRAGMA integrity_check").fetchone()[0]=="ok"
 finally:new.close();old.close()
assert dbs, "Ingen SQLite-databas hittades i DATA_DIR"
print("Online-kopia klar:",len(dbs),"SQLite-filer")
PY
chown -R "$SERVICE_USER:$SERVICE_GROUP" "$PREFLIGHT"
(
 cd "$STAGE"
 runuser -u "$SERVICE_USER" -- env CI=true WRANGLER_SEND_METRICS=false \
  node "$STAGE/node_modules/wrangler/bin/wrangler.js" d1 migrations apply DB \
  --local --config "$STAGE/selfhost/wrangler.jsonc" --persist-to "$PREFLIGHT"
)
python3 - "$PREFLIGHT" <<'PY'
import pathlib,sqlite3,sys
found=0
for p in pathlib.Path(sys.argv[1]).rglob("*.sqlite"):
 db=sqlite3.connect("file:"+str(p)+"?mode=ro",uri=True)
 try:
  names={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
  if {"employees","projects","activities","user_accounts"}.issubset(names):
   found+=1
   required={"time_entries","weekly_plan_rows","activity_project_reclassifications"}
   assert required.issubset(names),"Saknar migrationsresultat: "+str(required-names)
   assert db.execute("PRAGMA integrity_check").fetchone()[0]=="ok","Databasfel efter testmigration"
   assert not db.execute("PRAGMA foreign_key_check").fetchone(),"Felaktiga främmande nycklar efter testmigration"
 finally:db.close()
assert found==1,"Förväntade en applikationsdatabas; fann "+str(found)
print("PASS: Produktionsdatabasens testmigration och integritet.")
PY
rm -rf --one-file-system -- "$PREFLIGHT"

echo "[2/6] Stoppar produktion kort och tar konsekvent backup av hela DATA_DIR."
STOPPED=1
systemctl stop "$SERVICE"
[[ ! -e "$BACKUP" ]] || { echo "Backupkollision.";exit 1; }
mkdir -p "$BACKUP"
cp -a "$DATA" "$BACKUP/data"
DB_SNAPSHOT=1
# Check each application SQLite DB in the consistent, stopped backup.
python3 - "$BACKUP/data" <<'PY'
import pathlib,sqlite3,sys
files=list(pathlib.Path(sys.argv[1]).rglob("*.sqlite"))
assert files, "Ingen SQLite-databas hittades"
main=0
for f in files:
 db=sqlite3.connect("file:"+str(f)+"?mode=ro",uri=True)
 try:
  assert db.execute("PRAGMA integrity_check").fetchone()[0]=="ok",f"Integritetsfel i {f}"
  names={x[0] for x in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
  if {"employees","projects","activities","user_accounts"}.issubset(names): main+=1
 finally:db.close()
assert main==1, f"Förväntade en produktionsdatabas, fann {main}"
print(f"Backup kontrollerad: {len(files)} SQLite-filer, {main} applikationsdatabas")
PY

echo "[3/6] Byter endast produktionskod. Startar migrationer på produktionsdatabasen."
mv "$APP" "$OLD"
SWAPPED=1
mv "$STAGE" "$APP"
runuser -u "$SERVICE_USER" -- bash -c 'cd "$1" && test -r ./scripts/start-selfhosted.mjs' _ "$APP" ||
 { echo "Efter kodbyte: tjänstanvändaren kan inte öppna /opt/resursplanering." >&2;exit 1; }
systemctl start "$SERVICE"

echo "[4/6] Verifierar produktion och test."
ready=0
for attempt in {1..60};do
 code="$(curl -s --max-time 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/auth || true)"
 if [[ "$code" == 200 ]];then ready=1;break;fi
 sleep 1
done
[[ "$ready" == 1 ]] || { echo "Produktion blev aldrig redo." >&2;exit 1; }
for route in /api/data /api/weekly-v2 /api/other-work-inbox;do
 code="$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:3000$route" || true)"
 [[ "$code" == 401 ]] || { echo "Skyddad produktionsväg $route gav HTTP $code (förväntat 401).";exit 1; }
done
[[ "$(curl -s --max-time 6 -o /dev/null -w '%{http_code}' http://127.0.0.1:3200/api/auth)" == 200 ]] ||
 { echo "Testmiljön svarar inte längre.";exit 1; }
[[ "$(git -c safe.directory="$APP" -C "$APP" rev-parse HEAD)" == "$TARGET" ]] ||
 { echo "Fel kodrevision efter byte.";exit 1; }

echo "[5/6] Kontrollerar produktionsdatabas efter migrationerna."
python3 - "$DATA" <<'PY'
import pathlib,sqlite3,sys
found=0
for f in pathlib.Path(sys.argv[1]).rglob("*.sqlite"):
 db=sqlite3.connect("file:"+str(f)+"?mode=ro",uri=True,timeout=15)
 try:
  names={x[0] for x in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
  if {"employees","projects","activities","user_accounts"}.issubset(names):
   found+=1
   assert {"weekly_plan_rows","activity_project_reclassifications","time_entries"}.issubset(names),"Saknar nya tabeller"
   assert db.execute("PRAGMA quick_check").fetchone()[0]=="ok","Databasfel"
   assert not db.execute("PRAGMA foreign_key_check").fetchone(),"Främmande nycklar är inkonsekventa"
 finally:db.close()
assert found==1,f"Förväntade en produktionsdatabas, fann {found}"
print("Nya tabeller och SQLite-integritet OK")
PY
SUCCESS=1
echo "[6/6] KLART: produktion verifierad på port 3000."
echo "Release: $TARGET"
echo "Rollback-kod: $OLD"
echo "Databassäkerhetskopia: $BACKUP/data"
echo "Ingen automatisk rensning av äldre produktionskopior vid första releasen."
