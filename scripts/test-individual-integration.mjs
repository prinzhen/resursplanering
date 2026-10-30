import assert from "node:assert/strict";
import {spawn,spawnSync} from "node:child_process";
import {mkdtemp,rm,readdir,cp} from "node:fs/promises";
import {DatabaseSync} from "node:sqlite";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";

const dir=await mkdtemp(join(tmpdir(),"resursplanering-e2e-"));
if(process.env.TEST_DATA_SOURCE){await cp(process.env.TEST_DATA_SOURCE,join(dir,"data"),{recursive:true});console.log("Testing disposable COPY of existing SQLite data:",process.env.TEST_DATA_SOURCE)}
const port=32137,base=`http://127.0.0.1:${port}`;
let sessionCookie="";
const originalFetch=globalThis.fetch;
globalThis.fetch=(input,init={})=>{
 const url=typeof input==="string"?input:input instanceof URL?String(input):input.url;
 if(url.startsWith(base)&&sessionCookie){
  const headers=new Headers(init.headers);headers.set("cookie",sessionCookie);
  return originalFetch(input,{...init,headers});
 }
 return originalFetch(input,init);
};

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
  try{let r=await fetch(base+"/api/auth",{signal:AbortSignal.timeout(1000)});if(r.ok){ready=true;break}}catch{}
  await sleep(1000);
 }
 if(!ready)throw Error("Selfhosted API did not start in 90 seconds. Logs:\n"+logs.slice(-12000));
 console.log("Fresh test instance started with isolated SQLite at",dir);
 // Provision a real administrator using the same offline CLI as deployment.
 const adminPassword="SampleAdminPassphrase-2026!";
 const provision=spawnSync("python3",["scripts/provision-account.py","--data-dir",join(dir,"data"),"--email","ci-admin@example.se","--admin","--password-stdin"],{input:adminPassword+"\n",encoding:"utf8"});
 if(provision.status!==0)throw Error("Admin provisioning failed: "+provision.stderr+" "+provision.stdout);
 const anon=await fetch(base+"/api/data");
 check("Anonymous planning API is protected",()=>assert.equal(anon.status,401));
 const auth=await fetch(base+"/api/auth",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"login",email:"ci-admin@example.se",password:adminPassword})});
 if(!auth.ok)throw Error("Admin login failed: "+await auth.text());
 sessionCookie=(auth.headers.get("set-cookie")||"").split(";")[0];
 check("Admin login sets an HttpOnly session cookie",()=>{assert.match(sessionCookie,/^rp_session=/);assert.match(auth.headers.get("set-cookie"),/HttpOnly/);});

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
 const globalStart="2026-09-07",globalEnd="2026-12-22";
 snap=await request("/api/data",{action:"updateActivity",id:1,projectId:1,workPackageId:"",parentActivityId:"",code:"A-10",name:"Systemdesign",description:"Automatiskt test av global period",startDate:globalStart,endDate:globalEnd,estimatedHours:420,status:"Pågår"});
 check("Editing overall project start/end dates updates the activity",()=>{
  assert.equal(activity(snap,1).startDate,globalStart);
  assert.equal(activity(snap,1).endDate,globalEnd);
 });
 check("Project date edit moves only single-period resources matching old project period",()=>{
  const saras=snap.assignmentPeriods.filter(x=>x.assignmentId===assignment(snap,1,sara).id);
  assert.equal(saras.length,1);
  assert.equal(saras[0].startDate,globalStart);
  assert.equal(saras[0].endDate,globalEnd);
  const eriks=snap.assignmentPeriods.filter(x=>x.assignmentId===erikId);
  assert.equal(eriks.length,3);
  assert.equal(eriks[0].startDate,"2026-09-01");
  assert.equal(eriks[2].endDate,"2027-04-30");
 });
 const backedUp=structuredClone(snap);
 snap=await request("/api/data",{action:"restore",backup:{version:3,data:backedUp}});
 check("Version 3 backup and restore preserve all individual variable periods",()=>{
  assert.deepEqual(snap.assignmentPeriods,backedUp.assignmentPeriods);
  assert.deepEqual(snap.assignments,backedUp.assignments);
  assert.equal(snap.individualFormItems.length,backedUp.individualFormItems.length);
 });
 // Project priority default, employee-specific order, and resetting.
 const sorting=await import("../lib/project-sort.ts");
 const memberIds=[...new Set(snap.projectMembers.filter(m=>m.employeeId===erik).map(m=>m.projectId))];
 snap=await request("/api/data",{action:"setProjectMemberships",employeeId:erik,projectIds:[...new Set([...memberIds,3])]});
 snap=await request("/api/data",{action:"updateProject",id:1,code:"P-1042",name:"Modernisering styrsystem",color:"#2563eb",description:"",status:"Aktivt",priority:2});
 snap=await request("/api/data",{action:"updateProject",id:2,code:"P-1087",name:"Nätverkssegmentering",color:"#0f766e",description:"",status:"Aktivt",priority:1});
 snap=await request("/api/data",{action:"updateProject",id:3,code:"P-1110",name:"Underhållsrevision",color:"#ca8a04",description:"",status:"Aktivt",priority:1});
 const eligible=snap.projects.filter(p=>p.id<=3);
 const ordered=()=>sorting.sortEmployeeProjects(erik,eligible,snap.assignments,snap.activities,snap.employeeProjectOrders).map(p=>p.id);
 check("Default order: assigned projects first; then priority; unassigned projects last",()=>{
  assert.deepEqual(ordered(),[2,1,3]);
 });
 snap=await request("/api/data",{action:"setEmployeeProjectOrder",employeeId:erik,projectIds:[3,1,2]});
 check("Manual order supports inactive projects at the top",()=>{
  assert.deepEqual(ordered(),[3,1,2]);
  assert.equal(snap.employeeProjectOrders.filter(x=>x.employeeId===sara).length,0);
 });
 const dup=await fetch(base+"/api/data",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"setEmployeeProjectOrder",employeeId:erik,projectIds:[1,1,2]})});
 check("Duplicate project IDs are rejected before saving",()=>assert.equal(dup.status,400));
 const customBackup=structuredClone(snap);
 snap=await request("/api/data",{action:"restore",backup:{version:3,data:customBackup}});
 check("Saved employee project ordering survives backup roundtrip",()=>{
  assert.deepEqual(snap.employeeProjectOrders,customBackup.employeeProjectOrders);
  assert.deepEqual(ordered(),[3,1,2]);
  assert.equal(snap.projects.find(p=>p.id===2).priority,1);
 });
 snap=await request("/api/data",{action:"resetEmployeeProjectOrder",employeeId:erik});
 check("Reset restores dynamic project priority and alphabetical default",()=>{
  assert.equal(snap.employeeProjectOrders.filter(x=>x.employeeId===erik).length,0);
  assert.deepEqual(ordered(),[2,1,3]);
 });
 // A narrow 'current weeks' window must not hide all future/historical Gantt work.
 const ganttSource=await (await import("node:fs/promises")).readFile("app/page.tsx","utf8");
 check("Employee Gantt chooses full planning when current four weeks contain no tasks",()=>{
  assert.match(ganttSource,/items\.some\(i=>overlaps\(i\.start,i\.end,initialStart,periodEnd\(initialStart,"4w"\)\)\)\?"4w":"all"/);
 });
 const {ganttState,ganttColor}=await import("../lib/gantt-status.ts");
 check("Gantt status and color helpers work for both screen and print",()=>{
  const active={status:"Pågår",color:"#2563eb"};
  const frozen={status:"Fryst",color:"#2563eb"};
  const paused={status:"Pausad",color:"#2563eb"};
  const completed={status:"Pågående",completedAt:"2026-10-30",color:"#2563eb"};
  assert.equal(ganttState(active),"Pågående");
  assert.equal(ganttColor(active),active.color);
  assert.equal(ganttState(frozen),"Fryst");
  assert.match(ganttColor(frozen),/color-mix/);
  assert.equal(ganttState(paused),"Pausad");
  assert.equal(ganttState(completed),"Klar");
  assert.match(ganttColor(completed),/color-mix/);
 });
 const source=await (await import("node:fs/promises")).readFile("app/page.tsx","utf8");
 check("Both Gantt views import status helpers, preventing browser ReferenceError",()=>{
  assert.match(source,/import\s*\{\s*ganttState\s*,\s*ganttColor\s*\}\s*from\s*["']@\/lib\/gantt-status["']/);
  assert.match(source,/function PrintGantt\(/);
  assert.match(source,/function GanttView\(/);
  assert.equal((source.match(/ganttState\(/g)||[]).length>=3,true);
 });
 // Reusable employee groups and Kanban integration.
 const {kanbanForPeople,kanbanForActivities,normalizeKanbanStatus}=await import("../lib/kanban.ts");
 check("All-person Kanban contains every assignment as its own card",()=>{
  const cards=kanbanForPeople(snap.employees.map(e=>e.id),snap.employees,snap.projects,snap.activities,snap.assignments);
  assert.equal(cards.length,snap.assignments.length);
  assert.equal(new Set(cards.map(c=>c.key)).size,cards.length);
 });
 snap=await request("/api/data",{action:"saveEmployeeGroup",name:"Testgrupp konstruktion",description:"Test av medarbetargrupp",employeeIds:[erik,sara]});
 const group=snap.employeeGroups.find(x=>x.name==="Testgrupp konstruktion");
 check("New group persists members and name",()=>{
  assert.ok(group);
  assert.deepEqual(snap.employeeGroupMembers.filter(x=>x.groupId===group.id).map(x=>x.employeeId).sort((a,b)=>a-b),[erik,sara].sort((a,b)=>a-b));
 });
 const testGroupId=group.id;
 const invalidGroup=await fetch(base+"/api/data",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"saveEmployeeGroup",id:testGroupId,name:"Invalid",description:"",employeeIds:[999999]})});
 check("Group update with unknown employee is rejected",()=>assert.equal(invalidGroup.status,400));
 snap=await request();
 check("Rejected group update preserves name and original members",()=>{
  assert.equal(snap.employeeGroups.find(g=>g.id===testGroupId).name,"Testgrupp konstruktion");
  assert.equal(snap.employeeGroupMembers.filter(x=>x.groupId===testGroupId).length,2);
 });
 snap=await request("/api/data",{action:"saveEmployeeGroup",id:testGroupId,name:"Testgrupp Uppdaterad",description:"Ny beskrivning",employeeIds:[sara]});
 check("Group membership can be updated without changing employee assignments",()=>{
  assert.deepEqual(snap.employeeGroupMembers.filter(x=>x.groupId===testGroupId).map(x=>x.employeeId),[sara]);
  assert.ok(assignment(snap,1,erik));
 });
 const groupBackup=structuredClone(snap);
 snap=await request("/api/data",{action:"restore",backup:{version:3,data:groupBackup}});
 check("Group names and memberships survive full backup/restore",()=>{
  assert.deepEqual(snap.employeeGroups,groupBackup.employeeGroups);
  assert.deepEqual(snap.employeeGroupMembers,groupBackup.employeeGroupMembers);
 });
 snap=await request("/api/data",{action:"setAssignmentStatus",activityId:1,employeeId:erik,status:"Klar"});
 snap=await request("/api/data",{action:"setAssignmentStatus",activityId:1,employeeId:sara,status:"Pågående"});
 const grouped=kanbanForPeople([erik,sara],snap.employees,snap.projects,snap.activities,snap.assignments);
 const two=grouped.filter(c=>c.activityId===1);
 check("Kanban keeps distinct status for two people on same activity",()=>{
  assert.equal(two.length,2);
  assert.equal(two.find(c=>c.employeeId===erik).status,"Klar");
  assert.equal(two.find(c=>c.employeeId===sara).status,"Pågående");
 });
 const board=kanbanForActivities(snap.activities.filter(a=>a.id===1),snap.employees,snap.projects,snap.assignments);
 check("Project Kanban groups shared activity into one card",()=>{
  assert.equal(board.length,1);
  assert.equal(board[0].employeeId,null);
  assert.ok(board[0].people.length>=2);
 });
 check("Kanban normalizes all activity status values",()=>{
  assert.equal(normalizeKanbanStatus("Pågår"),"Pågående");
  assert.equal(normalizeKanbanStatus("Fryst"),"Fryst");
  assert.equal(normalizeKanbanStatus("Klar"),"Klar");
 });
 const deletedGroup=await fetch(base+"/api/data?type=group&id="+testGroupId,{method:"DELETE"});
 assert.equal(deletedGroup.status,200);
 snap=await deletedGroup.json();
 check("Deleting group leaves employees and activity assignments untouched",()=>{
  assert.equal(snap.employeeGroups.some(g=>g.id===testGroupId),false);
  assert.ok(snap.employees.some(e=>e.id===erik));
  assert.ok(assignment(snap,1,erik));
 });
 // Restore the earlier individual state before the original SQLite postconditions.
 snap=await request("/api/data",{action:"setAssignmentStatus",activityId:1,employeeId:erik,status:"Pågående"});
 check("Post-test cleanup restores the individual to active state in the disposable database",()=>{
  assert.equal(assignment(snap,1,erik).completedAt,null);
  assert.equal(assignment(snap,1,erik).workStatus,"Pågående");
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
 // Roles are exercised as real separately logged-in users.
 const userPassword="EmployeePassphrase-2026!";
 await request("/api/access",{action:"saveAccount",email:"erik@example.se",employeeId:erik,password:userPassword,isAdmin:false});
 await request("/api/access",{action:"saveAccount",email:"sara@example.se",employeeId:sara,password:userPassword,isAdmin:false});
 const asUser=async(email,password=userPassword)=>{
  const res=await fetch(base+"/api/auth",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"login",email,password})});
  if(!res.ok)throw Error("Could not log in as "+email+": "+await res.text());
  sessionCookie=(res.headers.get("set-cookie")||"").split(";")[0];
  assert.match(sessionCookie,/^rp_session=/);
 };
 await asUser("erik@example.se");
 let userData=await request();
 check("Employee sees project 1 and project 2 where assigned, not unrelated project 3",()=>{
  assert.ok(userData.projects.some(p=>p.id===1));
  assert.ok(userData.projects.some(p=>p.id===2));
  assert.equal(userData.projects.some(p=>p.id===3),false);
  assert.ok(userData.activities.some(a=>a.id===1));
 });
 const denied=await fetch(base+"/api/data",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"setAssignmentStatus",activityId:1,employeeId:sara,status:"Klar"})});
 check("Ordinary employee cannot change colleague assignment",()=>assert.equal(denied.status,403));
 const deniedExport=await fetch(base+"/api/individual?email=sara@example.se");
 check("Ordinary employee cannot export colleague Excel",()=>assert.equal(deniedExport.status,403));
 const created=await request("/api/data",{action:"activity",projectId:1,name:"Approval end-to-end activity",description:"Requires colleague acceptance before assignment",startDate:"2026-11-02",endDate:"2026-11-20",estimatedHours:40,status:"Planerad"});
 const createdAct=created.activities.find(a=>a.name==="Approval end-to-end activity");
 check("Employee can create task for self in a joined project",()=>{
  assert.ok(createdAct);
  assert.ok(assignment(created,createdAct.id,erik));
  assert.equal(assignment(created,createdAct.id,sara),undefined);
 });
 const requestData=await request("/api/requests",{action:"request",activityId:createdAct.id,recipientId:sara,effortPercent:40,startDate:"2026-11-02",endDate:"2026-11-20"});
 check("Self-service request stays pending without creating recipient workload",()=>{
  assert.equal(requestData.requests.some(r=>r.activityId===createdAct.id&&r.status==="pending"),true);
 });
 userData=await request();
 check("Pending request has not assigned recipient to the activity",()=>assert.equal(assignment(userData,createdAct.id,sara),undefined));
 await asUser("sara@example.se");
 const saraInbox=await request("/api/requests");
 const pending=saraInbox.requests.find(r=>r.activityId===createdAct.id&&r.status==="pending");
 check("Recipient sees pending request in personal inbox",()=>assert.ok(pending));
 const accepted=await request("/api/requests",{action:"answer",id:pending.id,approve:true});
 check("Recipient approves and pending request moves to approved",()=>assert.equal(accepted.requests.find(r=>r.id===pending.id)?.status,"approved"));
 const saraPlan=await request();
 check("Approved request creates exactly one employee assignment",()=>{
  assert.equal(saraPlan.assignments.filter(s=>s.activityId===createdAct.id&&s.employeeId===sara).length,1);
 });
 const duplicateApproval=await fetch(base+"/api/requests",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"answer",id:pending.id,approve:true})});
 check("Repeat approval rejected",()=>assert.equal(duplicateApproval.status,409));
 await asUser("ci-admin@example.se",adminPassword);
 const approvedSnapshot=await request();
 check("Admin view still sees all original employees",()=>assert.equal(approvedSnapshot.employees.length>=4,true));
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
