"use client";
import {useEffect,useMemo,useState} from "react";
import {createWeeklyV2Xlsx,readWeeklyV2Xlsx,normalizeISOWeek,durationLabel,splitPeriodIntoWeeks,currentWeekKey,shiftISOWeek,weekMonday,WEEK_DAYS,type WeeklyV2Row} from "@/lib/weekly-xlsx-v2";
import type {FormValues} from "@/lib/individual-xlsx";
import {rowFromDates,scheduleDates,hoursForSchedule} from "@/lib/activity-calendar";

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
/** One exported row per employee/activity, even when legacy allocations contain many periods. */
function asWeeklyRows(data:FormValues,employeeId:number,identities:Array<{uid:string;activityId:number}>):WeeklyV2Row[]{
 const byUid=new Map(identities.map(x=>[x.uid,x.activityId]));
 const groups=new Map<string,FormValues["activities"]>();
 for(const a of data.activities){
  const list=groups.get(a.uid)||[];list.push(a);groups.set(a.uid,list);
 }
 return [...groups.entries()].map(([uid,periods]):WeeklyV2Row=>{
  const first=periods[0],activityId=byUid.get(uid);
  const starts=periods.map(p=>p.periodStart).filter((x):x is string=>!!x&&/^\d{4}-\d{2}-\d{2}$/.test(x));
  const ends=periods.map(p=>p.periodEnd).filter((x):x is string=>!!x&&/^\d{4}-\d{2}-\d{2}$/.test(x));
  const start=starts.sort()[0],end=ends.sort().at(-1);
  const dates=start&&end&&end>=start?rowFromDates(start,end):
   {week:parseOldWeek(first.week)||currentWeekKey(),day:"",duration:"1 vecka"};
  const effort=periods.at(-1)?.effortPercent??first.effortPercent??null;
  const projectCode=first.projectCode||(first.kind==="Verksamhet"?"INTERNAL-VERK":first.kind==="Övrigt"?"INTERNAL-OVR":"");
  return {...dates,task:first.name,effort,workType:first.kind,
   hours:effort===null?first.hours??null:hoursForSchedule({...dates,effort}),status:first.status,priority:first.priority,
   deadline:first.dueDate||"",projectCode,projectName:first.link,
   firstWeek:parseOldWeek(first.firstWeek)||dates.week,comment:first.comment,moveReason:first.reason,
   activityId:activityId?"activity-"+activityId:uid,
   rowKey:activityId?"plan-"+employeeId+"-"+activityId:"",
   rowRevision:0};
 });
}
export default function WeeklyV2Page(){
 const [people,setPeople]=useState<Person[]>([]),[selected,setSelected]=useState(""),[rows,setRows]=useState<WeeklyV2Row[]>([]);
 const [error,setError]=useState(""),[message,setMessage]=useState(""),[loading,setLoading]=useState(false);
 const [preview,setPreview]=useState<{created:number;updated:number;unchanged:number}|null>(null);
 const [selectedWeek,setSelectedWeek]=useState(()=>currentWeekKey());
 const [showAllWeeks,setShowAllWeeks]=useState(false);
 const weeks=useMemo(()=>{
  const list=[] as string[];
  for(let i=-104;i<=156;i++)list.push(shiftISOWeek(currentWeekKey(),i));
  return list;
 },[]);
 const visibleRows=useMemo(()=>showAllWeeks?rows:rows.filter(r=>{
  try{const {start,end}=scheduleDates(r);const monday=weekMonday(selectedWeek);
   const sunday=new Date(monday);sunday.setUTCDate(sunday.getUTCDate()+6);
   return start<=sunday.toISOString().slice(0,10)&&end>=monday.toISOString().slice(0,10);
  }catch{return r.week===selectedWeek}
 }),[rows,selectedWeek,showAllWeeks]);
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
 useEffect(()=>{if(selected&&people.some(p=>p.email===selected)){void fetchRows(selected)}},[selected,people]);
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
   const byActivity=new Map(stored.map(x=>[x.activityId,x]));
   const chosen=next.map(x=>savedByKey.get(x.rowKey||"")||byActivity.get(x.activityId)||x);
   const chosenIds=new Set(chosen.map(x=>x.activityId));
   setRows([...chosen,...stored.filter(x=>!chosenIds.has(x.activityId))]);
   setMessage("Läste "+next.length+" aktiviteter på "+next.length+" rader. Befintliga aktivitetsperioder har slagits ihop i visningen.");
  }catch(e){setError(e instanceof Error?e.message:String(e))}finally{setLoading(false)}
 };
 const save=(items:WeeklyV2Row[],name:string)=>{
  setError("");
  if(loading){setError("Planeringen läses in. Försök igen när inläsningen är klar.");return}
  if(!selected){setError("Välj först en medarbetare.");return}
  if(!items.length){setError("Det finns inga planeringsrader att exportera för detta urval.");return}
  try{
   const blob=createWeeklyV2Xlsx(items);
   const url=URL.createObjectURL(blob),a=document.createElement("a");
   a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();
   setTimeout(()=>URL.revokeObjectURL(url),2000);
   setMessage("Exporterade "+items.length+" planeringsrader.");
  }catch(e){setError("Exporten misslyckades: "+(e instanceof Error?e.message:String(e)))}
 };
 const saveBlank=()=>{setError("");try{
  const blob=createWeeklyV2Xlsx([]),url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url;a.download="veckoplanering-v2-mall.xlsx";document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),2000);
 }catch(e){setError("Kunde inte skapa mallen: "+String(e))}
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
    <select className="min-w-64 rounded-lg border p-2" value={selected} onChange={e=>setSelected(e.target.value)}><option value="">Välj medarbetare</option>{people.map(p=><option key={p.id} value={p.email}>{p.name}</option>)}</select>
    <button disabled={loading||!selected} onClick={()=>fetchRows(selected)} className="rounded-lg border px-4 py-2 disabled:opacity-50">Hämta planering</button>
    <button disabled={loading||!selected||!rows.length} onClick={()=>save(rows,"veckoplanering-v2.xlsx")} className="rounded-lg bg-blue-700 px-4 py-2 text-white">Exportera XLSX</button>
    <button onClick={saveBlank} className="rounded-lg border px-4 py-2">Tom XLSX-mall</button>
    <label className="cursor-pointer rounded-lg border px-4 py-2">Läs XLSX<input type="file" accept=".xlsx" className="hidden" onChange={e=>openFile(e.currentTarget.files?.[0]||null)}/></label>
   </div>
   <div className="mt-4 flex flex-wrap gap-3">
    <button disabled={loading||!rows.length} onClick={()=>importRows(false)} className="rounded-lg border border-blue-400 px-4 py-2 disabled:opacity-50">Förhandsgranska ändringar</button>
    <button disabled={loading||!preview||preview.created+preview.updated===0} onClick={()=>importRows(true)} className="rounded-lg bg-emerald-700 px-4 py-2 text-white disabled:opacity-50">Godkänn och spara planeringsposter</button>
   </div>
   <p className="mt-3 text-sm text-amber-800">V2-importen sparar separata planeringsposter och revisionshistorik. Den ändrar inte registrerad tid eller befintliga beläggningsperioder. En ny aktivitet måste först skapas i planeringsverktyget; Excel-raden måste ha ett befintligt aktivitets-ID och dold radnyckel.</p>
  </section>
  <section className="rounded-xl border bg-white p-4 space-y-3">
   <h2 className="font-semibold">Välj planeringsvecka</h2>
   <div className="flex flex-wrap items-center gap-2">
    <button aria-label="Föregående vecka" onClick={()=>{setSelectedWeek(w=>shiftISOWeek(w,-1));setShowAllWeeks(false)}} className="rounded-lg border px-4 py-2">← Föregående</button>
    <select aria-label="Välj vecka" value={selectedWeek} onChange={e=>{setSelectedWeek(e.target.value);setShowAllWeeks(false)}} className="rounded-lg border px-4 py-2">
     {weeks.map(w=><option key={w} value={w}>{w}{w===currentWeekKey()?" (aktuell vecka)":""}</option>)}
    </select>
    <button aria-label="Nästa vecka" onClick={()=>{setSelectedWeek(w=>shiftISOWeek(w,1));setShowAllWeeks(false)}} className="rounded-lg border px-4 py-2">Nästa →</button>
    <button onClick={()=>{setSelectedWeek(currentWeekKey());setShowAllWeeks(false)}} className="rounded-lg border px-4 py-2">Aktuell vecka</button>
    <label className="ml-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={showAllWeeks} onChange={e=>setShowAllWeeks(e.target.checked)}/> Visa alla veckor</label>
   </div>
   <p className="text-sm text-slate-600">Veckoväljaren startar på aktuell vecka. En aktivitet visas under alla veckor som dess start och varaktighet täcker – men exporteras bara på en rad.</p>
  </section>
  <section className="overflow-x-auto rounded-xl border bg-white p-4"><h2 className="mb-3 font-semibold">Förhandsgranskning ({visibleRows.length} av {rows.length} rader)</h2><table className="w-full min-w-[950px] text-left text-sm">
   <thead><tr className="border-b bg-slate-100"><th className="p-2">Vecka</th><th className="p-2">Dag</th><th className="p-2">Aktivitet</th><th className="p-2">Varaktighet</th><th className="p-2">Insats</th><th className="p-2">Startdatum</th><th className="p-2">Slutdatum</th><th className="p-2">Timmar</th><th className="p-2">Projekt</th></tr></thead>
   <tbody>{visibleRows.map((r,i)=><tr className="border-b" key={i}><td className="p-2">{r.week}</td><td className="p-2">{r.day||"Ej vald"}</td><td className="p-2">{r.task}</td><td className="p-2">{r.duration}</td><td className="p-2">{r.effort===null?"–":r.effort+" %"}</td><td className="p-2">{scheduleDates(r).start}</td><td className="p-2">{scheduleDates(r).end}</td><td className="p-2">{r.hours??hoursForSchedule(r)??"–"}</td><td className="p-2">{r.projectCode}</td></tr>)}</tbody></table>
  </section>
 </div></main>;
}
