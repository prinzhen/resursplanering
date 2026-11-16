/** General project-planning interchange. Separate from the personal weekly XLSX.
 * Only well-defined fields are mapped. Unsupported scheduling semantics must
 * never be silently represented as if they were fully supported.
 */
import {zip,unzip,parseSheet} from "./individual-xlsx.ts";

export const PLAN_COLUMNS=["record_type","project_code","project_name","work_package_code","work_package_name",
 "activity_code","activity","parent_activity_code","description","start_date","end_date",
 "estimated_hours","status","employee_email","employee_name","effort_percent"] as const;
export type ExchangeRow=Record<(typeof PLAN_COLUMNS)[number],string>;
type Named={id:number;name:string};
export type PlanningSnapshot={
 projects:Array<Named&{code:string}>;
 workPackages:Array<Named&{projectId:number;code:string}>;
 activities:Array<Named&{projectId:number;workPackageId:number|null;parentActivityId:number|null;code:string|null;description:string|null;startDate:string;endDate:string;estimatedHours:number|null;status:string}>;
 employees:Array<Named&{email:string;role:string;capacityPercent:number;managerId:number|null}>;
 assignments:Array<{id:number;activityId:number;employeeId:number;effortPercent:number;startDate:string;endDate:string}>;
};
export function exchangeRows(data:PlanningSnapshot):ExchangeRow[]{
 const projects=new Map(data.projects.map(x=>[x.id,x])),people=new Map(data.employees.map(x=>[x.id,x]));
 const work=new Map(data.workPackages.map(x=>[x.id,x])),activities=new Map(data.activities.map(x=>[x.id,x]));
 const rows:ExchangeRow[]=[];
 for(const a of data.activities){
  const p=projects.get(a.projectId);if(!p)continue;
  const w=a.workPackageId?work.get(a.workPackageId):null;
  const parent=a.parentActivityId?activities.get(a.parentActivityId):null;
  const attached=data.assignments.filter(x=>x.activityId===a.id);
  const matches=attached.length?attached:[null];
  for(const assignment of matches){
   const person=assignment?people.get(assignment.employeeId):null;
   rows.push(Object.fromEntries(PLAN_COLUMNS.map(k=>[k,""])) as ExchangeRow);
   const row=rows.at(-1)!;
   Object.assign(row,{record_type:"activity",project_code:p.code,project_name:p.name,
    work_package_code:w?.code||"",work_package_name:w?.name||"",
    // Existing activities without an explicit code are identified by an
    // RP-ID surrogate. The importer resolves that ID only if it belongs to
    // the same existing project.
    activity_code:a.code||"RP-ID-"+a.id,activity:a.name,
    parent_activity_code:parent?(parent.code||"RP-ID-"+parent.id):"",
    description:a.description||"",start_date:a.startDate,end_date:a.endDate,
    estimated_hours:String(a.estimatedHours??""),status:a.status,
    employee_email:person?.email||"",employee_name:person?.name||"",
    effort_percent:assignment?String(assignment.effortPercent):""});
  }
 }
 return rows;
}
const e=(s:unknown)=>String(s??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
const textCell=(ref:string,val:string)=>'<c r="'+ref+'" t="inlineStr"><is><t xml:space="preserve">'+e(val)+'</t></is></c>';
export function writePlanningXlsx(rows:ExchangeRow[]):Blob{
 if(rows.length>5000)throw Error("Max 5000 planeringsrader.");
 const cellRef=(n:number)=>{let v=n+1,s="";while(v){v--;s=String.fromCharCode(65+v%26)+s;v=Math.floor(v/26)}return s};
 const lines=['<row r="1">'+PLAN_COLUMNS.map((x,i)=>textCell(cellRef(i)+"1",x)).join("")+'</row>'];
 rows.forEach((r,i)=>lines.push('<row r="'+(i+2)+'">'+PLAN_COLUMNS.map((c,j)=>textCell(cellRef(j)+(i+2),r[c]||"")).join("")+'</row>'));
 const worksheet='<?xml version="1.0" encoding="utf-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>'+lines.join("")+'</sheetData><autoFilter ref="A1:P'+Math.max(1,rows.length+1)+'"/></worksheet>';
 return zip({
  "[Content_Types].xml":'<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
  "_rels/.rels":'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  "xl/workbook.xml":'<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Planering" sheetId="1" r:id="rId1"/></sheets></workbook>',
  "xl/_rels/workbook.xml.rels":'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  "xl/worksheets/sheet1.xml":worksheet
 });
}
export async function readPlanningXlsx(file:File):Promise<ExchangeRow[]>{
 if(file.size>8000000)throw Error("XLSX-filen är större än 8 MB.");
 const parts=await unzip(new Uint8Array(await file.arrayBuffer()));
 const xml=parts.get("xl/worksheets/sheet1.xml");if(!xml)throw Error("XLSX saknar blad.");
 const texts:string[]=[];
 if(parts.get("xl/sharedStrings.xml")){
  const dom=new DOMParser().parseFromString(parts.get("xl/sharedStrings.xml")!,"application/xml");
  for(const item of Array.from(dom.getElementsByTagName("si")))
   texts.push(Array.from(item.getElementsByTagName("t")).map(x=>x.textContent||"").join(""));
 }
 const value=parseSheet(xml,texts),key=(i:number)=>{let n=i+1,s="";while(n){n--;s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26)}return s};
 PLAN_COLUMNS.forEach((header,i)=>{if(value(key(i)+"1")!==header)throw Error("Fel Excelmall i kolumn "+key(i));});
 const rows:ExchangeRow[]=[];
 for(let i=2;i<=5001;i++){
  const row=Object.fromEntries(PLAN_COLUMNS.map((c,j)=>[c,value(key(j)+i).trim()])) as ExchangeRow;
  if(!PLAN_COLUMNS.some(c=>row[c]))continue;
  rows.push(row);
 }
 return rows;
}
function safeIso(value:string){const date=value?.slice(0,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(date||"")||new Date(date+"T00:00:00Z").toISOString().slice(0,10)!==date)throw Error("Ogiltigt datum: "+value);return date}
function projectCode(s:string){return s.trim().toUpperCase().replace(/[^A-Z0-9._-]+/g,"_").slice(0,40)}
function asXml(xml:string){const dom=new DOMParser().parseFromString(xml,"application/xml");
 if(dom.getElementsByTagName("parsererror").length)throw Error("Ogiltigt MSPDI/XML.");
 const root=dom.documentElement;if(root.localName!=="Project")throw Error("XML-filen innehåller inte ett Microsoft Project-projekt.");
 return root;
}
const direct=(parent:Element,local:string)=>Array.from(parent.children).find(x=>x.localName===local)?.textContent?.trim()||"";
const children=(parent:Element,local:string)=>Array.from(parent.children).filter(x=>x.localName===local);
const sub=(parent:Element,collection:string,item:string)=>{const container=children(parent,collection)[0];return container?children(container,item):[]};
export function readMspdi(xml:string):ExchangeRow[]{
 const project=asXml(xml);
 const projectName=direct(project,"Name")||"Importerat Microsoft Project";
 const code=projectCode(direct(project,"Code")||"MSP-"+projectName)||"MSP-IMPORT";
 const people=new Map(sub(project,"Resources","Resource").map(r=>[direct(r,"UID"),{name:direct(r,"Name"),email:direct(r,"EmailAddress")}]));
 const tasks=sub(project,"Tasks","Task").filter(t=>direct(t,"UID")!=="0"&&direct(t,"IsNull")!=="1"&&direct(t,"Summary")!=="1");
 const assignments=new Map<string,Array<{email:string;name:string;effort:string}>>();
 for(const a of sub(project,"Assignments","Assignment")){
  const uid=direct(a,"TaskUID"),person=people.get(direct(a,"ResourceUID"));if(!uid||!person)continue;
  const units=Number(direct(a,"Units")||1);
  if(!Number.isFinite(units)||units<0)continue;
  const current=assignments.get(uid)||[];
  current.push({name:person.name,email:person.email,effort:String(Math.round(units*100))});
  assignments.set(uid,current);
 }
 const out:ExchangeRow[]=[];
 for(const t of tasks){
  const uid=direct(t,"UID"),start=direct(t,"Start"),end=direct(t,"Finish");
  if(!uid||!start||!end)continue;
  const codeId=direct(t,"WBS")||"MSP-"+uid;
  for(const p of assignments.get(uid)||[{name:"",email:"",effort:""}]){
   const row=Object.fromEntries(PLAN_COLUMNS.map(c=>[c,""])) as ExchangeRow;
   Object.assign(row,{record_type:"activity",project_code:code,project_name:projectName,
    activity_code:codeId,activity:direct(t,"Name")||"Aktivitet "+uid,
    description:direct(t,"Notes").slice(0,500),start_date:safeIso(start),
    end_date:safeIso(end),employee_name:p.name,employee_email:p.email,effort_percent:p.effort,
    status:"Planerad"});
   out.push(row);
  }
 }
 if(!out.length)throw Error("XML-filen innehåller inga aktiviteter med start- och slutdatum.");
 return out;
}
export function writeMspdi(rows:ExchangeRow[]):string{
 const activities=new Map<string,{row:ExchangeRow;uid:number}>();
 const resources=new Map<string,{name:string;uid:number}>();
 rows.forEach(r=>{
  if(r.record_type!=="activity")return;
  const key=r.project_code+"|"+r.activity_code+"|"+r.activity+"|"+r.start_date;
  if(!activities.has(key))activities.set(key,{row:r,uid:activities.size+1});
  if(r.employee_email&&!resources.has(r.employee_email))resources.set(r.employee_email,{name:r.employee_name||r.employee_email,uid:resources.size+1});
 });
 const taskXml=[...activities.values()].map(({row:r,uid})=>'<Task><UID>'+uid+'</UID><ID>'+uid+'</ID><Name>'+e(r.activity)+'</Name><Start>'+e(r.start_date)+'T08:00:00</Start><Finish>'+e(r.end_date)+'T17:00:00</Finish><Notes>'+e(r.description)+'</Notes><WBS>'+e(r.activity_code)+'</WBS></Task>').join("");
 const resXml=[...resources.entries()].map(([email,{name,uid}])=>'<Resource><UID>'+uid+'</UID><ID>'+uid+'</ID><Name>'+e(name)+'</Name><EmailAddress>'+e(email)+'</EmailAddress></Resource>').join("");
 const assignmentXml=rows.flatMap(r=>{if(!r.employee_email)return[];const key=r.project_code+"|"+r.activity_code+"|"+r.activity+"|"+r.start_date;
  const task=activities.get(key),resource=resources.get(r.employee_email);if(!task||!resource)return[];
  return ['<Assignment><UID>'+((task.uid*100000)+resource.uid)+'</UID><TaskUID>'+task.uid+'</TaskUID><ResourceUID>'+resource.uid+'</ResourceUID><Units>'+((Number(r.effort_percent)||0)/100)+'</Units></Assignment>'];
 }).join("");
 const projectName=rows[0]?.project_name||"Resursplanering";
 return '<?xml version="1.0" encoding="utf-8"?>\n<Project xmlns="http://schemas.microsoft.com/project"><SaveVersion>14</SaveVersion><Name>'+e(projectName)+'</Name><Tasks>'+taskXml+'</Tasks><Resources>'+resXml+'</Resources><Assignments>'+assignmentXml+'</Assignments></Project>';
}
/** MPX is a legacy, configurable record format. We support a documented
 * task subset (numeric layout 61 + tasks 70); unsupported records are never
 * claimed to have been imported. Export includes WBS, Start and Finish.
 */
