#!/usr/bin/env node
/**
 * Independent role/permission test, using an isolated temporary D1/SQLite DB.
 * It does not touch /var/lib/resursplanering or the live application.
 * Run: node scripts/test-role-access.mjs
 */
import assert from "node:assert/strict";
import {spawn,spawnSync} from "node:child_process";
import {mkdtemp,rm,readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";
import {DatabaseSync} from "node:sqlite";
import {createServer} from "node:net";

const dir=await mkdtemp(join(tmpdir(),"resursplanering-roles-"));
// Do not reuse a fixed port: a leftover Wrangler worker from a cancelled
// test could answer HTTP 200 while this instance has no SQLite database.
const port=await new Promise((resolve,reject)=>{
 const listener=createServer();
 listener.once("error",reject);
 listener.listen(0,"127.0.0.1",()=>{
  const address=listener.address();
  const number=typeof address==="object"&&address?address.port:null;
  listener.close(error=>error?reject(error):resolve(number));
 });
});
const base=`http://127.0.0.1:${port}`;
const password="CI-Role-Matrix-Only!2026";
let logs="";
let passes=0;
const server=spawn(process.execPath,["scripts/start-selfhosted.mjs"],{
 cwd:process.cwd(),
 env:{...process.env,DATA_DIR:join(dir,"data"),HOST:"127.0.0.1",PORT:String(port),CI:"true",NO_COLOR:"1"},
 detached:true,stdio:["ignore","pipe","pipe"]
});
for(const stream of [server.stdout,server.stderr])stream.on("data",chunk=>{
 logs+=String(chunk);
 if(logs.length>75000)logs=logs.slice(-75000);
});
function check(label,fn){fn();passes++;console.log("PASS role-matrix:",label)}
async function api(cookie,path,body,{retryKnownDenied=false}={}){
 // Only safe reads, read-only previews, and explicit EXPECTED denial checks
 // may retry if Wrangler returns a transient worker-restarted HTTP 503.
 // Mutating POST requests are deliberately NOT replayed.

 const options={headers:{"accept":"application/json"}};
 if(cookie)options.headers.cookie=cookie;
 if(body!==undefined){
  options.method="POST";
  options.headers["content-type"]="application/json";
  options.body=JSON.stringify(body);
 }
 const safeRetry=body===undefined||body?.commit===false||retryKnownDenied;
 let response,raw="";
 for(let attempt=0;attempt<(safeRetry?3:1);attempt++){
  try{
   response=await fetch(base+path,{...options,signal:AbortSignal.timeout(15000)});
   raw=await response.text();
  }catch(e){
   if(safeRetry&&attempt<2){await sleep(500);continue}
   throw Error("HTTP-testet misslyckades på "+path+": "+String(e));
  }
  if(safeRetry&&response.status===503&&raw.includes("worker restarted mid-request")&&attempt<2){
   console.warn("Transient Wrangler restart for "+path+" (retry "+(attempt+1)+"/2)");
   await sleep(800);continue
  }
  break;
 }
 if(!response)throw Error("Ingen HTTP-respons på "+path);
 let value;
 try{value=JSON.parse(raw)}catch{throw Error(`Non-JSON response for ${path} HTTP ${response.status}: ${raw.slice(0,500)}`)}
 return {status:response.status,data:value};
}
async function ok(cookie,path,body){
 const response=await api(cookie,path,body);
 if(response.status<200||response.status>=300)throw Error(`Unexpected HTTP ${response.status} at ${path}: ${JSON.stringify(response.data)}`);
 return response.data;
}
async function login(email){
 const r=await api("","/api/auth",{action:"login",email,password});
 if(r.status!==200)throw Error(`Unable to log in as ${email}: ${JSON.stringify(r.data)}`);
 const c=r?.data?.user;
 assert.ok(c&&typeof c.isAdmin==="boolean");
 return {cookie:(await fetch(base+"/api/auth",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"login",email,password})})).headers.get("set-cookie")?.split(";")[0],user:c};
}
async function connected(email){
 const r=await login(email);
 assert.match(r.cookie||"",/^rp_session=/);
 return r.cookie;
}
async function onlyDatabase(folder){
 const walk=async p=>{
  let matches=[];
  for(const entry of await readdir(p,{withFileTypes:true})){
   const fp=join(p,entry.name);
   if(entry.isDirectory())matches.push(...await walk(fp));
   else if(entry.name.endsWith(".sqlite")&&entry.name!=="metadata.sqlite")matches.push(fp);
  }
  return matches;
 };
 const found=await walk(folder);
 assert.equal(found.length,1,`Expected exactly one test database, found: ${found.join(", ")}`);
 return found[0];
}
try{
 let ready=false;
 for(let i=0;i<90;i++){
  if(server.exitCode!==null)throw Error(`Test server exited: ${server.exitCode}`);
  try{if((await fetch(base+"/api/auth",{signal:AbortSignal.timeout(1200)})).status===200){ready=true;break}}catch{}
  await sleep(1000);
 }
 if(!ready)throw Error("Isolated test server failed to become ready: "+logs.slice(-4000));
 // HTTP readiness alone is not enough: make sure THIS test instance completed
 // its SQLite migrations. Do not provision accounts against a missing file.
 let dbReady=false;
 for(let i=0;i<30;i++){
  if(server.exitCode!==null)throw Error("Test server exited while waiting for SQLite: "+logs.slice(-4000));
  try{
   const location=await onlyDatabase(join(dir,"data"));
   const probe=new DatabaseSync(location,{readOnly:true});
   try{
    dbReady=!!probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_accounts'").get();
   }finally{probe.close()}
   if(dbReady)break;
  }catch{}
  await sleep(250);
 }
 if(!dbReady)throw Error("Isolated SQLite database was not initialized before admin provisioning. Port "+port+"; server logs: "+logs.slice(-4000));
 const provision=spawnSync("python3",["scripts/provision-account.py","--data-dir",join(dir,"data"),"--email","role-admin@example.se","--admin","--password-stdin"],{input:password+"\n",encoding:"utf8"});
 if(provision.status!==0)throw Error("Admin provisioning failed: "+provision.stdout+" "+provision.stderr);
 const anon=await api("","/api/quick-activity");
 check("Anonymous project catalog is protected",()=>assert.equal(anon.status,401));
 const admin=await connected("role-admin@example.se");
 const init=await ok(admin,"/api/data");
 const ids=Object.fromEntries(init.employees.map(p=>[p.name,p.id]));
 const anna=ids["Anna Lind"],erik=ids["Erik Holm"],sara=ids["Sara Berg"],johan=ids["Johan Nyström"];
 assert.ok(anna&&erik&&sara&&johan);
 const projectIds=init.projects.map(p=>p.id);
 check("Seeded planning data has projects and people",()=>{
  assert.ok(projectIds.length>=3);
  assert.equal(init.viewer.isAdmin,true);
  assert.equal(init.viewer.employeeId,null);
 });
 const noLinkCatalog=await ok(admin,"/api/quick-activity");
 check("ADMIN without linked employee still sees ALL projects in dropdown endpoint",()=>{
  assert.deepEqual(noLinkCatalog.projects.map(p=>p.id).sort((a,b)=>a-b),[...projectIds].sort((a,b)=>a-b));
  assert.equal(noLinkCatalog.needsEmployeeLink,true);
 });
 const invalidBeforeLink=await api(admin,"/api/quick-activity",{projectId:1,name:"Nekad utan person",description:"Spårbarhet",startDate:"2026-11-10",endDate:"2026-11-20"},{retryKnownDenied:true});
 check("Unlinked admin cannot create untraceable activity",()=>assert.equal(invalidBeforeLink.status,403));
 await ok(admin,"/api/data",{action:"employee",name:"Rolltest Admin",email:"role-admin@example.se",role:"Administratör",capacityPercent:100});
 const linked=await ok(admin,"/api/data");
 const adminPerson=linked.employees.find(e=>e.email==="role-admin@example.se");
 check("Matching admin login automatically identifies its employee",()=>{
  assert.ok(adminPerson);
  assert.equal(linked.viewer.employeeId,adminPerson.id);
 });
 const adminCatalog=await ok(admin,"/api/quick-activity");
 check("ADMIN with employee sees all projects even without being member",()=>{
  assert.deepEqual(adminCatalog.projects.map(p=>p.id).sort((a,b)=>a-b),[...projectIds].sort((a,b)=>a-b));
  assert.equal(adminCatalog.needsEmployeeLink,false);
 });
 const adminRemote=await ok(admin,"/api/quick-activity?projectId=1");
 check("ADMIN can propose work to any existing employee",()=>{
  assert.equal(adminRemote.allowed,true);
  assert.ok(adminRemote.eligibleRecipients.some(e=>e.id===johan));
 });
 // Create organizational roles through the same API as the web UI.
 for(const [email,employeeId,isGroupManager] of [
  ["anna@example.se",anna,true],["erik@example.se",erik,false],
  ["sara@example.se",sara,false],["johan@example.se",johan,false]
 ]){
  await ok(admin,"/api/access",{action:"saveAccount",email,employeeId,password,isAdmin:false,isGroupManager});
 }
 // Anna leads the reporting group but must join a project to create there.
 await ok(admin,"/api/data",{action:"setSingleProjectMember",projectId:1,employeeId:anna,enabled:true});
 await ok(admin,"/api/access",{action:"setProjectLeader",projectId:1,employeeId:erik,enabled:true});
 const group=await ok(admin,"/api/data",{action:"saveEmployeeGroup",name:"Behörighetstest TEAM",employeeIds:[erik,sara]});
 const team=group.employeeGroups.find(g=>g.name==="Behörighetstest TEAM");
 assert.ok(team);
 await ok(admin,"/api/access",{action:"setTeamLeader",teamId:team.id,employeeId:erik,enabled:true});
 const manager=await connected("anna@example.se");
 const leader=await connected("erik@example.se");
 const ordinary=await connected("sara@example.se");
 const nonmember=await connected("johan@example.se");
 // Generic multi-project import must not bypass RBAC via direct HTTP POST.
 const multiProjectRow={
  record_type:"activity",project_code:"TEST-XCH",project_name:"Utbyte test",
  work_package_code:"",work_package_name:"",activity_code:"XCH-01",activity:"Planerad integration",
  parent_activity_code:"",description:"Behörighetstest",start_date:"2026-11-16",end_date:"2026-11-20",
  estimated_hours:"20",status:"Planerad",employee_email:"sara@example.se",
  employee_name:"Sara Berg",effort_percent:"50"
 };
 // Explicit v2 Excel permission matrix: all tests use a disposable database.
 const weeklyBootstrap="/api/weekly-v2/bootstrap";
 const newWeeklyRow={week:"2026-V47",day:"Måndag",task:"Nytt veckouppdrag",duration:"3 veckor",
  effort:50,workType:"Projekt",hours:60,status:"Planerad",priority:"3",deadline:"",
  projectCode:"WK-ACCESS",projectName:"Veckotest åtkomst",firstWeek:"2026-V47",
  comment:"",moveReason:"",activityId:"",rowKey:"",rowRevision:0};
 const workbook={name:"Ny Excelmedarbetare",email:"new-excel-role@example.se",rows:[newWeeklyRow]};
 const anonWeekly=await api("",weeklyBootstrap,{...workbook,commit:true},{retryKnownDenied:true});
 check("Anonymous cannot create weekly Excel records",()=>assert.equal(anonWeekly.status,401));
 for(const [role,cookie] of [["ORDINARY STAFF",ordinary],["PROJECT/TEAM LEADER",leader],["NONMEMBER",nonmember]]){
  const denied=await api(cookie,weeklyBootstrap,{...workbook,commit:true},{retryKnownDenied:true});
  check(role+" cannot create unscoped employee via v2",()=>assert.equal(denied.status,403));
 }
 const snapshotWeeklyBefore=await ok(admin,"/api/data");
 const previewWeekly=await ok(admin,weeklyBootstrap,{...workbook,commit:false});
 check("ADMIN preview accurately counts missing person, project and activity",()=>{
  assert.equal(previewWeekly.preview.employeesCreated,1);
  assert.equal(previewWeekly.preview.projectsCreated,1);
  assert.equal(previewWeekly.preview.activitiesCreated,1);
 });
 const snapshotWeeklyPreview=await ok(admin,"/api/data");
 check("Weekly preview is read-only",()=>{
  assert.deepEqual(snapshotWeeklyPreview.employees,snapshotWeeklyBefore.employees);
  assert.deepEqual(snapshotWeeklyPreview.projects,snapshotWeeklyBefore.projects);
  assert.deepEqual(snapshotWeeklyPreview.activities,snapshotWeeklyBefore.activities);
 });
 const invalidWeekly=await api(admin,weeklyBootstrap,{...workbook,
  rows:[newWeeklyRow,{...newWeeklyRow,task:"Invalid second row",week:"2026-V99"}],commit:true});
 check("Malformed weekly row rejects entire requested creation",()=>assert.equal(invalidWeekly.status,400));
 const afterInvalidWeekly=await ok(admin,"/api/data");
 check("Invalid weekly workbook creates neither person nor project",()=>{
  assert.equal(afterInvalidWeekly.employees.some(p=>p.email===workbook.email),false);
  assert.equal(afterInvalidWeekly.projects.some(p=>p.code==="WK-ACCESS"),false);
 });
 const managerWorkbook={name:"Ny gruppmedarbetare",email:"new-group-role@example.se",
  rows:[{...newWeeklyRow,task:"Gruppchefens veckouppdrag",projectCode:"WK-MANAGER",projectName:"Chefprojekt"}]};
 const managerPreview=await ok(manager,weeklyBootstrap,{...managerWorkbook,commit:false});
 check("GROUP MANAGER may preview own new employee and project",()=>{
  assert.equal(managerPreview.preview.employeesCreated,1);
  assert.equal(managerPreview.preview.projectsCreated,1);
 });
 await ok(manager,weeklyBootstrap,{...managerWorkbook,commit:true});
 const managerCreated=await ok(admin,"/api/data");
 check("GROUP MANAGER new person assigned to importing group",()=>{
  const created=managerCreated.employees.find(p=>p.email===managerWorkbook.email);
  assert.ok(created);
  assert.equal(created.managerId,anna);
 });
 const managerScope=await ok(manager,"/api/data");
 check("GROUP MANAGER sees newly registered employee",()=>{
  assert.ok(managerScope.employees.some(p=>p.email===managerWorkbook.email));
 });
 await ok(admin,weeklyBootstrap,{...workbook,commit:true});
 const afterWeekly=await ok(admin,"/api/data");
 check("ADMIN weekly import creates full three-week activity",()=>{
  const project=afterWeekly.projects.find(p=>p.code==="WK-ACCESS");
  const task=afterWeekly.activities.find(a=>a.projectId===project?.id&&a.name===newWeeklyRow.task);
  assert.ok(task);
  assert.equal(task.startDate,"2026-11-16");
  assert.equal(task.endDate,"2026-12-04");
 });
 const exchangeUrl="/api/planning-exchange";
 const anonymousExchange=await api("",exchangeUrl,{rows:[multiProjectRow],commit:true},{retryKnownDenied:true});
 check("Anonymous bulk exchange is denied",()=>assert.equal(anonymousExchange.status,401));
 for(const [role,cookie] of [["GROUP MANAGER",manager],["PROJECT/TEAM LEADER",leader],["ORDINARY STAFF",ordinary],["NONMEMBER",nonmember]]){
  const denied=await api(cookie,exchangeUrl,{rows:[multiProjectRow],commit:true},{retryKnownDenied:true});
  check(role+" cannot bypass bulk-import rights with direct API call",()=>assert.equal(denied.status,403));
 }
 const beforePreview=await ok(admin,"/api/data");
 const safePreview=await ok(admin,exchangeUrl,{rows:[multiProjectRow],commit:false});
 check("ADMIN preview describes new project and activity without changing database",()=>{
  assert.equal(safePreview.preview.projectsCreated,1);
  assert.equal(safePreview.preview.activitiesCreated,1);
  assert.equal(safePreview.committed,false);
 });
 const previewSnapshot=await ok(admin,"/api/data");
 check("Preview is read-only and creates no employee, project or activity",()=>{
  assert.deepEqual(previewSnapshot.projects,beforePreview.projects);
  assert.deepEqual(previewSnapshot.activities,beforePreview.activities);
  assert.deepEqual(previewSnapshot.employees,beforePreview.employees);
 });
 const invalidBulk=[multiProjectRow,{...multiProjectRow,activity_code:"XCH-02",activity:"Invalid row",start_date:"2026-11-31"}];
 const refused=await api(admin,exchangeUrl,{rows:invalidBulk,commit:true},{retryKnownDenied:true});
 check("Invalid bulk import is rejected before any writes",()=>assert.equal(refused.status,400));
 const afterInvalid=await ok(admin,"/api/data");
 check("Invalid date cannot partially create project or activities",()=>assert.ok(!afterInvalid.projects.some(p=>p.code==="TEST-XCH")));
 const committed=await ok(admin,exchangeUrl,{rows:[multiProjectRow],commit:true});
 check("ADMIN can commit validated ordinary project exchange",()=>assert.equal(committed.committed,true));
 const afterExchange=await ok(admin,"/api/data");
 const importedProject=afterExchange.projects.find(p=>p.code==="TEST-XCH");
 const importedTask=afterExchange.activities.find(a=>a.projectId===importedProject?.id&&a.code==="XCH-01");
 check("Atomic import creates exactly one new project, activity and assignment",()=>{
  assert.ok(importedProject&&importedTask);
  assert.equal(afterExchange.projects.filter(p=>p.code==="TEST-XCH").length,1);
  assert.equal(afterExchange.assignments.filter(a=>a.activityId===importedTask.id&&a.employeeId===sara).length,1);
  const importedAssignment=afterExchange.assignments.find(a=>a.activityId===importedTask.id&&a.employeeId===sara);
  assert.equal(afterExchange.assignmentPeriods.filter(p=>p.assignmentId===importedAssignment.id).length,1);
  assert.ok(afterExchange.projectMembers.some(p=>p.employeeId===sara&&p.projectId===importedProject.id));
 });
 await ok(admin,exchangeUrl,{rows:[multiProjectRow],commit:true});
 const afterRepeat=await ok(admin,"/api/data");
 check("Importing same activity twice is idempotent",()=>{
  assert.equal(afterRepeat.activities.filter(a=>a.projectId===importedProject.id&&a.code==="XCH-01").length,1);
  assert.equal(afterRepeat.assignments.filter(a=>a.activityId===importedTask.id&&a.employeeId===sara).length,1);
 });
 const noCsv=await api(admin,"/api/data",{action:"import",rows:[multiProjectRow]},{retryKnownDenied:true});
 check("Legacy CSV import cannot bypass the reviewed exchange workflow",()=>assert.equal(noCsv.status,410));
 const managerState=await ok(manager,"/api/data");
 check("GROUP MANAGER role is retained with real employee identity",()=>{
  assert.equal(managerState.viewer.isGroupManager,true);
  assert.equal(managerState.viewer.employeeId,anna);
 });
 const managerCatalog=await ok(manager,"/api/quick-activity");
 check("GROUP MANAGER sees project they joined, not all organization projects",()=>{
  assert.ok(managerCatalog.projects.some(p=>p.id===1));
  assert.ok(!managerCatalog.projects.some(p=>p.id===3));
 });
 const managerGroup=await ok(manager,`/api/quick-activity?projectId=1&context=group&contextId=${anna}`);
 check("GROUP MANAGER may propose to direct reports who share a project",()=>{
  assert.equal(managerGroup.allowed,true);
  assert.ok(managerGroup.eligibleRecipients.some(p=>p.id===sara));
 });
 const leaderCatalog=await ok(leader,"/api/quick-activity");
 check("PROJECT LEADER sees every project they participate in",()=>{
  assert.ok(leaderCatalog.projects.some(p=>p.id===1));
  assert.ok(leaderCatalog.projects.some(p=>p.id===2));
 });
 const teamCatalog=await ok(leader,`/api/quick-activity?projectId=1&context=team&contextId=${team.id}`);
 check("TEAM LEADER can propose to TEAM member on shared project",()=>{
  assert.equal(teamCatalog.allowed,true);
  assert.ok(teamCatalog.eligibleRecipients.some(e=>e.id===sara));
  assert.ok(!teamCatalog.eligibleRecipients.some(e=>e.id===johan));
 });
 const normalCatalog=await ok(ordinary,"/api/quick-activity");
 check("ORDINARY STAFF sees own projects but not unrelated projects",()=>{
  assert.ok(normalCatalog.projects.some(p=>p.id===1));
  assert.ok(!normalCatalog.projects.some(p=>p.id===2));
 });
 const deniedProject=await api(ordinary,"/api/quick-activity",{projectId:2,recipientId:erik,name:"Förbjudet annan projekttillhörighet",
  description:"Ska nekas",startDate:"2026-11-10",endDate:"2026-11-20",effortPercent:30},{retryKnownDenied:true});
 check("ORDINARY STAFF cannot bypass project membership with direct POST",()=>assert.equal(deniedProject.status,403));
 const ordinarySelf=await ok(ordinary,"/api/quick-activity",{projectId:1,name:"Egen rolltest aktivitet",
  description:"Egen aktivitet av vanlig anställd",startDate:"2026-11-10",endDate:"2026-11-20",effortPercent:20});
 const ordinaryAfter=await ok(ordinary,"/api/data");
 check("ORDINARY STAFF can allocate work to self",()=>{
  assert.equal(ordinarySelf.proposal,false);
  assert.ok(ordinaryAfter.assignments.some(a=>a.activityId===ordinarySelf.activityId&&a.employeeId===sara));
 });
 const managerProposal=await ok(manager,"/api/quick-activity",{projectId:1,recipientId:erik,name:"Gruppchef föreslår jobb",
  description:"Ska godkännas av mottagaren",startDate:"2026-11-10",endDate:"2026-11-20",effortPercent:30});
 check("GROUP MANAGER can create pending request to project participant",()=>assert.equal(managerProposal.proposal,true));
 const leaderSelf=await ok(leader,"/api/quick-activity",{projectId:1,name:"Ledare egen aktivitet",
  description:"Ledaren får arbeta själv",startDate:"2026-11-10",endDate:"2026-11-20",effortPercent:15});
 check("PROJECT LEADER can create own activity",()=>assert.equal(leaderSelf.proposal,false));
 const adminSelf=await ok(admin,"/api/quick-activity",{projectId:3,name:"Admin egen aktivitet utan projektmedlemskap",
  description:"Admin som organisatorisk medarbetare",startDate:"2026-11-10",endDate:"2026-11-20",effortPercent:25});
 const adminAfterSelf=await ok(admin,"/api/data");
 check("ADMIN can allocate activity to self in any project",()=>{
  assert.equal(adminSelf.proposal,false);
  assert.ok(adminAfterSelf.assignments.some(a=>a.activityId===adminSelf.activityId&&a.employeeId===adminPerson.id));
 });
 // Johan has an assignment in project 1, so project 3 is the actual outside-project case.
 check("Outside-project recipient has no existing project 3 membership or assignment",()=>{
  assert.ok(!adminAfterSelf.projectMembers.some(m=>m.projectId===3&&m.employeeId===johan));
  assert.ok(!adminAfterSelf.assignments.some(a=>a.employeeId===johan&&adminAfterSelf.activities.some(t=>t.id===a.activityId&&t.projectId===3)));
 });
 const adminProposal=await ok(admin,"/api/quick-activity",{projectId:3,recipientId:johan,name:"Admin föreslår jobb till extern deltagare",
  description:"Mottagaren måste godkänna innan bemanning",startDate:"2026-11-10",endDate:"2026-11-20",effortPercent:35});
 const pending=await ok(admin,"/api/data");
 check("ADMIN can propose to other employee but cannot assign without consent",()=>{
  assert.equal(adminProposal.proposal,true);
  assert.equal(pending.assignments.some(a=>a.activityId===adminProposal.activityId&&a.employeeId===johan),false);
 });
 const inbox=await ok(nonmember,"/api/requests");
 const pendingRequest=inbox.requests.find(r=>r.activityId===adminProposal.activityId&&r.recipientId===johan&&r.status==="pending");
 check("Recipient sees proposal addressed to them",()=>assert.ok(pendingRequest));
 const illegalApproval=await api(admin,"/api/requests",{action:"answer",id:pendingRequest.id,approve:true},{retryKnownDenied:true});
 check("ADMIN cannot approve proposal on someone else's behalf",()=>assert.equal(illegalApproval.status,403));
 await ok(nonmember,"/api/requests",{action:"answer",id:pendingRequest.id,approve:true});
 const approved=await ok(admin,"/api/data");
 check("Accepted ADMIN proposal adds project membership and exactly one allocation",()=>{
  assert.equal(approved.assignments.filter(a=>a.activityId===adminProposal.activityId&&a.employeeId===johan).length,1);
  assert.ok(approved.projectMembers.some(m=>m.projectId===3&&m.employeeId===johan));
 });
 // Fallback for real-world legacy administrators: a separate login owns the
 // SAME person record, while the old administrator login keeps its privileges.
 const deniedWorkLogin=await api(ordinary,"/api/access",{action:"createPersonalLogin",employeeId:sara,
  email:"new-staff@example.se",password:"A long temporary passphrase 2026",isGroupManager:false,projectIds:[1]},{retryKnownDenied:true});
 check("ORDINARY STAFF cannot create personal logins",()=>assert.equal(deniedWorkLogin.status,403));
 const duplicateWorker=await api(admin,"/api/access",{action:"createPersonalLogin",employeeId:sara,
  email:"sara-second@example.se",password:"A long temporary passphrase 2026",projectIds:[1]},{retryKnownDenied:true});
 check("ADMIN cannot steal a person from an existing standard login",()=>assert.equal(duplicateWorker.status,409));
 const identityBeforeSplit=await ok(admin,"/api/access");
 const staffBeforeSplit=approved.employees.filter(e=>e.id===adminPerson.id);
 const split=await ok(admin,"/api/access",{action:"createPersonalLogin",employeeId:adminPerson.id,
  email:"role-admin-work@example.se",password:password,isGroupManager:true,isProjectLeader:true,projectIds:[2,3]});
 assert.match(split.message,/Arbetskonto skapat/);
 const adminAfterSplit=await ok(admin,"/api/access");
 check("Existing ADMIN login survives splitting into separate work account",()=>{
  assert.equal(identityBeforeSplit.viewer.employeeId,adminPerson.id);
  assert.equal(adminAfterSplit.viewer.isAdmin,true);
  assert.equal(adminAfterSplit.viewer.employeeId,null);
  assert.equal(adminAfterSplit.accounts.filter(x=>x.employeeId===adminPerson.id).length,1);
  assert.equal(adminAfterSplit.accounts.find(x=>x.email==="role-admin-work@example.se")?.isAdmin,0);
 });
 const workCookie=await connected("role-admin-work@example.se");
 const workSnapshot=await ok(workCookie,"/api/data");
 const workProjects=await ok(workCookie,"/api/quick-activity");
 check("New non-admin work login sees existing employee and projects",()=>{
  assert.equal(workSnapshot.viewer.employeeId,adminPerson.id);
  assert.equal(workSnapshot.viewer.isAdmin,false);
  assert.equal(workSnapshot.viewer.isGroupManager,true);
  assert.equal(workSnapshot.employees.filter(e=>e.id===adminPerson.id).length,1);
  assert.equal(staffBeforeSplit.length,1);
  assert.ok(workProjects.projects.some(p=>p.id===3));
  assert.ok(workProjects.projects.some(p=>p.id===2));
  assert.ok(workSnapshot.projectLeaders.some(p=>p.projectId===2&&p.employeeId===adminPerson.id));
  assert.ok(workSnapshot.assignments.some(a=>a.activityId===adminSelf.activityId&&a.employeeId===adminPerson.id));
 });
 const workProjectTwo=await ok(workCookie,"/api/quick-activity?projectId=2");
 check("New work login can create tasks in newly selected project",()=>assert.equal(workProjectTwo.allowed,true));
 const workSelf=await ok(workCookie,"/api/quick-activity",{projectId:3,name:"Egen aktivitet med separerat arbetskonto",
  description:"Historiken följer samma medarbetare",startDate:"2026-11-10",endDate:"2026-11-20",effortPercent:35});
 check("New work login can create own activity immediately",()=>assert.equal(workSelf.proposal,false));
 const workOther=await ok(workCookie,"/api/quick-activity",{projectId:3,recipientId:johan,
  name:"Arbetskonto föreslår aktivitet",description:"Mottagaren ska godkänna",startDate:"2026-11-10",endDate:"2026-11-20",effortPercent:30});
 check("New work login can propose work to project member",()=>assert.equal(workOther.proposal,true));
 const workProposalBeforeApproval=await ok(admin,"/api/data");
 check("New work login does not bypass recipient approval",()=>{
  assert.ok(!workProposalBeforeApproval.assignments.some(a=>a.activityId===workOther.activityId&&a.employeeId===johan));
 });
 // Password reset must target the separate personal login, preserving its
 // distinct email and leaving the administrator account untouched.
 const changedWorkPassword="New-Dedicated-Work-Password!2026";
 await ok(admin,"/api/access",{action:"setEmployeePassword",employeeId:adminPerson.id,password:changedWorkPassword});
 const oldWorkSession=await api(workCookie,"/api/data");
 check("Resetting work login password invalidates previous work sessions",()=>assert.equal(oldWorkSession.status,401));
 const originalWorkLogin=await api("","/api/auth",{action:"login",email:"role-admin-work@example.se",password},{retryKnownDenied:true});
 check("Old work password is revoked",()=>assert.equal(originalWorkLogin.status,401));
 const recoveredAuth=await api("","/api/auth",{action:"login",email:"role-admin-work@example.se",password:changedWorkPassword});
 check("Dedicated work login can reset password without claiming admin email",()=>assert.equal(recoveredAuth.status,200));
 const afterResetAccounts=await ok(admin,"/api/access");
 check("Admin account remains administrator after work password reset",()=>{
  assert.equal(afterResetAccounts.accounts.find(x=>x.email==="role-admin@example.se")?.isAdmin,1);
  assert.equal(afterResetAccounts.accounts.find(x=>x.email==="role-admin-work@example.se")?.employeeId,adminPerson.id);
 });
 const badPassword=await api(admin,"/api/access",{action:"createPersonalLogin",employeeId:anna,
  email:"weak@example.se",password:"short",projectIds:[1]},{retryKnownDenied:true});
 check("Password shorter than 12 characters is denied for new login",()=>assert.equal(badPassword.status,400));
 const workConflict=await api(admin,"/api/access",{action:"createPersonalLogin",employeeId:adminPerson.id,
  email:"another-personal@example.se",password:password,projectIds:[1]},{retryKnownDenied:true});
 check("Admin cannot duplicate the existing personal account",()=>assert.equal(workConflict.status,409));

 // Work-time reporting regression suite, using the SAME isolated database.
 const anonymousTime=await api("","/api/time-entries");
 check("Anonymous staff cannot read logged work hours",()=>assert.equal(anonymousTime.status,401));
 const unlinkedTime=await api(admin,"/api/time-entries");
 check("Admin account without employee identity cannot report work time",()=>assert.equal(unlinkedTime.status,403));
 const timeBefore=await ok(ordinary,"/api/time-entries");
 check("Staff time reporting offers only authorized activities",()=>{
  assert.ok(timeBefore.activities.some(a=>a.projectId===1));
  assert.ok(!timeBefore.activities.some(a=>a.projectId===2));
 });
 await ok(ordinary,"/api/time-entries",{action:"start",activityId:1});
 const timeRunning=await ok(ordinary,"/api/time-entries");
 const ticking=timeRunning.entries.find(e=>e.activityId===1&&e.endedAt===null);
 check("Start creates persistent timer for own employee",()=>{
  assert.ok(ticking);
  assert.equal(ticking.employeeId,sara);
  assert.ok(Math.abs(ticking.startedAt-timeRunning.serverTime)<5);
 });
 const duplicateTimer=await api(ordinary,"/api/time-entries",{action:"start",activityId:1},{retryKnownDenied:true});
 check("Only one active timer can exist per employee",()=>assert.equal(duplicateTimer.status,409));
 const foreignStop=await api(leader,"/api/time-entries",{action:"stop",id:ticking.id},{retryKnownDenied:true});
 check("Other employee cannot stop a colleague's timer",()=>assert.equal(foreignStop.status,409));
 const forbiddenTimeActivity=await api(ordinary,"/api/time-entries",{action:"manual",activityId:2,workDate:"2026-11-02",durationMinutes:30},{retryKnownDenied:true});
 check("Staff cannot log hours on unauthorized projects",()=>assert.equal(forbiddenTimeActivity.status,403));
 await ok(ordinary,"/api/time-entries",{action:"stop",id:ticking.id});
 const timeStopped=await ok(ordinary,"/api/time-entries");
 check("Stopped timer stores closed interval with duration",()=>{
  const entry=timeStopped.entries.find(e=>e.id===ticking.id);
  assert.ok(entry.endedAt!==null);
  assert.ok(entry.durationSeconds>=1);
 });
 const otherView=await ok(leader,"/api/time-entries");
 check("Individual staff cannot read another person's tracked time",()=>assert.ok(!otherView.entries.some(e=>e.id===ticking.id)));
 const otherChange=await api(leader,"/api/time-entries",{action:"update",id:ticking.id,workDate:"2026-11-02",durationMinutes:60},{retryKnownDenied:true});
 check("Individual staff cannot modify another person's hours",()=>assert.equal(otherChange.status,404));
 await ok(ordinary,"/api/time-entries",{action:"update",id:ticking.id,workDate:"2026-11-02",durationMinutes:90,note:"Korrigerade timmar"});
 const correctedTime=await ok(ordinary,"/api/time-entries");
 check("Recorded time may be corrected afterwards with work date and note",()=>{
  const entry=correctedTime.entries.find(e=>e.id===ticking.id);
  assert.equal(entry.workDate,"2026-11-02");
  assert.equal(entry.durationSeconds,5400);
  assert.equal(entry.note,"Korrigerade timmar");
  assert.equal(entry.source,"adjusted");
 });
 await ok(ordinary,"/api/time-entries",{action:"manual",activityId:1,workDate:"2026-11-03",durationMinutes:75,note:"Manuellt projektarbete"});
 const manualTime=(await ok(ordinary,"/api/time-entries")).entries.find(e=>e.source==="manual");
 check("Manual reporting works alongside timer entries",()=>{
  assert.ok(manualTime);
  assert.equal(manualTime.durationSeconds,4500);
  assert.equal(manualTime.workDate,"2026-11-03");
 });
 const anonymousDelete=await api(leader,"/api/time-entries",{action:"delete",id:manualTime.id},{retryKnownDenied:true});
 check("Other employees cannot delete time reporting history",()=>assert.equal(anonymousDelete.status,404));
 await ok(ordinary,"/api/time-entries",{action:"delete",id:manualTime.id});
 const afterDelete=(await ok(ordinary,"/api/time-entries")).entries;
 check("Deleted hours remain audited but disappear from personal totals",()=>assert.ok(!afterDelete.some(e=>e.id===manualTime.id)));
 const protectedStaff=await fetch(base+"/api/data?type=employee&id="+sara,{method:"DELETE",headers:{cookie:admin}});
 const protectedActivity=await fetch(base+"/api/data?type=activity&id=1",{method:"DELETE",headers:{cookie:admin}});
 const protectedProject=await fetch(base+"/api/data?type=project&id=1",{method:"DELETE",headers:{cookie:admin}});
 check("Reported time protects staff, activity and project from destructive deletion",()=>{
  assert.equal(protectedStaff.status,409);
  assert.equal(protectedActivity.status,409);
  assert.equal(protectedProject.status,409);
 });
 const csvResp=await fetch(base+"/api/time-entries?format=csv",{headers:{cookie:await connected("sara@example.se")}});
 const csvOutput=await csvResp.text();
 check("Time export includes stable entry identifiers, work dates and deletions",()=>{
  assert.equal(csvResp.status,200);
  assert.match(csvResp.headers.get("content-type"),/text\/csv/);
  assert.match(csvOutput,/entry_id/);
  assert.match(csvOutput,/2026-11-02/);
  assert.match(csvOutput,/deleted/);
  assert.match(csvOutput,/Korrigerade timmar/);
 });
 const workTimer=await ok(await (async()=>{const r=await api("","/api/auth",{action:"login",email:"role-admin-work@example.se",password:changedWorkPassword});assert.equal(r.status,200);return (await fetch(base+"/api/auth",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"login",email:"role-admin-work@example.se",password:changedWorkPassword})})).headers.get("set-cookie")?.split(";")[0]})(),"/api/time-entries",{action:"manual",activityId:workSelf.activityId,workDate:"2026-11-04",durationMinutes:20});
 check("Separated personal work login may time-report on its own activity",()=>assert.equal(workTimer.ok,true));


 // Regression: deletion must clean *every* dependent planning relation, not
 // just assignments. This previously caused HTTP 500 / "Kunde inte ta bort posten".
 const deleteProjectCode="DEL-REFS-TEST";
 const deleteProjectState=await ok(admin,"/api/data",{action:"project",code:deleteProjectCode,name:"Isolerat raderingstest",description:"Endast automatisk test",priority:3});
 const deleteProject=deleteProjectState.projects.find(p=>p.code===deleteProjectCode);
 assert.ok(deleteProject?.id);
 const withWork=await ok(admin,"/api/data",{action:"workPackage",projectId:deleteProject.id,code:"UP-DEL",name:"Uppdrag raderingstest"});
 const deleteWork=withWork.workPackages.find(w=>w.projectId===deleteProject.id&&w.code==="UP-DEL");
 assert.ok(deleteWork?.id);
 await ok(admin,"/api/data",{action:"setSingleProjectMember",projectId:deleteProject.id,employeeId:sara,enabled:true});
 await ok(admin,"/api/access",{action:"setProjectLeader",projectId:deleteProject.id,employeeId:erik,enabled:true});
 const newActivity=async(name,parentActivityId=null,workPackageId=deleteWork.id)=>{
  const current=await ok(admin,"/api/data",{action:"activity",projectId:deleteProject.id,workPackageId,parentActivityId,name,description:"Kontrollerar säker borttagning av relaterad planering",startDate:"2026-11-06",endDate:"2026-11-30",estimatedHours:20,status:"Planerad"});
  const found=current.activities.find(a=>a.name===name&&a.projectId===deleteProject.id);
  assert.ok(found?.id,"New activity missing: "+name);
  return found.id;
 };
 const parentToRemove=await newActivity("DEL-TEST parent");
 const childToRemove=await newActivity("DEL-TEST child",parentToRemove);
 await ok(admin,"/api/data",{action:"setActivityAssignments",activityId:childToRemove,resources:[{employeeId:sara,effortPercent:40}]});
 await ok(admin,"/api/data",{action:"setAssignmentPeriods",activityId:childToRemove,employeeId:sara,periods:[
  {startDate:"2026-11-06",endDate:"2026-11-12",effortPercent:40},
  {startDate:"2026-11-13",endDate:"2026-11-30",effortPercent:60}
 ]});
 const productionEquivalentDB=await onlyDatabase(join(dir,"data"));
 const addRelations=(activityId,token)=>{
  const rw=new DatabaseSync(productionEquivalentDB);
  try{
   rw.exec("PRAGMA busy_timeout=5000");
   rw.prepare("INSERT INTO individual_form_items(item_uid,employee_id,activity_id,first_week,current_week) VALUES(?,?,?,?,?)").run(token,sara,activityId,"2026-W45","2026-W45");
   rw.prepare("INSERT INTO individual_week_moves(item_uid,from_week,to_week,reason) VALUES(?,?,?,?)").run(token,"2026-W45","2026-W46","CI-raderingstest");
   rw.prepare("INSERT OR REPLACE INTO individual_project_state(employee_id,project_id,state) VALUES(?,?,?)").run(sara,deleteProject.id,"Aktiv");
   rw.prepare("INSERT OR REPLACE INTO employee_project_orders(employee_id,project_id,sort_order) VALUES(?,?,?)").run(sara,deleteProject.id,0);
   rw.prepare("INSERT INTO activity_priority_history(activity_id,effective_from,priority,source) VALUES(?,?,?,?)").run(activityId,"2026-11-06",2,"excel");
   rw.prepare("INSERT INTO assignment_requests(activity_id,requested_by,recipient_id,effort_percent,start_date,end_date,status) VALUES(?,?,?,?,?,?,?)").run(activityId,erik,sara,30,"2026-11-06","2026-11-30","pending");
  }finally{rw.close()}
 };
 addRelations(childToRemove,"CI-DEL-CHILD-"+childToRemove);
 const delParentResponse=await fetch(base+"/api/data?type=activity&id="+parentToRemove,{method:"DELETE",headers:{cookie:admin}});
 const delParentRaw=await delParentResponse.text();
 check("Removing parent activity clears descendant assignments, periods, forms, moves, requests and priority history",()=>{
  assert.equal(delParentResponse.status,200,delParentRaw.slice(0,600));
 });
 // Create an unrelated activity with its own relations to exercise project delete.
 const remainingActivity=await newActivity("DEL-TEST project childless");
 await ok(admin,"/api/data",{action:"setActivityAssignments",activityId:remainingActivity,resources:[{employeeId:sara,effortPercent:25}]});
 addRelations(remainingActivity,"CI-DEL-PROJECT-"+remainingActivity);
 const deleteProjectResponse=await fetch(base+"/api/data?type=project&id="+deleteProject.id,{method:"DELETE",headers:{cookie:admin}});
 const deleteProjectRaw=await deleteProjectResponse.text();
 check("Removing a project clears planning relations, members, leaders and work package",()=>{
  assert.equal(deleteProjectResponse.status,200,deleteProjectRaw.slice(0,600));
 });
 const deletedDb=new DatabaseSync(productionEquivalentDB,{readOnly:true});
 try{
  check("Deletion leaves no orphaned refs in the actual D1 SQLite test database",()=>{
   for(const activityId of [parentToRemove,childToRemove,remainingActivity]){
    assert.equal(deletedDb.prepare("SELECT COUNT(*) n FROM activities WHERE id=?").get(activityId).n,0);
    assert.equal(deletedDb.prepare("SELECT COUNT(*) n FROM individual_form_items WHERE activity_id=?").get(activityId).n,0);
    assert.equal(deletedDb.prepare("SELECT COUNT(*) n FROM assignment_requests WHERE activity_id=?").get(activityId).n,0);
    assert.equal(deletedDb.prepare("SELECT COUNT(*) n FROM activity_priority_history WHERE activity_id=?").get(activityId).n,0);
   }
   assert.equal(deletedDb.prepare("SELECT COUNT(*) n FROM project_members WHERE project_id=?").get(deleteProject.id).n,0);
   assert.equal(deletedDb.prepare("SELECT COUNT(*) n FROM employee_project_orders WHERE project_id=?").get(deleteProject.id).n,0);
   assert.equal(deletedDb.prepare("SELECT COUNT(*) n FROM individual_project_state WHERE project_id=?").get(deleteProject.id).n,0);
   assert.equal(deletedDb.prepare("SELECT COUNT(*) n FROM work_packages WHERE project_id=?").get(deleteProject.id).n,0);
   assert.equal(deletedDb.prepare("PRAGMA foreign_key_check").all().length,0);
  });
 }finally{deletedDb.close()}


 // ADMIN reconciliation of historical time before removing source projects.
 const makeTemporaryProject=async(code,name)=>{
  const created=await ok(admin,"/api/data",{action:"project",code,name,description:"Admin time reconciliation CI",priority:3});
  const project=created.projects.find(p=>p.code===code);
  assert.ok(project?.id,"Test project not created");
  await ok(admin,"/api/data",{action:"setSingleProjectMember",projectId:project.id,employeeId:sara,enabled:true});
  const state=await ok(admin,"/api/data",{action:"activity",projectId:project.id,name:"Tid att flytta "+code,description:"Admin tidflytt test",startDate:"2026-11-01",endDate:"2026-11-28",status:"Planerad"});
  const activity=state.activities.find(a=>a.projectId===project.id&&a.name==="Tid att flytta "+code);
  assert.ok(activity?.id,"Test activity not created");
  return {projectId:project.id,activityId:activity.id};
 };
 const from=await makeTemporaryProject("CI-TIME-XFER","CI Tidflytt");
 await ok(ordinary,"/api/time-entries",{action:"manual",activityId:from.activityId,workDate:"2026-11-05",durationMinutes:67,note:"ci-transfer-original"});
 const original=(await ok(ordinary,"/api/time-entries")).entries.find(x=>x.note==="ci-transfer-original");
 assert.ok(original?.id,"Source time missing");
 const deniedImpact=await fetch(base+`/api/delete-impact?type=project&id=${from.projectId}`,{headers:{cookie:ordinary}});
 check("Non-admin cannot inspect organizational time-deletion preview",()=>assert.equal(deniedImpact.status,403));
 const preview=await ok(admin,`/api/delete-impact?type=project&id=${from.projectId}`);
 check("Admin sees time count, hours and safe destinations before deletion",()=>{
  assert.equal(preview.impact.entryCount,1);
  assert.equal(preview.impact.totalSeconds,4020);
  assert.ok(preview.targets.some(t=>t.id===2));
  assert.ok(!preview.targets.some(t=>t.id===from.activityId));
 });
 const unconfirmed=await fetch(base+`/api/data?type=project&id=${from.projectId}`,{method:"DELETE",headers:{cookie:admin}});
 check("Project with time cannot be deleted without choosing relocation or archival removal",()=>assert.equal(unconfirmed.status,409));
 const transferParams=new URLSearchParams({type:"project",id:String(from.projectId),timeMode:"transfer",
  targetActivityId:"2",expectedFingerprint:preview.impact.fingerprint});
 const movedResponse=await fetch(base+"/api/data?"+transferParams,{method:"DELETE",headers:{cookie:admin}});
 const movedRaw=await movedResponse.text();
 check("Administrator can move historical time to another project before removing source project",()=>{
  assert.equal(movedResponse.status,200,movedRaw.slice(0,550));
 });
 const moved= (await ok(ordinary,"/api/time-entries")).entries.find(x=>x.id===original.id);
 check("Transferred time retains original employee, work date and duration",()=>{
  assert.ok(moved);assert.equal(moved.activityId,2);
  assert.equal(moved.durationSeconds,4020);assert.equal(moved.workDate,"2026-11-05");
 });
 const toPurge=await makeTemporaryProject("CI-TIME-PURGE","CI Radera tid");
 await ok(ordinary,"/api/time-entries",{action:"manual",activityId:toPurge.activityId,workDate:"2026-11-05",durationMinutes:14,note:"ci-purge-original"});
 const purgeOriginal=(await ok(ordinary,"/api/time-entries")).entries.find(x=>x.note==="ci-purge-original");
 assert.ok(purgeOriginal?.id);
 const allRows=await ok(admin,"/api/time-entries?scope=all");
 check("ADMIN can view all employees' reported time",()=>assert.ok(allRows.entries.some(x=>x.id===purgeOriginal.id&&x.employeeId===sara)));
 await ok(admin,"/api/time-entries",{action:"adminDelete",id:purgeOriginal.id});
 const afterAdminSoftDelete=(await ok(ordinary,"/api/time-entries")).entries;
 check("ADMIN can audit-soft-delete colleague's finished report",()=>assert.ok(!afterAdminSoftDelete.some(x=>x.id===purgeOriginal.id)));
 const previewPurge=await ok(admin,`/api/delete-impact?type=project&id=${toPurge.projectId}`);
 check("Soft-deleted time also remains protected until explicitly resolved",()=>{
  assert.equal(previewPurge.impact.entryCount,1);
  assert.equal(previewPurge.impact.deletedEntryCount,1);
 });
 const purgeParams=new URLSearchParams({type:"project",id:String(toPurge.projectId),timeMode:"purge",
  expectedFingerprint:previewPurge.impact.fingerprint,confirm:"RADERA TID"});
 const incomplete=await fetch(base+"/api/data?"+new URLSearchParams({type:"project",id:String(toPurge.projectId),timeMode:"purge",expectedFingerprint:previewPurge.impact.fingerprint}),{method:"DELETE",headers:{cookie:admin}});
 check("Permanent removal requires an explicit typed confirmation",()=>assert.equal(incomplete.status,400));
 const purgedResponse=await fetch(base+"/api/data?"+purgeParams,{method:"DELETE",headers:{cookie:admin}});
 const purgedRaw=await purgedResponse.text();
 check("Administrator can archive reported time, issue tombstone and then remove project",()=>{
  assert.equal(purgedResponse.status,200,purgedRaw.slice(0,500));
 });
 const afterReconcileDb=new DatabaseSync(await onlyDatabase(join(dir,"data")),{readOnly:true});
 try{
  check("Time relocation history and permanent removal archive survive source-project deletion",()=>{
   const transfer=afterReconcileDb.prepare("SELECT * FROM time_entry_relocations WHERE entry_id=?").get(original.id);
   assert.equal(transfer.original_activity_id,from.activityId);
   assert.equal(transfer.target_activity_id,2);
   assert.equal(transfer.actor_account_id>0,true);
   const rem=afterReconcileDb.prepare("SELECT * FROM time_entry_removal_archive WHERE original_entry_id=?").get(purgeOriginal.id);
   assert.ok(rem?.source_event_id>0);
   assert.equal(rem.original_activity_id,toPurge.activityId);
   assert.equal(afterReconcileDb.prepare("SELECT COUNT(*) n FROM time_entries WHERE id=?").get(purgeOriginal.id).n,0);
   assert.equal(afterReconcileDb.prepare("PRAGMA foreign_key_check").all().length,0);
  });
 }finally{afterReconcileDb.close()}


 // Re-check the scoped activity/subtree path with time: wrong targets and
 // concurrent changes must be rejected, running clocks must be stopped.
 const actSource=await makeTemporaryProject("CI-TIME-ACT","CI Radera aktivitetsgren");
 const firstChildState=await ok(admin,"/api/data",{action:"activity",projectId:actSource.projectId,parentActivityId:actSource.activityId,
  name:"CI child with time",description:"Undertest",startDate:"2026-11-01",endDate:"2026-11-28",status:"Planerad"});
 const actChild=firstChildState.activities.find(x=>x.name==="CI child with time"&&x.parentActivityId===actSource.activityId);
 assert.ok(actChild?.id);
 await ok(ordinary,"/api/time-entries",{action:"manual",activityId:actChild.id,workDate:"2026-11-06",durationMinutes:23,note:"ci-subtree-transfer"});
 const actPreview=await ok(admin,`/api/delete-impact?type=activity&id=${actSource.activityId}`);
 check("Parent activity impact includes descendant time, excludes source and child as targets",()=>{
  assert.equal(actPreview.impact.entryCount,1);
  assert.ok(!actPreview.targets.some(x=>x.id===actSource.activityId||x.id===actChild.id));
 });
 const badTarget=await fetch(base+"/api/data?"+new URLSearchParams({type:"activity",id:String(actSource.activityId),
  timeMode:"transfer",expectedFingerprint:actPreview.impact.fingerprint,targetActivityId:String(actChild.id)}),{method:"DELETE",headers:{cookie:admin}});
 check("Transfer target inside a deleted activity subtree is rejected",()=>assert.equal(badTarget.status,409));
 await ok(ordinary,"/api/time-entries",{action:"manual",activityId:actChild.id,workDate:"2026-11-07",durationMinutes:31,note:"ci-subtree-stale"});
 const stale=await fetch(base+"/api/data?"+new URLSearchParams({type:"activity",id:String(actSource.activityId),
  timeMode:"transfer",expectedFingerprint:actPreview.impact.fingerprint,targetActivityId:"2"}),{method:"DELETE",headers:{cookie:admin}});
 check("Admin must refresh confirmation if newly reported time changed the impact",()=>assert.equal(stale.status,409));
 const livePreview=await ok(admin,`/api/delete-impact?type=activity&id=${actSource.activityId}`);
 await ok(ordinary,"/api/time-entries",{action:"start",activityId:actChild.id});
 const clockPreview=await ok(admin,`/api/delete-impact?type=activity&id=${actSource.activityId}`);
 const runningDelete=await fetch(base+"/api/data?"+new URLSearchParams({type:"activity",id:String(actSource.activityId),
  timeMode:"purge",expectedFingerprint:clockPreview.impact.fingerprint,confirm:"RADERA TID"}),{method:"DELETE",headers:{cookie:admin}});
 check("Running time capture prevents admin from deleting that activity",()=>assert.equal(runningDelete.status,409));
 const saraActive=(await ok(ordinary,"/api/time-entries")).entries.find(x=>x.activityId===actChild.id&&x.endedAt===null);
 assert.ok(saraActive?.id);
 await ok(ordinary,"/api/time-entries",{action:"stop",id:saraActive.id});
 const afterStop=await ok(admin,`/api/delete-impact?type=activity&id=${actSource.activityId}`);
 const deletedActivity=await fetch(base+"/api/data?"+new URLSearchParams({type:"activity",id:String(actSource.activityId),
  timeMode:"transfer",expectedFingerprint:afterStop.impact.fingerprint,targetActivityId:"2"}),{method:"DELETE",headers:{cookie:admin}});
 const deletedActivityBody=await deletedActivity.text();
 check("Parent and children with recorded hours can be removed after moving time",()=>{
  assert.equal(deletedActivity.status,200,deletedActivityBody.slice(0,800));
 });
 const afterActivityMove=new DatabaseSync(await onlyDatabase(join(dir,"data")),{readOnly:true});
 try{
  check("All descendant hours retain their employee and now reference the chosen destination",()=>{
   assert.equal(afterActivityMove.prepare("SELECT COUNT(*) n FROM activities WHERE id IN (?,?)").get(actSource.activityId,actChild.id).n,0);
   assert.equal(afterActivityMove.prepare("SELECT COUNT(*) n FROM time_entries WHERE activity_id=?").get(actChild.id).n,0);
   assert.equal(afterActivityMove.prepare("SELECT COUNT(*) n FROM time_entries WHERE employee_id=? AND activity_id=? AND work_date IN ('2026-11-06','2026-11-07')").get(sara,2).n>=2,true);
   assert.equal(afterActivityMove.prepare("PRAGMA foreign_key_check").all().length,0);
  });
 }finally{afterActivityMove.close()}
 const db=new DatabaseSync(await onlyDatabase(join(dir,"data")),{readOnly:true});
 try{
  check("Time adjustments are audited, including delete",()=>{
   const records=db.prepare("SELECT action,old_seconds,new_seconds FROM time_entry_audit WHERE time_entry_id=? ORDER BY id").all(ticking.id);
   assert.deepEqual(records.map(r=>r.action),["start","stop","update"]);
   assert.equal(records.at(-1).new_seconds,5400);
   const deleted=db.prepare("SELECT deleted_at FROM time_entries WHERE id=?").get(manualTime.id);
   assert.ok(deleted.deleted_at!==null);
  });
  check("All role tests preserve SQLite foreign keys",()=>assert.equal(db.prepare("PRAGMA foreign_key_check").all().length,0));
  check("All role tests preserve SQLite integrity",()=>assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check,"ok"));
 }finally{db.close()}
 console.log(`SUCCESS role-matrix: ${passes} independent permission and project-catalogue assertions passed; only ${dir} was modified.`);
}catch(error){
 console.error("FAILED role-matrix:",error);
 console.error("Test server log tail:\n"+logs.slice(-12000));
 process.exitCode=1;
}finally{
 try{process.kill(-server.pid,"SIGTERM")}catch{server.kill("SIGTERM")}
 await sleep(1100);
 try{process.kill(-server.pid,"SIGKILL")}catch{}
 await rm(dir,{recursive:true,force:true});
 console.log("Removed isolated role-matrix database",dir);
}
