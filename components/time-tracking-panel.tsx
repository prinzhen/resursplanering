"use client";
import {useCallback,useEffect,useMemo,useState,type FormEvent} from "react";
import {Button} from "@/components/ui/button";
import {Clock3,Download,Pause,Play,Plus,Save,Trash2,Pencil,X} from "lucide-react";

type Project={id:number;code:string;name:string};
type Activity={id:number;projectId:number;code:string|null;name:string;status:string};
type Entry={id:number;employeeId:number;activityId:number;projectId:number;employeeEmail:string|null;employeeName:string;reportingGroupId:number|null;reportingGroupName:string|null;projectCode:string;
 activityCode:string|null;activityName:string;workDate:string;startedAt:number;endedAt:number|null;
 durationSeconds:number|null;note:string;source:string;updatedAt:number};
type State={viewer:{employeeId:number|null;isAdmin:boolean;canViewGroupHistory:boolean};projects:Project[];activities:Activity[];entries:Entry[];serverTime:number;today:string;hasMore:boolean;entryCount:number;totalSeconds:number;offset:number};
const clock=(secs:number)=>{
 const total=Math.max(0,Math.floor(secs)),h=Math.floor(total/3600),m=Math.floor(total%3600/60),s=total%60;
 return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
};
const hours=(secs:number)=>`${(Math.max(0,secs)/3600).toLocaleString("sv-SE",{minimumFractionDigits:2,maximumFractionDigits:2})} h`;
const today=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Stockholm",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());

