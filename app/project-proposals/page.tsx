"use client";
import {useEffect,useState} from "react";
type Proposal={id:number;submittedBy:number;submittedByEmail:string;code:string;name:string;description:string;color:string;priority:number;status:"pending"|"approved"|"rejected";reviewedByEmail:string|null;comment:string|null;createdProjectId:number|null;createdAt:string};
export default function ProjectProposals(){
 const [items,setItems]=useState<Proposal[]>([]),[canReview,setCanReview]=useState(false),
 [code,setCode]=useState(""),[name,setName]=useState(""),[description,setDescription]=useState(""),[color,setColor]=useState("#2563eb"),[priority,setPriority]=useState(3),
 [notes,setNotes]=useState<Record<number,string>>({}),[error,setError]=useState(""),[message,setMessage]=useState(""),[busy,setBusy]=useState(false);
 const reload=async()=>{const r=await fetch("/api/project-proposals",{cache:"no-store"});if(r.status===401){location.assign("/login");return}
  const data=await r.json() as {error?:string;proposals?:Proposal[];canReview?:boolean};
  if(!r.ok)throw Error(data.error||"Kunde inte läsa förslag");
  setItems(data.proposals||[]);setCanReview(!!data.canReview)};
 useEffect(()=>{reload().catch(e=>setError(String(e)))},[]);
 const post=async(payload:Record<string,unknown>)=>{setBusy(true);setError("");setMessage("");try{
  const r=await fetch("/api/project-proposals",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
  const result=await r.json() as {error?:string};
  if(!r.ok)throw Error(result.error||"Kunde inte spara");
  await reload();setMessage(payload.action==="submit"?"Projektförslaget är skickat för granskning.":payload.approve?"Projektet har godkänts och skapats.":"Förslaget har avslagits.");return true;
 }catch(e){setError(e instanceof Error?e.message:String(e));return false}finally{setBusy(false)}};
 return <main className="min-h-screen bg-slate-100 p-5 text-slate-900"><div className="mx-auto max-w-5xl space-y-5">
 <header className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-wider text-blue-700">Resursplanering</p><h1 className="text-3xl font-semibold">Projektförslag</h1><p className="mt-1 text-sm text-slate-600">Alla inloggade kan lämna förslag. Gruppchefer och administratörer beslutar om projekten ska skapas.</p></div><a className="rounded-lg border bg-white px-4 py-2 text-sm" href="/">← Till planeringen</a></header>
 {error&&<p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
 {message&&<p className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">{message}</p>}
 <section className="rounded-xl border bg-white p-5"><h2 className="mb-3 text-lg font-semibold">Föreslå ett nytt projekt</h2>
 <form className="grid gap-4 md:grid-cols-2" onSubmit={async e=>{e.preventDefault();if(await post({action:"submit",code,name,description,color,priority})){setCode("");setName("");setDescription("")}}}>
 <label className="text-sm font-semibold">Projektkod<input required maxLength={40} pattern="[a-zA-Z0-9][a-zA-Z0-9._-]*" className="mt-1 block w-full rounded-lg border p-2" value={code} onChange={e=>setCode(e.target.value)} placeholder="Exempel: P-2027-01"/></label>
 <label className="text-sm font-semibold">Projektnamn<input required minLength={3} maxLength={150} className="mt-1 block w-full rounded-lg border p-2" value={name} onChange={e=>setName(e.target.value)} placeholder="Projektets namn"/></label>
 <label className="text-sm font-semibold md:col-span-2">Beskrivning<textarea rows={3} maxLength={1500} className="mt-1 block w-full rounded-lg border p-2" value={description} onChange={e=>setDescription(e.target.value)} placeholder="Syfte, omfattning och önskat resultat"/></label>
 <label className="text-sm font-semibold">Prioritet<select value={priority} onChange={e=>setPriority(Number(e.target.value))} className="mt-1 block w-full rounded-lg border p-2">{[1,2,3,4,5].map(p=><option key={p} value={p}>{p} {p===1?"(högst)":p===5?"(lägst)":""}</option>)}</select></label>
 <label className="text-sm font-semibold">Färg<input type="color" value={color} onChange={e=>setColor(e.target.value)} className="mt-1 block h-10 w-24 rounded-lg border p-1"/></label>
 <div className="md:col-span-2"><button disabled={busy} className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Skicka projektförslag</button></div></form></section>
 <section className="rounded-xl border bg-white p-5"><h2 className="mb-2 text-lg font-semibold">{canReview?"Att granska och tidigare beslut":"Mina projektförslag"}</h2>
 <p className="mb-4 text-sm text-slate-600">{canReview?"Förslag som väntar på beslut visas först. Godkännande skapar projektet; avslag skapar inget projekt.":"Här kan du följa status för dina förslag."}</p>
 <div className="space-y-3">{items.map(p=><article key={p.id} className="rounded-lg border bg-white p-4"><div className="flex flex-wrap items-start gap-3"><span className="mt-1 h-8 w-1 rounded-full" style={{background:p.color}}/><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{p.code} · {p.name}</h3><span className={`rounded px-2 py-1 text-xs font-semibold ${p.status==="approved"?"bg-green-100 text-green-800":p.status==="rejected"?"bg-red-100 text-red-800":"bg-amber-100 text-amber-800"}`}>{p.status==="approved"?"Godkänt":p.status==="rejected"?"Avslaget":"Väntar på beslut"}</span></div><p className="mt-1 text-sm text-slate-600">{p.description||"Ingen beskrivning"}</p><p className="mt-2 text-xs text-slate-500">Prioritet {p.priority} · Inskickat av {p.submittedByEmail} · {p.createdAt}</p>{p.comment&&<p className="mt-2 text-sm text-slate-700">Beslutsmotivering: {p.comment}</p>}</div></div>
 {canReview&&p.status==="pending"&&<div className="mt-3 flex flex-wrap items-end gap-2 border-t pt-3"><label className="min-w-56 flex-1 text-xs font-semibold">Kommentar till beslutet<input className="mt-1 block w-full rounded-lg border p-2 text-sm" maxLength={500} value={notes[p.id]||""} onChange={e=>setNotes(n=>({...n,[p.id]:e.target.value}))}/></label><button disabled={busy} onClick={()=>post({action:"review",id:p.id,approve:true,comment:notes[p.id]||""})} className="rounded-lg bg-green-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Godkänn och skapa projekt</button><button disabled={busy} onClick={()=>post({action:"review",id:p.id,approve:false,comment:notes[p.id]||""})} className="rounded-lg border border-red-300 px-4 py-2 text-sm font-semibold text-red-700 disabled:opacity-50">Avslå</button></div>}
 </article>)}{!items.length&&<p className="rounded-lg border border-dashed p-6 text-sm text-slate-500">Inga projektförslag ännu.</p>}</div></section>
 </div></main>;
}
