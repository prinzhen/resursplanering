import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp,rm,readdir,cp} from "node:fs/promises";
import {DatabaseSync} from "node:sqlite";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";

const dir=await mkdtemp(join(tmpdir(),"resursplanering-e2e-"));
if(process.env.TEST_DATA_SOURCE){await cp(process.env.TEST_DATA_SOURCE,join(dir,"data"),{recursive:true});console.log("Testing disposable COPY of existing SQLite data:",process.env.TEST_DATA_SOURCE)}
const port=32137,base=`http://127.0.0.1:${port}`;
const server=spawn(process.execPath,["scripts/start-selfhosted.mjs"],{
 cwd:process.cwd(),env:{...process.env,DATA_DIR:join(dir,"data"),HOST:"127.0.0.1",PORT:String(port),CI:"true",NO_COLOR:"1"},
 detached:true,stdio:["ignore","pipe","pipe"]
});
let logs="";
for(const stream of [server.stdout,server.stderr])stream.on("data",chunk=>{logs+=String(chunk);if(logs.length>60000)logs=logs.slice(-60000)});
const request=async(path="/api/data",payload)=>{
 const options=payload===undefined?{}:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)};
 const res=await fetch(base+path,options);
 const raw=await res.text();let data;
 try{data=JSON.parse(raw)}catch{throw Error(`Non-JSON HTTP ${res.status} ${raw.slice(0,800)}`)}
 if(!res.ok)throw Error(`HTTP ${res.status} ${path}: ${JSON.stringify(data)}`);
 return data;
};
async function findSqlite(root){
 const found=[];
 async function visit(folder){
  for(const entry of await readdir(folder,{withFileTypes:true})){
   const path=join(folder,entry.name);
   if(entry.isDirectory())await visit(path);
   else if(entry.name.endsWith(".sqlite")&&entry.name!=="metadata.sqlite")found.push(path);
  }
 }
 await visit(root);
 assert.equal(found.length,1,"Expected exactly one isolated D1 application database");
 return found[0];
}
const check=(label,fn)=>{fn();console.log("PASS",label)};
const assignment=(snap,aid,eid)=>snap.assignments.find(a=>a.activityId===aid&&a.employeeId===eid);
const activity=(snap,aid)=>snap.activities.find(a=>a.id===aid);
const person=(snap,name)=>snap.employees.find(e=>e.name===name).id;
const sheet=async(email)=>request("/api/individual?email="+encodeURIComponent(email));
try{
 let ready=false;
 for(let i=0;i<90;i++){
  if(server.exitCode!==null)throw Error("Wrangler stopped during startup: "+server.exitCode);
  try{let r=await fetch(base+"/api/data",{signal:AbortSignal.timeout(1000)});if(r.ok){ready=true;break}}catch{}
  await sleep(1000);
 }
 if(!ready)throw Error("Selfhosted API did not start in 90 seconds. Logs:\n"+logs.slice(-12000));
 console.log("Fresh test instance started with isolated SQLite at",dir);
 let snap=await request();
 const erik=person(snap,"Erik Holm"),sara=person(snap,"Sara Berg");
 assert.ok(erik&&sara);
 const ass=assignment(snap,1,erik),saraAss=assignment(snap,1,sara);
 const originalEndErik=ass.endDate,originalEndSara=saraAss.endDate;
 check("Fixture has shared assignment",()=>{assert.ok(ass&&saraAss);assert.ok(ass.effortPercent>=0);assert.ok(saraAss.effortPercent>=0)});
 snap=await request("/api/data",{action:"setActivityStatus",activityId:1,status:"Klar"});
 check("Global completion closes both employees",()=>{
  assert.equal(activity(snap,1).status,"Klar");
  assert.equal(assignment(snap,1,erik).workStatus,"Klar");
  assert.ok(assignment(snap,1,erik).completedAt);
  assert.ok(assignment(snap,1,sara).completedAt);
 });
 const firstCompletion=assignment(snap,1,erik).completedAt,firstCloseEnd=assignment(snap,1,erik).endDate;
 snap=await request("/api/data",{action:"setActivityStatus",activityId:1,status:"Klar"});
 check("Repeating full completion is idempotent",()=>{
  assert.equal(assignment(snap,1,erik).completedAt,firstCompletion);
  assert.equal(assignment(snap,1,erik).endDate,firstCloseEnd);
 });
 snap=await request("/api/data",{action:"setActivityStatus",activityId:1,status:"Pågående"});
 check("Reopening global task restores each employee's planning period",()=>{
  assert.equal(activity(snap,1).status,"Pågår");
  assert.equal(assignment(snap,1,erik).completedAt,null);
  assert.equal(assignment(snap,1,sara).completedAt,null);
  assert.equal(assignment(snap,1,erik).endDate,originalEndErik);
  assert.equal(assignment(snap,1,sara).endDate,originalEndSara);
 });
 snap=await request("/api/data",{action:"setActivityStatus",activityId:1,status:"Fryst"});
 check("Freezing task updates all resources but preserves dates",()=>{
  assert.equal(activity(snap,1).status,"Fryst");
  assert.equal(assignment(snap,1,erik).workStatus,"Fryst");
  assert.equal(assignment(snap,1,sara).workStatus,"Fryst");
  assert.equal(assignment(snap,1,erik).endDate,originalEndErik);
 });
 snap=await request("/api/data",{action:"setAssignmentStatus",activityId:1,employeeId:erik,status:"Pågående"});
 check("Individual return to work leaves colleague frozen",()=>{
  assert.equal(assignment(snap,1,erik).workStatus,"Pågående");
  assert.equal(assignment(snap,1,sara).workStatus,"Fryst");
  assert.equal(activity(snap,1).status,"Pågår");
 });
 snap=await request("/api/data",{action:"setAssignmentStatus",activityId:1,employeeId:erik,status:"Klar"});
 check("Individual completion does not close active shared activity",()=>{
  assert.ok(assignment(snap,1,erik).completedAt);
  assert.equal(assignment(snap,1,sara).completedAt,null);
  assert.equal(activity(snap,1).status,"Fryst");
 });
 let exported=await sheet("erik@example.se");
 check("Closed row still appears in Excel API export",()=>{
  assert.equal(exported.activities.find(a=>a.name==="Systemdesign")?.status,"Klar");
  assert.ok(exported.activities.some(a=>a.name==="Detaljprojektering"));
 });
 const file1=structuredClone(exported);
 const row=file1.activities.find(a=>a.name==="Systemdesign");
 row.status="Pågående";
 let receipt=await request("/api/individual",file1);
 check("Excel import reopens previously completed employee allocation",()=>{
  assert.ok(receipt.updated>=1);
 });
 snap=await request();
 check("Latest import restores active employee",()=>{
  assert.equal(assignment(snap,1,erik).workStatus,"Pågående");
  assert.equal(assignment(snap,1,erik).completedAt,null);
  assert.equal(assignment(snap,1,sara).workStatus,"Fryst");
 });
 const fake={
  name:"Erik Holm",email:"erik@example.se",members:[],
  activities:[{
   uid:"",week:"2027 v.03",firstWeek:"2027 v.03",
   name:"API integration row",kind:"Projekt",projectCode:"P-1042",
   hours:20,status:"Planerad",comment:"E2E"
  }]
 };
 const count=snap.activities.length;
 receipt=await request("/api/individual",fake);
 check("New spreadsheet activity creates a project activity and assignment",()=>{
  assert.equal(receipt.created,1);
 });
 receipt=await request("/api/individual",fake);
 check("Reimporting same old workbook without IDs does not create duplicate",()=>{
  assert.equal(receipt.created,0);
  assert.equal(receipt.updated,1);
 });
 snap=await request();
 check("No duplicate activity and 50% allocated for 20 hours",()=>{
  assert.equal(snap.activities.length,count+1);
  const a=snap.activities.find(x=>x.name==="API integration row");
  assert.ok(a);
  assert.equal(assignment(snap,a.id,erik).effortPercent,50);
 });
 exported=await sheet("erik@example.se");
 check("Subsequent export includes newly imported and closed rows",()=>{
  assert.ok(exported.activities.some(x=>x.name==="API integration row"));
  assert.ok(exported.activities.some(x=>x.name==="Systemdesign"));
 });
 receipt=await request("/api/individual",{...file1,activities:file1.activities.slice(0,1)});
 check("Partial import does not delete missing activity assignments",()=>{
  assert.equal(receipt.updated,1);
 });
 snap=await request();
 check("All original assignments survive partial imports",()=>{
  assert.ok(assignment(snap,2,erik));assert.ok(assignment(snap,4,erik));
  assert.equal(snap.activities.length,count+1);
 });
 snap=await request("/api/data",{action:"setActivityAssignments",activityId:1,
  resources:[{employeeId:sara,effortPercent:40}]});
 check("Activity staffing editor removes one resource but retains other",()=>{
  assert.equal(assignment(snap,1,erik),undefined);
  assert.ok(assignment(snap,1,sara));
 });
 snap=await request("/api/data",{action:"setActivityAssignments",activityId:1,
  resources:[{employeeId:sara,effortPercent:40},{employeeId:erik,effortPercent:50}]});
 check("Activity staffing editor can add resource back",()=>{
  assert.ok(assignment(snap,1,erik));
  assert.equal(assignment(snap,1,erik).effortPercent,50);
 });
 snap=await request("/api/data",{action:"setAssignmentStatus",activityId:1,employeeId:erik,status:"Pausad"});
 check("Individual Pausad status is preserved for only that resource",()=>{
  assert.equal(assignment(snap,1,erik).workStatus,"Pausad");
  assert.notEqual(assignment(snap,1,sara).workStatus,"Pausad");
  assert.equal(assignment(snap,1,erik).completedAt,null);
 });
 snap=await request("/api/data",{action:"setAssignmentStatus",activityId:1,employeeId:erik,status:"Pågående"});
 check("Resuming individual paused work restores active status",()=>{
  assert.equal(assignment(snap,1,erik).workStatus,"Pågående");
  assert.equal(assignment(snap,1,erik).completedAt,null);
 });
 const initialFuture=assignment(snap,4,erik),endFuture=initialFuture.endDate;
 snap=await request("/api/data",{action:"setAssignmentStatus",activityId:4,employeeId:erik,status:"Klar"});
 check("Completing future assignment does not corrupt its date interval",()=>{
  const updated=assignment(snap,4,erik);
  assert.ok(updated.completedAt);
  assert.ok(updated.endDate>=updated.startDate);
  assert.equal(assignment(snap,4,4).completedAt,null);
 });
 snap=await request("/api/data",{action:"setAssignmentStatus",activityId:4,employeeId:erik,status:"Planerad"});
 check("Reopening future work restores its original end date",()=>{
  const updated=assignment(snap,4,erik);
  assert.equal(updated.completedAt,null);
  assert.equal(updated.endDate,endFuture);
 });
 // Independently editable percentages and dates for each individual period.
 const originalProject=activity(snap,1),originalSara=assignment(snap,1,sara);
 const custom=[
  {startDate:"2026-09-01",endDate:"2026-09-30",effortPercent:25},
  {startDate:"2026-10-01",endDate:"2026-10-31",effortPercent:50},
  {startDate:"2026-11-01",endDate:"2026-12-18",effortPercent:75}
 ];
 snap=await request("/api/data",{action:"setAssignmentPeriods",activityId:1,employeeId:erik,periods:custom});
 const erikId=assignment(snap,1,erik).id;
 check("Three dated percentage periods persist independently",()=>{
  const p=snap.assignmentPeriods.filter(x=>x.assignmentId===erikId);
  assert.equal(p.length,3);
  assert.deepEqual(p.map(x=>x.effortPercent),[25,50,75]);
  assert.equal(activity(snap,1).startDate,originalProject.startDate);
  assert.equal(activity(snap,1).endDate,originalProject.endDate);
  assert.equal(assignment(snap,1,sara).startDate,originalSara.startDate);
 });
 const modified=custom.map((x,i)=>i===0?{...x,effortPercent:40}:x);
 snap=await request("/api/data",{action:"setAssignmentPeriods",activityId:1,employeeId:erik,periods:modified});
 check("Historical period percentage is editable without modifying future",()=>{
  const p=snap.assignmentPeriods.filter(x=>x.assignmentId===erikId);
  assert.deepEqual(p.map(x=>x.effortPercent),[40,50,75]);
 });
 const bad=await fetch(base+"/api/data",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"setAssignmentPeriods",activityId:1,employeeId:erik,periods:[{startDate:"2026-11-01",endDate:"2026-12-01",effortPercent:50},{startDate:"2026-11-15",endDate:"2026-12-18",effortPercent:100}]})});
 check("Overlapping periods rejected without changing saved data",()=>{assert.equal(bad.status,400)});
 snap=await request();
 check("Rejected overlap left all three periods unchanged",()=>{
  assert.deepEqual(snap.assignmentPeriods.filter(x=>x.assignmentId===erikId).map(x=>x.effortPercent),[40,50,75]);
 });
 const move=[{startDate:"2026-09-01",endDate:"2026-09-30",effortPercent:20},
 {startDate:"2026-10-10",endDate:"2026-10-20",effortPercent:80},
 {startDate:"2027-02-01",endDate:"2027-04-30",effortPercent:60}];
 snap=await request("/api/data",{action:"setAssignmentPeriods",activityId:1,employeeId:erik,periods:move});
 check("Resource periods can contain gaps and extend beyond project dates",()=>{
  const p=snap.assignmentPeriods.filter(x=>x.assignmentId===erikId);
  assert.equal(p[1].startDate,"2026-10-10");
  assert.equal(p[2].endDate,"2027-04-30");
  assert.equal(assignment(snap,1,erik).endDate,"2027-04-30");
  assert.equal(activity(snap,1).endDate,originalProject.endDate);
 });
 // Staff quick editor must not flatten custom effort periods.
 const quick=await fetch(base+"/api/data",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"setActivityAssignments",activityId:1,resources:[{employeeId:erik,effortPercent:99},{employeeId:sara,effortPercent:40}]})});
 check("Quick staffing refuses to flatten multiple customized periods",()=>{assert.equal(quick.status,400)});
 snap=await request();
 check("Quick-staff rejection preserves per-period percentages",()=>{
  assert.deepEqual(snap.assignmentPeriods.filter(x=>x.assignmentId===erikId).map(x=>x.effortPercent),[20,80,60]);
 });
 // Inspect the real SQLite state independently of API serialization.
 const sqliteFile=await findSqlite(join(dir,"data"));
 const sql=new DatabaseSync(sqliteFile,{readOnly:true});
 try{
  check("SQLite PRAGMA integrity_check",()=>{
   assert.equal(sql.prepare("PRAGMA integrity_check").get().integrity_check,"ok");
  });
  check("SQLite has no foreign key violations",()=>{
   assert.equal(sql.prepare("PRAGMA foreign_key_check").all().length,0);
  });
  check("SQLite has exactly one copy of the twice-imported task",()=>{
   assert.equal(sql.prepare("SELECT COUNT(*) count FROM activities WHERE name=?").get("API integration row").count,1);
  });
  check("SQLite records successful import batches",()=>{
   assert.ok(sql.prepare("SELECT COUNT(*) count FROM individual_import_runs WHERE employee_id=?").get(erik).count>=4);
  });
  check("SQLite stores original end date for reopened allocations",()=>{
   const rows=sql.prepare("SELECT original_end_date originalEnd,completed_at completedAt FROM assignments WHERE activity_id=? AND employee_id=?").get(1,erik);
   assert.ok(rows.originalEnd);
   assert.equal(rows.completedAt,null);
  });
 }finally{sql.close()}
 console.log("\nSUCCESS: integration tests passed; only isolated temp database was modified.");
}catch(err){
 console.error("\nFAILED:",err);
 console.error("Server log tail:\n",logs.slice(-10000));
 process.exitCode=1;
}finally{
 try{process.kill(-server.pid,"SIGTERM")}catch{server.kill("SIGTERM")}
 await sleep(1100);
 try{process.kill(-server.pid,"SIGKILL")}catch{}
 await rm(dir,{recursive:true,force:true});
 console.log("Cleaned up isolated database",dir);
}
