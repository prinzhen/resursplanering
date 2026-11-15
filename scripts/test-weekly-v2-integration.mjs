import assert from "node:assert/strict";
import {spawn,spawnSync} from "node:child_process";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";

const dir=await mkdtemp(join(tmpdir(),"resursplanering-weekly-v2-"));
const port=32139,base="http://127.0.0.1:"+port;
const server=spawn(process.execPath,["scripts/start-selfhosted.mjs"],{
 env:{...process.env,DATA_DIR:join(dir,"data"),HOST:"127.0.0.1",PORT:String(port),CI:"true",NO_COLOR:"1"},
 detached:true,stdio:["ignore","pipe","pipe"]
});
let logs="",cookie="";
for(const stream of [server.stdout,server.stderr])stream.on("data",d=>{logs=(logs+String(d)).slice(-16000)});
const call=async(path,body)=>{
 const options=body===undefined?{}:{method:"POST",headers:{"content-type":"application/json","cookie":cookie},body:JSON.stringify(body)};
 if(body===undefined)options.headers={"cookie":cookie};
 const response=await fetch(base+path,options),result=await response.json();
 return {status:response.status,result};
};
try{
 let ready=false;for(let i=0;i<90;i++){
  if(server.exitCode!==null)throw Error("Server stopped: "+logs);
  try{const res=await fetch(base+"/api/auth",{signal:AbortSignal.timeout(1000)});if(res.ok){ready=true;break}}catch{}
  await sleep(1000);
 }
 assert.ok(ready,"Server not ready: "+logs);
 const pw="CI-weekly-v2-safe-passphrase";
 const account=spawnSync("python3",["scripts/provision-account.py","--data-dir",join(dir,"data"),"--email","ci-admin@example.se","--admin","--password-stdin"],{input:pw+"\n",encoding:"utf8"});
 assert.equal(account.status,0,account.stderr);
 assert.equal((await call("/api/weekly-v2?employeeId=1")).status,401,"Anonymous weekly planning must be protected");
 const auth=await fetch(base+"/api/auth",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"login",email:"ci-admin@example.se",password:pw})});
 assert.ok(auth.ok,await auth.text());cookie=(auth.headers.get("set-cookie")||"").split(";")[0];assert.match(cookie,/rp_session=/);
 const bootstrapRow={week:"2026-V40",day:"Tisdag",task:"Ny tio-veckorsaktivitet",duration:"10 veckor",
  effort:50,workType:"Projekt",hours:200,status:"Planerad",priority:"3",deadline:"",
  projectCode:"N.90990",projectName:"Nytt testprojekt",firstWeek:"2026-V40",
  comment:"",moveReason:"",activityId:"",rowKey:"",rowRevision:0};
 const newPerson={name:"Excel Person",email:"excel-person@example.se",rows:[bootstrapRow]};
 let bs=await call("/api/weekly-v2/bootstrap",{...newPerson,commit:false});
 assert.equal(bs.status,200,JSON.stringify(bs.result));
 assert.equal(bs.result.preview.employeesCreated,1);
 assert.equal(bs.result.preview.projectsCreated,1);
 assert.equal(bs.result.preview.activitiesCreated,1);
 let beforeBootstrap=await call("/api/data");
 assert.ok(!beforeBootstrap.result.employees.some(x=>x.email===newPerson.email),"Preview must not mutate database");
 bs=await call("/api/weekly-v2/bootstrap",{...newPerson,commit:true});
 assert.equal(bs.status,200,JSON.stringify(bs.result));
 const boot=await call("/api/data");
 const newEmployee=boot.result.employees.find(x=>x.email===newPerson.email);
 assert.ok(newEmployee,"V1 backend must create missing employee from personal v2 XLSX");
 const newProject=boot.result.projects.find(x=>x.code==="N.90990");
 assert.ok(newProject,"V1 backend must create project");
 const newActivity=boot.result.activities.find(x=>x.projectId===newProject.id&&x.name===bootstrapRow.task);
 assert.ok(newActivity,"V1 backend must create activity");
 assert.equal(newActivity.startDate,"2026-09-29");
 assert.equal(newActivity.endDate,"2026-12-07");
 assert.ok(boot.result.assignments.some(x=>x.activityId===newActivity.id&&x.employeeId===newEmployee.id));
 const snap=await call("/api/data");assert.equal(snap.status,200,JSON.stringify(snap.result));
 const erik=snap.result.employees.find(x=>x.name==="Erik Holm");assert.ok(erik);
 const activity=snap.result.activities.find(x=>x.name==="Systemdesign");assert.ok(activity);
 const row={week:"2026-V47",day:"Torsdag",task:activity.name,duration:"2 dagar",effort:50,
  workType:"Projekt",hours:8,status:"Planerad",priority:"3",deadline:"2026-12-01",
  projectCode:snap.result.projects.find(x=>x.id===activity.projectId).code,projectName:"",
  firstWeek:"2026-V47",comment:"test",moveReason:"",activityId:"activity-"+activity.id,
  rowKey:"plan-"+erik.id+"-"+activity.id,rowRevision:0};
 const payload={employeeId:erik.id,rows:[row]};
 let response=await call("/api/weekly-v2",{...payload,commit:false});
 assert.equal(response.status,200,JSON.stringify(response.result));
 assert.deepEqual(response.result.preview,{created:1,updated:0,unchanged:0});
 let saved=await call("/api/weekly-v2",{...payload,commit:true});assert.equal(saved.status,200,JSON.stringify(saved.result));
 response=await call("/api/weekly-v2?employeeId="+erik.id);
 assert.equal(response.status,200);assert.equal(response.result.rows.length,1);assert.equal(response.result.rows[0].revision,1);
 const changed={...row,comment:"changed",week:"2026-V48",rowRevision:1};
 saved=await call("/api/weekly-v2",{employeeId:erik.id,rows:[changed],commit:true});
 assert.equal(saved.status,200,JSON.stringify(saved.result));
 const stale=await call("/api/weekly-v2",{...payload,commit:true});assert.equal(stale.status,400);
 const updated=await call("/api/weekly-v2?employeeId="+erik.id);
 assert.equal(updated.result.rows[0].week,"2026-V48");assert.equal(updated.result.rows[0].revision,2);
 const repeat=await call("/api/weekly-v2",{employeeId:erik.id,rows:[{...changed,rowRevision:2}],commit:true});
 assert.deepEqual(repeat.result.preview,{created:0,updated:0,unchanged:1});
 const after=await call("/api/data");
 const shifted=after.result.activities.find(x=>x.id===activity.id);
 assert.equal(shifted.startDate,"2026-11-26","Changing start week must move Gantt start");
 assert.equal(shifted.endDate,"2026-11-27","Same duration must move Gantt end equally");
 assert.equal(after.result.assignments.find(x=>x.activityId===activity.id&&x.employeeId===erik.id).startDate,"2026-11-26","Resource assignment must follow moved Gantt start");
 const extended={...changed,duration:"10 veckor",rowRevision:2};
 const longSave=await call("/api/weekly-v2",{employeeId:erik.id,rows:[extended],commit:true});
 assert.equal(longSave.status,200,JSON.stringify(longSave.result));
 const longSnap=await call("/api/data");
 const longActivity=longSnap.result.activities.find(x=>x.id===activity.id);
 assert.equal(longActivity.startDate,"2026-11-26","Duration edit cannot change start date");
 assert.equal(longActivity.endDate,"2027-02-03","10 calendar weeks has inclusive end date");
 const currentExport=await call("/api/weekly-v2?employeeId="+erik.id);
 const mapped=currentExport.result.identities.find(x=>x.activityId===activity.id);
 assert.equal(mapped.startDate,"2026-11-26","Subsequent export must read moved Gantt start");
 assert.equal(mapped.endDate,"2027-02-03","Subsequent export must read extended Gantt end");
 assert.equal(longSnap.result.weeklyPlanRows.find(x=>x.activityId===activity.id).revision,3);

 assert.equal(after.result.weeklyPlanRows.length,1);
 assert.equal(longSnap.result.weeklyPlanRowHistory.length,3,"Audit records both moving and lengthening");
 const restoration=await call("/api/data",{action:"restore",backup:{version:4,data:longSnap.result}});
 assert.equal(restoration.status,200,JSON.stringify(restoration.result));
 assert.equal(restoration.result.weeklyPlanRows.length,1,"Backup restore preserves weekly rows");
 assert.equal(restoration.result.weeklyPlanRowHistory.length,3,"Backup restore preserves audit revision history");
 assert.equal(restoration.result.weeklyPlanRows[0].revision,3);
 console.log("PASS weekly-v2 integration: auth, preview, commit, audit revision, stale conflict, idempotency, Gantt start/end synchronization, duration edits, backup");
} catch(e){console.error(e);console.error(logs);process.exitCode=1}
finally{try{process.kill(-server.pid,"SIGTERM")}catch{server.kill("SIGTERM")}
 await sleep(800);try{process.kill(-server.pid,"SIGKILL")}catch{}
 await rm(dir,{recursive:true,force:true});}
