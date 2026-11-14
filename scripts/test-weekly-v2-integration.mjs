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
 const snap=await call("/api/data");assert.equal(snap.status,200,JSON.stringify(snap.result));
 const erik=snap.result.employees.find(x=>x.name==="Erik Holm");assert.ok(erik);
 const activity=snap.result.activities.find(x=>x.name==="Systemdesign");assert.ok(activity);
 const row={week:"2026-V47",day:"Torsdag",task:activity.name,duration:"2 dagar",effort:50,
  workType:"Projekt",hours:8,status:"Planerad",priority:"3",deadline:"2026-12-01",
  projectCode:snap.result.projects.find(x=>x.id===activity.projectId).code,projectName:"",
  firstWeek:"2026-V47",comment:"test",moveReason:"",activityId:"activity-"+activity.id,
  rowKey:"ci-weekly-"+erik.id+"-"+activity.id,rowRevision:0};
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
 assert.deepEqual(after.result.assignmentPeriods,snap.result.assignmentPeriods,"Forecast must never overwrite historical assignment periods");
 assert.equal(after.result.weeklyPlanRows.length,1);
 assert.equal(after.result.weeklyPlanRowHistory.length,0,"Audit entries must not leak through generic snapshot");
 console.log("PASS weekly-v2 integration: auth, preview, commit, audit revision, stale conflict, idempotency, load history");
} catch(e){console.error(e);console.error(logs);process.exitCode=1}
finally{try{process.kill(-server.pid,"SIGTERM")}catch{server.kill("SIGTERM")}
 await sleep(800);try{process.kill(-server.pid,"SIGKILL")}catch{}
 await rm(dir,{recursive:true,force:true});}
