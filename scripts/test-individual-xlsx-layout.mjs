import assert from "node:assert/strict";
import {createIndividualXlsx} from "../lib/individual-xlsx.ts";

const data={name:"Exempel",email:"example@example.se",savedAt:"2026-11-11",members:[],activities:[{
 uid:"activity-42",week:"2026-W46",firstWeek:"2026-W46",
 name:"Larmsystem",kind:"Projekt",link:"Projekt A",projectCode:"N.001",
 hours:70,status:"Planerad",priority:"3",dueDate:"2026-12-30",
 comment:"Kommentar",reason:"",periodStart:"2026-11-01",periodEnd:"2026-11-30",effortPercent:40
}]};
const blob=createIndividualXlsx(data);
const bytes=new Uint8Array(await blob.arrayBuffer());
const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
const read=new TextDecoder();
let sheet="";
for(let p=0;p+30<=bytes.length&&view.getUint32(p,true)===0x04034b50;){
 const method=view.getUint16(p+8,true);
 assert.equal(method,0,"Workbook writer must store XLSX parts without compression");
 const length=view.getUint32(p+18,true),names=view.getUint16(p+26,true),extra=view.getUint16(p+28,true);
 const name=read.decode(bytes.slice(p+30,p+30+names));
 const dataStart=p+30+names+extra;
 if(name==="xl/worksheets/sheet1.xml")sheet=read.decode(bytes.slice(dataStart,dataStart+length));
 p=dataStart+length;
}
assert.ok(sheet,"Missing first sheet XML");
const cell=(ref)=>{
 const match=new RegExp('<c r="'+ref+'"[^>]*>([\\s\\S]*?)<\\/c>').exec(sheet);
 assert.ok(match,"Missing cell "+ref);
 return match[1];
};
for(const [ref,value] of Object.entries({
 G8:"Status",H8:"Start",I8:"Slut",J8:"Insats (%)",K8:"Prioritet",
 L8:"Klart senast",M8:"Kommentar / behov",N8:"Först planerad",
 O8:"Orsak om flyttad",P8:"Aktivitets-ID",
 H9:"2026-11-01",I9:"2026-11-30",J9:"40",K9:"3",P9:"activity-42"
})){
 assert.ok(cell(ref).includes(value),"Unexpected "+ref+": expected "+value);
}
console.log("PASS XLSX new layout: Status G, Start H, Slut I, Insats J, Prio K, ID P");
