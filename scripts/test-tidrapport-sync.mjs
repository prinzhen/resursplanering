#!/usr/bin/env node
/** Isolated integration tests for the Tidrapport outbox sender.
 * No production database or external network is used.
 */
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {spawn} from "node:child_process";
import {mkdtemp,rm,readFile,writeFile,mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createServer} from "node:http";

const root=await mkdtemp(join(tmpdir(),"planering-tidrapport-sync-"));
const data=join(root,"data"),dbdir=join(data,"v3","d1"),dbpath=join(dbdir,"app.sqlite"),state=join(root,"sync-state.json");
const token="test-only-Tidrapport-long-token-2026";
let checks=0,fail=false;
const seen=new Map(),received=[];
const check=(label,fn)=>{fn();checks++;console.log("PASS tidrapport-sync:",label)};
let forceFailure=false;
const server=createServer(async(req,res)=>{
 let raw="";
 for await(const chunk of req)raw+=chunk;
 const key=req.headers["idempotency-key"];
 if(req.method!=="POST"||req.headers.authorization!=="Bearer "+token){
  res.writeHead(401);res.end();return;
 }
 if(forceFailure){res.writeHead(503);res.end("Temporarily unavailable");return}
 let body;
 try{body=JSON.parse(raw)}catch{res.writeHead(400);res.end();return}
 received.push({key,body});
 const first=!seen.has(key);
 if(first)seen.set(key,body);
 res.writeHead(first?201:200,{"content-type":"application/json"});res.end(JSON.stringify({ok:true,duplicate:!first}));
});
const run=(envAdd={})=>new Promise((resolve,reject)=>{
 let stdout="",stderr="";
 const child=spawn(process.execPath,["scripts/sync-tidrapport.mjs"],{
  cwd:process.cwd(),
  env:{...process.env,PLANERING_DATA_DIR:data,TIDRAPPORT_SYNC_INSTANCE:"planering-ci",
   TIDRAPPORT_SYNC_STATE:state,TIDRAPPORT_SYNC_ENDPOINT:`http://127.0.0.1:${server.address().port}/api/time-entries/import`,
   TIDRAPPORT_SYNC_TOKEN:token,TIDRAPPORT_SYNC_ENABLED:"yes",...envAdd},
  stdio:["ignore","pipe","pipe"]
 });
 child.stdout.on("data",x=>{stdout+=String(x)});
 child.stderr.on("data",x=>{stderr+=String(x)});
 child.on("error",reject);
 child.on("exit",code=>resolve({code,stdout,stderr}));
});
try{
 await mkdir(dbdir,{recursive:true});
 const db=new DatabaseSync(dbpath);
 db.exec(`
 CREATE TABLE employees(id INTEGER PRIMARY KEY,name TEXT,email TEXT,is_group_ledger INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE projects(id INTEGER PRIMARY KEY,code TEXT,name TEXT);
 CREATE TABLE activities(id INTEGER PRIMARY KEY,project_id INTEGER,code TEXT,name TEXT);
 CREATE TABLE time_entries(id INTEGER PRIMARY KEY,employee_id INTEGER,activity_id INTEGER,work_date TEXT,started_at INTEGER,
  ended_at INTEGER,duration_seconds INTEGER,note TEXT,source TEXT,updated_at INTEGER,deleted_at INTEGER,
  reporting_group_id INTEGER,reporting_group_name TEXT);
 CREATE TABLE time_entry_audit(id INTEGER PRIMARY KEY,time_entry_id INTEGER,action TEXT,changed_at INTEGER);
 CREATE TABLE time_entry_removal_archive(
  source_event_id INTEGER PRIMARY KEY, original_entry_id INTEGER,employee_id INTEGER,
  employee_email TEXT,employee_name TEXT,original_project_id INTEGER,original_project_code TEXT,
  original_project_name TEXT,original_activity_id INTEGER,original_activity_code TEXT,
  original_activity_name TEXT,work_date TEXT,started_at INTEGER,ended_at INTEGER,
  duration_seconds INTEGER,note TEXT,source TEXT,updated_at INTEGER,removed_at INTEGER
 );
 INSERT INTO employees(id,name,email) VALUES(7,'CI Medarbetare','role-ci@example.se');
 INSERT INTO projects VALUES(11,'P-1042','Controller modernisering');
 INSERT INTO activities VALUES(12,11,'A-42','Integrationstest aktivitet');
 INSERT INTO time_entries(id,employee_id,activity_id,work_date,started_at,ended_at,duration_seconds,note,source,updated_at,deleted_at) VALUES(22,7,12,'2026-11-03',1793692800,1793696400,3600,'Första timmen','manual',1793696400,NULL);
 INSERT INTO time_entry_audit VALUES(1,22,'manual',1793696400);
 `);
 await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",e=>e?reject(e):resolve()));
 const noEnable=await run({TIDRAPPORT_SYNC_ENABLED:""});
 check("Sender is disabled by default",()=>{
  assert.notEqual(noEnable.code,0);
  assert.match(noEnable.stderr,/Not enabled/);
  assert.equal(received.length,0);
 });
 const dry=await run({TIDRAPPORT_SYNC_DRY_RUN:"yes",TIDRAPPORT_SYNC_ENABLED:""});
 check("Dry run previews outbox without network or committing checkpoint",()=>{
  assert.equal(dry.code,0);
  assert.match(dry.stdout,/"sync_preview"/);
  assert.equal(received.length,0);
 });
 const first=await run();
 check("First synchronization sends one manual time entry with stable IDs",()=>{
  assert.equal(first.code,0,first.stderr);
  assert.equal(received.length,1);
  const e=received[0].body;
  assert.equal(e.schemaVersion,1);assert.equal(e.sourceInstance,"planering-ci");
  assert.equal(e.sourceEntryId,"22");assert.equal(e.sourceEventId,"1");
  assert.equal(e.sourceVersion,1);assert.equal(e.operation,"upsert");
  assert.equal(e.employee.email,"role-ci@example.se");assert.equal(e.project.code,"P-1042");
  assert.equal(e.activity.code,"A-42");assert.equal(e.durationSeconds,3600);
  assert.equal(e.workDate,"2026-11-03");
  assert.equal(received[0].key,"planering:planering-ci:22:1");
 });
 let progress=JSON.parse(await readFile(state,"utf8"));
 check("Checkpoint advances only after successful 2xx acknowledgement",()=>{
  assert.equal(progress.lastEventId,1);
  assert.equal(progress.sourceInstance,"planering-ci");
 });
 const second=await run();
 check("Repeated synchronization without changes does not send duplicates",()=>{
  assert.equal(second.code,0,second.stderr);
  assert.equal(received.length,1);
 });
 db.exec(`UPDATE time_entries SET duration_seconds=5400,note='Efterhandskorrigerad',updated_at=1793697400 WHERE id=22;
 INSERT INTO time_entry_audit VALUES(2,22,'update',1793697400);`);
 const third=await run();
 check("Adjusted time has same source entry ID but newer event version",()=>{
  assert.equal(third.code,0,third.stderr);
  assert.equal(received.length,2);
  assert.equal(received[1].body.sourceEntryId,"22");
  assert.equal(received[1].body.sourceVersion,2);
  assert.equal(received[1].body.durationSeconds,5400);
  assert.equal(received[1].body.note,"Efterhandskorrigerad");
 });
 db.exec(`UPDATE time_entries SET deleted_at=1793698000,updated_at=1793698000 WHERE id=22;
 INSERT INTO time_entry_audit VALUES(3,22,'delete',1793698000);`);
 const fourth=await run();
 check("Soft deletion sends an idempotent tombstone",()=>{
  assert.equal(fourth.code,0,fourth.stderr);
  assert.equal(received.length,3);
  assert.equal(received[2].body.operation,"delete");
  assert.equal(received[2].body.sourceVersion,3);
  assert.equal(received[2].body.durationSeconds,null);
 });
 db.exec(`INSERT INTO time_entries(id,employee_id,activity_id,work_date,started_at,ended_at,duration_seconds,note,source,updated_at,deleted_at) VALUES(23,7,12,'2026-11-04',1793779200,1793781000,1800,'Ny post','timer',1793781000,NULL);
 INSERT INTO time_entry_audit VALUES(4,23,'start',1793779200);
 INSERT INTO time_entry_audit VALUES(5,23,'stop',1793781000);`);
 forceFailure=true;
 const failed=await run();
 const checkpointAfterFailure=JSON.parse(await readFile(state,"utf8"));
 check("HTTP 503 keeps the last successful checkpoint, never drops hours",()=>{
  assert.notEqual(failed.code,0);
  assert.match(failed.stderr,/HTTP 503/);
  assert.equal(checkpointAfterFailure.lastEventId,3);
 });
 forceFailure=false;
 const recovered=await run();
 const checkpointAfterRetry=JSON.parse(await readFile(state,"utf8"));
 check("A later run retries pending entry and skips start-only audit event",()=>{
  assert.equal(recovered.code,0,recovered.stderr);
  assert.equal(received.length,4);
  assert.equal(received[3].body.sourceEntryId,"23");
  assert.equal(received[3].body.sourceVersion,5);
  assert.equal(checkpointAfterRetry.lastEventId,5);
 });
 // Crash between 2xx and checkpoint can lead to a replay. The same key is
 // deliberately reused so a conforming Tidrapport receiver deduplicates it.
 await writeFile(state,JSON.stringify({schemaVersion:1,sourceInstance:"planering-ci",lastEventId:3}));
 const replay=await run();
 check("Replay uses identical idempotency key; target can deduplicate",()=>{
  assert.equal(replay.code,0,replay.stderr);
  assert.equal(received.length,5);
  assert.equal(received[4].key,received[3].key);
  assert.equal(seen.size,4);
 });
 // A hard-removed entry is absent from both time_entries and time_entry_audit,
 // but an immutable tombstone MUST still reach the external receiver.
 db.exec(`DELETE FROM time_entry_audit WHERE time_entry_id=23;
 DELETE FROM time_entries WHERE id=23;
 INSERT INTO time_entry_removal_archive VALUES(6,23,7,'role-ci@example.se','CI Medarbetare',11,'P-1042',
  'Controller modernisering',12,'A-42','Integrationstest aktivitet',
  '2026-11-04',1793779200,1793781000,1800,'Ny post','timer',1793782000,1793782000);`);
 await writeFile(state,JSON.stringify({schemaVersion:1,sourceInstance:"planering-ci",lastEventId:5}));
 const erased=await run();
 const erasedState=JSON.parse(await readFile(state,"utf8"));
 check("Hard-deleted source time sends durable tombstone from independent archive",()=>{
  assert.equal(erased.code,0,erased.stderr);
  assert.equal(received.at(-1).body.operation,"delete");
  assert.equal(received.at(-1).body.sourceEntryId,"23");
  assert.equal(received.at(-1).body.sourceVersion,6);
  assert.equal(erasedState.lastEventId,6);
 });
 db.exec(`INSERT INTO employees(id,name,email,is_group_ledger) VALUES(8,'Borttagen medarbetare','deleted-group-42@internal.invalid',1);
 INSERT INTO time_entries(id,employee_id,activity_id,work_date,started_at,ended_at,duration_seconds,note,source,updated_at,deleted_at,reporting_group_id,reporting_group_name)
 VALUES(24,8,12,'2026-11-05',1793865600,1793869200,3600,'Gruppens arbete','manual',1793869200,NULL,42,'Teknikgruppen');
 INSERT INTO time_entry_audit VALUES(7,24,'manual',1793869200);`);
 const groupRun=await run();
 check("Group-held historical time syncs without former person name, email or employee ID",()=>{
  assert.equal(groupRun.code,0,groupRun.stderr);
  const body=received.at(-1).body;
  assert.equal(body.sourceEntryId,"24");
  assert.equal(body.operation,"upsert");
  assert.equal(body.employee,null);
  assert.deepEqual(body.group,{sourceId:42,name:"Teknikgruppen"});
  assert.ok(!JSON.stringify(body).includes("deleted-group-"));
 });
 const mismatched=await run({TIDRAPPORT_SYNC_INSTANCE:"wrong-instance"});
 check("Checkpoint cannot be accidentally reused for another Planering instance",()=>{
  assert.notEqual(mismatched.code,0);
  assert.match(mismatched.stderr,/different instance/);
 });
 const forbiddenPlaintext=await run({TIDRAPPORT_SYNC_ENDPOINT:"http://example.com/incoming"});
 check("Credentials are not sent over plaintext to non-loopback hosts",()=>{
  assert.notEqual(forbiddenPlaintext.code,0);
  assert.match(forbiddenPlaintext.stderr,/HTTPS/);
 });
 db.close();
 console.log(`SUCCESS tidrapport-sync: ${checks} isolated tests passed; no real Tidrapport or production data was touched.`);
}catch(error){
 fail=true;
 console.error("FAILED tidrapport-sync:",error);
}finally{
 server.close();
 await rm(root,{recursive:true,force:true});
 console.log("Cleaned up isolated Tidrapport sync test data",root);
}
if(fail)process.exitCode=1;
