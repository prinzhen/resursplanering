#!/usr/bin/env bash
# Safely test a *copy* of the current Excel test database, never the original.
set -Eeuo pipefail
if [[ "${EUID}" -ne 0 ]]; then echo "Kör som root: sudo bash scripts/test-current-testdata-sandbox.sh" >&2; exit 1; fi
service="resursplanering-test-excel.service"
root="/opt/resursplanering-test-excel"
source="/var/lib/resursplanering-test-excel/data"
cd "$root"
[[ -d "$source" ]] || { echo "Saknar testdatabasen: $source" >&2; exit 1; }
tmp="$(mktemp -d /tmp/resursplanering-isolated-copy.XXXXXXXX)"
was_active=false
is_stopped=false
if systemctl is-active --quiet "$service"; then was_active=true; fi
cleanup(){
 local code=$?
 if [[ "$is_stopped" == true && "$was_active" == true ]]; then systemctl start "$service" || true; fi
 rm -rf -- "$tmp"
 exit "$code"
}
trap cleanup EXIT
snapshot_hash(){
 python3 - "$source" <<'PY'
import glob, hashlib, json, sqlite3, sys
files=[p for p in glob.glob(sys.argv[1]+"/v3/d1/**/*.sqlite",recursive=True) if not p.endswith("metadata.sqlite")]
if len(files)!=1:raise SystemExit("Hittade inte exakt en testdatabas.")
db=sqlite3.connect("file:"+files[0]+"?mode=ro",uri=True)
tables=["employees","projects","work_packages","activities","assignments","assignment_periods","activity_priority_history","project_members","employee_project_orders","employee_groups","employee_group_members","user_accounts","user_sessions","project_proposals","project_leaders","team_leaders","assignment_requests","individual_form_items","individual_week_moves","individual_project_state","individual_import_runs"]
h=hashlib.sha256()
for name in tables:
 try:
  rows=db.execute("SELECT * FROM "+name+" ORDER BY rowid").fetchall()
  h.update((name+json.dumps(rows,ensure_ascii=False,default=str)).encode())
 except sqlite3.OperationalError:pass
print(h.hexdigest())
PY
}
echo "[1/4] Stoppar endast Excel-testtjänsten medan en konsekvent kopia tas."
if [[ "$was_active" == true ]]; then systemctl stop "$service"; is_stopped=true; fi
before_hash="$(snapshot_hash)"
cp -a -- "$source" "$tmp/data"
echo "[2/4] Startar om den ordinarie Excel-testtjänsten oförändrad."
if [[ "$was_active" == true ]]; then systemctl start "$service"; is_stopped=false; fi
echo "[3/4] Kör integrationstester på privat kopia. API-port 32137."
TEST_DATA_SOURCE="$tmp/data" node scripts/test-individual-integration.mjs
after_hash="$(snapshot_hash)"
if [[ "$before_hash" != "$after_hash" ]]; then
 echo "VARNING: Ursprungliga planeringsdata ändrades medan testet pågick! Kontrollera annan trafik mot port 3100." >&2
 exit 1
fi
echo "[4/4] Alla tester klara. Originaldatabasens SHA256 över planeringstabellerna är oförändrad: $after_hash"
