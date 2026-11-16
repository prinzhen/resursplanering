import assert from "node:assert/strict";
import {createWeeklyV2Xlsx,WEEKLY_COLUMNS,parseDurationDays,durationLabel,normalizeISOWeek,rowCalendarRange,estimatedHours,splitPeriodIntoWeeks,currentWeekKey,shiftISOWeek,weekOptions,weekKeyForDate,formatWeekLabel,parseWeekLabel} from "../lib/weekly-xlsx-v2.ts";

assert.deepEqual(WEEKLY_COLUMNS,[
"Vecka","Dag","Vad jag skall göra","Varaktighet","Insats",
"Typ av arbete","Planerade timmar","Status","Prioritet",
"Klart senast","Projektkod","Projekt/verksamhet","Först planerad",
"Kommentar/behov","Orsak om flyttad","Aktivitets-ID"]);
assert.equal(normalizeISOWeek("2026-W40"),"2026-V40");
assert.equal(normalizeISOWeek("2026-V53"),"2026-V53");
assert.throws(()=>normalizeISOWeek("2026-V54"));
assert.equal(parseDurationDays("3 veckor"),21);
for(const [raw,expected] of [["1v",7],["1v3d",10],["1v 3d",10],["10",10],["10d",10],["2v4d",18],["7",7],["1 vecka 3 dagar",10],["1 vecka 3 d",10],["3 dagar",3],["7 kalenderdagar",7]]){
 assert.equal(parseDurationDays(raw),expected,"Varaktighet "+raw);
}
assert.equal(parseDurationDays(10),10,"Excel numeric duration should be interpreted as calendar days");
assert.throws(()=>parseDurationDays("1v7d"),/högst 6/);
assert.throws(()=>parseDurationDays("0"),/1–3650/);
assert.throws(()=>parseDurationDays("9999d"),/1–3650/);
assert.throws(()=>parseDurationDays("2d3d"));
assert.deepEqual(rowCalendarRange("2026-V47","Måndag","1v3d"),{start:"2026-11-16",end:"2026-11-25"});
assert.deepEqual(rowCalendarRange("2026-V47","Måndag","10d"),{start:"2026-11-16",end:"2026-11-25"});
assert.deepEqual(rowCalendarRange("2026-V47","Måndag","7 kalenderdagar"),{start:"2026-11-16",end:"2026-11-22"});

assert.equal(durationLabel(7),"7 dagar");
assert.equal(durationLabel(9),"1 vecka 2 dagar");
assert.equal(parseDurationDays("1 vecka 2 dagar"),9,"Exported mixed durations must import");
assert.equal(parseDurationDays(durationLabel(366)),366,"Long periods must round-trip");
assert.equal(weekKeyForDate("2027-01-01"),"2026-V53","ISO rollover");
assert.equal(currentWeekKey(new Date("2026-11-14T12:00:00Z")),"2026-V46");
assert.equal(shiftISOWeek("2026-V53",1),"2027-V01");
assert.equal(shiftISOWeek("2027-V01",-1),"2026-V53");
assert.equal(weekOptions("2026-V46",2,2)[0],"2026-V46","Dropdown must begin with current week");
assert.deepEqual(weekOptions("2026-V46",2,2),["2026-V46","2026-V45","2026-V47","2026-V44","2026-V48"],"Dropdown offers past and future immediately");
assert.equal(formatWeekLabel("2026-V46","2026-V46"),"v.46 (aktuell vecka)");
assert.equal(formatWeekLabel("2026-V45","2026-V46"),"v.45 (föregående vecka)");
assert.equal(formatWeekLabel("2026-V47","2026-V46"),"v.47 (kommande vecka)");
assert.equal(formatWeekLabel("2027-V01","2026-V53"),"2027 v.01 (kommande vecka)");
assert.equal(formatWeekLabel("2026-V53","2027-V01"),"2026 v.53 (föregående vecka)");
assert.equal(parseWeekLabel("v.46 (aktuell vecka)",2026),"2026-V46");
assert.equal(parseWeekLabel("v.45 (föregående vecka)",2026),"2026-V45");
assert.equal(parseWeekLabel("2027 v.01 (kommande vecka)",2026),"2027-V01");
assert.equal(parseWeekLabel("2026-V46",2027),"2026-V46","Old canonical files remain supported");
assert.equal(parseWeekLabel("v.46",2026),"2026-V46","Short label resolves to XLSX export year");
assert.throws(()=>parseWeekLabel("v.53",2027),"Invalid week must reject");


