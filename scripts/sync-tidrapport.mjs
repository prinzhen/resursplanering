#!/usr/bin/env node
/**
 * Outbound Tidrapport sync adapter.
 *
 * IMPORTANT: This sends a documented JSON contract to a receiver that must
 * implement idempotent upsert/delete. It does not assume Tidrapport currently
 * implements that contract. Never enable until its API has been verified.
 *
 * Data source: the local D1 SQLite DB, opened READ ONLY. Checkpoint: a separate
 * JSON file updated atomically ONLY after a successful remote 2xx response.
 * The immutable time_entry_audit.id provides ordered, retry-safe event versions.
 *
 * Env:
 *   PLANERING_DATA_DIR        REQUIRED, e.g. /var/lib/resursplanering-test-access/data
 *   TIDRAPPORT_SYNC_ENDPOINT  REQUIRED, exact receiving API URL (HTTPS normally)
 *   TIDRAPPORT_SYNC_TOKEN     REQUIRED, bearer token from the receiving service
 *   TIDRAPPORT_SYNC_INSTANCE  REQUIRED, stable unique Planering installation ID
 *   TIDRAPPORT_SYNC_STATE     REQUIRED, durable JSON state outside source directory
 *   TIDRAPPORT_SYNC_ENABLED   must be exactly 'yes' to transmit
 *   TIDRAPPORT_SYNC_DRY_RUN   'yes' to preview without POST or changing checkpoint
 *   TIDRAPPORT_SYNC_LIMIT     optional 1..500, default 100
 *   TIDRAPPORT_SYNC_TIMEOUT_MS optional 1000..120000, default 15000
 *
 * Run under flock to prevent concurrent sync jobs; e.g. systemd service example.
 */
import {DatabaseSync} from "node:sqlite";
import {readdir,readFile,writeFile,rename,mkdir,unlink,open as openFile} from "node:fs/promises";
import {dirname,join,resolve} from "node:path";

