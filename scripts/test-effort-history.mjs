import assert from "node:assert/strict";
import {overlayEffortPeriods} from "../lib/effort-history.ts";

const single=[{startDate:"2026-11-01",endDate:"2026-11-30",effortPercent:40}];
const changed=[{...single[0],effortPercent:60}];
const first=overlayEffortPeriods(single,changed,"2026-11-11");
assert.equal(first.changed,true);
assert.deepEqual(first.periods,[
 {startDate:"2026-11-01",endDate:"2026-11-10",effortPercent:40},
 {startDate:"2026-11-11",endDate:"2026-11-30",effortPercent:60}
]);
const repeated=overlayEffortPeriods(first.periods,first.periods,"2026-11-11");
assert.equal(repeated.changed,false);
assert.deepEqual(repeated.periods,first.periods);
const later=overlayEffortPeriods(first.periods,[{...single[0],effortPercent:70}],"2026-11-20");
assert.deepEqual(later.periods,[
 {startDate:"2026-11-01",endDate:"2026-11-10",effortPercent:40},
 {startDate:"2026-11-11",endDate:"2026-11-19",effortPercent:60},
 {startDate:"2026-11-20",endDate:"2026-11-30",effortPercent:70}
]);
const future=[...single,{startDate:"2026-12-01",endDate:"2026-12-31",effortPercent:20}];
const partial=overlayEffortPeriods(future,changed,"2026-11-11");
assert.deepEqual(partial.periods,[
 {startDate:"2026-11-01",endDate:"2026-11-10",effortPercent:40},
 {startDate:"2026-11-11",endDate:"2026-11-30",effortPercent:60},
 {startDate:"2026-12-01",endDate:"2026-12-31",effortPercent:20}
]);
assert.equal(overlayEffortPeriods(single,single,"2026-11-11").changed,false);
assert.deepEqual(overlayEffortPeriods(single,[{...single[0],effortPercent:60}],"2026-12-01").periods,single);
console.log("PASS Effort overlay: history preserved, single-row edits, no-op reimport, same-day correction, unrelated future preserved");
