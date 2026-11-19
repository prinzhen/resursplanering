import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {readFileSync} from "node:fs";

const path="scripts/update-production-3000.sh";
const syntax=spawnSync("bash",["-n",path],{encoding:"utf8"});
assert.equal(syntax.status,0,syntax.stderr);
const script=readFileSync(path,"utf8");
const checks=[
 'EXPECTED_CURRENT="bf8e928c4f63c30d7b46be530479bd61ee83a9aa"',
 'TARGET="10cb199e89c3a3c1978e1f2146490b0d104e7e32"',
 'APP="/opt/resursplanering"',
 'DATA="/var/lib/resursplanering/data"',
 'SERVICE="resursplanering.service"',
 'TEST_SERVICE="resursplanering-weekly-v2.service"',
 'SUCCESS=0','DB_SNAPSHOT=0','trap rollback EXIT',
 'systemctl stop "$SERVICE"',
 'cp -a "$DATA" "$BACKUP/data"',
 'SWAPPED=1','mv "$OLD" "$APP"',
 'cp -a "$BACKUP/data" "$DATA"',
 'activity_project_reclassifications',
 'PRAGMA integrity_check','PRAGMA foreign_key_check',
 'PORT=3000', 'read -r -p "Skriv JA UPPDATERA PRODUKTION: " answer',
 'SERVICE_USER="$(systemctl show -P User "$SERVICE")"',
 'SERVICE_GROUP="$(id -gn "$SERVICE_USER")"',
 'chgrp -R "$SERVICE_GROUP" "$STAGE"',
 'chmod -R g+rX "$STAGE"',
 'runuser -u "$SERVICE_USER" -- test -x "$STAGE"',
 'runuser -u "$SERVICE_USER" -- test -r "$STAGE/scripts/start-selfhosted.mjs"',
 'install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0700 "$STAGE/selfhost/.wrangler/tmp"',
 'mktemp -d "$STAGE/selfhost/.wrangler/tmp/dev-XXXXXXXX"',
 'PREFLIGHT="$STAGE/.prod-migration-preflight"',
 'old.backup(new,pages=250,sleep=.1)',
 'd1 migrations apply DB',
 'PASS: Produktionsdatabasens testmigration och integritet.',
];
for(const check of checks)assert.ok(script.includes(check),"Mandatory release protection missing: "+check);
assert.ok(script.indexOf('cp -a "$DATA" "$BACKUP/data"') < script.indexOf('mv "$APP" "$OLD"'),
 "Backup must precede code activation");
assert.ok(script.indexOf('SWAPPED=1') < script.indexOf('mv "$STAGE" "$APP"'),
 "Rollback must be armed before new stage is moved into service path");
assert.ok(script.indexOf('chmod -R g+rX "$STAGE"') < script.indexOf('systemctl stop "$SERVICE"',script.indexOf('echo "[2/6] Stoppar produktion')),
 "Production service permissions must be verified BEFORE any downtime");
assert.ok(script.indexOf('PREFLIGHT="$STAGE/.prod-migration-preflight"') < script.indexOf('systemctl stop "$SERVICE"',script.indexOf('echo "[2/6] Stoppar produktion')),
 "Migrations of the production online snapshot must pass before stopping the service");
assert.ok(script.indexOf('mktemp -d "$STAGE/selfhost/.wrangler/tmp/dev-XXXXXXXX"') < script.indexOf('systemctl stop "$SERVICE"',script.indexOf('echo "[2/6] Stoppar produktion')),
 "Wrangler runtime write access must be verified before stopping production");
console.log("PASS production release: bash -n, pinned verified code, offline DB backup, rollback, auth and integrity gates");
