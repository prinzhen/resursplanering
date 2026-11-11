import assert from "node:assert/strict";
import {projectEffortOnDay} from "../lib/project-effort.ts";
const assignments=[
 {id:1,activityId:11,employeeId:1,startDate:"2026-10-01",endDate:"2026-12-31",effortPercent:30,completedAt:null,workStatus:"Pågående"},
 {id:2,activityId:12,employeeId:1,startDate:"2026-10-01",endDate:"2026-12-31",effortPercent:40,completedAt:null,workStatus:"Pågående"},
 {id:3,activityId:12,employeeId:2,startDate:"2026-10-01",endDate:"2026-12-31",effortPercent:25,completedAt:null,workStatus:"Pågående"},
 {id:4,activityId:13,employeeId:1,startDate:"2026-10-01",endDate:"2026-12-31",effortPercent:60,completedAt:null,workStatus:"Pågående"},
 {id:5,activityId:11,employeeId:3,startDate:"2026-10-01",endDate:"2026-12-31",effortPercent:90,completedAt:null,workStatus:"Pausad"}
];
const periods=[
 {assignmentId:1,startDate:"2026-10-01",endDate:"2026-11-10",effortPercent:30},
 {assignmentId:1,startDate:"2026-11-11",endDate:"2026-12-31",effortPercent:50},
 {assignmentId:2,startDate:"2026-10-01",endDate:"2026-12-31",effortPercent:40}
];
const project=new Set([11,12]);
const old=projectEffortOnDay(project,assignments,periods,"2026-11-10");
assert.deepEqual([...old.entries()],[[1,70],[2,25]]);
assert.equal([...old.values()].reduce((a,b)=>a+b,0),95);
const updated=projectEffortOnDay(project,assignments,periods,"2026-11-11");
assert.deepEqual([...updated.entries()],[[1,90],[2,25]]);
assert.equal([...updated.values()].reduce((a,b)=>a+b,0),115);
assert.equal(projectEffortOnDay(new Set([13]),assignments,periods,"2026-11-11").get(1),60);
const unchanged=projectEffortOnDay(project,assignments,periods,"2027-01-01");
assert.equal(unchanged.size,0,"Past and future effort periods must not be counted outside their dates");
console.log("PASS project effort: sums assignments per person, respects activity/project boundaries and dated history");
