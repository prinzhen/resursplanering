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
echo "[1/4] Stoppar endast Excel-testtjänsten medan en konsekvent kopia tas."
if [[ "$was_active" == true ]]; then systemctl stop "$service"; is_stopped=true; fi
cp -a -- "$source" "$tmp/data"
echo "[2/4] Startar om den ordinarie Excel-testtjänsten oförändrad."
if [[ "$was_active" == true ]]; then systemctl start "$service"; is_stopped=false; fi
echo "[3/4] Kör integrationstester på privat kopia. API-port 32137."
TEST_DATA_SOURCE="$tmp/data" node scripts/test-individual-integration.mjs
echo "[4/4] Alla tester klara. Privat databas kastas, originalet är orört."
