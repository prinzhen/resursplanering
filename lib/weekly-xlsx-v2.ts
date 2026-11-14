import {zip,unzip,parseSheet} from "./individual-xlsx.ts";

export const WEEKLY_COLUMNS = [
  "Vecka","Dag","Vad jag skall göra","Varaktighet","Insats",
  "Typ av arbete","Planerade timmar","Status","Prioritet",
  "Klart senast","Projektkod","Projekt/verksamhet","Först planerad",
  "Kommentar/behov","Orsak om flyttad","Aktivitets-ID"
] as const;

export type WeeklyV2Row = {
  week:string; day:string; task:string; duration:string; effort:number|null;
  workType:string; hours:number|null; status:string; priority:string;
  deadline:string; projectCode:string; projectName:string;
  firstWeek:string; comment:string; moveReason:string; activityId:string;
  rowKey?:string;
};
export const WEEK_DAYS = ["","Måndag","Tisdag","Onsdag","Torsdag","Fredag","Lördag","Söndag"] as const;
const enc=(s:unknown)=>String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const isodate=(date:Date)=>date.toISOString().slice(0,10);
export function normalizeISOWeek(value:string):string{
 const m=/^(\d{4})-[VW](\d{1,2})$/i.exec(value.trim());
 if(!m)throw Error("Ange vecka som exempelvis 2026-V40.");
 const year=Number(m[1]),num=Number(m[2]);
 const jan4=new Date(Date.UTC(year,0,4));
 jan4.setUTCDate(jan4.getUTCDate()-((jan4.getUTCDay()+6)%7)+(num-1)*7);
 const check=new Date(jan4);check.setUTCDate(check.getUTCDate()+3);
 if(year<1900||year>2100||num<1||num>53||check.getUTCFullYear()!==year)
  throw Error("Vecka finns inte: "+value);
 return m[1]+"-V"+String(num).padStart(2,"0");
}
export function weekMonday(week:string):Date{
 const [year,num]=normalizeISOWeek(week).split("-V").map(Number);
 const jan4=new Date(Date.UTC(year,0,4));
 jan4.setUTCDate(jan4.getUTCDate()-((jan4.getUTCDay()+6)%7)+(num-1)*7);
 return jan4;
}
export function parseDurationDays(value:string|number):number{
 if(typeof value==="number"&&Number.isInteger(value)&&value>0)return value;
 const v=String(value).toLowerCase().trim();
 const m=/^(\d+)\s*(dag|dagar|dygn|vecka|veckor)$/.exec(v);
 if(!m||Number(m[1])<1||Number(m[1])>3650)throw Error("Varaktighet ska vara t.ex. 3 dagar eller 2 veckor.");
 return Number(m[1])*(m[2].startsWith("veck")?7:1);
}
export function durationLabel(days:number):string{
 if(!Number.isInteger(days)||days<1)throw Error("Ogiltig varaktighet.");
 if(days<=7)return days+" "+(days===1?"dag":"dagar");
 const weeks=Math.floor(days/7),remaining=days%7;
 return weeks+" "+(weeks===1?"vecka":"veckor")+(remaining?" "+remaining+" "+(remaining===1?"dag":"dagar"):"");
}
export function rowCalendarRange(week:string,day:string,duration:string|number){
 const start=weekMonday(week);
 const index=WEEK_DAYS.findIndex(x=>x.toLowerCase()===day.trim().toLowerCase());
 if(index<0)throw Error("Ogiltig veckodag: "+day);
 start.setUTCDate(start.getUTCDate()+(index===0?0:index-1));
 const end=new Date(start);end.setUTCDate(end.getUTCDate()+parseDurationDays(duration)-1);
 return {start:isodate(start),end:isodate(end)};
}
export function estimatedHours(row:Pick<WeeklyV2Row,"week"|"day"|"duration"|"effort">):number{
 if(row.effort===null)return 0;
 if(!Number.isFinite(row.effort)||row.effort<0||row.effort>100)throw Error("Insats ska anges 0–100 %.");
 const {start,end}=rowCalendarRange(row.week,row.day,row.duration);
 let days=0;const a=new Date(start+"T00:00:00Z"),b=new Date(end+"T00:00:00Z");
 for(let t=a.getTime();t<=b.getTime();t+=86400000){const d=new Date(t).getUTCDay();if(d!==0&&d!==6)days++}
 return Math.round(days*8*row.effort)/100;
}
export function validateWeeklyV2(row:WeeklyV2Row){
 normalizeISOWeek(row.week);
 if(row.day&&!WEEK_DAYS.some(x=>x.toLowerCase()===row.day.trim().toLowerCase()))throw Error("Felaktig veckodag.");
 parseDurationDays(row.duration);
 if(!row.task.trim())throw Error("Aktivitetsnamnet saknas.");
 if(!row.projectCode.trim())throw Error("Projektkoden saknas.");
 if(row.effort!==null&&(!Number.isFinite(row.effort)||row.effort<0||row.effort>100))throw Error("Insats måste vara 0–100 %.");
 if(row.hours!==null&&(!Number.isFinite(row.hours)||row.hours<0))throw Error("Planerade timmar är ogiltiga.");
 if(row.deadline&&!/^\d{4}-\d{2}-\d{2}$/.test(row.deadline))throw Error("Klart senast ska vara ÅÅÅÅ-MM-DD.");
}
const cell=(ref:string,v:string|number|null|undefined,style=0)=>{
 if(v===null||v===undefined||v==="")return "";
 if(typeof v==="number")return '<c r="'+ref+'" s="'+style+'"><v>'+v+'</v></c>';
 return '<c r="'+ref+'" s="'+style+'" t="inlineStr"><is><t xml:space="preserve">'+enc(v)+'</t></is></c>';
};
const column=(index:number)=>String.fromCharCode(65+index);
export function createWeeklyV2Xlsx(rows:WeeklyV2Row[]):Blob{
 if(rows.length>5000)throw Error("Max 5000 rader per export.");
 const body=['<row r="1">'+WEEKLY_COLUMNS.map((h,i)=>cell(column(i)+"1",h,1)).join("")+'</row>'];
 rows.forEach((row,i)=>{
  validateWeeklyV2(row);
  const values=[normalizeISOWeek(row.week),row.day,row.task,row.duration,row.effort,row.workType,
   row.hours,row.status,row.priority,row.deadline,row.projectCode,row.projectName,row.firstWeek,
   row.comment,row.moveReason,row.activityId];
  const ref=i+2;
  body.push('<row r="'+ref+'">'+values.map((v,n)=>cell(column(n)+ref,v)).join("")+
   cell("Q"+ref,row.rowKey||"")+'</row>');
 });
 const validation=[
  '<dataValidation type="list" allowBlank="1" sqref="B2:B5001"><formula1>"Måndag,Tisdag,Onsdag,Torsdag,Fredag,Lördag,Söndag"</formula1></dataValidation>',
  '<dataValidation type="list" allowBlank="1" sqref="H2:H5001"><formula1>"Planerad,Pågående,Pausad,Klar,Fryst,Flyttad"</formula1></dataValidation>',
  '<dataValidation type="list" allowBlank="1" sqref="I2:I5001"><formula1>"1,2,3,4,5"</formula1></dataValidation>',
 ].join("");
 const cols=WEEKLY_COLUMNS.map((v,i)=>'<col min="'+(i+1)+'" max="'+(i+1)+'" width="'+Math.min(45,Math.max(17,v.length+4))+'" customWidth="1"/>').join("");
 const sheet='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>'+cols+'<col min="17" max="17" hidden="1"/></cols><sheetData>'+body.join("")+'</sheetData><autoFilter ref="A1:P'+Math.max(1,rows.length+1)+'"/><dataValidations count="3">'+validation+'</dataValidations></worksheet>';
 const styles='<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1E40AF"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0"/></cellXfs></styleSheet>';
 return zip({
  "[Content_Types].xml":'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
  "_rels/.rels":'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  "xl/workbook.xml":'<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Veckoplanering" sheetId="1" r:id="rId1"/></sheets></workbook>',
  "xl/_rels/workbook.xml.rels":'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
  "xl/styles.xml":styles,
  "xl/worksheets/sheet1.xml":sheet,
 });
}
export async function readWeeklyV2Xlsx(file:File):Promise<WeeklyV2Row[]>{
 if(file.size>8_000_000)throw Error("Maximal XLSX-storlek är 8 MB.");
 const entries=await unzip(new Uint8Array(await file.arrayBuffer()));
 const xml=entries.get("xl/worksheets/sheet1.xml");if(!xml)throw Error("Arbetsboken saknar första bladet.");
 const strings:string[]=[];
 const shared=entries.get("xl/sharedStrings.xml");
 if(shared){const dom=new DOMParser().parseFromString(shared,"application/xml");for(const si of Array.from(dom.getElementsByTagName("si"))){strings.push(Array.from(si.getElementsByTagName("t")).map(t=>t.textContent||"").join(""))}}
 const c=parseSheet(xml,strings);
 WEEKLY_COLUMNS.forEach((h,i)=>{if(c(column(i)+"1")!==h)throw Error("Fel veckoplaneringsmall i kolumn "+column(i)+".");});
 const out:WeeklyV2Row[]=[];
 for(let index=2;index<=5001;index++){
  const name=c("C"+index);if(!name)continue;
  const str=(x:string)=>c(x+index);
  const num=(s:string)=>{const v=s.replace("%","").replace(",",".").trim();return v?Number(v):null};
  const row:WeeklyV2Row={week:str("A"),day:str("B"),task:name,duration:str("D"),
   effort:num(str("E")),workType:str("F"),hours:num(str("G")),status:str("H"),
   priority:str("I"),deadline:str("J"),projectCode:str("K"),projectName:str("L"),
   firstWeek:str("M"),comment:str("N"),moveReason:str("O"),activityId:str("P"),rowKey:str("Q")};
  validateWeeklyV2(row);out.push(row);
 }
 return out;
}
