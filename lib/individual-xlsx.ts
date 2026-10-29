/* Browser-side OOXML reader/writer for the one-sheet individual planning form.
 * No external CDN and no macros. The writer uses ZIP STORE; the reader accepts
 * STORE and DEFLATE, as produced by LibreOffice and Excel.
 */
export type FormActivity={uid:string;week:string;name:string;kind:string;link:string;projectCode:string;hours:number;status:string;priority:string;dueDate:string;comment:string;firstWeek:string;reason:string};
export type FormMember={code:string;name:string;state:string};
export type FormValues={name:string;email:string;activities:FormActivity[];members:FormMember[]};
const utf8=new TextEncoder(),utf8d=new TextDecoder();
const xml=(v:unknown)=>String(v??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
const col=(n:number)=>{let s="";for(;n;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s};
const toUint=(v:number,n:number)=>Array.from({length:n},(_,i)=>(v>>>(8*i))&255);
const concat=(arr:Uint8Array[])=>{const out=new Uint8Array(arr.reduce((n,a)=>n+a.length,0));let p=0;for(const a of arr){out.set(a,p);p+=a.length}return out};
function crc(bytes:Uint8Array){let c=~0;for(const b of bytes){c^=b;for(let j=0;j<8;j++)c=(c>>>1)^((c&1)?0xEDB88320:0)}return (~c)>>>0}
function zip(entries:Record<string,string>){
 const locals:Uint8Array[]=[],central:Uint8Array[]=[];let at=0;
 for(const [name,value] of Object.entries(entries)){
   const file=utf8.encode(value),nm=utf8.encode(name),checksum=crc(file);
   const local=new Uint8Array(30+nm.length),l=new DataView(local.buffer);
   l.setUint32(0,0x04034b50,true);
   l.setUint16(4,20,true);
   l.setUint16(6,0x0800,true);
   l.setUint16(8,0,true);
   l.setUint32(14,checksum,true);
   l.setUint32(18,file.length,true);
   l.setUint32(22,file.length,true);
   l.setUint16(26,nm.length,true);
   local.set(nm,30);
   const dir=new Uint8Array(46+nm.length),d=new DataView(dir.buffer);
   d.setUint32(0,0x02014b50,true);
   d.setUint16(4,20,true);
   d.setUint16(6,20,true);
   d.setUint16(8,0x0800,true);
   d.setUint16(10,0,true);
   d.setUint32(16,checksum,true);
   d.setUint32(20,file.length,true);
   d.setUint32(24,file.length,true);
   d.setUint16(28,nm.length,true);
   d.setUint32(42,at,true);
   dir.set(nm,46);
   locals.push(local,file);central.push(dir);
   at+=local.length+file.length;
 }
 const cdir=concat(central),end=new Uint8Array(22),e=new DataView(end.buffer);
 e.setUint32(0,0x06054b50,true);
 e.setUint16(8,central.length,true);
 e.setUint16(10,central.length,true);
 e.setUint32(12,cdir.length,true);
 e.setUint32(16,at,true);
 return new Blob([...locals,cdir,end],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
}
async function unzip(bytes:Uint8Array){
 const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let e=-1;
 for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--){if(v.getUint32(i,true)===0x06054b50){e=i;break}}
 if(e<0)throw Error("Filen är inte en giltig XLSX-fil.");
 const count=v.getUint16(e+10,true),start=v.getUint32(e+16,true);
 if(count>500)throw Error("Arbetsboken innehåller för många delar.");
 const result=new Map<string,string>();let off=start;let sum=0;
 for(let i=0;i<count;i++){
  if(v.getUint32(off,true)!==0x02014b50)throw Error("Skadad XLSX-katalog.");
  const method=v.getUint16(off+10,true),compressed=v.getUint32(off+20,true),uncompressed=v.getUint32(off+24,true),namelen=v.getUint16(off+28,true),extra=v.getUint16(off+30,true),comment=v.getUint16(off+32,true),localOff=v.getUint32(off+42,true);
  const name=utf8d.decode(bytes.slice(off+46,off+46+namelen));off+=46+namelen+extra+comment;
  if(uncompressed>6_000_000||(sum+=uncompressed)>15_000_000)throw Error("XLSX-filen är för stor.");
  if(!["xl/worksheets/sheet1.xml","xl/sharedStrings.xml"].includes(name))continue;
  if(v.getUint32(localOff,true)!==0x04034b50)throw Error("Skadad XLSX-fil.");
  const begin=localOff+30+v.getUint16(localOff+26,true)+v.getUint16(localOff+28,true);
  const data=bytes.slice(begin,begin+compressed);let output:Uint8Array;
  if(method===0)output=data;
  else if(method===8){const stream=new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));output=new Uint8Array(await new Response(stream).arrayBuffer())}
  else throw Error("ZIP-komprimering stöds inte: "+method);
  result.set(name,utf8d.decode(output));
 }
 return result;
}
function parseSheet(xmlText:string,shared:string[]){
 const doc=new DOMParser().parseFromString(xmlText,"application/xml");
 if(doc.getElementsByTagName("parsererror").length)throw Error("Felaktigt XML-innehåll i arbetsboken.");
 const get=(node:Element,name:string)=>Array.from(node.getElementsByTagName("*")).find(x=>x.localName===name);
 const cells=new Map<string,string>();
 for(const c of Array.from(doc.getElementsByTagName("*")).filter(x=>x.localName==="c")){
  const ref=c.getAttribute("r");if(!ref)continue;
  const kind=c.getAttribute("t");let value="";
  if(kind==="inlineStr")value=Array.from(c.getElementsByTagName("*")).filter(x=>x.localName==="t").map(x=>x.textContent||"").join("");
  else {value=get(c,"v")?.textContent||"";if(kind==="s")value=shared[Number(value)]||""}
  cells.set(ref,value);
 }
 return (ref:string)=>cells.get(ref)?.trim()||"";
}
export async function readIndividualXlsx(file:File):Promise<FormValues>{
 if(file.size>8_000_000)throw Error("Maximal filstorlek är 8 MB.");
 const entries=await unzip(new Uint8Array(await file.arrayBuffer()));
 const doc=entries.get("xl/worksheets/sheet1.xml");if(!doc)throw Error("Arbetsboken saknar första kalkylbladet.");
 const ss=entries.get("xl/sharedStrings.xml");let strings:string[]=[];
 if(ss){const parsed=new DOMParser().parseFromString(ss,"application/xml");strings=Array.from(parsed.getElementsByTagName("*")).filter(x=>x.localName==="si").map(el=>Array.from(el.getElementsByTagName("*")).filter(x=>x.localName==="t").map(x=>x.textContent||"").join(""))}
 const cell=parseSheet(doc,strings),activities:FormActivity[]=[];
 // Support current approved layout (header row 8), and the prior slim layout (row 7).
 const header=cell("A8").toLowerCase().includes("vecka")?8:cell("A7").toLowerCase().includes("vecka")?7:0;
 if(!header)throw Error("Det här är inte det individuella planeringsformuläret.");
 for(let r=header+1;r<=header+100;r++){
  const name=cell("B"+r);if(!name)continue;
  const rawHours=cell("F"+r).replace(",",".");const hours=rawHours?Number(rawHours):0;
  if(!Number.isFinite(hours))throw Error("Ogiltigt antal timmar på rad "+r);
  const d=cell("I"+r);
  const dueDate=d&&/^\d{5}(\.\d+)?$/.test(d)?new Date(Date.UTC(1899,11,30)+Number(d)*86400000).toISOString().slice(0,10):d;
  activities.push({uid:cell("M"+r),week:cell("A"+r),name,kind:cell("C"+r)||"Övrigt",link:cell("D"+r),projectCode:cell("E"+r),hours,status:cell("G"+r)||"Planerad",priority:cell("H"+r),dueDate,comment:cell("J"+r),firstWeek:cell("K"+r),reason:cell("L"+r)});
 }
 const members:FormMember[]=[];
 // Keep membership as a separate section on the SAME worksheet.
 for(let r=77;r<=110;r++){const code=cell("A"+r),name=cell("B"+r);if(!code&&!name)continue;members.push({code,name,state:cell("C"+r)||"Aktiv"})}
 return {name:cell("B4"),email:cell("F4"),activities,members};
}
function currentISOWeek(d:Date){const u=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate()));u.setUTCDate(u.getUTCDate()+4-(u.getUTCDay()||7));const year=u.getUTCFullYear(),yearStart=new Date(Date.UTC(year,0,1));return{year,week:Math.ceil(((u.getTime()-yearStart.getTime())/86400000+1)/7)}}
function weekLabel(y:number,w:number,base:{year:number;week:number}){
 const date=(year:number,week:number)=>{const d=new Date(Date.UTC(year,0,4));d.setUTCDate(d.getUTCDate()-(d.getUTCDay()+6)%7+(week-1)*7);return d.getTime()};
 const diff=(date(y,w)-date(base.year,base.week))/604800000;
 const suffix=diff===-1?" (föregående vecka)":diff===0?" (aktuell vecka)":diff===1?" (kommande vecka)":"";
 return(y===base.year?"":y+" ")+"v."+String(w).padStart(2,"0")+suffix;
}
function row(n:number,cells:Record<number,string|number|null>,style=0){let out="";for(const [c,v] of Object.entries(cells)){if(v===null||v===undefined||v==="")continue;const ref=col(Number(c))+n;out+=typeof v==="number"?'<c r="'+ref+'" s="'+style+'"><v>'+v+'</v></c>':'<c r="'+ref+'" s="'+style+'" t="inlineStr"><is><t xml:space="preserve">'+xml(v)+'</t></is></c>'}return '<row r="'+n+'">'+out+'</row>'}
export function createIndividualXlsx(values:FormValues){
 const base=currentISOWeek(new Date()),rows:string[]=[];
 rows.push(row(1,{1:"MIN PLANERING · AKTIVITETER & UPPFÖLJNING"},1));
 rows.push(row(4,{1:"NAMN",2:values.name,5:"E-POST",6:values.email,10:"UPPDATERAD",11:new Date().toISOString().slice(0,10)},2));
 rows.push(row(6,{1:"Välj vecka i listan eller skriv fritt, exempelvis 44, v44 eller 2017 8."},3));
 rows.push(row(8,{1:"Vecka",2:"Vad ska jag göra?",3:"Typ av arbete",4:"Projekt / verksamhet",5:"Projektkod",6:"Planerade timmar",7:"Status",8:"Prioritet",9:"Klart senast",10:"Kommentar / behov",11:"Först planerad",12:"Orsak om flyttad",13:"Aktivitets-ID"},2));
 for(let i=0;i<60;i++){const a=values.activities[i];rows.push(row(i+9,a?{1:a.week,2:a.name,3:a.kind,4:a.link,5:a.projectCode,6:a.hours,7:a.status,8:a.priority,9:a.dueDate,10:a.comment,11:a.firstWeek,12:a.reason,13:a.uid}:{},i%2?4:5))}
 rows.push(row(73,{1:"PROJEKTMEDVERKAN – även utan aktiviteter"},1));
 rows.push(row(76,{1:"Projektkod",2:"Projektnamn",3:"Medverkan"},2));
 for(let i=0;i<34;i++){const m=values.members[i];rows.push(row(i+77,m?{1:m.code,2:m.name,3:m.state}:{},i%2?4:5))}
 // Dropdown sources follow current ISO week.
 for(let i=0;i<85;i++){
  const offset=i===0?-1:i<69?i-1:-(i-67);
  const monday=new Date(Date.UTC(base.year,0,4));monday.setUTCDate(monday.getUTCDate()-(monday.getUTCDay()+6)%7+(base.week-1+offset)*7);
  const yw=currentISOWeek(monday);
  const target=i+2, extra=row(target,{24:weekLabel(yw.year,yw.week,base)},0);
  const at=rows.findIndex(x=>x.startsWith(`<row r="${target}">`));
  if(at<0)rows.push(extra);else rows[at]=rows[at].replace("</row>",extra.replace(/^<row[^>]*>/,"").replace("</row>","")+"</row>")
 }
 const maxRow=110,validations=[
 '<dataValidation type="list" allowBlank="1" showErrorMessage="0" sqref="A9:A68 K9:K68"><formula1>$X$2:$X$86</formula1></dataValidation>',
 '<dataValidation type="list" allowBlank="1" sqref="C9:C68"><formula1>"Projekt,Verksamhet,Övrigt"</formula1></dataValidation>',
 '<dataValidation type="list" allowBlank="1" sqref="G9:G68"><formula1>"Planerad,Pågående,Pausad,Klar,Fryst"</formula1></dataValidation>',
 '<dataValidation type="list" allowBlank="1" sqref="C77:C110"><formula1>"Aktiv,Vilande"</formula1></dataValidation>'
 ].join("");
 // Excel needs rows numerically sorted (source rows 2..86 are inserted in order below).
 rows.sort((a,b)=>Number(/<row r="(\d+)"/.exec(a)?.[1]||0)-Number(/<row r="(\d+)"/.exec(b)?.[1]||0));
 const worksheet='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
 +'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="8" topLeftCell="A9" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
 +'<cols>'+[[1,28],[2,40],[3,18],[4,28],[5,19],[6,18],[7,18],[8,15],[9,18],[10,32],[11,27],[12,31],[13,19]].map(([n,w])=>'<col min="'+n+'" max="'+n+'" width="'+w+'" customWidth="1"/>').join('')+'<col min="24" max="24" hidden="1"/></cols>'
 +'<sheetData>'+rows.join("")+'</sheetData>'
 +'<mergeCells count="3"><mergeCell ref="A1:M2"/><mergeCell ref="A6:M6"/><mergeCell ref="A73:M74"/></mergeCells>'
 +'<dataValidations count="4">'+validations+'</dataValidations></worksheet>';
 const styles='<?xml version="1.0" encoding="UTF-8"?>'
 +'<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="3"><font><sz val="11"/><name val="Aptos"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="16"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/></font></fonts><fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF142B40"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF087F87"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF1F5F9"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFill="1" applyFont="1"/><xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0" applyFill="1" applyFont="1"/><xf numFmtId="0" fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1"/></cellXfs></styleSheet>';
 return zip({
  "[Content_Types].xml":'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
  "_rels/.rels":'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  "xl/workbook.xml":'<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Min planering" sheetId="1" r:id="rId1"/></sheets></workbook>',
  "xl/_rels/workbook.xml.rels":'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
  "xl/styles.xml":styles,
  "xl/worksheets/sheet1.xml":worksheet
 });
}