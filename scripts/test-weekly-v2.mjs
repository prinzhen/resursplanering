import assert from "node:assert/strict";
import {createWeeklyV2Xlsx,WEEKLY_COLUMNS,parseDurationDays,durationLabel,normalizeISOWeek,rowCalendarRange,estimatedHours} from "../lib/weekly-xlsx-v2.ts";

assert.deepEqual(WEEKLY_COLUMNS,[
"Vecka","Dag","Vad jag skall göra","Varaktighet","Insats",
"Typ av arbete","Planerade timmar","Status","Prioritet",
"Klart senast","Projektkod","Projekt/verksamhet","Först planerad",
"Kommentar/behov","Orsak om flyttad","Aktivitets-ID"]);
assert.equal(normalizeISOWeek("2026-W40"),"2026-V40");
assert.equal(normalizeISOWeek("2026-V53"),"2026-V53");
assert.throws(()=>normalizeISOWeek("2026-V54"));
assert.equal(parseDurationDays("3 veckor"),21);
assert.equal(durationLabel(7),"7 dagar");
assert.equal(durationLabel(9),"1 vecka 2 dagar");
assert.deepEqual(rowCalendarRange("2026-V40","Torsdag","3 dagar"),{start:"2026-10-01",end:"2026-10-03"});
assert.equal(estimatedHours({week:"2026-V47",day:"",duration:"3 veckor",effort:50}),60);
assert.equal(estimatedHours({week:"2026-V47",day:"Måndag",duration:"1 dag",effort:100}),8);
assert.equal(estimatedHours({week:"2026-V47",day:"Lördag",duration:"2 dagar",effort:100}),0);
assert.throws(()=>estimatedHours({week:"2026-V47",day:"",duration:"1 dag",effort:101}));
const row={week:"2026-V47",day:"Torsdag",task:"Systemdesign",duration:"3 dagar",effort:50,
workType:"Projekt",hours:12,status:"Planerad",priority:"3",deadline:"2026-12-01",
projectCode:"N.001",projectName:"Exempel",firstWeek:"2026-V46",comment:"Behov",
moveReason:"",activityId:"activity-42",rowKey:"row-42"};
const blob=createWeeklyV2Xlsx([row]);
const bytes=new Uint8Array(await blob.arrayBuffer()), view=new DataView(bytes.buffer);
const decoder=new TextDecoder();
let sheet="";
for(let offset=0;offset+30<=bytes.length&&view.getUint32(offset,true)===0x04034b50;){
 assert.equal(view.getUint16(offset+8,true),0,"Expected ZIP STORE in XLSX writer");
 const size=view.getUint32(offset+18,true),nameSize=view.getUint16(offset+26,true),extra=view.getUint16(offset+28,true);
 const name=decoder.decode(bytes.slice(offset+30,offset+30+nameSize));
 const start=offset+30+nameSize+extra;
 if(name==="xl/worksheets/sheet1.xml")sheet=decoder.decode(bytes.slice(start,start+size));
 offset=start+size;
}
assert.ok(sheet,"Missing sheet");
for(let i=0;i<WEEKLY_COLUMNS.length;i++){
 const ref=String.fromCharCode(65+i)+"1";
 assert.ok(sheet.includes('r="'+ref+'"'),"Missing header "+ref);
 assert.ok(sheet.includes(WEEKLY_COLUMNS[i]),"Missing header "+WEEKLY_COLUMNS[i]);
}
assert.ok(sheet.includes('r="Q2"'),"Missing stable hidden planning row key");
assert.ok(sheet.includes('min="17" max="17" hidden="1"'),"Metadata column must be hidden");
console.log("PASS weekly XLSX v2: all 16 columns, dates, duration, effort and ZIP structure");
