import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";

const dir=await mkdtemp(join(tmpdir(),"resursplanering-e2e-"));
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
 check("Fixture has shared assignment",()=>{assert.equal(ass.effortPercent,50);assert.equal(saraAss.effortPercent,40)});
 snap=await request("/api/data",{action:"setActivityStatus",activityId:1,status:"Klar"});
 check("Global completion closes both employees",()=>{
  assert.equal(activity(snap,1).status,"Klar");
  assert.equal(assignment(snap,1,erik).workStatus,"Klar");
  assert.ok(assignment(snap,1,erik).completedAt);
  assert.ok(assignment(snap,1,sara).completedAt);
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
