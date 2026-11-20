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
const enc=(s:unknown)=>String(s??"").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g,"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
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
/** Calendar spans: one week is seven calendar days. Work hours are computed separately. */
export function parseDurationDays(value:string|number):number{
 if(typeof value==="number"){
  if(!Number.isSafeInteger(value)||value<1||value>3650)throw Error("Varaktighet måste vara 1–3650 kalenderdagar.");
  return value;
 }
 const raw=String(value??"").trim().toLowerCase().replace(/\s+/g," ");
 if(/^\d+$/.test(raw)){
  const days=Number(raw);
  if(!Number.isSafeInteger(days)||days<1||days>3650)throw Error("Varaktighet måste vara 1–3650 kalenderdagar.");
  return days;
 }
 const m=/^(\d+)\s*(v|vecka|veckor|d|dag|dagar|dygn|kalenderdag|kalenderdagar)(?:\s*(\d+)\s*(d|dag|dagar|dygn))?$/.exec(raw);
 if(!m)throw Error("Varaktighet: ange t.ex. 10, 10d, 1v, 1v3d eller 1 vecka 3 dagar.");
 const weeks=["v","vecka","veckor"].includes(m[2]);
 const rest=Number(m[3]||0),days=Number(m[1])*(weeks?7:1)+rest;
 if(m[3]!==undefined&&(!weeks||rest>6))throw Error("Ange högst 6 extra dagar efter hela veckor.");
 if(!Number.isSafeInteger(days)||days<1||days>3650)throw Error("Varaktighet måste vara 1–3650 kalenderdagar.");
 return days;
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
 const end=new Date(start);
 end.setUTCDate(end.getUTCDate()+parseDurationDays(duration)-1);
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
 // Missing project is permitted only for NEW activities. The import
 // bootstrap places them in the current planning instance's internal
 // catch-all project, so work estimates are never discarded.
 if(!row.projectCode.trim()&&row.activityId.trim())
  throw Error("Befintlig aktivitet saknar projektkod. Flytta den via projektplaneringen eller exportera på nytt.");
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

/** Standard OOXML formula. Excel/LibreOffice recalculate the second sheet. */
const formulaCell=(ref:string,formula:string,style=0)=>'<c r="'+ref+'" s="'+style+'"><f>'+enc(formula)+'</f><v>0</v></c>';
/** OOXML shared formulas: one definition, 4999 lightweight references.
 * Relative A5/B5 etc are adjusted automatically for each Excel row. */
const sharedFormulaCell=(ref:string,formula:string,series:number,start:boolean)=>{
 const columnName=ref.replace(/[0-9]+$/,"");
 const range=start?' ref="'+columnName+'5:'+columnName+'5004"':"";
 return '<c r="'+ref+'"><f t="shared" si="'+series+'"'+range+'>'+
  (start?enc(formula):"")+'</f><v>0</v></c>';
};
const excelCol=(n:number)=>{let result="";for(let x=n;x;x=Math.floor((x-1)/26))result=String.fromCharCode(65+(x-1)%26)+result;return result};
const excelSerial=(iso:string)=>Math.round((Date.parse(iso+"T00:00:00Z")-Date.UTC(1899,11,30))/86400000);
/** Formula fields V,W,X are local-only helpers for the visual load tab. */
function dateHelperFormula(r:number){
 const a="A"+r,b="B"+r;
 const year='IFERROR(VALUE(LEFT('+a+',4)),$T$1)';
 const week='IFERROR(VALUE(MID('+a+',FIND(".",'+a+')+1,2)),0)';
 const day='IF('+b+'="Tisdag",2,IF('+b+'="Onsdag",3,IF('+b+'="Torsdag",4,IF('+b+'="Fredag",5,IF('+b+'="Lördag",6,IF('+b+'="Söndag",7,1))))))';
 const first='DATE('+year+',1,4)';
 return 'IF(OR('+a+'="",C'+r+'=""),0,'+first+'-WEEKDAY('+first+',2)+1+('+week+'-1)*7+'+day+'-1)';
}
function normalizedDurationFormula(r:number){
 // Standard legacy-compatible Excel functions; no LET/TEXTSPLIT needed.
 const d="D"+r;
 let result='LOWER(TRIM('+d+'))';
 for(const [from,to] of [[" veckor","v"],[" vecka","v"],[" kalenderdagar","d"],[" kalenderdag","d"],[" dagar","d"],[" dag","d"],[" dygn","d"],[" ",""]]){
  result='SUBSTITUTE('+result+',"'+from+'","'+to+'")';
 }
 return 'IF('+d+'="","",'+result+')';
}
function durationHelperFormula(r:number){
 const y="Y"+r;
 const week= 'FIND("v",'+y+')';
 const extra='IFERROR(VALUE(SUBSTITUTE(MID('+y+','+week+'+1,99),"d","")),0)';
 return 'IFERROR(IF('+y+'="",0,IF(ISNUMBER(SEARCH("v",'+y+')),7*VALUE(LEFT('+y+','+week+'-1))+'+extra+',VALUE(SUBSTITUTE('+y+',"d","")))),0)';
}
function dailyLoadFormula(r:number){
 const e="E"+r,g="G"+r,v="V"+r,w="W"+r,h="H"+r;
 return 'IF(OR('+v+'=0,'+w+'<'+v+','+h+'="Pausad",'+h+'="Fryst",'+h+'="Klar"),0,IFERROR(IF('+e+'<>"",'+e+',IF('+g+'<>"",'+g+'/NETWORKDAYS('+v+','+w+')/8*100,0)),0))';
}
/** 28 weekly columns: previous week, current week and 26 weeks ahead. */
function workloadSheet(base:string){
 const weeks=Array.from({length:28},(_,i)=>shiftISOWeek(base,i-1));
 const headers=weeks.map((key,i)=>{
  const col=excelCol(i+2),monday=weekMonday(key).toISOString().slice(0,10);
  return {col,key,serial:excelSerial(monday)};
 });
 const loadFormula=(col:string)=>{
  const days=Array.from({length:5},(_,day)=>{
   const d=col+'$5+'+day;
   return 'SUMPRODUCT((Veckoplanering!$V$5:$V$5004>0)*(Veckoplanering!$V$5:$V$5004<='+d+')*(Veckoplanering!$W$5:$W$5004>='+d+')*Veckoplanering!$X$5:$X$5004)';
  });
  return 'ROUND(('+days.join('+')+')/5,1)';
 };
 const row=(r:number,values:string[])=>'<row r="'+r+'">'+values.join("")+'</row>';
 const body=[
  row(1,[cell("A1","BELÄGGNING PER VECKA",1)]),
  row(2,[cell("A2","Beräknas automatiskt från Veckoplanering. Ändra aktiviteter i första fliken.")]),
  row(3,[cell("A3","Omfattning: 1 vecka bakåt, aktuell vecka och 26 veckor framåt. Måndag–fredag, 40 h/vecka.")]),
  row(4,[cell("A4","Mått",1),...headers.map(h=>cell(h.col+"4",h.key,1))]),
  row(5,[cell("A5","Veckans måndag"),...headers.map(h=>cell(h.col+"5",h.serial,2))]),
  row(6,[cell("A6","Beläggning %",1),...headers.map(h=>formulaCell(h.col+"6",loadFormula(h.col),3))]),
  row(7,[cell("A7","Planerade timmar",1),...headers.map(h=>formulaCell(h.col+"7",h.col+"6*40/100",4))]),
  row(8,[cell("A8","Tillgängligt (h)",1),...headers.map(h=>cell(h.col+"8",40))]),
  row(9,[cell("A9","Ledig kapacitet (h)",1),...headers.map(h=>formulaCell(h.col+"9",h.col+"8-"+h.col+"7",4))]),
  row(11,[cell("A11","Grön: 80–100 % · Gul: under 80 % · Röd: över 100 %")]),
  row(12,[cell("A12","Endast aktiviteter i denna arbetsbok. Fliken ingår inte i importen.")])
 ];
 const last=headers.at(-1)!.col;
 return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
 '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'+
 '<sheetViews><sheetView workbookViewId="0"><pane xSplit="1" ySplit="5" topLeftCell="B6" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>'+
 '<cols><col min="1" max="1" width="31" customWidth="1"/><col min="2" max="29" width="16" customWidth="1"/></cols>'+
 '<sheetData>'+body.join("")+'</sheetData>'+
 '<conditionalFormatting sqref="B6:'+last+'6">'+
 '<cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>100</formula></cfRule>'+
 '<cfRule type="cellIs" dxfId="1" priority="2" operator="between"><formula>80</formula><formula>100</formula></cfRule>'+
 '<cfRule type="cellIs" dxfId="2" priority="3" operator="lessThan"><formula>80</formula></cfRule>'+
 '</conditionalFormatting></worksheet>';
}

export function createWeeklyV2Xlsx(rows:WeeklyV2Row[],base=currentWeekKey(),person:{name:string;email:string}={name:"",email:""}):Blob{
 if(rows.length>5000)throw Error("Max 5000 rader per export.");
 const exportYear=Number(normalizeISOWeek(base).slice(0,4));
 const body=[
  '<row r="1">'+cell("A1","PERSONLIG VECKOPLANERING",1)+cell("T1",exportYear)+cell("U1","KALENDERDAGAR-7")+'</row>',
  '<row r="2">'+cell("A2","Namn",1)+cell("B2",person.name)+cell("D2","E-postadress",1)+cell("E2",person.email)+'</row>',
  '<row r="4">'+WEEKLY_COLUMNS.map((h,i)=>cell(column(i)+"4",h,1)).join("")+'</row>'
 ];
 // Write each row once, with cells strictly ordered by column. Excel can
 // repair/remove shared formulas when helper cells are appended as V,Y,Z,W,X,S.
 // Keep import data A:R, dropdown S and calculated helpers V:Z in order.
 const options=weekOptions(base);
 for(let i=0;i<5000;i++){
  const row=rows[i],ref=i+5,first=i===0;
  let contents="";
  if(row){
   validateWeeklyV2(row);
   const values=[formatWeekLabel(row.week,base),row.day,row.task,row.duration,row.effort,row.workType,
    row.hours,row.status,row.priority,row.deadline,row.projectCode,row.projectName,row.firstWeek?formatWeekLabel(row.firstWeek,base):"",
    row.comment,row.moveReason,row.activityId];
   contents=values.map((v,n)=>cell(column(n)+ref,v)).join("")+
    cell("Q"+ref,row.rowKey||"")+cell("R"+ref,row.rowRevision??0);
  }
  if(options[i])contents+=cell("S"+ref,formatWeekLabel(options[i],base));
  contents+=sharedFormulaCell("V"+ref,dateHelperFormula(ref),0,first)+
   sharedFormulaCell("W"+ref,'IF(V'+ref+'=0,0,V'+ref+'+Z'+ref+'-1)',1,first)+
   sharedFormulaCell("X"+ref,dailyLoadFormula(ref),2,first)+
   sharedFormulaCell("Y"+ref,normalizedDurationFormula(ref),3,first)+
   sharedFormulaCell("Z"+ref,durationHelperFormula(ref),4,first);
  body.push('<row r="'+ref+'">'+contents+'</row>');
 }
 const validation=[
  '<dataValidation type="list" allowBlank="1" showErrorMessage="0" sqref="A5:A5004 M5:M5004"><formula1>$S$5:$S$265</formula1></dataValidation>',
  '<dataValidation type="list" allowBlank="1" sqref="B5:B5004"><formula1>"Måndag,Tisdag,Onsdag,Torsdag,Fredag,Lördag,Söndag"</formula1></dataValidation>',
  '<dataValidation type="list" allowBlank="1" sqref="H5:H5004"><formula1>"Planerad,Pågående,Pausad,Klar,Fryst,Flyttad"</formula1></dataValidation>',
  '<dataValidation type="list" allowBlank="1" sqref="I5:I5004"><formula1>"1,2,3,4,5"</formula1></dataValidation>',
 ].join("");
 const cols=WEEKLY_COLUMNS.map((v,i)=>'<col min="'+(i+1)+'" max="'+(i+1)+'" width="'+Math.min(45,Math.max(17,v.length+4))+'" customWidth="1"/>').join("");
 const sheet='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>'+cols+'<col min="17" max="26" hidden="1"/></cols><sheetData>'+body.join("")+'</sheetData><autoFilter ref="A4:P'+Math.max(4,rows.length+4)+'"/><dataValidations count="4">'+validation+'</dataValidations></worksheet>';
 const loadSheet=workloadSheet(base);
 const styles='<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1E40AF"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><dxfs count="3"><dxf><fill><patternFill patternType="solid"><fgColor rgb="FFFCA5A5"/><bgColor indexed="64"/></patternFill></fill></dxf><dxf><fill><patternFill patternType="solid"><fgColor rgb="FFBBF7D0"/><bgColor indexed="64"/></patternFill></fill></dxf><dxf><fill><patternFill patternType="solid"><fgColor rgb="FFFEF08A"/><bgColor indexed="64"/></patternFill></fill></dxf></dxfs></styleSheet>';
 return zip({
  "[Content_Types].xml":'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
  "_rels/.rels":'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  "xl/workbook.xml":'<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Veckoplanering" sheetId="1" r:id="rId1"/><sheet name="Beläggning" sheetId="2" r:id="rId3"/></sheets><calcPr calcId="191029" fullCalcOnLoad="1" forceFullCalc="1" calcMode="auto"/></workbook>',
  "xl/_rels/workbook.xml.rels":'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
  "xl/styles.xml":styles,
  "xl/worksheets/sheet1.xml":sheet,
  "xl/worksheets/sheet2.xml":loadSheet,
 });
}
/** Read legacy five-working-day XLSX precisely, without changing calendar semantics. */
function legacyFiveDayDuration(value:string):number{
 const raw=value.trim().toLowerCase().replace(/\s+/g," ");
 const number=/^\d+$/.exec(raw);
 if(number)return Number(number[0]);
 const explicit=/^(\d+)\s*kalenderdag(?:ar)?$/.exec(raw);
 if(explicit)return Number(explicit[1]);
 const m=/^(\d+)\s*(v|vecka|veckor|d|dag|dagar|dygn)(?:\s*(\d+)\s*(d|dag|dagar|dygn))?$/.exec(raw);
 if(!m)throw Error("Ogiltig varaktighet i femdagarsfil: "+value);
 const weeks=["v","vecka","veckor"].includes(m[2]);
 const days=Number(m[1])*(weeks?5:1)+Number(m[3]||0);
 if(days<1||days>3650)throw Error("Ogiltig varaktighet i femdagarsfil.");
 return days;
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
 const usesFiveDayWorkweeks=c("U1")==="ARBETSDAGAR-5";
 const headerRow=c("A4")==="Vecka"?4:c("A1")==="Vecka"?1:0;
 if(!headerRow)throw Error("Fel XLSX-mall. Exportera en ny personlig planeringsfil.");
 WEEKLY_COLUMNS.forEach((h,i)=>{if(c(column(i)+headerRow)!==h)throw Error("Fel veckoplaneringsmall i kolumn "+column(i)+".");});
 const out:WeeklyV2Row[]=[];
 for(let index=headerRow+1;index<=headerRow+5000;index++){
  const name=c("C"+index);if(!name)continue;
  const str=(x:string)=>c(x+index);
  const num=(s:string)=>{const v=s.replace("%","").replace(",",".").trim();return v?Number(v):null};
  // Workbooks exported by the intermediate 5-day release must keep their
  // original calendar endpoints even when read by the restored 7-day version.
  let duration=str("D");
  if(usesFiveDayWorkweeks){
   const explicitCalendar=/^(\d+)\s*kalenderdag(?:ar)?$/i.test(duration.trim());
   const n=legacyFiveDayDuration(duration);
   if(explicitCalendar){
    duration=n+" kalenderdagar";
   }else{
   const w=parseWeekLabel(str("A"),referenceYear);
   const day=str("B");
   const begin=weekMonday(w);
   const idx=WEEK_DAYS.findIndex(x=>x.toLowerCase()===day.trim().toLowerCase());
   if(idx<0)throw Error("Ogiltig veckodag i äldre femdagarsfil på rad "+index);
   begin.setUTCDate(begin.getUTCDate()+(idx===0?0:idx-1));
   const end=new Date(begin);
   if(n>1&&(begin.getUTCDay()===0||begin.getUTCDay()===6))throw Error("Ogiltig start på helg i femdagarsfil.");
   for(let left=n-1;left>0;){
    end.setUTCDate(end.getUTCDate()+1);
    if(end.getUTCDay()!==0&&end.getUTCDay()!==6)left--;
   }
   duration=(Math.round((end.getTime()-begin.getTime())/86400000)+1)+" kalenderdagar";
   }
  }
  const row:WeeklyV2Row={week:parseWeekLabel(str("A"),referenceYear),day:str("B"),task:name,duration,
   effort:num(str("E")),workType:str("F"),hours:num(str("G")),status:str("H"),
   priority:str("I"),deadline:str("J"),projectCode:str("K"),projectName:str("L"),
   firstWeek:str("M")?parseWeekLabel(str("M"),referenceYear):"",comment:str("N"),moveReason:str("O"),activityId:str("P"),rowKey:str("Q"),rowRevision:Number(str("R")||0)};
  validateWeeklyV2(row);out.push(row);
 }
 return {name:headerRow===4?c("B2").trim():"",email:headerRow===4?c("E2").trim().toLowerCase():"",rows:out};
}
