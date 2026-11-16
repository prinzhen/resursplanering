import assert from "node:assert/strict";
import {exchangeRows,writePlanningXlsx,writeMspdi,writeMpx,readMpx,detectExchangeFile,PLAN_COLUMNS} from "../lib/planning-exchange.ts";
const snapshot={
 projects:[{id:1,code:"N.100",name:"Projekt ett",status:"Aktivt"}],
 workPackages:[{id:11,projectId:1,code:"UP-1",name:"Uppdrag"}],
 activities:[{id:20,projectId:1,workPackageId:11,parentActivityId:null,code:null,
   name:"Lång aktivitet",description:"Test av datum",startDate:"2026-09-29",endDate:"2026-12-07",
   estimatedHours:200,status:"Planerad"}],
 employees:[{id:4,name:"Testperson",email:"test@example.se",role:"Medarbetare",capacityPercent:100,managerId:null}],
 assignments:[{id:9,activityId:20,employeeId:4,effortPercent:50,startDate:"2026-09-29",endDate:"2026-12-07"}]
};
const rows=exchangeRows(snapshot);
assert.equal(rows.length,1);
assert.deepEqual(PLAN_COLUMNS.slice(0,3),["record_type","project_code","project_name"]);
assert.equal(rows[0].activity_code,"RP-ID-20");
assert.equal(rows[0].start_date,"2026-09-29");
assert.equal(rows[0].end_date,"2026-12-07");
assert.equal(rows[0].employee_email,"test@example.se");
assert.equal(rows[0].effort_percent,"50");
const file=writePlanningXlsx(rows);
assert.ok(file.size>500);
const bytes=new Uint8Array(await file.arrayBuffer());
const decoder=new TextDecoder(),view=new DataView(bytes.buffer);
let sheet="";
for(let offset=0;offset+30<=bytes.length&&view.getUint32(offset,true)===0x04034b50;){
 const size=view.getUint32(offset+18,true),nameSize=view.getUint16(offset+26,true),
 extra=view.getUint16(offset+28,true);
 const name=decoder.decode(bytes.slice(offset+30,offset+30+nameSize));
 const start=offset+30+nameSize+extra;
 if(name==="xl/worksheets/sheet1.xml")sheet=decoder.decode(bytes.slice(start,start+size));
 offset=start+size;
}
assert.ok(sheet.includes("2026-09-29")&&sheet.includes("2026-12-07"),"XLSX must preserve dates");
assert.ok(sheet.includes("RP-ID-20")&&sheet.includes("test@example.se"),"XLSX metadata and staffing");
assert.ok(!sheet.includes("CSV"),"XLSX has no CSV references");
const xml=writeMspdi(rows);
assert.ok(xml.includes('xmlns="http://schemas.microsoft.com/project"'));
assert.ok(xml.includes("<Start>2026-09-29T08:00:00</Start>"));
assert.ok(xml.includes("<Finish>2026-12-07T17:00:00</Finish>"));
assert.ok(xml.includes("<EmailAddress>test@example.se</EmailAddress>"));
assert.ok(xml.includes("<TaskUID>1</TaskUID>"),"MSPDI assignment linked to task");
const mpx=writeMpx(rows);
const parsed=readMpx(mpx,"N.100","Projekt ett");
assert.equal(parsed.length,1);
assert.equal(parsed[0].activity,"Lång aktivitet");
assert.equal(parsed[0].start_date,"2026-09-29");
assert.equal(parsed[0].end_date,"2026-12-07");
assert.equal(detectExchangeFile("plan.xlsx"),"xlsx");
assert.equal(detectExchangeFile("plan.xml"),"xml");
assert.equal(detectExchangeFile("plan.mpp"),"mpp");
assert.throws(()=>detectExchangeFile("plan.csv"),/CSV stöds inte längre/);
console.log("PASS planning exchange formats: XLSX, MSPDI, MPX roundtrips and no CSV");
