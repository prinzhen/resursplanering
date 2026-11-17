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
 assert.equal(bs.result.verified,true,JSON.stringify(bs.result));
 assert.equal(bs.result.registered.length,1);
 assert.ok(bs.result.registered[0].activityId>0);
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
 // Existing employee + new project + new activity is the main real-world flow.
 const knownPerson={name:newEmployee.name,email:newPerson.email,rows:[
  {...bootstrapRow,task:"Ny aktivitet i nytt projekt från Excel",duration:"1v3d",
   week:"2026-V47",firstWeek:"2026-V47",projectCode:"N.90991",projectName:"Andra nya projektet",hours:40},
 ]};
 let previewKnown=await call("/api/weekly-v2/bootstrap",{...knownPerson,commit:false});
 assert.equal(previewKnown.status,200,JSON.stringify(previewKnown.result));
 assert.equal(previewKnown.result.preview.employeesCreated,0);
 assert.equal(previewKnown.result.preview.projectsCreated,1);
 assert.equal(previewKnown.result.preview.activitiesCreated,1);
 let commitKnown=await call("/api/weekly-v2/bootstrap",{...knownPerson,commit:true});
 assert.equal(commitKnown.status,200,JSON.stringify(commitKnown.result));
 assert.equal(commitKnown.result.verified,true,JSON.stringify(commitKnown.result));
 assert.equal(commitKnown.result.registered[0].projectCode,"N.90991");
 const afterKnown=await call("/api/data");
 const addedProject=afterKnown.result.projects.find(p=>p.code==="N.90991");
 assert.ok(addedProject,"New project must be in main project catalogue after personal Excel import");
 assert.equal(addedProject.name,"Andra nya projektet","New project should retain Excel display name");
 const addedTask=afterKnown.result.activities.find(a=>a.projectId===addedProject.id&&a.name==="Ny aktivitet i nytt projekt från Excel");
 assert.ok(addedTask,"New activity must appear under new project");
 assert.equal(addedTask.startDate,"2026-11-17");
 assert.equal(addedTask.endDate,"2026-11-26","1v3d = ten calendar days from Tuesday through Thursday");
 assert.ok(afterKnown.result.assignments.some(a=>a.activityId===addedTask.id&&a.employeeId===newEmployee.id),
  "New activity must be assigned to the existing employee");
 const afterKnownExport=await call("/api/individual?email="+encodeURIComponent(newPerson.email));
 assert.equal(afterKnownExport.status,200,JSON.stringify(afterKnownExport.result));
 assert.ok(afterKnownExport.result.activities.some(a=>a.name==="Ny aktivitet i nytt projekt från Excel"),
  "New activity must be visible in next personal export");
 // Unassigned new XLSX activities must be received without knowing a
 // project. Auto-create the planning instance's internal "Övrigt arbete".
 const unassigned={name:newEmployee.name,email:newPerson.email,rows:[
  {...bootstrapRow,task:"Okänt projekt – första aktiviteten",workType:"Projekt",projectCode:"",projectName:"",
   week:"2026-V47",firstWeek:"2026-V47",duration:"10d",hours:null},
  {...bootstrapRow,task:"Okänt projekt – andra aktiviteten",workType:"Projekt",projectCode:"",projectName:"",
   week:"2026-V48",firstWeek:"2026-V48",duration:"1v",hours:null},
 ]};
 const beforeUnknown=await call("/api/data");
 assert.equal(beforeUnknown.result.projects.filter(p=>p.code==="INTERNAL-OVR").length,0,"Test catch-all must not exist yet");
 const unknownPreview=await call("/api/weekly-v2/bootstrap",{...unassigned,commit:false});
 assert.equal(unknownPreview.status,200,JSON.stringify(unknownPreview.result));
 assert.equal(unknownPreview.result.preview.projectsCreated,1,"Catch-all should be created once");
 assert.equal(unknownPreview.result.preview.assignedToInternal,2);
 assert.equal(unknownPreview.result.preview.activitiesCreated,2);
 const unknownAfterPreview=await call("/api/data");
 assert.equal(unknownAfterPreview.result.projects.some(p=>p.code==="INTERNAL-OVR"),false,"Preview must not create catch-all");
 const unknownCommit=await call("/api/weekly-v2/bootstrap",{...unassigned,commit:true});
 assert.equal(unknownCommit.status,200,JSON.stringify(unknownCommit.result));
 assert.equal(unknownCommit.result.verified,true,JSON.stringify(unknownCommit.result));
 assert.equal(unknownCommit.result.registered.length,2);
 const unknownInbox=await call("/api/other-work-inbox");
 assert.equal(unknownInbox.status,200,JSON.stringify(unknownInbox.result));
 assert.equal(unknownInbox.result.readOnly,false);
 for(const activityName of unassigned.rows.map(r=>r.task)){
  assert.ok(unknownInbox.result.activities.some(a=>a.task===activityName&&a.employeeName===newEmployee.name),
   "A newly imported blank-project task must be visible in the Övrigt arbete inbox");
 }
 const unknownSaved=await call("/api/data");
 const catchAll=unknownSaved.result.projects.filter(p=>p.code==="INTERNAL-OVR");
 assert.equal(catchAll.length,1,"Only one internal catch-all is allowed per planning instance");
 assert.equal(catchAll[0].name,"Övrigt arbete");
 for(const activityName of unassigned.rows.map(r=>r.task)){
  const activity=unknownSaved.result.activities.find(a=>a.projectId===catchAll[0].id&&a.name===activityName);
  assert.ok(activity,"Unassigned activity must be visible for later project classification");
  assert.ok(unknownSaved.result.assignments.some(a=>a.activityId===activity.id&&a.employeeId===newEmployee.id));
 }
 const third={...unassigned,rows:[{...unassigned.rows[0],task:"Okänt projekt – tredje aktiviteten",week:"2026-V49",firstWeek:"2026-V49"}]};
 const nextPreview=await call("/api/weekly-v2/bootstrap",{...third,commit:false});
 assert.equal(nextPreview.status,200,JSON.stringify(nextPreview.result));
 assert.equal(nextPreview.result.preview.projectsCreated,0,"Internal project must be reused");
 assert.equal(nextPreview.result.preview.assignedToInternal,1);
 const nextCommit=await call("/api/weekly-v2/bootstrap",{...third,commit:true});
 assert.equal(nextCommit.status,200,JSON.stringify(nextCommit.result));
 assert.equal(nextCommit.result.verified,true);
 const repeatUnknown=await call("/api/weekly-v2/bootstrap",{...third,commit:true});
 assert.equal(repeatUnknown.status,200,JSON.stringify(repeatUnknown.result));
 const afterRepeat=await call("/api/data");
 assert.equal(afterRepeat.result.projects.filter(p=>p.code==="INTERNAL-OVR").length,1);
 assert.equal(afterRepeat.result.activities.filter(a=>a.projectId===catchAll[0].id&&a.name===third.rows[0].task).length,1,"Re-import must not duplicate unassigned task");
 // The inbox permits audited reclassification only for truly future-only
 // work. In-progress / historical activities must never be silently moved.
 const futureUnassigned={...unassigned,rows:[{
  ...unassigned.rows[0],task:"Framtida aktivitet för projektklassificering",
  week:"2027-V12",firstWeek:"2027-V12",duration:"2 veckor"
 }]};
 const futureSave=await call("/api/weekly-v2/bootstrap",{...futureUnassigned,commit:true});
 assert.equal(futureSave.status,200,JSON.stringify(futureSave.result));
 const futureActivityId=futureSave.result.registered[0].activityId;
 const originalOld=unknownSaved.result.activities.find(x=>x.name==="Okänt projekt – första aktiviteten");
 const historicalDenied=await call("/api/other-work-inbox",{
  activityId:originalOld.id,targetProjectId:newProject.id
 });
 assert.equal(historicalDenied.status,422,"Past-dated work must not change project history");
 const oldStill=await call("/api/data");
 assert.equal(oldStill.result.activities.find(x=>x.id===originalOld.id).projectId,catchAll[0].id);
 const classified=await call("/api/other-work-inbox",{
  activityId:futureActivityId,targetProjectId:newProject.id
 });
 assert.equal(classified.status,200,JSON.stringify(classified.result));
 assert.equal(classified.result.projectCode,newProject.code);
 const classificationSnapshot=await call("/api/data");
 assert.equal(classificationSnapshot.result.activities.find(x=>x.id===futureActivityId).projectId,newProject.id,
  "Only the future activity changes project");
 assert.equal(classificationSnapshot.result.activityProjectReclassifications.filter(x=>x.activityId===futureActivityId).length,1,
  "Project transfer must leave a durable audit row");
 assert.ok(classificationSnapshot.result.projectMembers.some(x=>x.projectId===newProject.id&&x.employeeId===newEmployee.id),
  "Recipient project must include the assigned employee");
 const replayClassification=await call("/api/other-work-inbox",{
  activityId:futureActivityId,targetProjectId:newProject.id
 });
 assert.equal(replayClassification.status,409,"Reclassification cannot silently replay");
 // A backup restore must retain the audit, not just the new project ID.
 const classificationRestore=await call("/api/data",{action:"restore",backup:{version:4,data:classificationSnapshot.result}});
 assert.equal(classificationRestore.status,200,JSON.stringify(classificationRestore.result));
 const afterClassificationRestore=await call("/api/data");
 assert.equal(afterClassificationRestore.result.activityProjectReclassifications.length,1,
  "Restoring a planning backup must restore project classification history");
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
 // A user's explicit estimate is authoritative even if their Excel was
 // exported before a later import; don't silently overwrite concurrent edits.
 const revisedEstimate={...row,week:"2026-V47",day:"Måndag",duration:"10d",rowRevision:1};
 const conflictPreview=await call("/api/weekly-v2",{employeeId:erik.id,rows:[revisedEstimate],commit:false});
 assert.equal(conflictPreview.status,200,JSON.stringify(conflictPreview.result));
 assert.equal(conflictPreview.result.preview.conflicts.length,1);
 assert.equal(conflictPreview.result.preview.conflicts[0].currentRevision,3);
 const deniedOverride=await call("/api/weekly-v2",{employeeId:erik.id,rows:[revisedEstimate],commit:true});
 assert.equal(deniedOverride.status,400,"A stale estimate requires explicit approval");
 const acceptedEstimate=await call("/api/weekly-v2",{employeeId:erik.id,rows:[revisedEstimate],commit:true,acceptStaleRevisions:true});
 assert.equal(acceptedEstimate.status,200,JSON.stringify(acceptedEstimate.result));
 const estimatedSnap=await call("/api/data");
 const estimatedTask=estimatedSnap.result.activities.find(x=>x.id===activity.id);
 assert.equal(estimatedTask.startDate,"2026-11-16","Excel week/day replaces former Gantt start");
 assert.equal(estimatedTask.endDate,"2026-11-25","Excel 10d updates Gantt end inclusive");
 assert.equal(estimatedSnap.result.weeklyPlanRows.find(x=>x.activityId===activity.id).revision,4);
 assert.equal(estimatedSnap.result.weeklyPlanRowHistory.length,4,"Override is retained in revision audit log");
 console.log("PASS weekly-v2 integration: auth, preview, commit, audit revision, stale conflict, idempotency, Gantt start/end synchronization, duration edits, backup, explicit stale-confirmed estimate");
} catch(e){console.error(e);console.error(logs);process.exitCode=1}
finally{try{process.kill(-server.pid,"SIGTERM")}catch{server.kill("SIGTERM")}
 await sleep(800);try{process.kill(-server.pid,"SIGKILL")}catch{}
 await rm(dir,{recursive:true,force:true});}
