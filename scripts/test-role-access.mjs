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

const dir=await mkdtemp(join(tmpdir(),"resursplanering-roles-"));
const port=32141,base=`http://127.0.0.1:${port}`;
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
async function api(cookie,path,body){
 const options={headers:{"accept":"application/json"}};
 if(cookie)options.headers.cookie=cookie;
 if(body!==undefined){
  options.method="POST";
  options.headers["content-type"]="application/json";
  options.body=JSON.stringify(body);
 }
 const response=await fetch(base+path,options);
 const raw=await response.text();
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
 if(!ready)throw Error("Isolated test server failed to become ready");
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
 const invalidBeforeLink=await api(admin,"/api/quick-activity",{projectId:1,name:"Nekad utan person",description:"Spårbarhet",startDate:"2026-11-10",endDate:"2026-11-20"});
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
  description:"Ska nekas",startDate:"2026-11-10",endDate:"2026-11-20",effortPercent:30});
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
 const adminProposal=await ok(admin,"/api/quick-activity",{projectId:1,recipientId:johan,name:"Admin föreslår jobb till extern deltagare",
  description:"Mottagaren måste godkänna innan bemanning",startDate:"2026-11-10",endDate:"2026-11-20",effortPercent:35});
 const pending=await ok(admin,"/api/data");
 check("ADMIN can propose to other employee but cannot assign without consent",()=>{
  assert.equal(adminProposal.proposal,true);
  assert.equal(pending.assignments.some(a=>a.activityId===adminProposal.activityId&&a.employeeId===johan),false);
 });
 const inbox=await ok(nonmember,"/api/requests");
 const pendingRequest=inbox.requests.find(r=>r.activityId===adminProposal.activityId&&r.recipientId===johan&&r.status==="pending");
 check("Recipient sees proposal addressed to them",()=>assert.ok(pendingRequest));
 const illegalApproval=await api(admin,"/api/requests",{action:"answer",id:pendingRequest.id,approve:true});
 check("ADMIN cannot approve proposal on someone else's behalf",()=>assert.equal(illegalApproval.status,403));
 await ok(nonmember,"/api/requests",{action:"answer",id:pendingRequest.id,approve:true});
 const approved=await ok(admin,"/api/data");
 check("Accepted ADMIN proposal adds project membership and exactly one allocation",()=>{
  assert.equal(approved.assignments.filter(a=>a.activityId===adminProposal.activityId&&a.employeeId===johan).length,1);
  assert.ok(approved.projectMembers.some(m=>m.projectId===1&&m.employeeId===johan));
 });
 const db=new DatabaseSync(await onlyDatabase(join(dir,"data")),{readOnly:true});
 try{
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
