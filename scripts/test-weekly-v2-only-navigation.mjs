import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const home=readFileSync("app/page.tsx","utf8");
const legacy=readFileSync("app/individual/page.tsx","utf8");
const weekly=readFileSync("app/weekly-v2/page.tsx","utf8");
const legacyApi=readFileSync("app/api/individual/route.ts","utf8");

assert.match(home,/<a href="\/weekly-v2"[^>]*>Veckoplanering · Excel<\/a>/);
assert.doesNotMatch(home,/href="\/individual"/);
assert.match(legacy,/redirect\("\/weekly-v2"\)/);
assert.doesNotMatch(legacy,/createIndividualXlsx|readIndividualXlsx|importNow|exportFile/);
assert.doesNotMatch(weekly,/href="\/individual"/);
assert.doesNotMatch(weekly,/Utvecklingsversion|Befintlig veckoplanering/);
assert.match(weekly,/href="\/"/);
assert.match(weekly,/createWeeklyV2Xlsx|readWeeklyV2Xlsx/);
// v2 currently fetches legacy GET to load its existing activities. Keep that
// shared read endpoint; removing it would break existing v2 exports.
assert.match(legacyApi,/export async function GET\(/);
assert.match(weekly,/\/api\/individual\?email=/);
console.log("PASS weekly v2 only: official navigation, legacy URL redirect, v2 import/export and shared read API intact");
