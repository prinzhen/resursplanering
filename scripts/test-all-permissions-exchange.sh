#!/usr/bin/env bash
# Full role and exchange safety suite using isolated temporary databases.
set -Eeuo pipefail
[[ "$EUID" -ne 0 ]] || { echo "SÄKERHETSSTOPP: kör inte med sudo/root." >&2; exit 1; }
ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"
case "$ROOT" in /opt/resursplanering*|/var/lib/resursplanering*) echo "SÄKERHETSSTOPP: kör testsviten i en separat klon, inte i en aktiv installation." >&2;exit 1;;esac
for bin in node pnpm;do command -v "$bin" >/dev/null || { echo "Saknar $bin";exit 1; };done
[[ -f package.json && -d node_modules ]] || { echo "Installera beroenden först.";exit 1; }
case "${DATA_DIR:-}" in /var/lib/resursplanering*) echo "SÄKERHETSSTOPP: DATA_DIR är skarp databas." >&2;exit 1;;esac
echo "== Isolerat säkerhetstest: $(git rev-parse --short HEAD) =="
pnpm build
pnpm exec tsc --noEmit
for t in \
 scripts/test-chef-filter.mjs \
 scripts/test-effort-history.mjs \
 scripts/test-planning-exchange.mjs \
 scripts/test-weekly-v2.mjs \
 scripts/test-activity-calendar.mjs \
 scripts/test-weekly-single-row.mjs \
 scripts/test-weekly-load.mjs \
 scripts/test-weekly-v2-integration.mjs \
 scripts/test-individual-integration.mjs \
 scripts/test-role-access.mjs \
 scripts/test-tidrapport-sync.mjs
do
 echo "=== $t ==="
 DATA_DIR= node "$t"
done
echo "PASS: samtliga isolerade behörighets- och import/exporttester."
