#!/usr/bin/env bash
# Uppdatera endast veckoplaneringens TEST-installation på port 3200.
# Staging byggs före tjänstestopp; gammal kod och databaskopia sparas.
set -Eeuo pipefail
umask 077
[[ $EUID -eq 0 ]] || { echo "Kör med sudo" >&2; exit 1; }
APP="/opt/resursplanering-weekly-v2"
DATA="/var/lib/resursplanering-weekly-v2/data"
SERVICE="resursplanering-weekly-v2.service"
BRANCH="feature/weekly-xlsx-v2-bf8e928-base"
VERSION="3940bb553691e91be403e2f546ece12b5fb8f75a"
PREVIOUS="90ba2336e5fdcbe6a4aeea56e456bd759246fb3e"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
STAGE="/opt/.resursplanering-weekly-v2-stage-$STAMP"
OLD="/opt/resursplanering-weekly-v2.before-$STAMP"
BACKUP="/var/backups/resursplanering-weekly-v2/$STAMP"
OWNER="prinzhen"
STOPPED=0
SWAPPED=0
SUCCESS=0
rollback(){
 local code="$?"
 [[ $SUCCESS -eq 1 ]] && return
 trap - EXIT
 echo "Uppdateringen avbröts (kod $code)." >&2
 if [[ $STOPPED -eq 1 ]];then
  systemctl stop "$SERVICE" >/dev/null 2>&1 || true
  if [[ -d "$OLD" ]];then
   [[ -d "$APP" ]] && mv "$APP" "$BACKUP/failed-code" || true
   mv "$OLD" "$APP" || true
  fi
  systemctl start "$SERVICE" || true
 fi
 echo "Testdatabasen och produktionen är oförändrade. Backup: $BACKUP" >&2
 exit "$code"
}
trap rollback EXIT
for bin in git pnpm node python3 systemctl runuser curl;do
 command -v "$bin" >/dev/null || { echo "Saknar $bin" >&2;exit 1; }
done
[[ -d "$APP/.git" && -d "$DATA" && ! -L "$APP" && ! -L "$DATA" ]] || { echo "Testinstallation saknas." >&2;exit 1; }
CURRENT="$(git -c safe.directory="$APP" -C "$APP" rev-parse HEAD)"
if [[ "$CURRENT" != "$PREVIOUS" && "$CURRENT" != "6b87b4c7be1671367aca841d463a4e801a6310cb" && "$CURRENT" != "9a68562c8543593ac0d91d6d6d89e484608e3b90" && "$CURRENT" != "55842ab6cc87381af2cf66140207faeb906dbd6c" ]];then
 echo "Testversion $CURRENT är inte en av de godkända föregående versionerna. Avbryter." >&2;exit 1
fi
systemctl is-active --quiet "$SERVICE" || { echo "Testtjänsten är inte aktiv." >&2;exit 1; }
systemctl is-active --quiet resursplanering.service || { echo "Produktion är inte aktiv." >&2;exit 1; }
[[ ! -e "$STAGE" && ! -e "$OLD" && ! -e "$BACKUP" ]] || { echo "Katalogkollision." >&2;exit 1; }
echo "Uppdaterar enbart TEST på 3200. Skarp port 3000 berörs inte."
echo "Nuvarande version: $CURRENT"
echo "Ny version: $VERSION"
read -r -p "Skriv JA UPPDATERA TEST för att fortsätta: " answer
[[ "$answer" == "JA UPPDATERA TEST" ]] || { echo "Avbrutet.";exit 0; }
echo "[1/5] Bygger ny testkod separat."
git clone --quiet --single-branch --branch "$BRANCH" https://github.com/prinzhen/resursplanering.git "$STAGE"
git -C "$STAGE" checkout --quiet --detach "$VERSION"
[[ "$(git -C "$STAGE" rev-parse HEAD)" == "$VERSION" ]] || { echo "Fel Git-version." >&2; exit 1; }
chown -R "$OWNER:$(id -gn "$OWNER")" "$STAGE"
runuser -u "$OWNER" -- env HOME="/home/$OWNER" CI=true pnpm --dir "$STAGE" install --frozen-lockfile
(
 cd "$STAGE"
 runuser -u "$OWNER" -- env HOME="/home/$OWNER" CI=true pnpm build
 runuser -u "$OWNER" -- env HOME="/home/$OWNER" CI=true pnpm exec tsc --noEmit
 runuser -u "$OWNER" -- env HOME="/home/$OWNER" CI=true node scripts/test-weekly-v2.mjs
 runuser -u "$OWNER" -- env HOME="/home/$OWNER" CI=true node scripts/test-weekly-load.mjs
 runuser -u "$OWNER" -- env HOME="/home/$OWNER" CI=true node scripts/test-weekly-v2-integration.mjs
 runuser -u "$OWNER" -- env HOME="/home/$OWNER" CI=true node scripts/test-chef-filter.mjs
)
echo "[2/5] Säkerhetskopierar test-DB med SQLite online backup."
install -d -m 0700 "$BACKUP/data"
python3 - "$DATA" "$BACKUP/data" <<'PY'
import pathlib,sqlite3,shutil,sys
src,dst=map(pathlib.Path,sys.argv[1:])
dbs=list(src.rglob("*.sqlite"))
if not dbs:raise RuntimeError("Hittade ingen testdatabas")
for item in src.rglob("*"):
 target=dst/item.relative_to(src)
 if item.is_dir():target.mkdir(parents=True,exist_ok=True)
 elif not item.name.endswith((".sqlite",".sqlite-wal",".sqlite-shm")):
  target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(item,target)
for file in dbs:
 target=dst/file.relative_to(src);target.parent.mkdir(parents=True,exist_ok=True)
 old=sqlite3.connect("file:"+str(file)+"?mode=ro",uri=True,timeout=30)
 new=sqlite3.connect(str(target),timeout=30)
 try:
  old.backup(new,pages=100,sleep=.1)
  assert new.execute("PRAGMA integrity_check").fetchone()[0]=="ok"
 finally:new.close();old.close()
print("Sparade",len(dbs),"SQLite-kopior")
PY
echo "[3/5] Byter ENDAST testkoden och startar om testtjänsten."
systemctl stop "$SERVICE"
STOPPED=1
mv "$APP" "$OLD"
mv "$STAGE" "$APP"
SWAPPED=1
systemctl start "$SERVICE"
echo "[4/5] Hälsokontroll."
ready=false
for n in {1..45};do
 test_status="$(curl --max-time 3 -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3200/api/auth || true)"
 if [[ "$test_status" == 200 ]];then ready=true;break;fi
 sleep 1
done
[[ "$ready" == true ]] || { echo "Testtjänsten svarade inte." >&2;exit 1; }
[[ "$(curl --max-time 4 -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3200/api/weekly-v2)" == 401 ]] ||
 { echo "Inloggningsskydd på port 3200 svarar inte korrekt." >&2;exit 1; }
[[ "$(curl --max-time 4 -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/auth)" == 200 ]] ||
 { echo "Produktionens hälsokontroll misslyckades." >&2;exit 1; }
SUCCESS=1
echo "[5/5] KLART – veckoväljare och personexport uppdaterade på port 3200."
echo "Gammal testkod: $OLD"
echo "Säkerhetskopia av testdata: $BACKUP/data"
echo "Koden använder Git-revision $VERSION"
