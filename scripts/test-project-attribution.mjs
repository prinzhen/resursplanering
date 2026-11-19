import assert from "node:assert/strict";
import {projectAtDate,projectSlices} from "../lib/project-attribution.ts";

const activityId=5,oldProject=10,newProject=20;
const events=[{id:1,activityId,sourceProjectId:oldProject,targetProjectId:newProject,effectiveFrom:"2026-11-19"}];
assert.deepEqual(projectSlices(newProject,activityId,"2026-11-02","2026-12-04",events),[
 {projectId:oldProject,start:"2026-11-02",end:"2026-11-18"},
 {projectId:newProject,start:"2026-11-19",end:"2026-12-04"},
]);
assert.equal(projectAtDate(newProject,activityId,"2026-11-18",events),oldProject);
assert.equal(projectAtDate(newProject,activityId,"2026-11-19",events),newProject);
assert.deepEqual(projectSlices(newProject,activityId,"2026-11-19","2026-11-19",events),[
 {projectId:newProject,start:"2026-11-19",end:"2026-11-19"}]);
assert.deepEqual(projectSlices(newProject,activityId,"2026-11-01","2026-11-10",events),[
 {projectId:oldProject,start:"2026-11-01",end:"2026-11-10"}]);
assert.deepEqual(projectSlices(newProject,999,"2026-11-01","2026-11-20",events),[
 {projectId:newProject,start:"2026-11-01",end:"2026-11-20"}]);
assert.deepEqual(projectSlices(newProject,activityId,"2026-11-21","2026-11-20",events),[]);
const repeated=[...events,{id:2,activityId,sourceProjectId:newProject,targetProjectId:30,effectiveFrom:"2026-12-01"}];
assert.deepEqual(projectSlices(30,activityId,"2026-11-18","2026-12-03",repeated),[
 {projectId:oldProject,start:"2026-11-18",end:"2026-11-18"},
 {projectId:newProject,start:"2026-11-19",end:"2026-11-30"},
 {projectId:30,start:"2026-12-01",end:"2026-12-03"},
]);
console.log("PASS project attribution: split weeks across move date, historical ownership, unchanged activities, chained moves");