const str=(v)=>typeof v==="string"?v.trim():"";
const requireEnv=(name)=>{
 const v=str(process.env[name]);
 if(!v)throw Error("Missing required environment variable: "+name);
 return v;
};
const requiredInteger=(value,def,max,min=1)=>{
 if(!str(value))return def;
 const parsed=Number(value);
 if(!Number.isSafeInteger(parsed)||parsed<min||parsed>max)throw Error("Invalid integer setting");
 return parsed;
};
async function findDatabase(root){
 const list=[];
 async function walk(dir){
  for(const e of await readdir(dir,{withFileTypes:true})){
   const full=join(dir,e.name);
   if(e.isDirectory())await walk(full);
   else if(e.isFile()&&e.name.endsWith(".sqlite")&&e.name!=="metadata.sqlite")list.push(full);
  }
 }
 await walk(resolve(root));
 if(list.length!==1)throw Error("Expected exactly one application SQLite database; found "+list.length+". Refusing unsafe selection.");
 return list[0];
}
async function readState(path,instance){
 let state;
 try{state=JSON.parse(await readFile(path,"utf8"))}
 catch(e){if(e?.code==="ENOENT")return 0;throw Error("Cannot read checkpoint state safely: "+e.message)}
 if(state.schemaVersion!==1||state.sourceInstance!==instance||!Number.isSafeInteger(state.lastEventId)||state.lastEventId<0)
  throw Error("Checkpoint belongs to a different instance or is corrupt. Refusing to resync or overwrite it.");
 return state.lastEventId;
}
async function persistState(path,instance,lastEventId){
 const directory=dirname(path);
 await mkdir(directory,{recursive:true,mode:0o700});
 const temporary=path+".tmp-"+process.pid;
 let exists=false;
 try{
  const handle=await openFile(temporary,"wx",0o600);
  exists=true;
  try{
   await handle.writeFile(JSON.stringify({schemaVersion:1,sourceInstance:instance,lastEventId})+"\n","utf8");
   await handle.sync();
  }finally{await handle.close()}
  await rename(temporary,path);
  exists=false;
 }finally{
  if(exists)await unlink(temporary).catch(()=>{});
 }
}
const sql=`
 SELECT * FROM (
  SELECT j.id eventId,j.action,j.changed_at eventTime,
   t.id entryId,t.employee_id employeeId,t.activity_id activityId,t.work_date workDate,
   t.started_at startedAt,t.ended_at endedAt,t.duration_seconds durationSeconds,
   t.note,t.source,t.updated_at updatedAt,t.deleted_at deletedAt,
   CASE WHEN e.is_group_ledger=1 THEN NULL ELSE e.email END employeeEmail,
   CASE WHEN e.is_group_ledger=1 THEN NULL ELSE e.name END employeeName,
   t.reporting_group_id groupId,t.reporting_group_name groupName,
   a.code activityCode,a.name activityName,a.project_id projectId,
   p.code projectCode,p.name projectName
  FROM time_entry_audit j
  JOIN time_entries t ON t.id=j.time_entry_id
  JOIN employees e ON e.id=t.employee_id
  JOIN activities a ON a.id=t.activity_id
  JOIN projects p ON p.id=a.project_id
  WHERE j.action IN ('stop','manual','update','delete')
  UNION ALL
  -- An administrator may permanently erase a time entry to remove a project.
  -- Its original row and audit records no longer exist, but this durable
  -- tombstone MUST still reach the receiver with its original stable entry ID.
  SELECT r.source_event_id eventId,'delete' action,r.removed_at eventTime,
   r.original_entry_id entryId,r.employee_id employeeId,
   r.original_activity_id activityId,r.work_date workDate,
   r.started_at startedAt,r.ended_at endedAt,r.duration_seconds durationSeconds,
   r.note,r.source,r.updated_at updatedAt,r.removed_at deletedAt,
   r.employee_email employeeEmail,r.employee_name employeeName,
   NULL groupId,NULL groupName,
   r.original_activity_code activityCode,r.original_activity_name activityName,
   r.original_project_id projectId,r.original_project_code projectCode,
   r.original_project_name projectName
  FROM time_entry_removal_archive r
 )
 WHERE eventId>? ORDER BY eventId ASC LIMIT ?`;