assert.deepEqual(rowCalendarRange("2026-V40","Torsdag","3 dagar"),{start:"2026-10-01",end:"2026-10-03"});
assert.equal(estimatedHours({week:"2026-V47",day:"",duration:"3 veckor",effort:50}),60);
assert.equal(estimatedHours({week:"2026-V47",day:"Måndag",duration:"1 dag",effort:100}),8);
assert.equal(estimatedHours({week:"2026-V47",day:"Lördag",duration:"2 dagar",effort:100}),0);
assert.throws(()=>estimatedHours({week:"2026-V47",day:"",duration:"1 dag",effort:101}));
assert.deepEqual(splitPeriodIntoWeeks("2026-11-16","2026-12-06",50),[
 {week:"2026-V47",day:"Måndag",hours:20},
 {week:"2026-V48",day:"",hours:20},
 {week:"2026-V49",day:"",hours:20}
]);
assert.deepEqual(splitPeriodIntoWeeks("2026-12-31","2027-01-04",100),[
 {week:"2026-V53",day:"Torsdag",hours:16},
 {week:"2027-V01",day:"",hours:8}
]);
const row={week:"2026-V47",day:"Torsdag",task:"Systemdesign",duration:"3 dagar",effort:50,
workType:"Projekt",hours:12,status:"Planerad",priority:"3",deadline:"2026-12-01",
projectCode:"N.001",projectName:"Exempel",firstWeek:"2026-V46",comment:"Behov",
moveReason:"",activityId:"activity-42",rowKey:"row-42"};
const blob=createWeeklyV2Xlsx([row],"2026-V46",{name:"Test Person",email:"test@example.se"});
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
 const ref=String.fromCharCode(65+i)+"4";
 assert.ok(sheet.includes('r="'+ref+'"'),"Missing header "+ref);
 assert.ok(sheet.includes(WEEKLY_COLUMNS[i]),"Missing header "+WEEKLY_COLUMNS[i]);
}
assert.ok(sheet.includes('r="Q5"'),"Missing stable hidden planning row key");
assert.ok(sheet.includes('min="17" max="21" hidden="1"'),"Metadata, year, duration-mode and week-list columns must be hidden");
assert.ok(sheet.includes('r="U1"')&&sheet.includes("KALENDERDAGAR-7"),"New XLSX must declare seven-day calendar spans");
assert.ok(sheet.includes('sqref="A5:A5004 M5:M5004"'),"Dropdown required for ISO week and first planned week");
assert.ok(sheet.includes('$S$5:$S$265'),"Scrollable week list must be in hidden column S");
assert.ok(sheet.includes('r="S5"'),"Week list must start at current week");
assert.ok(sheet.includes('r="T1"'),"Export year must be preserved in hidden metadata");
assert.ok(sheet.includes('r="B2"')&&sheet.includes('Test Person'),"Personal name must be visible in workbook");
assert.ok(sheet.includes('r="E2"')&&sheet.includes('test@example.se'),"Personal email must be visible in workbook");

assert.ok(sheet.includes("v.46 (aktuell vecka)"),"Current week must have visible relative label");
assert.ok(sheet.includes("v.45 (föregående vecka)"),"Previous week must have visible relative label");
assert.ok(sheet.includes("v.47 (kommande vecka)"),"Next week must have visible relative label");

assert.ok(sheet.includes('r="S265"'),"Week list must cover past/future years");
assert.ok(sheet.includes('r="A4"'),"Visible header stays unchanged");
const longer={...row,duration:"1 vecka 2 dagar",projectCode:"INTERNAL-VERK"};
assert.ok(createWeeklyV2Xlsx([longer]).size>1000,"Combined duration and internal project must export");
console.log("PASS weekly XLSX v2: all 16 columns, dates, duration, effort and ZIP structure");
