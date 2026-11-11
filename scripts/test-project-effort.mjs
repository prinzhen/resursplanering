import assert from "node:assert/strict";
import {projectEffortOnDay,projectEffortForPeriod} from "../lib/project-effort.ts";
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
const old=projectEffortOnDay(project,assignments,periods,"2026-11-10","2026-11-11");
assert.deepEqual([...old.entries()],[[1,70],[2,25],[3,90]],"Historic effort must remain visible even if assignment is paused today");
assert.equal([...old.values()].reduce((a,b)=>a+b,0),185);
const updated=projectEffortOnDay(project,assignments,periods,"2026-11-11","2026-11-11");
assert.deepEqual([...updated.entries()],[[1,90],[2,25]]);
assert.equal([...updated.values()].reduce((a,b)=>a+b,0),115);
assert.equal(projectEffortOnDay(new Set([13]),assignments,periods,"2026-11-11").get(1),60);
const unchanged=projectEffortOnDay(project,assignments,periods,"2027-01-01");
assert.equal(unchanged.size,0,"Past and future effort periods must not be counted outside their dates");
const month=projectEffortForPeriod(project,assignments,periods,"2026-11-01","2026-11-30","2026-11-11");
assert.ok(month.get(1)>70&&month.get(1)<90,"Month must weight historic 30% and future 50%, plus 40% second activity");
assert.equal(month.get(2),25);
const history=projectEffortForPeriod(project,assignments,periods,"2026-10-05","2026-10-09","2026-11-11");
assert.deepEqual([...history.entries()],[[1,70],[2,25],[3,90]],"Monthly history must not be erased by later pause");
const future=projectEffortForPeriod(project,assignments,periods,"2026-12-07","2026-12-11","2026-11-11");
assert.deepEqual([...future.entries()],[[1,90],[2,25]]);
const completed=[{...assignments[0],completedAt:"2026-11-10",workStatus:"Klar"}];
assert.equal(projectEffortOnDay(project,completed,periods,"2026-11-05").get(1),30);
assert.equal(projectEffortOnDay(project,completed,periods,"2026-11-12").size,0);
assert.equal(projectEffortForPeriod(project,completed,periods,"2026-11-01","2026-11-30","2026-11-11").get(1)>0,true);
console.log("PASS project effort: sums assignments per person, respects activity/project boundaries and dated history");