function mpxFields(line:string):string[]{
 const out:string[]=[];let token="",quoted=false;
 for(let i=0;i<line.length;i++){
  const ch=line[i];
  if(ch==='"'){
   if(quoted&&line[i+1]==='"'){token+='"';i++}else quoted=!quoted;
  }else if(ch===","&&!quoted){out.push(token);token=""}
  else token+=ch;
 }
 if(quoted)throw Error("Ogiltigt MPX-citat.");
 out.push(token);return out;
}
const quoted=(s:string)=>'"'+s.replaceAll('"','""').replace(/[\r\n]+/g," ")+'"';
export function writeMpx(rows:ExchangeRow[]):string{
 const unique=new Map<string,ExchangeRow>();
 for(const row of rows)if(row.record_type==="activity"){
  const key=row.project_code+"|"+row.activity_code+"|"+row.start_date;
  if(!unique.has(key))unique.set(key,row);
 }
 const output=["MPX,Microsoft Project,4.0","61,90,1,2,50,51"];
 let i=0;
 for(const r of unique.values()){
  i++;
  output.push(["70",String(i),quoted(r.activity),quoted(r.activity_code),r.start_date,r.end_date].join(","));
 }
 return output.join("\r\n")+"\r\n";
}
export function readMpx(input:string,importCode="MPX-IMPORT",importName="Importerat MPX"):ExchangeRow[]{
 const text=input.replace(/^\uFEFF/,""),lines=text.split(/\r?\n/).filter(x=>x.trim());
 if(lines.length>6000||!/^MPX[,;]/i.test(lines[0]||""))throw Error("Filen saknar MPX-huvud.");
 let columns:string[]=[];
 const result:ExchangeRow[]=[];
 for(const line of lines.slice(1)){
  const values=mpxFields(line),type=values[0];
  if(type==="61"){columns=values.slice(1);continue}
  if(type!=="70")continue;
  if(!columns.length)throw Error("MPX saknar numerisk aktivitetslayout (post 61).");
  const field=(id:string)=>values[columns.indexOf(id)+1]||"";
  const name=field("1"),start=field("50").slice(0,10),end=field("51").slice(0,10);
  if(!name||!start||!end)continue;
  const row=Object.fromEntries(PLAN_COLUMNS.map(k=>[k,""])) as ExchangeRow;
  Object.assign(row,{record_type:"activity",project_code:importCode,project_name:importName,
   activity_code:field("2")||"MPX-"+(field("90")||result.length+1),
   activity:name,start_date:safeIso(start),end_date:safeIso(end),status:"Planerad"});
  result.push(row);
 }
 if(!result.length)throw Error("MPX innehåller inga läsbara aktiviteter med start och slut.");
 return result;
}
export function detectExchangeFile(filename:string):"xlsx"|"xml"|"mpp"|"mpx"|"json"{
 const ext=filename.toLowerCase().split(".").at(-1);
 if(ext==="csv")throw Error("CSV stöds inte längre. Använd XLSX, XML/MSPDI eller MPX.");
 if(ext==="xlsx"||ext==="xml"||ext==="mpp"||ext==="mpx"||ext==="json")return ext;
 throw Error("Formatet stöds inte: "+filename);
}
