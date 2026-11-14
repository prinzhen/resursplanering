import assert from "node:assert/strict";
import {dateWeek,weeklyOverridePercent} from "../lib/weekly-load.ts";

assert.equal(dateWeek("2027-01-01"),"2026-V53");
const weekly=[{activityId:7,employeeId:3,week:"2026-V47",weekday:null,durationDays:7,effort:50,hours:20}];
for(const day of ["2026-11-16","2026-11-17","2026-11-18","2026-11-19","2026-11-20"])
 assert.equal(weeklyOverridePercent(weekly,7,3,day),50,"20 h over five days = 50% each day: "+day);
assert.equal(weeklyOverridePercent(weekly,7,3,"2026-11-21"),0);
assert.equal(weeklyOverridePercent(weekly,7,3,"2026-11-23"),undefined);
const daily=[{...weekly[0],weekday:4,durationDays:1,hours:8}];
assert.equal(weeklyOverridePercent(daily,7,3,"2026-11-19"),100);
assert.equal(weeklyOverridePercent(daily,7,3,"2026-11-18"),0);
const mixed=[...daily,{...weekly[0],weekday:null,hours:10}];
assert.equal(weeklyOverridePercent(mixed,7,3,"2026-11-19"),125);
assert.equal(weeklyOverridePercent(mixed,7,3,"2026-11-18"),25);
assert.equal(weeklyOverridePercent(weekly,7,99,"2026-11-19"),undefined);
const threeDays=[{...daily[0],durationDays:3,hours:12}]; // Thu-Fri-Sat = 2 workdays
assert.equal(weeklyOverridePercent(threeDays,7,3,"2026-11-19"),75);
assert.equal(weeklyOverridePercent(threeDays,7,3,"2026-11-20"),75);
assert.equal(weeklyOverridePercent(threeDays,7,3,"2026-11-21"),0);
const threeWeeks=[{...weekly[0],durationDays:21,hours:60}];
assert.equal(weeklyOverridePercent(threeWeeks,7,3,"2026-11-16"),50);
assert.equal(weeklyOverridePercent(threeWeeks,7,3,"2026-11-27"),50);
assert.equal(weeklyOverridePercent(threeWeeks,7,3,"2026-12-02"),50);
assert.equal(weeklyOverridePercent(threeWeeks,7,3,"2026-12-07"),undefined);
const rollover=[{...weekly[0],week:"2026-V53",weekday:4,durationDays:5,hours:24}];
assert.equal(weeklyOverridePercent(rollover,7,3,"2026-12-31"),100);
assert.equal(weeklyOverridePercent(rollover,7,3,"2027-01-04"),100);
console.log("PASS weekly utilization: multi-day distribution, week rollover, legacy fallback and no double counting");
