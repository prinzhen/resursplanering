"use client";
import {useEffect,useState} from "react";
import {createWeeklyV2Xlsx,readWeeklyV2Xlsx,normalizeISOWeek,durationLabel,WEEK_DAYS,type WeeklyV2Row} from "@/lib/weekly-xlsx-v2";
import type {FormValues} from "@/lib/individual-xlsx";

type Person={id:number;name:string;email:string};
const parseOldWeek=(value:string)=>{const m=/^(\d{4})-[VW](\d{1,2})/i.exec(value.trim());return m?normalizeISOWeek(m[1]+"-V"+m[2]):"";};
function rangeDuration(start:string,end:string):number|null{
 if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end))return null;
 const a=Date.parse(start+"T00:00:00Z"),b=Date.parse(end+"T00:00:00Z");
 return b>=a?Math.round((b-a)/86400000)+1:null;
}
function weekFromDate(date:string):string{
 const d=new Date(date+"T00:00:00Z");d.setUTCDate(d.getUTCDate()+3-((d.getUTCDay()+6)%7));
 const year=d.getUTCFullYear(),first=new Date(Date.UTC(year,0,4));
 first.setUTCDate(first.getUTCDate()-((first.getUTCDay()+6)%7));
 const number=1+Math.round((d.getTime()-first.getTime())/604800000);
 return normalizeISOWeek(year+"-V"+number);
}
function asWeeklyRows(data:FormValues,employeeId:number,identities:Array<{uid:string;activityId:number}>):WeeklyV2Row[]{
 const byUid=new Map(identities.map(x=>[x.uid,x.activityId]));
 return data.activities.map((a,i)=>{
  const days=rangeDuration(a.periodStart||"",a.periodEnd||"");
  const week=a.periodStart&&days?weekFromDate(a.periodStart):parseOldWeek(a.week);
  const day=a.periodStart&&days?WEEK_DAYS[((new Date(a.periodStart+"T00:00:00Z").getUTCDay()+6)%7)+1]:"";
  const activityId=byUid.get(a.uid);const id=activityId?`activity-${activityId}`:a.uid;
  const source=(a.periodStart||a.week).replace(/[^a-zA-Z0-9-]/g,"");
  return {week,day,task:a.name,duration:durationLabel(days??7),effort:a.effortPercent??null,
   workType:a.kind,hours:a.hours,status:a.status,priority:a.priority,deadline:a.dueDate,
   projectCode:a.projectCode,projectName:a.link,firstWeek:parseOldWeek(a.firstWeek)||week,
   comment:a.comment,moveReason:a.reason,activityId:id,rowKey:activityId?`legacy-${employeeId}-${activityId}-${source}`:"",rowRevision:0};
 });
}
export default function WeeklyV2Page(){
 const [people,setPeople]=useState<Person[]>([]),[selected,setSelected]=useState(""),[rows,setRows]=useState<WeeklyV2Row[]>([]);
 const [error,setError]=useState(""),[message,setMessage]=useState(""),[loading,setLoading]=useState(false);
 const [preview,setPreview]=useState<{created:number;updated:number;unchanged:number}|null>(null);
 useEffect(()=>{fetch("/api/data",{cache:"no-store"}).then(async r=>{
  if(r.status===401){window.location.assign("/login");return null}
  if(!r.ok)throw Error("Kunde inte läsa medarbetare");
  return r.json() as Promise<{employees:Person[];viewer?:{employeeId:number|null;isAdmin:boolean;isGroupManager:boolean;managedEmployeeIds:number[]}}>;
 }).then(data=>{
  if(!data)return;
  const viewer=data.viewer;
  const visible=data.employees.filter(p=>viewer?.isAdmin||p.id===viewer?.employeeId||(viewer?.isGroupManager&&viewer.managedEmployeeIds.includes(p.id)));
  setPeople(visible);
  if(visible.length===1)setSelected(visible[0].email);
 }).catch(e=>setError(String(e)))},[]);
 const fetchRows=async(email:string)=>{setSelected(email);setRows([]);setPreview(null);setError("");setMessage("");if(!email)return;setLoading(true);
  try{const r=await fetch("/api/individual?email="+encodeURIComponent(email)+"&includeClosed=1",{cache:"no-store"});
   const body=await r.json() as FormValues&{error?:string};if(!r.ok)throw Error(body.error||"API-fel");
   const person=people.find(p=>p.email===email);if(!person)throw Error("Välj en medarbetare.");
   const response=await fetch("/api/weekly-v2?employeeId="+person.id,{cache:"no-store"});
   const current=await response.json() as {rows:Array<{rowKey:string;employeeId:number;activityId:number;week:string;weekday:number|null;durationDays:number;effort:number|null;hours:number|null;workType:string;status:string;priority:number|null;deadline:string|null;firstWeek:string;comment:string;moveReason:string;revision:number;task:string;projectCode:string;projectName:string}>;identities:Array<{uid:string;activityId:number}>;error?:string};
   if(!response.ok)throw Error(current.error||"Kunde inte läsa sparade planeringsrader");
   const next=asWeeklyRows(body,person.id,current.identities);
   const stored=current.rows.map(w=>({week:w.week,day:WEEK_DAYS[w.weekday??0]||"",task:w.task,duration:durationLabel(w.durationDays),
    effort:w.effort,workType:w.workType,hours:w.hours,status:w.status,priority:String(w.priority??""),
    deadline:w.deadline||"",projectCode:w.projectCode,projectName:w.projectName,firstWeek:w.firstWeek,
    comment:w.comment,moveReason:w.moveReason,activityId:"activity-"+w.activityId,rowKey:w.rowKey,rowRevision:w.revision}));
   const savedByKey=new Map(stored.map(x=>[x.rowKey,x]));
   const keys=new Set(next.map(x=>x.rowKey));
   setRows([...next.map(x=>savedByKey.get(x.rowKey)||x),...stored.filter(x=>!keys.has(x.rowKey))]);
   setMessage("Läste "+next.length+" befintliga periodrader och "+stored.length+" sparade v2-rader.");
  }catch(e){setError(e instanceof Error?e.message:String(e))}finally{setLoading(false)}
 };
 const save=(items:WeeklyV2Row[],name:string)=>{
  const blob=createWeeklyV2Xlsx(items);const url=URL.createObjectURL(blob);
  const a=document.createElement("a");a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);
 };
 const openFile=async(file:File|null)=>{if(!file)return;setError("");try{
  const parsed=await readWeeklyV2Xlsx(file);setRows(parsed);setPreview(null);
  setMessage("Validerade "+parsed.length+" rader. Klicka Förhandsgranska ändringar innan du sparar.");
 }catch(e){setError(e instanceof Error?e.message:String(e))}
 };
 const importRows=async(commit:boolean)=>{
  const person=people.find(p=>p.email===selected);if(!person){setError("Välj medarbetare.");return}
  setError("");setLoading(true);
  try{
   const response=await fetch("/api/weekly-v2",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({employeeId:person.id,rows,commit})});
   const result=await response.json() as {error?:string;preview:{created:number;updated:number;unchanged:number};committed:boolean};
   if(!response.ok)throw Error(result.error||"Importen avbröts");
   setPreview(result.preview);
   if(commit){setMessage("Sparade "+(result.preview.created+result.preview.updated)+" planeringsposter. Rapporterad tid och äldre beläggningsperioder är oförändrade.");
    await fetchRows(person.email);
   }else{setMessage("Förhandsgranskning: "+result.preview.created+" nya, "+result.preview.updated+" ändrade, "+result.preview.unchanged+" oförändrade.")}
  }catch(e){setError(e instanceof Error?e.message:String(e))}
  finally{setLoading(false)}
 };
 return <main className="min-h-screen bg-slate-50 p-5 text-slate-900"><div className="mx-auto max-w-6xl space-y-5">
  <header className="flex flex-wrap justify-between gap-4"><div><p className="text-sm font-medium text-blue-700">Resursplanering · Utvecklingsversion</p><h1 className="text-3xl font-semibold">Veckoplanering XLSX v2</h1>
   <p className="mt-2 text-sm text-slate-600">16 kolumner: vecka, valfri dag, varaktighet i dagar/veckor och planerad insats. Standard 8 h/dag och 40 h/vecka.</p></div>
   <a className="rounded-lg border bg-white px-4 py-2 text-sm" href="/individual">← Befintlig veckoplanering</a></header>
  {error&&<p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4 text-red-800">{error}</p>}
  {message&&<p className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-blue-900">{message}</p>}
  <section className="rounded-xl border bg-white p-5"><h2 className="mb-4 font-semibold">Exportera eller läs XLSX</h2>
   <div className="flex flex-wrap items-center gap-3">
    <select className="min-w-64 rounded-lg border p-2" value={selected} onChange={e=>fetchRows(e.target.value)}><option value="">Välj medarbetare</option>{people.map(p=><option key={p.id} value={p.email}>{p.name}</option>)}</select>
    <button disabled={loading||!selected} onClick={()=>fetchRows(selected)} className="rounded-lg border px-4 py-2 disabled:opacity-50">Hämta planering</button>
    <button onClick={()=>save(rows,"veckoplanering-v2.xlsx")} className="rounded-lg bg-blue-700 px-4 py-2 text-white">Exportera XLSX</button>
    <button onClick={()=>save([],"veckoplanering-v2-mall.xlsx")} className="rounded-lg border px-4 py-2">Tom XLSX-mall</button>
    <label className="cursor-pointer rounded-lg border px-4 py-2">Läs XLSX<input type="file" accept=".xlsx" className="hidden" onChange={e=>openFile(e.currentTarget.files?.[0]||null)}/></label>
   </div>
   <div className="mt-4 flex flex-wrap gap-3">
    <button disabled={loading||!rows.length} onClick={()=>importRows(false)} className="rounded-lg border border-blue-400 px-4 py-2 disabled:opacity-50">Förhandsgranska ändringar</button>
    <button disabled={loading||!preview||preview.created+preview.updated===0} onClick={()=>importRows(true)} className="rounded-lg bg-emerald-700 px-4 py-2 text-white disabled:opacity-50">Godkänn och spara planeringsposter</button>
   </div>
   <p className="mt-3 text-sm text-amber-800">V2-importen sparar separata planeringsposter och revisionshistorik. Den ändrar inte registrerad tid eller befintliga beläggningsperioder. En ny aktivitet måste först skapas i planeringsverktyget; Excel-raden måste ha ett befintligt aktivitets-ID och dold radnyckel.</p>
  </section>
  <section className="overflow-x-auto rounded-xl border bg-white p-4"><h2 className="mb-3 font-semibold">Förhandsgranskning ({rows.length} rader)</h2><table className="w-full min-w-[950px] text-left text-sm">
   <thead><tr className="border-b bg-slate-100"><th className="p-2">Vecka</th><th className="p-2">Dag</th><th className="p-2">Aktivitet</th><th className="p-2">Varaktighet</th><th className="p-2">Insats</th><th className="p-2">Timmar</th><th className="p-2">Projekt</th></tr></thead>
   <tbody>{rows.map((r,i)=><tr className="border-b" key={i}><td className="p-2">{r.week}</td><td className="p-2">{r.day||"Ej vald"}</td><td className="p-2">{r.task}</td><td className="p-2">{r.duration}</td><td className="p-2">{r.effort===null?"–":r.effort+" %"}</td><td className="p-2">{r.hours??"–"}</td><td className="p-2">{r.projectCode}</td></tr>)}</tbody></table>
  </section>
 </div></main>;
}