export default function TimeTrackingPanel(){
 const [data,setData]=useState<State|null>(null);
 const [view,setView]=useState<"mine"|"all"|"history">("mine");
 const [page,setPage]=useState(0);
 const [activityId,setActivityId]=useState("");
 const [manualDate,setManualDate]=useState(today()),[manualMinutes,setManualMinutes]=useState("60"),[manualNote,setManualNote]=useState("");
 const [editing,setEditing]=useState<number|null>(null),[editDate,setEditDate]=useState(""),[editMinutes,setEditMinutes]=useState(""),[editNote,setEditNote]=useState(""),[editActivity,setEditActivity]=useState("");
 const [now,setNow]=useState(Math.floor(Date.now()/1000));
 const [busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
 const fetchData=useCallback(async()=>{
  const r=await fetch("/api/time-entries?scope="+view+"&offset="+(page*250),{cache:"no-store"}),j=await r.json() as State&{error?:string};
  if(r.status===401){window.location.assign("/login");return}
  if(!r.ok)throw Error(j.error||"Kunde inte läsa tidrapporten");
  setData(j);
  setActivityId(old=>old&&j.activities.some(x=>String(x.id)===old)?old:String(j.activities[0]?.id??""));
 },[view,page]);
 useEffect(()=>{
  fetchData().catch(e=>setError(e instanceof Error?e.message:String(e)));
  const handle=setInterval(()=>setNow(Math.floor(Date.now()/1000)),1000);
  return ()=>clearInterval(handle);
 },[fetchData]);
 const post=async(payload:Record<string,unknown>,message:string)=>{
  setBusy(true);setError("");setNotice("");
  try{
   const r=await fetch("/api/time-entries",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
   const j=await r.json() as {error?:string};
   if(r.status===401){window.location.assign("/login");return false}
   if(!r.ok)throw Error(j.error||"Kunde inte spara tidrapporten");
   await fetchData();setNotice(message);return true;
  }catch(e){setError(e instanceof Error?e.message:String(e));return false}
  finally{setBusy(false)}
 };
 const active=data?.entries.find(e=>e.endedAt===null&&e.employeeId===data.viewer.employeeId);
 const selectedActivity=data?.activities.find(a=>String(a.id)===activityId);
 const total=useMemo(()=>data?.totalSeconds??0,[data]);
 const start=()=>post({action:"start",activityId:Number(activityId)},"Tidtagningen startade och fortsätter även om du lämnar sidan.");
 const stop=()=>active&&post({action:"stop",id:active.id},"Tidtagningen stoppades. Du kan korrigera tiden i listan nedan.");
 const addManual=async(e:FormEvent<HTMLFormElement>)=>{
  e.preventDefault();
  const minutes=Number(manualMinutes);
  if(!Number.isSafeInteger(minutes)||minutes<1||minutes>1440){setError("Ange 1–1440 hela minuter.");return}
  if(await post({action:"manual",activityId:Number(activityId),workDate:manualDate,durationMinutes:minutes,note:manualNote},"Tiden lades till.")){
   setManualNote("");setManualMinutes("60");
  }
 };
 const saveEdit=async(e:FormEvent<HTMLFormElement>)=>{
  e.preventDefault();
  const minutes=Number(editMinutes);
  if(!Number.isSafeInteger(minutes)||minutes<1||minutes>1440){setError("Ange 1–1440 hela minuter.");return}
  if(await post({action:data?.viewer.isAdmin?"adminUpdate":"update",id:editing,workDate:editDate,durationMinutes:minutes,note:editNote,
   ...(data?.viewer.isAdmin?{activityId:Number(editActivity)}:{})},"Tidrapporten korrigerades."))setEditing(null);
 };
 const changeEdit=(entry:Entry)=>{
  setEditing(entry.id);setEditActivity(String(entry.activityId));setEditDate(entry.workDate);setEditMinutes(String(Math.max(1,Math.round((entry.durationSeconds??0)/60))));setEditNote(entry.note||"");
 };
 const remove=async(entry:Entry)=>{
  if(!window.confirm("Ta bort rapporterade "+hours(entry.durationSeconds??0)+" för "+(entry.reportingGroupName?"grupp "+entry.reportingGroupName:entry.employeeEmail)+" på "+entry.activityName+"? Borttagningen sparas i ändringshistoriken."))return;
  const adminOther=data?.viewer.isAdmin&&entry.employeeId!==data.viewer.employeeId;
  if(await post({action:adminOther?"adminDelete":"delete",id:entry.id},"Tidposten togs bort och ändringen är spårbar."))setEditing(null);
 };
 const classes="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900";
 const visible=(data?.entries||[]);
 return <section className="panel overflow-hidden">
  <div className="panel-head flex-wrap items-start gap-3">
   <div><h2 className="flex items-center gap-2"><Clock3 className="h-5 w-5"/>Tidrapportering</h2>
    <p>Registrera faktiskt nedlagd tid per aktivitet. Planerad beläggning förändras inte.</p></div>
   <a className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50" href={"/api/time-entries?format=csv&scope="+view}><Download className="h-4 w-4"/>Exportera till CSV</a>
  </div>
  <div className="space-y-5 p-4 sm:p-6">
   {error&&<p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
   {notice&&<p role="status" className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</p>}
   {!data&&<p className="text-sm text-slate-600">Läser aktiviteter och tidposter…</p>}
   {data&&<>
    {(data.viewer.isAdmin||data.viewer.canViewGroupHistory)&&<label className="block max-w-xl text-sm font-medium">Visa tidrapporter
      <select className="mt-1 block w-full rounded-lg border border-slate-300 bg-white p-2" value={view} onChange={e=>{setView(e.target.value as "mine"|"all"|"history");setPage(0);setEditing(null)}}>
       <option value="mine">Min rapporterade tid</option>
       {data.viewer.isAdmin&&<option value="all">Alla medarbetare och grupper (administratör)</option>}
       <option value="history">Historiska timmar bokförda på grupp</option>
      </select>
      <span className="mt-1 block text-xs font-normal text-slate-500">Grupptimmar visas för ansvarig gruppchef, berörd projektledare och administratör. Timmarna saknar personlig koppling.</span>
    </label>}
    <div className="grid gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
     <label className="block text-sm font-semibold">Aktivitet
      <select className={classes+" mt-2"} value={activityId} onChange={e=>setActivityId(e.target.value)}>
       {data.activities.length===0&&<option value="">Inga aktiviteter tillgängliga</option>}
       {data.activities.map(a=>{
        const p=data.projects.find(p=>p.id===a.projectId);
        return <option key={a.id} value={a.id}>{p?.code||"Projekt"} · {a.code?a.code+" · ":""}{a.name}</option>
       })}
      </select>
      <span className="mt-1 block text-xs font-normal text-slate-500">Projektledare, medlemmar och tilldelade medarbetare kan rapportera sin egen tid. Endast en klocka kan vara aktiv.</span>
     </label>
     <div className="flex flex-wrap items-center gap-3">
      {active?<>
       <div className="min-w-0" role="timer" aria-live="off"><div className="font-mono text-3xl font-bold tabular-nums text-blue-900">{clock(now-active.startedAt)}</div>
        <div className="max-w-72 truncate text-xs text-slate-600">Pågår: {active.projectCode} · {active.activityName}</div></div>
       <Button type="button" onClick={stop} disabled={busy}><Pause/>Stoppa klocka</Button>
      </>:<>
       <div className="text-sm text-slate-600">Ingen klocka igång</div>
       <Button type="button" onClick={start} disabled={busy||!selectedActivity}><Play/>Starta klocka</Button>
      </>}
     </div>
    </div>
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(230px,280px)]">
     <form onSubmit={addManual} className="grid gap-3 rounded-xl border border-slate-200 p-4 sm:grid-cols-2">
      <div className="sm:col-span-2"><h3 className="font-semibold">Lägg in tid manuellt</h3><p className="text-xs text-slate-600">Samma valda aktivitet som ovan. Du kan också redigera en tidigare tidpost.</p></div>
      <label className="text-sm">Datum<input className={classes+" mt-1"} type="date" required value={manualDate} onChange={e=>setManualDate(e.target.value)}/></label>
      <label className="text-sm">Nedlagd tid (minuter)<input className={classes+" mt-1"} type="number" min={1} max={1440} step={1} required value={manualMinutes} onChange={e=>setManualMinutes(e.target.value)}/></label>
      <label className="text-sm sm:col-span-2">Kommentar (valfritt)<input className={classes+" mt-1"} maxLength={500} value={manualNote} onChange={e=>setManualNote(e.target.value)} placeholder="Vad arbetade du med?"/></label>
      <div className="sm:col-span-2"><Button type="submit" variant="outline" disabled={busy||!selectedActivity}><Plus/>Registrera tid</Button></div>
     </form>
     <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
      <p className="text-sm font-semibold text-slate-700">Summa registrerad tid</p>
      <div className="mt-3 text-3xl font-bold tabular-nums text-slate-950">{hours(total)}</div>
      <p className="mt-2 text-sm text-slate-600">{data.entryCount} tidposter i valt urval. Summeringen omfattar alla sidor, men inte pågående eller borttagna tidposter.</p>
      <p className="mt-3 text-xs text-slate-500">CSV innehåller medarbetare, projektkod, aktivitetskod, datum och timmar. Synkronisering med Tidrapport kan anslutas när dess API är känt.</p>
     </div>
    </div>
    <div>
     <h3 className="mb-3 font-semibold">Rapporterade tidposter</h3>
     {data.entries.length===0?<p className="rounded-lg bg-slate-50 p-4 text-sm text-slate-600">Ingen tid registrerad ännu.</p>:
     <div className="space-y-2">{visible.map(e=>
      <div key={e.id} className="rounded-lg border border-slate-200 bg-white p-3">
       {editing===e.id?
        <form onSubmit={saveEdit} className="grid gap-2 sm:grid-cols-2 sm:items-end">
         <label className="text-sm">Datum<input className={classes+" mt-1"} type="date" required value={editDate} onChange={v=>setEditDate(v.target.value)}/></label>
         <label className="text-sm">Minuter<input className={classes+" mt-1"} type="number" min={1} max={1440} required value={editMinutes} onChange={v=>setEditMinutes(v.target.value)}/></label>
         <label className="text-sm">Kommentar<input className={classes+" mt-1"} maxLength={500} value={editNote} onChange={v=>setEditNote(v.target.value)}/></label>
         {data.viewer.isAdmin&&<label className="text-sm">Projekt och aktivitet<select className={classes+" mt-1"} value={editActivity} onChange={v=>setEditActivity(v.target.value)}>
          {data.activities.map(a=><option key={a.id} value={a.id}>{data.projects.find(p=>p.id===a.projectId)?.code||"Projekt"} · {a.name}</option>)}
         </select></label>}
         <div className="flex gap-2"><Button size="sm" type="submit" disabled={busy}><Save/>Spara</Button>
          <Button size="sm" variant="outline" type="button" onClick={()=>setEditing(null)}><X/>Avbryt</Button></div>
        </form>:
        <div className="flex flex-wrap items-center justify-between gap-3">
         <div className="min-w-0"><div className="text-sm font-semibold text-slate-900">{e.projectCode} · {e.activityName}</div>
          {(view!=="mine"||e.reportingGroupId!==null)&&<div className="text-xs font-semibold text-blue-700">
           {e.reportingGroupName?"Borttagen medarbetare · Grupp: "+e.reportingGroupName:e.employeeName+" · "+(e.employeeEmail??"")}
          </div>}
          <div className="mt-1 text-xs text-slate-500">{e.workDate} · {e.source==="manual"?"Manuellt":e.source==="adjusted"?"Korrigerad":"Tidtagning"}{e.note?" · "+e.note:""}</div></div>
         <div className="flex flex-wrap items-center gap-2">
          <strong className="font-mono text-base tabular-nums">{e.endedAt===null?"Pågår":clock(e.durationSeconds??0)}</strong>
          {e.endedAt!==null&&<>{(data.viewer.isAdmin||e.employeeId===data.viewer.employeeId)&&<Button type="button" size="sm" variant="outline" onClick={()=>changeEdit(e)} disabled={busy} aria-label={"Ändra tidpost "+e.id}><Pencil/>Ändra</Button>}
          {(data.viewer.isAdmin||e.employeeId===data.viewer.employeeId)&&<Button type="button" size="sm" variant="ghost" className="text-red-700" onClick={()=>remove(e)} disabled={busy} aria-label={"Ta bort tidpost "+e.id}><Trash2/></Button>}</>}
         </div>
        </div>}
      </div>)}</div>}
     <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
      <span>Visar sida {page+1} · {data.entryCount} tidposter i totalt urval</span>
      <div className="flex gap-2">
       <Button variant="outline" size="sm" type="button" disabled={busy||page===0} onClick={()=>{setPage(p=>Math.max(0,p-1));setEditing(null)}}>Föregående</Button>
       <Button variant="outline" size="sm" type="button" disabled={busy||!data.hasMore} onClick={()=>{setPage(p=>p+1);setEditing(null)}}>Nästa</Button>
      </div>
     </div>
     {data.entryCount>20000&&<p className="mt-3 text-xs text-amber-700">För att exportera fler än 20 000 poster, dela upp CSV-exporten med datumfilter.</p>}
    </div>
   </>}
  </div>
 </section>;
}
