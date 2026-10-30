"use client";
import {useEffect,useState} from "react";
type Activity={id:number;name:string;projectId:number;startDate:string;endDate:string};
type Employee={id:number;name:string;email:string};
type Recipient=Employee&{projectId:number};
type RequestItem={id:number;activityId:number;requestedBy:number;recipientId:number;activityName:string;requestedByName:string;recipientName:string;projectCode:string;effortPercent:number;startDate:string;endDate:string;status:string;createdAt:string;comment?:string};
type Data={viewer:{employeeId:number|null;isAdmin:boolean};activities:Activity[];employees:Employee[]};
export default function Requests(){
 const [data,setData]=useState<Data|null>(null),[requests,setRequests]=useState<RequestItem[]>([]),[eligible,setEligible]=useState<Recipient[]>([]),
 [activity,setActivity]=useState(""),[recipient,setRecipient]=useState(""),[effort,setEffort]=useState(50),
 [start,setStart]=useState(""),[end,setEnd]=useState(""),[comment,setComment]=useState(""),
 [message,setMessage]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false);
 const reload=async()=>{
  const [a,b]=await Promise.all([fetch("/api/data",{cache:"no-store"}),fetch("/api/requests",{cache:"no-store"})]);
  if(a.status===401||b.status===401){window.location.assign("/login");return}
  const d=await a.json(),r=await b.json();if(!a.ok||!b.ok)throw Error(d.error||r.error||"Kan inte hämta begäranden");
  setData(d);setRequests(r.requests||[]);setEligible(r.eligibleRecipients||[]);
 };
 useEffect(()=>{reload().catch(e=>setError(String(e)))},[]);
 const post=async(payload:Record<string,unknown>)=>{setBusy(true);setError("");setMessage("");try{
  const r=await fetch("/api/requests",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
  const d=await r.json();if(!r.ok)throw Error(d.error||"Åtgärden misslyckades");
  setMessage("Ändringen sparades.");await reload();return true;
 }catch(e){setError(e instanceof Error?e.message:String(e));return false}finally{setBusy(false)}};
 const selectedActivity=data?.activities.find(a=>a.id===Number(activity));
 const peers=eligible.filter(p=>p.projectId===selectedActivity?.projectId&&p.id!==data?.viewer.employeeId);
 const received=requests.filter(r=>r.recipientId===data?.viewer.employeeId&&r.status==="pending");
 const sent=requests.filter(r=>r.requestedBy===data?.viewer.employeeId);
 return <main className="min-h-screen bg-slate-100 p-5 text-slate-900"><div className="mx-auto max-w-5xl space-y-5">
 <header className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-widest text-blue-700">Resursplanering</p><h1 className="text-3xl font-semibold">Aktivitetsförfrågningar</h1><p className="text-sm text-slate-600">Begär bemanning av en kollega. Aktiviteten läggs inte på personen förrän den godkänts.</p></div><a href="/" className="rounded-lg border bg-white px-4 py-2 text-sm">← Till planeringen</a></header>
 {error&&<div className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-700" role="alert">{error}</div>}
 {message&&<div className="rounded-lg border border-green-200 bg-green-50 p-3 text-green-700">{message}</div>}
 <section className="rounded-xl border bg-white p-5"><h2 className="mb-4 text-lg font-semibold">Skicka förfrågan om aktivitet</h2>
 <form onSubmit={async e=>{e.preventDefault();if(await post({action:"request",activityId:Number(activity),recipientId:Number(recipient),effortPercent:effort,startDate:start,endDate:end,comment})){setRecipient("");setComment("")}}} className="grid gap-4 sm:grid-cols-2">
 <label className="text-sm font-medium">Aktivitet<select className="mt-1 block w-full rounded-lg border px-3 py-2" value={activity} onChange={e=>{setActivity(e.target.value);setRecipient("");const a=data?.activities.find(x=>x.id===Number(e.target.value));setStart(a?.startDate||"");setEnd(a?.endDate||"")}} required><option value="">Välj aktivitet</option>{data?.activities.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
 <label className="text-sm font-medium">Mottagare<select className="mt-1 block w-full rounded-lg border px-3 py-2" value={recipient} onChange={e=>setRecipient(e.target.value)} required><option value="">Välj medarbetare i projektet</option>{peers.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
 <label className="text-sm font-medium">Startdatum<input className="mt-1 block w-full rounded-lg border px-3 py-2" type="date" value={start} onChange={e=>setStart(e.target.value)} required/></label>
 <label className="text-sm font-medium">Slutdatum<input className="mt-1 block w-full rounded-lg border px-3 py-2" type="date" value={end} onChange={e=>setEnd(e.target.value)} required/></label>
 <label className="text-sm font-medium">Medverkan (%)<input className="mt-1 block w-full rounded-lg border px-3 py-2" type="number" min="0" max="200" value={effort} onChange={e=>setEffort(Number(e.target.value))} required/></label>
 <label className="text-sm font-medium">Kommentar (valfri)<input className="mt-1 block w-full rounded-lg border px-3 py-2" maxLength={500} value={comment} onChange={e=>setComment(e.target.value)}/></label>
 <div className="sm:col-span-2"><button disabled={busy||!recipient} className="rounded-lg bg-blue-700 px-5 py-2 font-semibold text-white disabled:opacity-50">Skicka för godkännande</button></div>
 </form></section>
 <section className="rounded-xl border bg-white p-5"><h2 className="mb-3 text-lg font-semibold">Att godkänna ({received.length})</h2><div className="space-y-3">{received.map(r=><article key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"><div><strong>{r.activityName}</strong><p className="text-sm text-slate-600">{r.projectCode} · Från {r.requestedByName} · {r.effortPercent}%</p><p className="text-xs text-slate-500">{r.startDate}–{r.endDate}{r.comment?" · "+r.comment:""}</p></div><div className="flex gap-2"><button className="rounded-lg bg-green-700 px-3 py-2 text-sm text-white disabled:opacity-50" disabled={busy} onClick={()=>post({action:"answer",id:r.id,approve:true})}>Godkänn</button><button className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50" disabled={busy} onClick={()=>post({action:"answer",id:r.id,approve:false})}>Avvisa</button></div></article>)}{!received.length&&<p className="text-sm text-slate-500">Inga väntande förfrågningar.</p>}</div></section>
 <section className="rounded-xl border bg-white p-5"><h2 className="mb-3 text-lg font-semibold">Skickade förfrågningar</h2><div className="space-y-2">{sent.map(r=><div key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm"><div><strong>{r.activityName}</strong><p className="text-slate-500">Till {r.recipientName} · {r.effortPercent}% · {r.status}</p></div>{r.status==="pending"&&<button disabled={busy} onClick={()=>post({action:"cancel",id:r.id})} className="rounded-lg border px-3 py-2">Återkalla</button>}</div>)}{!sent.length&&<p className="text-sm text-slate-500">Inga skickade förfrågningar.</p>}</div></section>
 </div></main>;
}
