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
  rowKey?:string; rowRevision?:number;
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
/** ISO current week based on Swedish local calendar date. */
export function currentWeekKey(now=new Date()):string{
 const parts=new Intl.DateTimeFormat("sv-SE",{timeZone:"Europe/Stockholm",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(now);
 const values=Object.fromEntries(parts.map(x=>[x.type,x.value]));
 return weekKeyForDate(values.year+"-"+values.month+"-"+values.day);
}
export function weekKeyForDate(date:string):string{
 const d=new Date(date+"T00:00:00Z");
 if(Number.isNaN(d.getTime())||d.toISOString().slice(0,10)!==date)throw Error("Ogiltigt datum");
 d.setUTCDate(d.getUTCDate()+3-((d.getUTCDay()+6)%7));
 const y=d.getUTCFullYear(),jan4=new Date(Date.UTC(y,0,4));
 jan4.setUTCDate(jan4.getUTCDate()-((jan4.getUTCDay()+6)%7));
 return normalizeISOWeek(y+"-V"+(1+Math.round((d.getTime()-jan4.getTime())/604800000)));
}
export function shiftISOWeek(week:string,offset:number):string{
 if(!Number.isSafeInteger(offset)||Math.abs(offset)>2000)throw Error("Ogiltig veckoförflyttning");
 const monday=weekMonday(week);monday.setUTCDate(monday.getUTCDate()+offset*7);
 return weekKeyForDate(monday.toISOString().slice(0,10));
}
export function weekOptions(current:string,past=104,future=156):string[]{
 const all=[current];
 // Alternate backwards and forwards: current, previous, next, previous-2,
 // next+2. Both directions remain easily reachable in Excel's dropdown.
 for(let i=1;i<=Math.max(past,future);i++){
  if(i<=past)all.push(shiftISOWeek(current,-i));
  if(i<=future)all.push(shiftISOWeek(current,i));
 }
 return all;
}
/** User-facing week labels; all stored identifiers remain YYYY-Vww. */
export function formatWeekLabel(week:string,base=currentWeekKey()):string{
 const key=normalizeISOWeek(week),reference=normalizeISOWeek(base);
 const [year,num]=key.split("-V");
 const offset=Math.round((weekMonday(key).getTime()-weekMonday(reference).getTime())/604800000);
 const relative=offset===-1?" (föregående vecka)":offset===0?" (aktuell vecka)":offset===1?" (kommande vecka)":"";
 return (year===reference.slice(0,4)?"":year+" ")+"v."+num+relative;
}
/** Accept friendly Excel labels, but resolve omitted years against the workbook's
 * export year (NOT the import date, which may be months/years later).
 */
export function parseWeekLabel(value:string,referenceYear:number):string{
 const raw=String(value??"").trim();
 if(!Number.isInteger(referenceYear)||referenceYear<1900||referenceYear>2100)
  throw Error("Excelmallens referensår saknas eller är ogiltigt.");
 const clean=raw.replace(/\s+\((?:föregående|aktuell|kommande) vecka\)\s*$/i,"").trim();
 if(/^\d{4}-[VW]\d{1,2}$/i.test(clean))return normalizeISOWeek(clean);
 const m=/^(?:(\d{4})\s+)?v\.?\s*(\d{1,2})$/i.exec(clean);
 if(!m)throw Error("Ogiltig vecka: "+value+". Välj exempelvis v.46 eller 2027 v.01.");
 return normalizeISOWeek((m[1]||referenceYear)+"-V"+m[2]);
}
export function weekMonday(week:string):Date{
 const [year,num]=normalizeISOWeek(week).split("-V").map(Number);
 const jan4=new Date(Date.UTC(year,0,4));
 jan4.setUTCDate(jan4.getUTCDate()-((jan4.getUTCDay()+6)%7)+(num-1)*7);
 return jan4;
}
/** Working-day duration (Mon–Fri), 1v=5 days. Legacy explicit calendar days
 * preserve previously stored weekend endpoints during no-op roundtrips.
 */
export function parseDurationDays(value:string|number):number{
 if(typeof value==="number"){
  if(!Number.isSafeInteger(value)||value<1||value>3650)throw Error("Varaktighet måste vara 1–3650 dagar.");
  return value;
 }
 const v=String(value??"").trim().toLowerCase().replace(/\s+/g," ");
 if(/^\d+$/.test(v)){
  const days=Number(v);
  if(!Number.isSafeInteger(days)||days<1||days>3650)throw Error("Varaktighet måste vara 1–3650 kalenderdagar.");
  return days;
 }
 const legacy=/^(\d+)\s*kalenderdag(?:ar)?$/.exec(v);
 if(legacy){
  const days=Number(legacy[1]);
  if(!Number.isSafeInteger(days)||days<1||days>3650)throw Error("Ogiltig kalenderperiod.");
  return days;
 }
 const m=/^(\d+)\s*(v|vecka|veckor|d|dag|dagar|dygn)(?:\s*(\d+)\s*(d|dag|dagar|dygn))?$/.exec(v);
 if(!m)throw Error("Varaktighet: ange t.ex. 10, 10d, 1v, 1v3d eller 1 vecka 3 dagar.");
 const weeks=["v","vecka","veckor"].includes(m[2]);
 const rest=Number(m[3]||0);
 const days=Number(m[1])*(weeks?5:1)+rest;
 if(m[3]!==undefined&&(!weeks||rest>4))
  throw Error("Ange 0–4 extra arbetsdagar efter veckor (exempel: 1v3d).");
 if(!Number.isSafeInteger(days)||days<1||days>3650)
  throw Error("Varaktighet måste vara 1–3650 kalenderdagar.");
 return days;
}
export function durationLabel(days:number):string{
 if(!Number.isInteger(days)||days<1)throw Error("Ogiltig varaktighet.");
 if(days<5)return days+" "+(days===1?"dag":"dagar");
 const weeks=Math.floor(days/5),remaining=days%5;
 return weeks+" "+(weeks===1?"vecka":"veckor")+(remaining?" "+remaining+" "+(remaining===1?"dag":"dagar"):"");
}
export function rowCalendarRange(week:string,day:string,duration:string|number){
 const start=weekMonday(week);
 const index=WEEK_DAYS.findIndex(x=>x.toLowerCase()===day.trim().toLowerCase());
 if(index<0)throw Error("Ogiltig veckodag: "+day);
 start.setUTCDate(start.getUTCDate()+(index===0?0:index-1));
 const count=parseDurationDays(duration);
 const end=new Date(start);
 if(/^\\d+\\s*kalenderdag(?:ar)?$/i.test(String(duration).trim())){
  end.setUTCDate(end.getUTCDate()+count-1);
 }else{
  if(start.getUTCDay()===0||start.getUTCDay()===6)
   throw Error("En arbetsdagsaktivitet måste börja måndag–fredag. Välj arbetsdag eller ange kalenderdagar för äldre perioder.");
  let remaining=count-1;
  while(remaining>0){
   end.setUTCDate(end.getUTCDate()+1);
   if(end.getUTCDay()!==0&&end.getUTCDay()!==6)remaining--;
  }
 }
 return {start:isodate(start),end:isodate(end)};
}
/** Split a dated assignment segment into ISO calendar weeks with 8h/day / 40h/week. */
export function splitPeriodIntoWeeks(startISO:string,endISO:string,effort:number){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(startISO)||!/^\d{4}-\d{2}-\d{2}$/.test(endISO))
  throw Error("Start/slut ska vara ÅÅÅÅ-MM-DD");
 const start=new Date(startISO+"T00:00:00Z"),end=new Date(endISO+"T00:00:00Z");
 if(Number.isNaN(start.getTime())||Number.isNaN(end.getTime())||start.toISOString().slice(0,10)!==startISO||
    end.toISOString().slice(0,10)!==endISO||end<start)throw Error("Ogiltig planeringsperiod");
 if(!Number.isFinite(effort)||effort<0||effort>100)throw Error("Insats måste vara 0–100 %");
 const intervals:{week:string;day:string;hours:number}[]=[];
 let cursor=new Date(start);
 cursor.setUTCDate(cursor.getUTCDate()-((cursor.getUTCDay()+6)%7));
 for(;cursor<=end;cursor.setUTCDate(cursor.getUTCDate()+7)){
  const monday=new Date(cursor);
  const week=(()=>{const d=new Date(monday);d.setUTCDate(d.getUTCDate()+3);
   const y=d.getUTCFullYear(),jan4=new Date(Date.UTC(y,0,4));
   jan4.setUTCDate(jan4.getUTCDate()-((jan4.getUTCDay()+6)%7));
   return normalizeISOWeek(y+"-V"+(1+Math.round((d.getTime()-jan4.getTime())/604800000)));
  })();
  let days=0;
  for(let n=0;n<7;n++){const d=new Date(monday);d.setUTCDate(d.getUTCDate()+n);
   if(d>=start&&d<=end&&n<5)days++}
  const isFirst=monday<=start&&start.getTime()<monday.getTime()+604800000;
  const day=isFirst?WEEK_DAYS[((start.getUTCDay()+6)%7)+1]:"";
  if(days||isFirst)intervals.push({week,day,hours:Math.round(days*8*effort)/100});
 }
 return intervals;
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
export function createWeeklyV2Xlsx(rows:WeeklyV2Row[],base=currentWeekKey(),person:{name:string;email:string}={name:"",email:""}):Blob{
 if(rows.length>5000)throw Error("Max 5000 rader per export.");
 const exportYear=Number(normalizeISOWeek(base).slice(0,4));
 const body=[
  '<row r="1">'+cell("A1","PERSONLIG VECKOPLANERING",1)+cell("T1",exportYear)+'</row>',
  '<row r="2">'+cell("A2","Namn",1)+cell("B2",person.name)+cell("D2","E-postadress",1)+cell("E2",person.email)+'</row>',
  '<row r="4">'+WEEKLY_COLUMNS.map((h,i)=>cell(column(i)+"4",h,1)).join("")+'</row>'
 ];
 rows.forEach((row,i)=>{
  validateWeeklyV2(row);
  const values=[formatWeekLabel(row.week,base),row.day,row.task,row.duration,row.effort,row.workType,
   row.hours,row.status,row.priority,row.deadline,row.projectCode,row.projectName,row.firstWeek?formatWeekLabel(row.firstWeek,base):"",
   row.comment,row.moveReason,row.activityId];
  const ref=i+5;
  body.push('<row r="'+ref+'">'+values.map((v,n)=>cell(column(n)+ref,v)).join("")+
   cell("Q"+ref,row.rowKey||"")+cell("R"+ref,row.rowRevision??0)+'</row>');
 });
 // The dropdown starts at the CURRENT Swedish calendar week and includes
 // future and past weeks, including year boundaries. Hidden helper column S.
 weekOptions(base).forEach((week,i)=>{
  const number=i+5,extra=cell("S"+number,formatWeekLabel(week,base));
  const idx=body.findIndex(r=>r.startsWith('<row r="'+number+'">'));
  if(idx>=0)body[idx]=body[idx].replace("</row>",extra+"</row>");
  else body.push('<row r="'+number+'">'+extra+"</row>");
 });
 body.sort((a,b)=>Number(/<row r="(\d+)"/.exec(a)?.[1]||0)-Number(/<row r="(\d+)"/.exec(b)?.[1]||0));
 const validation=[
  '<dataValidation type="list" allowBlank="1" showErrorMessage="0" sqref="A5:A5004 M5:M5004"><formula1>$S$5:$S$265</formula1></dataValidation>',
  '<dataValidation type="list" allowBlank="1" sqref="B5:B5004"><formula1>"Måndag,Tisdag,Onsdag,Torsdag,Fredag,Lördag,Söndag"</formula1></dataValidation>',
  '<dataValidation type="list" allowBlank="1" sqref="H5:H5004"><formula1>"Planerad,Pågående,Pausad,Klar,Fryst,Flyttad"</formula1></dataValidation>',
  '<dataValidation type="list" allowBlank="1" sqref="I5:I5004"><formula1>"1,2,3,4,5"</formula1></dataValidation>',
 ].join("");
 const cols=WEEKLY_COLUMNS.map((v,i)=>'<col min="'+(i+1)+'" max="'+(i+1)+'" width="'+Math.min(45,Math.max(17,v.length+4))+'" customWidth="1"/>').join("");
 const sheet='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>'+cols+'<col min="17" max="20" hidden="1"/></cols><sheetData>'+body.join("")+'</sheetData><autoFilter ref="A4:P'+Math.max(4,rows.length+4)+'"/><dataValidations count="4">'+validation+'</dataValidations></worksheet>';
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
export async function readWeeklyV2Xlsx(file:File):Promise<{name:string;email:string;rows:WeeklyV2Row[]}>{
 if(file.size>8_000_000)throw Error("Maximal XLSX-storlek är 8 MB.");
 const entries=await unzip(new Uint8Array(await file.arrayBuffer()));
 const xml=entries.get("xl/worksheets/sheet1.xml");if(!xml)throw Error("Arbetsboken saknar första bladet.");
 const strings:string[]=[];
 const shared=entries.get("xl/sharedStrings.xml");
 if(shared){const dom=new DOMParser().parseFromString(shared,"application/xml");for(const si of Array.from(dom.getElementsByTagName("si"))){strings.push(Array.from(si.getElementsByTagName("t")).map(t=>t.textContent||"").join(""))}}
 const c=parseSheet(xml,strings);
 // Older v2 workbooks used canonical week keys and no hidden year metadata.
 const explicitYear=Number(c("T1"));
 const referenceYear=Number.isInteger(explicitYear)&&explicitYear>=1900&&explicitYear<=2100?explicitYear:
  Number(currentWeekKey().slice(0,4));
 const headerRow=c("A4")==="Vecka"?4:c("A1")==="Vecka"?1:0;
 if(!headerRow)throw Error("Fel XLSX-mall. Exportera en ny personlig planeringsfil.");
 WEEKLY_COLUMNS.forEach((h,i)=>{if(c(column(i)+headerRow)!==h)throw Error("Fel veckoplaneringsmall i kolumn "+column(i)+".");});
 const out:WeeklyV2Row[]=[];
 for(let index=headerRow+1;index<=headerRow+5000;index++){
  const name=c("C"+index);if(!name)continue;
  const str=(x:string)=>c(x+index);
  const num=(s:string)=>{const v=s.replace("%","").replace(",",".").trim();return v?Number(v):null};
  const row:WeeklyV2Row={week:parseWeekLabel(str("A"),referenceYear),day:str("B"),task:name,duration:str("D"),
   effort:num(str("E")),workType:str("F"),hours:num(str("G")),status:str("H"),
   priority:str("I"),deadline:str("J"),projectCode:str("K"),projectName:str("L"),
   firstWeek:str("M")?parseWeekLabel(str("M"),referenceYear):"",comment:str("N"),moveReason:str("O"),activityId:str("P"),rowKey:str("Q"),rowRevision:Number(str("R")||0)};
  validateWeeklyV2(row);out.push(row);
 }
 return {name:headerRow===4?c("B2").trim():"",email:headerRow===4?c("E2").trim().toLowerCase():"",rows:out};
}
