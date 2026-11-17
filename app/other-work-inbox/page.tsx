"use client";
import {useEffect,useMemo,useState} from "react";
type Item={activityId:number;task:string;status:string;priority:number;startDate:string;endDate:string;
 employeeId:number;employeeName:string;assignmentEffort:number;plannedHours:number|null};
export default function OtherWorkInbox(){
 const [items,setItems]=useState<Item[]>([]);
 const [error,setError]=useState("");
 const [loading,setLoading]=useState(true);
 const [person,setPerson]=useState("alla");
 const [search,setSearch]=useState("");
 const [includeClosed,setIncludeClosed]=useState(false);
 useEffect(()=>{
  const abort=new AbortController();
  fetch("/api/other-work-inbox",{cache:"no-store",signal:abort.signal}).then(async r=>{
   if(r.status===401){location.assign("/login");return null}
   const data=await r.json() as {activities?:Item[];error?:string};
   if(!r.ok)throw Error(data.error||"Kunde inte läsa inkorgen.");
   return data;
  }).then(d=>{if(d)setItems(d.activities||[])}).catch(e=>{
   if(!abort.signal.aborted)setError(e instanceof Error?e.message:String(e));
  }).finally(()=>{if(!abort.signal.aborted)setLoading(false)});
  return ()=>abort.abort();
 },[]);
 const people=useMemo(()=>[...new Map(items.map(x=>[x.employeeId,x.employeeName])).entries()]
  .sort((a,b)=>a[1].localeCompare(b[1],"sv")),[items]);
 const visible=useMemo(()=>items.filter(x=>
  (person==="alla"||String(x.employeeId)===person)&&
  (includeClosed||!["Klar","Fryst"].includes(x.status))&&
  (x.task+" "+x.employeeName).toLocaleLowerCase("sv").includes(search.toLocaleLowerCase("sv"))
 ),[items,person,search,includeClosed]);
 const effort=visible.reduce((sum,x)=>sum+Number(x.plannedHours||0),0);
 return <main className="min-h-screen bg-slate-100 p-5 text-slate-900">
  <div className="mx-auto max-w-6xl space-y-5">
   <header className="flex flex-wrap items-center justify-between gap-3">
    <div><p className="text-xs font-bold uppercase tracking-widest text-blue-700">Resursplanering</p>
    <h1 className="text-3xl font-semibold">Övrigt arbete · Inkorg</h1>
    <p className="mt-1 text-sm text-slate-600">Aktiviteter utan projektkod från planeringen samlas här för senare klassificering.</p></div>
    <a href="/" className="rounded-lg border bg-white px-4 py-2 text-sm">← Till planeringen</a>
   </header>
   <section className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-950">
    <strong>Förhandsversion – endast läsning.</strong> Att flytta en aktivitet till nytt projekt aktiveras
    först när ändringsdatum, tidigare beläggning och tidrapporthistorik kan bevaras korrekt.
   </section>
   {error&&<p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-800">{error}</p>}
   <section className="grid gap-3 rounded-xl border bg-white p-4 md:grid-cols-3">
    <label className="text-sm font-semibold">Sök aktivitet
     <input className="mt-1 block w-full rounded-lg border p-2" value={search}
      onChange={e=>setSearch(e.target.value)} placeholder="Sök efter aktivitet eller person"/></label>
    <label className="text-sm font-semibold">Medarbetare
     <select className="mt-1 block w-full rounded-lg border p-2" value={person} onChange={e=>setPerson(e.target.value)}>
      <option value="alla">Alla jag har behörighet till</option>
      {people.map(([id,name])=><option value={id} key={id}>{name}</option>)}
     </select></label>
    <label className="flex items-center gap-2 self-end text-sm">
     <input type="checkbox" checked={includeClosed} onChange={e=>setIncludeClosed(e.target.checked)}/>
     Visa även klara och frysta aktiviteter</label>
   </section>
   <div className="grid gap-3 sm:grid-cols-2">
    <section className="rounded-xl border bg-white p-4"><div className="text-sm text-slate-500">Aktivitetskopplingar i urvalet</div>
     <div className="text-3xl font-bold">{visible.length}</div></section>
    <section className="rounded-xl border bg-white p-4"><div className="text-sm text-slate-500">Planerade veckoradstimmar i urvalet</div>
     <div className="text-3xl font-bold">{effort.toLocaleString("sv-SE",{maximumFractionDigits:1})} h</div>
     <p className="text-xs text-slate-500">Endast sparade Excel v2-veckorader; inte en total historisk beläggning.</p></section>
   </div>
   <section className="overflow-x-auto rounded-xl border bg-white">
    <table className="w-full min-w-[850px] text-left text-sm">
     <thead className="bg-slate-50 text-slate-600"><tr>
      {["Aktivitet","Medarbetare","Start","Slut","Status","Prioritet","Insats","Veckorader (h)"].map(h=>
       <th className="border-b px-4 py-3 font-semibold" key={h}>{h}</th>)}
     </tr></thead>
     <tbody>{visible.map(x=><tr key={x.activityId+"-"+x.employeeId} className="border-b last:border-0">
      <td className="px-4 py-3 font-medium">{x.task}<span className="block text-xs text-slate-500">ID {x.activityId}</span></td>
      <td className="px-4 py-3">{x.employeeName}</td><td className="px-4 py-3">{x.startDate}</td>
      <td className="px-4 py-3">{x.endDate}</td><td className="px-4 py-3">{x.status}</td>
      <td className="px-4 py-3">{x.priority}</td><td className="px-4 py-3">{x.assignmentEffort}%</td>
      <td className="px-4 py-3">{x.plannedHours===null?"—":x.plannedHours.toLocaleString("sv-SE")}</td>
     </tr>)}</tbody>
    </table>
    {loading?<p className="p-5 text-slate-500">Hämtar aktiviteter…</p>:
     !visible.length?<p className="p-5 text-slate-500">Inga oklassificerade aktiviteter i urvalet.</p>:null}
   </section>
  </div>
 </main>;
}
