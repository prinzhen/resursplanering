import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const path=new URL('./update-production-xlsx-3000.sh',import.meta.url);
const script=readFileSync(path,'utf8');
assert.equal(spawnSync('bash',['-n',path.pathname]).status,0);
for(const text of [
 'EXPECTED_CURRENT="87bcff2d50abc8d16f445cf7a6e2ed71eb53cab9"',
 'TARGET="0e4ea9910405861d8c805f8546d1b1373b5b0cc5"',
 'flock -n 9','diff --quiet HEAD --','rev-parse HEAD^',
 'Oväntad fil i XLSX-rättningen','pnpm build','pnpm exec tsc --noEmit',
 'cp -a "$DATA" "$BACKUP/data"','cp -a "$BACKUP/data" "$DATA"',
])assert.ok(script.includes(text),'Missing safeguard: '+text);
const stop=script.indexOf('systemctl stop "$SERVICE"',script.indexOf('echo "[2/6]'));
assert.ok(script.indexOf('pnpm build')<stop,'Build before stopping production');
assert.ok(script.indexOf('node "scripts/$test.mjs"')<stop,'Tests before stopping production');
assert.ok(script.indexOf('cp -a "$DATA" "$BACKUP/data"')<script.indexOf('mv "$APP" "$OLD"'),'Backup before swapping');
assert.doesNotMatch(script,/read -r -p|systemctl (?:stop|restart) .*weekly/,'No extra prompt or test-service stop');

// Execute the actual rollback function with real file operations in isolated
// directories. Service operations are replaced by a recording stub on PATH.
const rollback=script.slice(script.indexOf('rollback(){'),script.indexOf('trap rollback EXIT'));
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
for(const state of ['before-stop','stopped','between-renames','new-code-started']){
 const temp=mkdtempSync(join(tmpdir(),'xlsx-rollback-'));
 try{
  const app=join(temp,'app'),old=join(temp,'old'),data=join(temp,'data'),backup=join(temp,'backup'),stage=join(temp,'stage');
  const bin=join(temp,'bin'),events=join(temp,'events');
  for(const p of [data,backup,stage,bin])mkdirSync(p);
  writeFileSync(join(data,'record'),'original-data');
  const swapped=['between-renames','new-code-started'].includes(state);
  mkdirSync(swapped?old:app);writeFileSync(join(swapped?old:app,'version'),'original-code');
  if(state==='new-code-started'){
   mkdirSync(app);writeFileSync(join(app,'version'),'new-code');
   mkdirSync(join(backup,'data'));writeFileSync(join(backup,'data','record'),'original-data');
   writeFileSync(join(data,'record'),'startup-write');
  }
  writeFileSync(join(bin,'systemctl'),'#!/bin/sh\nprintf "%s\\n" "$*" >> "$XLSX_TEST_EVENTS"\n');
  chmodSync(join(bin,'systemctl'),0o755);
  const vars={APP:app,OLD:old,DATA:data,BACKUP:backup,STAGE:stage,SERVICE:'isolated-test.service',
   SUCCESS:'0',STOPPED:state==='before-stop'?'0':'1',SWAPPED:swapped?'1':'0',DB_SNAPSHOT:state==='new-code-started'?'1':'0'};
  const harness=Object.entries(vars).map(([k,v])=>k+'='+quote(v)).join('\n')+'\n'+rollback+'\ntrap rollback EXIT\nexit 7\n';
  const result=spawnSync('bash',['-c',harness],{encoding:'utf8',env:{...process.env,PATH:bin+':'+process.env.PATH,XLSX_TEST_EVENTS:events}});
  assert.equal(result.status,7,result.stderr);
  assert.equal(readFileSync(join(app,'version'),'utf8'),'original-code');
  assert.equal(readFileSync(join(data,'record'),'utf8'),'original-data');
  assert.ok(!existsSync(stage),'Discard failed staging');
  if(state==='before-stop')assert.ok(!existsSync(events),'Do not touch a running service on preflight failure');
  else assert.match(readFileSync(events,'utf8'),/start isolated-test.service/);
  if(state==='new-code-started')assert.equal(readFileSync(join(backup,'failed-data','record'),'utf8'),'startup-write');
  console.log('PASS XLSX release rollback: '+state);
 }finally{rmSync(temp,{recursive:true,force:true});}
}
console.log('PASS XLSX release: exact baseline, scope guard, build/test before downtime and retained backups');