const makePayload=(row,instance)=>{
 // Tombstone is based on CURRENT row state, not an earlier event snapshot.
 // The receiver applies only the greatest version per sourceEntryId.
 const deleted=row.deletedAt!==null||row.action==="delete";
 if(!deleted&&(!Number.isSafeInteger(row.durationSeconds)||row.durationSeconds<0))
  throw Error("Invalid duration in time entry "+row.entryId);
 return {
  schemaVersion:1,
  sourceSystem:"planering",
  sourceInstance:instance,
  sourceEntryId:String(row.entryId),
  sourceEventId:String(row.eventId),
  sourceVersion:row.eventId,
  operation:deleted?"delete":"upsert",
  employee:row.groupId!==null?null:
   {sourceId:row.employeeId,email:row.employeeEmail||null,name:row.employeeName||null},
  group:row.groupId!==null?{sourceId:row.groupId,name:row.groupName}:null,
  project:{sourceId:row.projectId,code:row.projectCode,name:row.projectName},
  activity:{sourceId:row.activityId,code:row.activityCode,name:row.activityName},
  workDate:row.workDate,
  durationSeconds:deleted?null:row.durationSeconds,
  note:deleted?null:row.note,
  origin:row.source,
  startedAtUtc:new Date(row.startedAt*1000).toISOString(),
  endedAtUtc:row.endedAt===null?null:new Date(row.endedAt*1000).toISOString(),
  updatedAtUtc:new Date(row.updatedAt*1000).toISOString(),
  eventTimeUtc:new Date(row.eventTime*1000).toISOString()
 };
};
const jsonLog=(event,data)=>console.log(JSON.stringify({event,...data}));
async function main(){
 const dataDir=requireEnv("PLANERING_DATA_DIR");
 const instance=requireEnv("TIDRAPPORT_SYNC_INSTANCE");
 if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,63}$/.test(instance))
  throw Error("Instance must be 3–64 alphanumeric, '-' or '_' characters");
 const statePath=resolve(requireEnv("TIDRAPPORT_SYNC_STATE"));
 const dry=process.env.TIDRAPPORT_SYNC_DRY_RUN==="yes";
 const limit=requiredInteger(process.env.TIDRAPPORT_SYNC_LIMIT,100,500);
 const timeout=requiredInteger(process.env.TIDRAPPORT_SYNC_TIMEOUT_MS,15000,120000,1000);
 if(!dry&&process.env.TIDRAPPORT_SYNC_ENABLED!=="yes")
  throw Error("Not enabled: TIDRAPPORT_SYNC_ENABLED must equal 'yes'. No data transmitted.");
 let endpoint=null,token=null;
 if(!dry){
  endpoint=new URL(requireEnv("TIDRAPPORT_SYNC_ENDPOINT"));
  // TLS required for credentials, except explicit local test receivers.
  const loopback=["127.0.0.1","localhost","[::1]"].includes(endpoint.hostname);
  if(endpoint.protocol!=="https:"&&!(loopback&&endpoint.protocol==="http:"))
   throw Error("Tidrapport endpoint must use HTTPS, unless it is loopback.");
  if(endpoint.username||endpoint.password||endpoint.hash)throw Error("Endpoint URL must not contain credentials or a fragment.");
  token=requireEnv("TIDRAPPORT_SYNC_TOKEN");
  if(token.length<16)throw Error("Tidrapport API bearer token must have at least 16 characters.");
 }
 const databasePath=await findDatabase(dataDir);
 if(statePath===databasePath||statePath.startsWith(resolve(dataDir)+"/"))
  throw Error("Checkpoint must be outside the application database folder.");
 let cursor=await readState(statePath,instance);
 const db=new DatabaseSync(databasePath,{readOnly:true});
 let sent=0,checked=0;
 try{
  const exists=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='time_entry_audit'").get();
  if(!exists)throw Error("Migration 0014 has not been applied; no audit queue is available.");
  const rows=db.prepare(sql).all(cursor,limit);
  checked=rows.length;
  jsonLog("sync_start",{sourceInstance:instance,checkpoint:cursor,pendingBatch:rows.length,dryRun:dry});
  for(const row of rows){
   const payload=makePayload(row,instance);
   if(dry){
    jsonLog("sync_preview",{sourceEntryId:payload.sourceEntryId,sourceVersion:payload.sourceVersion,operation:payload.operation});
    continue;
   }
   const idempotencyKey=`planering:${instance}:${row.entryId}:${row.eventId}`;
   let response;
   try{
    response=await fetch(endpoint,{
     method:"POST",
     headers:{
      "authorization":"Bearer "+token,
      "content-type":"application/json",
      "accept":"application/json",
      "idempotency-key":idempotencyKey,
      "x-planering-source":instance
     },
     body:JSON.stringify(payload),
     redirect:"error",
     signal:AbortSignal.timeout(timeout)
    });
   }catch(error){
    throw Error(`Network failure at event ${row.eventId} (checkpoint ${cursor}): ${error.message}`);
   }
   if(!response.ok){
    // Never log response body: receiver may accidentally echo secrets.
    await response.body?.cancel().catch(()=>{});
    throw Error(`Tidrapport rejected event ${row.eventId} with HTTP ${response.status}; last confirmed checkpoint is ${cursor}`);
   }
   await response.body?.cancel().catch(()=>{});
   // Acknowledged 2xx: immediately commit progress. Replays are possible on
   // crash between 2xx and checkpoint; receiver must implement idempotency.
   await persistState(statePath,instance,row.eventId);
   cursor=row.eventId;
   sent++;
  }
  jsonLog("sync_ok",{sourceInstance:instance,checkpoint:cursor,eventsSent:sent,eventsChecked:checked,dryRun:dry});
 }finally{db.close()}
}
main().catch(error=>{
 console.error("TIDRAPPORT_SYNC_ERROR:",error.message);
 process.exitCode=1;
});
