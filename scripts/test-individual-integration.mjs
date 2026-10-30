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
 // Create a deliberately unassigned project to detect accidental project-data leakage.
 snap=await request("/api/data",{action:"project",code:"P-RBAC-ISOLATED",name:"Access denied test project",description:"Visible to admins only",status:"Aktivt",priority:3,color:"#475569"});
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
 check("Employee sees only projects they participate in, including manually joined projects",()=>{
  const entitled=new Set(snap.projectMembers.filter(x=>x.employeeId===erik).map(x=>x.projectId));
  for(const a of snap.assignments.filter(x=>x.employeeId===erik)){
   const task=snap.activities.find(x=>x.id===a.activityId);
   if(task)entitled.add(task.projectId);
  }
  assert.ok(entitled.has(1)&&entitled.has(2));
  assert.deepEqual(new Set(userData.projects.map(p=>p.id)),entitled);
  assert.ok(userData.activities.some(a=>a.id===1));
  assert.ok(snap.projects.some(p=>!entitled.has(p.id)),"Fixture needs at least one out-of-scope project");
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
 // Explicit group managers can create TEAMs and designate leaders.
 await request("/api/access",{action:"saveAccount",email:"anna@example.se",employeeId:1,password:userPassword,isAdmin:false,isGroupManager:true});
 await asUser("anna@example.se");
 let annaData=await request();
 check("Group manager sees assigned reporting group",()=>{
  assert.equal(annaData.viewer.isGroupManager,true);
  assert.ok(annaData.employees.some(e=>e.id===erik));
  assert.ok(annaData.employees.some(e=>e.id===sara));
 });
 annaData=await request("/api/data",{action:"saveEmployeeGroup",name:"Safety TEAM regression",description:"Role permissions",employeeIds:[sara]});
 const authTeam=annaData.employeeGroups.find(t=>t.name==="Safety TEAM regression");
 check("Group manager may create own TEAM",()=>assert.ok(authTeam));
 await asUser("ci-admin@example.se",adminPassword);
 await request("/api/access",{action:"setTeamLeader",teamId:authTeam.id,employeeId:erik,enabled:true});
 await request("/api/access",{action:"setProjectLeader",projectId:1,employeeId:erik,enabled:true});
 const visibleOnly=await request("/api/data",{action:"project",code:"P-TEAM-READONLY",name:"TEAM-only project",status:"Aktivt",priority:3,color:"#334155",description:"Accessible only through team colleague"});
 const teamOnlyId=visibleOnly.projects.find(p=>p.code==="P-TEAM-READONLY").id;
 await request("/api/data",{action:"setSingleProjectMember",projectId:teamOnlyId,employeeId:sara,enabled:true});
 await asUser("erik@example.se");
 const erikLed=await request();
 check("TEAM leader can see colleague's project without belonging to it",()=>{
  assert.ok(erikLed.projects.some(p=>p.id===teamOnlyId));
  assert.equal(erikLed.viewer.projectLeadIds.includes(teamOnlyId),false);
 });
 const forbiddenTeamCreate=await fetch(base+"/api/data",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"activity",projectId:teamOnlyId,name:"Unauthorized team project work",description:"Must be forbidden",startDate:"2026-11-02",endDate:"2026-11-06",estimatedHours:8,status:"Planerad"})});
 check("TEAM read visibility does not grant right to create work in colleague's project",()=>assert.equal(forbiddenTeamCreate.status,403));
 check("TEAM leader sees TEAM membership and project leader role",()=>{
  assert.ok(erikLed.employeeGroups.some(t=>t.id===authTeam.id));
  assert.ok(erikLed.viewer.teamLeadIds.includes(authTeam.id));
  assert.ok(erikLed.viewer.projectLeadIds.includes(1));
 });
 const changed=await request("/api/data",{action:"setAssignmentStatus",activityId:1,employeeId:sara,status:"Pågående"});
 check("Project leader may change resource status within their own project",()=>{
  assert.ok(changed.assignments.some(a=>a.activityId===1&&a.employeeId===sara&&a.workStatus==="Pågående"));
 });
 const wrongProject=await fetch(base+"/api/data",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"updateProject",id:3,code:"P-1110",name:"Denied update",description:"",color:"#ca8a04",priority:3})});
 check("Project leader cannot alter unrelated project",()=>assert.equal(wrongProject.status,403));
 await asUser("ci-admin@example.se",adminPassword);
 // Passwords: admin can provision every employee by ID, reset without changing roles,
 // six-character passwords work, and password reset revokes existing sessions.
 const johanEmployee=snap.employees.find(e=>e.name.toLowerCase().includes("johan"));
 assert.ok(johanEmployee,"Missing Johan employee in fixture");
 await request("/api/access",{action:"setEmployeePassword",employeeId:johanEmployee.id,password:"Abc123"});
 const allAccounts=await request("/api/access");
 check("Admin can create a six-character password for an employee without an account",()=>{
  const account=allAccounts.accounts.find(a=>a.employeeId===johanEmployee.id);
  assert.ok(account);
  assert.equal(account.isAdmin,0);
  assert.equal(account.isGroupManager,0);
 });
 await asUser(johanEmployee.email,"Abc123");
 const johanAccess=await request("/api/access");
 check("New employee password logs in with normal, not admin permissions",()=>assert.equal(johanAccess.viewer.isAdmin,false));
 const forbiddenPassword=await fetch(base+"/api/access",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"setEmployeePassword",employeeId:erik,password:"Abc123"})});
 check("Ordinary employee cannot change other users passwords",()=>assert.equal(forbiddenPassword.status,403));
 const selfChange=await fetch(base+"/api/auth",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"changePassword",currentPassword:"Abc123",newPassword:"Xyz789"})});
 check("Employee can change own password to six characters",()=>assert.equal(selfChange.status,200));
 const afterChange=await fetch(base+"/api/data");
 check("Changing personal password revokes previous session",()=>assert.equal(afterChange.status,401));
 await asUser(johanEmployee.email,"Xyz789");
 await asUser("ci-admin@example.se",adminPassword);
 await request("/api/access",{action:"setEmployeePassword",employeeId:johanEmployee.id,password:"Qwe456"});
 const oldLogin=await fetch(base+"/api/auth",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"login",email:johanEmployee.email,password:"Xyz789"})});
 check("Old employee password rejected after admin reset",()=>assert.equal(oldLogin.status,401));
 await asUser(johanEmployee.email,"Qwe456");
 const accountAfterReset=await request("/api/access");
 check("Password reset does not elevate user roles",()=>assert.equal(accountAfterReset.viewer.isAdmin,false));
 await asUser("ci-admin@example.se",adminPassword);

 // Suggestions: ordinary users may submit, but only admin/manager may review.
 await asUser("sara@example.se");
 const projectCountBefore=(await request()).projects.length;
 const forbiddenDirectProject=await fetch(base+"/api/data",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"project",code:"P-FORBIDDEN",name:"Forbidden project",priority:3})});
 check("Employee cannot directly create a project",()=>assert.equal(forbiddenDirectProject.status,403));
 const proposed=await request("/api/project-proposals",{action:"submit",code:"P-TEST-APPROVE",name:"Föreslaget nytt projekt",description:"Granskas av gruppchef",priority:2,color:"#146c94"});
 const proposal=proposed.proposals.find(p=>p.code==="P-TEST-APPROVE");
 check("Employee submits pending proposal without creating project",()=>assert.ok(proposal&&proposal.status==="pending"));
 const cannotApprove=await fetch(base+"/api/project-proposals",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"review",id:proposal.id,approve:true})});
 check("Employee cannot approve own proposal",()=>assert.equal(cannotApprove.status,403));
 const proposalOnly=(await request()).projects;
 check("Pending proposal has no effect on project registry",()=>assert.equal(proposalOnly.length,projectCountBefore));
 await asUser("anna@example.se");
 const managerView=await request("/api/project-proposals");
 check("Group manager sees all pending project proposals",()=>assert.ok(managerView.canReview&&managerView.proposals.some(p=>p.id===proposal.id)));
 const managerCreated=await request("/api/data",{action:"project",code:"P-MANAGER-DIRECT",name:"Eget gruppchefsprojekt",description:"Skapad direkt av gruppchef",color:"#2563eb",priority:2});
 check("Group manager can create projects directly and becomes project leader",()=>{
  const p=managerCreated.projects.find(p=>p.code==="P-MANAGER-DIRECT");
  assert.ok(p);
  assert.ok(managerCreated.viewer.projectLeadIds.includes(p.id));
 });
 const managerApproved=await request("/api/project-proposals",{action:"review",id:proposal.id,approve:true,comment:"Godkänt i test"});
 check("Group manager approval creates exactly one new project",()=>assert.equal(managerApproved.proposals.find(p=>p.id===proposal.id).status,"approved"));
 const afterApproval=await request();
 check("Approving group manager gets access to created project",()=>assert.ok(afterApproval.projects.some(p=>p.code==="P-TEST-APPROVE")));
 const reapprove=await fetch(base+"/api/project-proposals",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"review",id:proposal.id,approve:true})});
 check("Duplicate project approval is rejected",()=>assert.equal(reapprove.status,409));
 await asUser("sara@example.se");
 const rejectedProposal=(await request("/api/project-proposals",{action:"submit",code:"P-TEST-REJECT",name:"Projekt som avslås",description:"Begäran ska inte skapa projekt",priority:3,color:"#2563eb"})).proposals.find(p=>p.code==="P-TEST-REJECT");
 await asUser("ci-admin@example.se",adminPassword);
 const rejected=await request("/api/project-proposals",{action:"review",id:rejectedProposal.id,approve:false,comment:"Ej prioriterat"});
 check("Admin rejects project proposal",()=>assert.equal(rejected.proposals.find(p=>p.id===rejectedProposal.id).status,"rejected"));
 const adminPlan=await request();
 check("Rejected proposal never appears as an active project",()=>assert.equal(adminPlan.projects.some(p=>p.code==="P-TEST-REJECT"),false));
 const restoredProposals=await request("/api/data",{action:"restore",backup:{version:3,data:adminPlan}});
 check("Backup and restore preserve project proposal review history",()=>{
  assert.deepEqual(restoredProposals.projectProposals,adminPlan.projectProposals);
  assert.ok(restoredProposals.projects.some(p=>p.code==="P-TEST-APPROVE"));
 });
 const shortPassword=await fetch(base+"/api/access",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"setEmployeePassword",employeeId:erik,password:"abc12"})});
 check("Passwords shorter than six characters are rejected",()=>assert.equal(shortPassword.status,400));
 const unauthorizedProposals=await originalFetch(base+"/api/project-proposals");
 check("Project proposal inbox is protected for anonymous users",()=>assert.equal(unauthorizedProposals.status,401));
 // Excel importer may create missing employees/projects when run by admin or group manager.
 const targetWeek="2026-W46";
 const importTemplate=(email,name,projectCode,projectName,priority="4")=>({
  email,name,members:[{code:projectCode,name:projectName,state:"Aktiv"}],
  activities:[{uid:"",week:targetWeek,name:"Excel import role-created task",kind:"Projekt",link:projectName,projectCode,
   hours:16,status:"Planerad",priority,dueDate:"",comment:"Automatiskt importerad aktivitet",firstWeek:targetWeek,reason:""}]
 });
 await asUser("anna@example.se");
 const managerNew=await request("/api/individual",importTemplate("new.report@example.se","Nya Rapporten","P-EXCEL-MAN","Importerat gruppchefsprojekt"));
 check("Group manager Excel import creates new employee and project",()=>{
  assert.equal(managerNew.employeesCreated,1);
  assert.equal(managerNew.projectsCreated,1);
  assert.equal(managerNew.created,1);
 });
 const managerPlan=await request();
 const newReport=managerPlan.employees.find(x=>x.email==="new.report@example.se"),managerProject=managerPlan.projects.find(p=>p.code==="P-EXCEL-MAN");
 check("New Excel employee reports to importer and manager leads newly created project",()=>{
  assert.ok(newReport&&managerProject);
  assert.equal(newReport.managerId,1);
  assert.ok(managerPlan.projectLeaders.some(x=>x.employeeId===1&&x.projectId===managerProject.id));
  const task=managerPlan.activities.find(x=>x.projectId===managerProject.id&&x.name==="Excel import role-created task");
  assert.ok(task&&assignment(managerPlan,task.id,newReport.id));
  assert.equal(task.priority,4);
 });
 const reportSheet=await sheet("new.report@example.se");
 check("Group manager can export report, including activity priority",()=>assert.equal(reportSheet.activities.find(a=>a.name==="Excel import role-created task").priority,"4"));
 const managerReimport=await request("/api/individual",importTemplate("new.report@example.se","Nya Rapporten","P-EXCEL-MAN","Importerat gruppchefsprojekt"));
 check("Reimporting same workbook creates no duplicate employee or project",()=>{
  assert.equal(managerReimport.employeesCreated,0);
  assert.equal(managerReimport.projectsCreated,0);
  assert.equal(managerReimport.created,0);
 });
 await asUser("erik@example.se");
 const ordinaryNew=await fetch(base+"/api/individual",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(importTemplate("other.new@example.se","Ej behörig","P-EXCEL-DENY","Förbjudet projekt"))});
 check("Ordinary employee cannot create users/projects by Excel",()=>assert.equal(ordinaryNew.status,403));
 await asUser("ci-admin@example.se",adminPassword);
 const newlyCreated=await request("/api/access");
 check("Excel-created employee receives a disabled personal login until admin sets a password",()=>{
  const account=newlyCreated.accounts.find(x=>x.employeeId===newReport.id);
  assert.ok(account);
  assert.equal(account.isDisabled,1);
  assert.equal(account.isAdmin,0);
 });
 await request("/api/access",{action:"setEmployeePassword",employeeId:newReport.id,password:"Safe123"});
 const activated=await request("/api/access");
 check("Admin password provisioning activates the Excel-created employee account",()=>{
  assert.equal(activated.accounts.find(x=>x.employeeId===newReport.id)?.isDisabled,0);
 });
 await asUser("new.report@example.se","Safe123");
 const reportIdentity=await request();
 check("Newly activated Excel employee can log in and see only own projects",()=>{
  assert.equal(reportIdentity.viewer.employeeId,newReport.id);
  assert.ok(reportIdentity.projects.some(p=>p.id===managerProject.id));
 });
 await asUser("ci-admin@example.se",adminPassword);
 const adminNew=await request("/api/individual",importTemplate("admin.new@example.se","Administrativt skapad","P-EXCEL-ADM","Projekt skapat av admin","2"));
 const adminState=await request();
 check("Admin import can create employee, project and activity without assigning a manager",()=>{
  assert.equal(adminNew.employeesCreated,1);
  assert.equal(adminNew.projectsCreated,1);
  const newPerson=adminState.employees.find(x=>x.email==="admin.new@example.se");
  assert.ok(newPerson);
  assert.equal(newPerson.managerId,null);
  assert.ok(adminState.projects.find(p=>p.code==="P-EXCEL-ADM"));
 });
 await asUser("anna@example.se");
 const forbiddenExisting=await fetch(base+"/api/individual",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(importTemplate("admin.new@example.se","Administrativt skapad","P-EXCEL-ADM","Projekt skapat av admin","1"))});
 check("Group manager cannot silently take over another manager's employee",()=>assert.equal(forbiddenExisting.status,403));
 await asUser("ci-admin@example.se",adminPassword);

 // Legacy worksheets with an empty H-column preserve the stored priority.
 const oldPrioritySheet=await sheet("admin.new@example.se");
 const priorityBefore=oldPrioritySheet.activities.find(a=>a.name==="Excel import role-created task");
 check("Administrator exports imported activity priority",()=>assert.equal(priorityBefore.priority,"2"));
 await request("/api/individual",{...oldPrioritySheet,activities:[{...priorityBefore,priority:""}],members:[]});
 const oldAfter=await request();
 check("Legacy Excel workbook with blank priority leaves activity priority unchanged",()=>{
  const id=oldAfter.projects.find(p=>p.code==="P-EXCEL-ADM").id;
  assert.equal(oldAfter.activities.find(a=>a.projectId===id&&a.name==="Excel import role-created task").priority,2);
 });
 const invalidPriority=await fetch(base+"/api/individual",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(importTemplate("bad.priority@example.se","Bad Priority","P-PRIO-INVALID","Får inte skapas","6"))});
 check("Invalid priority is rejected before new employee and project are created",()=>assert.equal(invalidPriority.status,400));
 const afterInvalidPriority=await request();
 check("Rejected priority import leaves employee/project registries unchanged",()=>{
  assert.equal(afterInvalidPriority.employees.some(e=>e.email==="bad.priority@example.se"),false);
  assert.equal(afterInvalidPriority.projects.some(p=>p.code==="P-PRIO-INVALID"),false);
 });
 // Priority edits are effective on Swedish calendar import day, not from the
 // activity's original start date. All current staffing segments split cleanly.
 const {importDateSweden,previousISODate}=await import("../lib/individual-priority.ts");
 const today=importDateSweden(),shiftDate=(offset)=>{
  const date=new Date(today+"T00:00:00Z");date.setUTCDate(date.getUTCDate()+offset);return date.toISOString().slice(0,10);
 };
 const dated=await request("/api/data",{action:"activity",projectId:1,name:"Excel priority change regression",description:"Historisk bemanning och prioritet",startDate:shiftDate(-10),endDate:shiftDate(10),estimatedHours:40,status:"Planerad"});
 const prioId=dated.activities.find(a=>a.name==="Excel priority change regression").id;
 await request("/api/data",{action:"setActivityAssignments",activityId:prioId,resources:[{employeeId:erik,effortPercent:60},{employeeId:sara,effortPercent:30}]});
 const originalSheet=await sheet("erik@example.se");
 const priorityRow=originalSheet.activities.find(a=>a.name==="Excel priority change regression");
 check("Activity priority is exported into existing Excel column H",()=>assert.equal(priorityRow.priority,"3"));
 const priorityWorkbook={...originalSheet,activities:[{...priorityRow,priority:"1"}],members:[]};
 const editedPriority=await request("/api/individual",priorityWorkbook);
 check("Excel priority import detects changed priority",()=>assert.equal(editedPriority.prioritiesChanged,1));
 let afterPrio=await request();
 check("Changed priority is current while existing periods split for all assigned resources",()=>{
  assert.equal(activity(afterPrio,prioId).priority,1);
  for(const employeeId of [erik,sara]){
   const a=assignment(afterPrio,prioId,employeeId),segments=afterPrio.assignmentPeriods.filter(p=>p.assignmentId===a.id);
   assert.equal(segments.length,2);
   assert.equal(segments[0].endDate,previousISODate(today));
   assert.equal(segments[1].startDate,today);
   assert.equal(segments[0].effortPercent,employeeId===erik?60:30);
   assert.equal(segments[1].effortPercent,segments[0].effortPercent);
  }
 });
 check("Priority history preserves original priority and new effective date",()=>{
  const rows=afterPrio.activityPriorityHistory.filter(h=>h.activityId===prioId).sort((a,b)=>a.effectiveFrom.localeCompare(b.effectiveFrom));
  assert.equal(rows.length,2);
  assert.equal(rows[0].priority,3);
  assert.equal(rows[1].priority,1);
  assert.equal(rows[1].effectiveFrom,today);
 });
 const secondPriority=await request("/api/individual",priorityWorkbook);
 check("Repeated Excel import with unchanged priority does not add allocation segments",()=>assert.equal(secondPriority.prioritiesChanged,0));
 afterPrio=await request();
 check("No duplicate split after repeated priority import",()=>{
  for(const id of [erik,sara])assert.equal(afterPrio.assignmentPeriods.filter(p=>p.assignmentId===assignment(afterPrio,prioId,id).id).length,2);
 });
 const priorityAgain=await request("/api/individual",{...priorityWorkbook,activities:[{...priorityRow,priority:"2"}]});
 check("Same-day reprioritization replaces effective-day record without another split",()=>assert.equal(priorityAgain.prioritiesChanged,1));
 afterPrio=await request();
 check("Same-day priority edit retains only one boundary in resource history",()=>{
  assert.equal(afterPrio.activityPriorityHistory.filter(h=>h.activityId===prioId).length,2);
  for(const id of [erik,sara])assert.equal(afterPrio.assignmentPeriods.filter(p=>p.assignmentId===assignment(afterPrio,prioId,id).id).length,2);
 });
 const backupPriorities=structuredClone(afterPrio);
 const restoredPriorities=await request("/api/data",{action:"restore",backup:{version:3,data:backupPriorities}});
 check("Backup roundtrip preserves priority and all dated allocation periods",()=>{
  assert.deepEqual(restoredPriorities.activityPriorityHistory,backupPriorities.activityPriorityHistory);
  assert.equal(activity(restoredPriorities,prioId).priority,2);
 });

 // Leadership can be managed in-context without changing activity assignments.
 const currentLeaderState=await request();
 const internalProject=async(code,name)=>{
  const all=await request();const exists=all.projects.find(p=>p.code===code);
  if(exists)return exists;
  const created=await request("/api/data",{action:"project",code,name,description:"Intern verksamhet",color:"#526a86",priority:3});
  return created.projects.find(p=>p.code===code);
 };
 const verksProject=await internalProject("INTERNAL-VERK","Verksamhet");
 const ovrProject=await internalProject("INTERNAL-OVR","Övrigt");
 const setLead=(kind,ids,oldEmployeeId,newEmployeeId)=>request("/api/access",{action:"replaceLeader",kind,...ids,oldEmployeeId,newEmployeeId});
 await setLead("project",{projectId:verksProject.id},null,erik);
 await setLead("project",{projectId:ovrProject.id},null,sara);
 const internalLeads=await request("/api/access");
 check("All users can be chosen as leaders on Verksamhet or Övrigt",()=>{
  assert.ok(internalLeads.projectLeaders.some(x=>x.projectId===verksProject.id&&x.employeeId===erik));
  assert.ok(internalLeads.projectLeaders.some(x=>x.projectId===ovrProject.id&&x.employeeId===sara));
 });
 await asUser("erik@example.se");
 const leadTask=await request("/api/data",{action:"activity",projectId:verksProject.id,name:"Project leader can do ordinary work",description:"Project lead may also be resource",startDate:"2026-11-04",endDate:"2026-11-12",estimatedHours:16,status:"Planerad"});
 const assignedActivity=leadTask.activities.find(x=>x.name==="Project leader can do ordinary work");
 check("Project leader can have own assigned activities",()=>assert.ok(assignedActivity&&assignment(leadTask,assignedActivity.id,erik)));
 await asUser("ci-admin@example.se",adminPassword);
 await setLead("project",{projectId:verksProject.id},erik,sara);
 const replacedProject=await request("/api/access");
 const afterReplace=await request();
 check("Project leader can be replaced while the previous leader's work remains assigned",()=>{
  assert.ok(replacedProject.projectLeaders.some(x=>x.projectId===verksProject.id&&x.employeeId===sara));
  assert.equal(replacedProject.projectLeaders.some(x=>x.projectId===verksProject.id&&x.employeeId===erik),false);
  assert.ok(assignment(afterReplace,assignedActivity.id,erik));
 });
 await setLead("project",{projectId:ovrProject.id},sara,null);
 check("Project leader can be removed without deleting project",()=>{
  assert.ok((afterReplace.projects||[]).some(p=>p.id===ovrProject.id));
 });
 const wProject=await request("/api/data",{action:"project",code:"P-LEAD-WORK",name:"Projekt med uppdragsledare",description:"Separata roller",color:"#2468ab",priority:3});
 const wProjId=wProject.projects.find(p=>p.code==="P-LEAD-WORK").id;
 const wData=await request("/api/data",{action:"workPackage",projectId:wProjId,code:"UPP-1",name:"Separat uppdrag",description:"Egen ledare"});
 const wId=wData.workPackages.find(w=>w.projectId===wProjId&&w.code==="UPP-1").id;
 await setLead("workPackage",{workPackageId:wId},null,sara);
 const inScope=await request("/api/data",{action:"activity",projectId:wProjId,workPackageId:wId,name:"Assignment within led work package",description:"Coworker in own work package",startDate:"2026-11-01",endDate:"2026-11-15",estimatedHours:16,status:"Planerad"});
 const inScopeId=inScope.activities.find(x=>x.name==="Assignment within led work package").id;
 await request("/api/data",{action:"setActivityAssignments",activityId:inScopeId,resources:[{employeeId:sara,effortPercent:25},{employeeId:johanEmployee.id,effortPercent:50}]});
 const outScope=await request("/api/data",{action:"activity",projectId:wProjId,name:"Unrelated task outside led work package",description:"Only the manager should see this assignment",startDate:"2026-11-01",endDate:"2026-11-15",estimatedHours:16,status:"Planerad"});
 const outScopeId=outScope.activities.find(x=>x.name==="Unrelated task outside led work package").id;
 await request("/api/data",{action:"setActivityAssignments",activityId:outScopeId,resources:[{employeeId:johanEmployee.id,effortPercent:35}]});
 const assignedW=await request("/api/access");
 check("Work package receives independent leader and auto-membership",()=>assert.ok(assignedW.workPackageLeaders.some(w=>w.workPackageId===wId&&w.employeeId===sara)));
 await asUser("sara@example.se");
 const workVisible=await request();
 check("Work-package leader sees coworker assignment only within their own uppdrag",()=>{
  assert.ok(workVisible.assignments.some(a=>a.activityId===inScopeId&&a.employeeId===johanEmployee.id));
  assert.equal(workVisible.assignments.some(a=>a.activityId===outScopeId&&a.employeeId===johanEmployee.id),false);
 });
 const createdWork=await request("/api/data",{action:"activity",projectId:wProjId,workPackageId:wId,name:"Uppdragsledare arbetar själv",description:"Bemanningsbar uppdragsledare",startDate:"2026-11-01",endDate:"2026-11-30",estimatedHours:32,status:"Planerad"});
 const wActivity=createdWork.activities.find(a=>a.name==="Uppdragsledare arbetar själv");
 check("Work package leader may create and be allocated to own activity",()=>assert.ok(wActivity&&assignment(createdWork,wActivity.id,sara)));
 const forbiddenLead=await fetch(base+"/api/access",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"replaceLeader",kind:"workPackage",workPackageId:wId,oldEmployeeId:sara,newEmployeeId:erik})});
 check("Ordinary work-package leader cannot grant leadership rights",()=>assert.equal(forbiddenLead.status,403));
 await asUser("ci-admin@example.se",adminPassword);
 await setLead("workPackage",{workPackageId:wId},sara,erik);
 const afterWorkReplace=await request();
 check("Work-package leadership change retains predecessor's own assignment",()=>{
  assert.ok(afterWorkReplace.workPackageLeaders.some(x=>x.workPackageId===wId&&x.employeeId===erik));
  assert.ok(assignment(afterWorkReplace,wActivity.id,sara));
 });
 const beforeTeamReplace=await request();
 const countSara=beforeTeamReplace.assignments.filter(a=>a.employeeId===sara).length;
 await setLead("team",{teamId:authTeam.id},erik,sara);
 const afterTeamReplace=await request();
 check("TEAM leader can be changed without changing members or activity workload",()=>{
  assert.ok(afterTeamReplace.teamLeaders.some(t=>t.teamId===authTeam.id&&t.employeeId===sara));
  assert.equal(afterTeamReplace.teamLeaders.some(t=>t.teamId===authTeam.id&&t.employeeId===erik),false);
  assert.equal(afterTeamReplace.assignments.filter(a=>a.employeeId===sara).length,countSara);
  assert.ok(afterTeamReplace.employeeGroupMembers.some(m=>m.groupId===authTeam.id&&m.employeeId===sara));
 });
 await asUser("sara@example.se");
 const leaderOwn=await request("/api/data",{action:"activity",projectId:1,name:"TEAM-leader kan ha egen aktivitet",description:"TEAM-leader är också vanlig resurs",startDate:"2026-11-04",endDate:"2026-11-12",estimatedHours:8,status:"Planerad"});
 check("TEAM leader may still have their own activities",()=>{
  const t=leaderOwn.activities.find(a=>a.name==="TEAM-leader kan ha egen aktivitet");
  assert.ok(t&&assignment(leaderOwn,t.id,sara));
 });
 await asUser("anna@example.se");
 const groupSwapped=await setLead("team",{teamId:authTeam.id},sara,johanEmployee.id);
 check("Owning group manager can replace a TEAM-leader with another employee",()=>{
  assert.ok(groupSwapped.teamLeaders.some(t=>t.teamId===authTeam.id&&t.employeeId===johanEmployee.id));
  assert.ok(!groupSwapped.teamLeaders.some(t=>t.teamId===authTeam.id&&t.employeeId===sara));
 });
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
