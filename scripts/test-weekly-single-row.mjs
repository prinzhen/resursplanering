import assert from "node:assert/strict";
import {asWeeklyRows} from "../lib/weekly-export.ts";
import {scheduleDates} from "../lib/activity-calendar.ts";
const person={name:"Test",email:"test@example.se",members:[],activities:[
 {uid:"employee-4-activity-8",week:"2026-W40",name:"Planering 10 veckor",kind:"Projekt",
  link:"Ett projekt",projectCode:"N.123",hours:200,status:"Planerad",priority:"3",
  dueDate:"",comment:"",firstWeek:"2026-W40",reason:"",
  periodStart:"2026-09-28",periodEnd:"2026-10-30",effortPercent:50},
 {uid:"employee-4-activity-8",week:"2026-W40",name:"Planering 10 veckor",kind:"Projekt",
  link:"Ett projekt",projectCode:"N.123",hours:200,status:"Planerad",priority:"3",
  dueDate:"",comment:"",firstWeek:"2026-W40",reason:"",
  periodStart:"2026-10-31",periodEnd:"2026-12-06",effortPercent:50}
]};
const mapping=[{uid:"employee-4-activity-8",activityId:8,startDate:"2026-09-28",endDate:"2026-12-06"}];
const rows=asWeeklyRows(person,4,mapping);
assert.equal(rows.length,1,"One long activity must be one XLSX row despite multiple legacy periods");
assert.equal(rows[0].rowKey,"plan-4-8");
assert.equal(rows[0].duration,"10 veckor");
assert.equal(rows[0].hours,200);
assert.deepEqual(scheduleDates(rows[0]),{start:"2026-09-28",end:"2026-12-06"});
const changed=asWeeklyRows(person,4,[{...mapping[0],startDate:"2026-10-06",endDate:"2026-12-14"}]);
assert.equal(changed.length,1);
assert.equal(changed[0].week,"2026-V41");
assert.equal(changed[0].day,"Tisdag");
assert.equal(changed[0].duration,"10 veckor");
assert.deepEqual(scheduleDates(changed[0]),{start:"2026-10-06",end:"2026-12-14"});
console.log("PASS one-row export: canonical Gantt date, merged periods, retained duration and hours");
