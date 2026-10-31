"use client";
import {useEffect,useState} from "react";
type Employee={id:number;name:string;email:string};
type Project={id:number;code:string;name:string};
type Team={id:number;name:string};
type Access={viewer:{accountId:number;employeeId:number|null;isAdmin:boolean};directoryEmployees:{id:number;name:string}[];accounts:{id:number;email:string;employeeId:number|null;isAdmin:number;isGroupManager:number;isDisabled:number}[];projectLeaders:{projectId:number;employeeId:number}[];teamLeaders:{teamId:number;employeeId:number}[]};
type Planning={employees:Employee[];projects:Project[];projectDirectory?:Project[];employeeGroups:Team[];viewer:{accountId:number;isAdmin:boolean;managedEmployeeIds:number[];projectLeadIds:number[]}};
function EmployeeCredentialRow({person,account,onSetPassword,busy}:{person:Employee;account?:Access["accounts"][number];onSetPassword:(employeeId:number,password:string)=>Promise<boolean>;busy:boolean}){
 const [password,setPassword]=useState(""),[show,setShow]=useState(false);
 return <div className="grid gap-2 rounded-lg border bg-white p-3 sm:grid-cols-[minmax(0,1fr)_minmax(180px,240px)_auto] sm:items-center">
  <div className="min-w-0"><div className="font-semibold text-slate-900">{person.name}</div><div className="truncate text-xs text-slate-500">{person.email}</div><span className={`text-xs ${account?"text-emerald-700":"text-amber-700"}`}>{account?.isDisabled?"Konto inaktivt · ange lösenord för att aktivera":account?"Konto finns · lösenord kan återställas":"Inget konto · skapa med lösenord"}</span></div>
  <div className="flex items-center gap-2"><input aria-label={`Nytt lösenord för ${person.name}`} type={show?"text":"password"} value={password} minLength={6} maxLength={256} autoComplete="new-password" placeholder="Nytt lösenord (minst 6)" onChange={e=>setPassword(e.target.value)} className="min-w-0 w-full rounded-md border px-3 py-2 text-sm"/><button type="button" className="shrink-0 text-xs text-blue-700" onClick={()=>setShow(v=>!v)}>{show?"Dölj":"Visa"}</button></div>
  <button type="button" disabled={busy||password.length<6} className="rounded-lg bg-blue-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" onClick={async()=>{if(await onSetPassword(person.id,password))setPassword("")}}>{account?.isDisabled?"Aktivera konto":account?"Byt lösenord":"Skapa konto"}</button>
 </div>;
}
export default function AccessPage(){
 const [data,setData]=useState<Planning|null>(null),[access,setAccess]=useState<Access|null>(null),[error,setError]=useState(""),[notice,setNotice]=useState(""),[busy,setBusy]=useState(false);
 const [email,setEmail]=useState(""),[password,setPassword]=useState(""),[employeeId,setEmployeeId]=useState(""),[admin,setAdmin]=useState(false),[groupManager,setGroupManager]=useState(false);
 const [accountLinks,setAccountLinks]=useState<Record<number,string>>({});
 const [leadEmployee,setLeadEmployee]=useState(""),[leadProject,setLeadProject]=useState(""),[leadTeam,setLeadTeam]=useState(""),[memberEmployee,setMemberEmployee]=useState(""),[memberProject,setMemberProject]=useState("");
 const reload=async()=>{
  const [a,b]=await Promise.all([fetch("/api/data",{cache:"no-store"}),fetch("/api/access",{cache:"no-store"})]);
  if(a.status===401||b.status===401){window.location.assign("/login");return}
  const ap=await a.json() as Planning&{error?:string},ac=await b.json() as Access&{error?:string};if(!a.ok||!b.ok)throw Error(ap.error||ac.error||"Åtkomstfel");
  setData(ap);setAccess(ac);
 };
 useEffect(()=>{reload().catch(e=>setError(String(e)))},[]);
 const post=async(payload:Record<string,unknown>)=>{setBusy(true);setError("");setNotice("");try{
  const r=await fetch("/api/access",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)}),j=await r.json() as {error?:string};
  if(!r.ok)throw Error(j.error||"Kunde inte spara");await reload();setNotice("Behörigheten sparades.");return true;
 }catch(e){setError(e instanceof Error?e.message:String(e));return false}finally{setBusy(false)}};
 const eligible=data?.employees.filter(e=>data.viewer.isAdmin||data.viewer.managedEmployeeIds.includes(e.id))||[];
 const membership=async(enabled:boolean)=>{
  if(!memberEmployee||!memberProject)return;
  setBusy(true);setError("");setNotice("");
  try{
   const result=await fetch("/api/data",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"setSingleProjectMember",projectId:Number(memberProject),employeeId:Number(memberEmployee),enabled})});
   const parsed=await result.json() as {error?:string};
   if(!result.ok)throw Error(parsed.error||"Kunde inte ändra projektmedverkan");
   await reload();setNotice(enabled?"Medarbetaren lades till i projektet.":"Projektmedverkan togs bort. Befintlig aktivitetsbemanning behålls.");
  }catch(e){setError(e instanceof Error?e.message:String(e))}finally{setBusy(false)}
 };

 return <main className="min-h-screen bg-slate-100 p-5 text-slate-900"><div className="mx-auto max-w-5xl space-y-5">
 <header className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-wider text-blue-700">Resursplanering</p><h1 className="text-3xl font-semibold">Konton och behörigheter</h1><p className="mt-1 text-sm text-slate-600">Administratören hanterar konton. Gruppchefer kan utse projektledare och TEAM-leaders bland sina medarbetare.</p></div><a href="/" className="rounded-lg border bg-white px-4 py-2 text-sm">← Till planeringen</a></header>
 {error&&<p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-red-700">{error}</p>}
 {notice&&<p className="rounded-lg border border-green-300 bg-green-50 p-3 text-green-800">{notice}</p>}
 {data?.viewer.isAdmin&&<section className="rounded-xl border bg-white p-5"><h2 className="mb-3 text-lg font-semibold">Lägg upp eller återställ konto</h2><p className="mb-3 text-sm text-slate-600">E-postadress identifierar kontot. Flera administratörer stöds och varje administratör kan kopplas till en medarbetare för egen planering. Använd befintlig medarbetarpost för att behålla historik och aktiviteter. Ett nytt lösenord återkallar tidigare sessioner.</p>
 <form onSubmit={async e=>{e.preventDefault();if(await post({action:"saveAccount",email,password,employeeId:employeeId?Number(employeeId):null,isAdmin:admin,isGroupManager:groupManager})){setPassword("");setEmail("")}}} className="grid gap-3 sm:grid-cols-2">
 <label className="text-sm font-medium">E-post<input value={email} onChange={e=>setEmail(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2" type="email" required/></label>
 <label className="text-sm font-medium">Lösenord (minst 6 tecken)<input value={password} onChange={e=>setPassword(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2" type="password" autoComplete="new-password" minLength={6} required/></label>
 <label className="text-sm font-medium">Kopplad medarbetare<select value={employeeId} onChange={e=>setEmployeeId(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2"><option value="">Ingen koppling (för admin utan personpost)</option>{data.employees.map(p=><option key={p.id} value={p.id}>{p.name} · {p.email}</option>)}</select></label>
 <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={groupManager} onChange={e=>setGroupManager(e.target.checked)}/>Gruppchef – hantera egna medarbetare och TEAM</label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={admin} onChange={e=>setAdmin(e.target.checked)}/>Administratör – full behörighet</label>
 <div className="sm:col-span-2"><button disabled={busy} className="rounded-lg bg-blue-700 px-4 py-2 font-semibold text-white disabled:opacity-50">Spara konto</button></div></form>
 <div className="mt-6 border-t pt-5"><h3 className="mb-2 text-lg font-semibold">Lösenord för samtliga medarbetare</h3>
 <p className="mb-3 text-sm text-slate-600">Här kan du skapa ett konto för varje medarbetare eller ändra lösenordet på ett befintligt konto. Konto och medarbetare kopplas ihop automatiskt via e-postadressen. Roller ändras inte när du byter lösenord. Tidigare inloggningar avslutas.</p>
 <div className="max-h-[55vh] space-y-2 overflow-y-auto">{data.employees.map(person=><EmployeeCredentialRow key={person.id} person={person} account={access?.accounts.find(a=>a.employeeId===person.id)} busy={busy} onSetPassword={async(id,password)=>post({action:"setEmployeePassword",employeeId:id,password})}/>)}</div>
 </div>
 <div className="mt-4 space-y-3"><h3 className="text-sm font-semibold">Registrerade konton och administratörer</h3>
 <p className="text-xs text-slate-600">Koppla ett konto till en befintlig medarbetare för att kombinera administratörsbehörighet med egna aktiviteter, TEAM och projekt. Att ta bort ett konto raderar inte medarbetarens planering.</p>
 {access?.accounts.map(a=><div key={a.id} className="space-y-2 rounded-lg border bg-white p-3 text-sm">
  <div className="flex flex-wrap items-center justify-between gap-2"><div><strong>{a.email}</strong><p className="text-slate-500">{a.isAdmin?"Administratör":a.isGroupManager?"Gruppchef":"Medarbetare"} · {a.isDisabled?"Inaktiverat":"Aktivt"}{a.id===data.viewer.accountId?" · Ditt konto":""}</p></div>
  {a.id!==data.viewer.accountId&&<div className="flex flex-wrap gap-2">
   <button type="button" disabled={busy} className="rounded border px-3 py-1" onClick={()=>post({action:"setAccountRole",accountId:a.id,isAdmin:!a.isAdmin})}>{a.isAdmin?"Ta bort adminbehörighet":"Ge adminbehörighet"}</button>
   <button type="button" disabled={busy} className="rounded border px-3 py-1" onClick={()=>post({action:"setAccountDisabled",accountId:a.id,disabled:!a.isDisabled})}>{a.isDisabled?"Aktivera":"Inaktivera"}</button>
   <button type="button" disabled={busy} className="rounded border border-red-300 px-3 py-1 text-red-700" onClick={()=>{if(window.confirm("Radera inloggningskontot "+a.email+"? Medarbetare, aktiviteter och planering behålls."))post({action:"deleteAccount",accountId:a.id})}}>Ta bort konto</button>
  </div>}</div>
  <div className="flex flex-wrap items-end gap-2">
   <label className="min-w-48 flex-1 text-xs font-medium">Kopplad medarbetare
    <select aria-label={"Kopplad medarbetare för "+a.email} value={accountLinks[a.id]??(a.employeeId===null?"":String(a.employeeId))} onChange={e=>setAccountLinks(prev=>({...prev,[a.id]:e.target.value}))} className="mt-1 w-full rounded border px-2 py-2 text-sm"><option value="">Ingen koppling</option>{data.employees.map(e=><option key={e.id} value={e.id}>{e.name} · {e.email}</option>)}</select>
   </label>
   <button type="button" disabled={busy||(accountLinks[a.id]??(a.employeeId===null?"":String(a.employeeId)))===(a.employeeId===null?"":String(a.employeeId))} className="rounded bg-blue-700 px-3 py-2 text-white disabled:opacity-40" onClick={async()=>{const value=accountLinks[a.id]??"";if(await post({action:"linkAccount",accountId:a.id,employeeId:value?Number(value):null}))setAccountLinks(prev=>{const next={...prev};delete next[a.id];return next})}}>Koppla</button>
  </div>
 </div>)}</div>
 </section>}
 <section className="rounded-xl border bg-white p-5"><h2 className="mb-3 text-lg font-semibold">Tilldela eller ta bort person i projekt</h2>
 <p className="mb-3 text-sm text-slate-600">Projektledare kan hantera medverkan i sina projekt. Gruppchef kan hantera sina egna medarbetare. Befintlig bemanning behöver tas bort separat om någon inte längre ska arbeta på aktiviteten.</p>
 <div className="flex flex-wrap items-end gap-3">
 <label className="min-w-48 flex-1 text-sm font-medium">Projekt<select className="mt-1 w-full rounded-lg border px-3 py-2" value={memberProject} onChange={e=>setMemberProject(e.target.value)}><option value="">Välj projekt</option>{(data?.projectDirectory||data?.projects||[]).map(p=><option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</select></label>
 <label className="min-w-48 flex-1 text-sm font-medium">Medarbetare<select className="mt-1 w-full rounded-lg border px-3 py-2" value={memberEmployee} onChange={e=>setMemberEmployee(e.target.value)}><option value="">Välj medarbetare</option>{(data?.viewer.isAdmin||!!data?.viewer.projectLeadIds.length?access?.directoryEmployees:access?.directoryEmployees.filter(e=>data?.viewer.managedEmployeeIds.includes(e.id)))?.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
 <button disabled={busy||!memberEmployee||!memberProject} onClick={()=>membership(true)} className="rounded-lg bg-blue-700 px-3 py-2 text-sm text-white">Lägg till</button>
 <button disabled={busy||!memberEmployee||!memberProject} onClick={()=>membership(false)} className="rounded-lg border px-3 py-2 text-sm">Ta bort</button>
 </div></section>
 <section className="rounded-xl border bg-white p-5"><h2 className="mb-3 text-lg font-semibold">Projektledare och TEAM-leader</h2>
 <div className="grid gap-3 sm:grid-cols-3">
 <label className="text-sm font-medium">Medarbetare<select className="mt-1 w-full rounded-lg border px-3 py-2" value={leadEmployee} onChange={e=>setLeadEmployee(e.target.value)}><option value="">Välj person</option>{eligible.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
 <label className="text-sm font-medium">Projekt<select className="mt-1 w-full rounded-lg border px-3 py-2" value={leadProject} onChange={e=>setLeadProject(e.target.value)}><option value="">Välj projekt</option>{data?.projects.map(p=><option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</select></label>
 <div className="flex items-end gap-2"><button className="rounded-lg bg-blue-700 px-3 py-2 text-sm text-white disabled:opacity-50" disabled={busy||!leadEmployee||!leadProject} onClick={()=>post({action:"setProjectLeader",employeeId:Number(leadEmployee),projectId:Number(leadProject),enabled:true})}>Utse projektledare</button><button disabled={busy||!leadEmployee||!leadProject} className="rounded-lg border px-3 py-2 text-sm" onClick={()=>post({action:"setProjectLeader",employeeId:Number(leadEmployee),projectId:Number(leadProject),enabled:false})}>Ta bort</button></div>
 <label className="text-sm font-medium">TEAM<select value={leadTeam} onChange={e=>setLeadTeam(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2"><option value="">Välj TEAM</option>{data?.employeeGroups.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
 <div className="flex items-end gap-2 sm:col-span-2"><button disabled={busy||!leadEmployee||!leadTeam} className="rounded-lg bg-blue-700 px-3 py-2 text-sm text-white" onClick={()=>post({action:"setTeamLeader",employeeId:Number(leadEmployee),teamId:Number(leadTeam),enabled:true})}>Utse TEAM-leader</button><button disabled={busy||!leadEmployee||!leadTeam} className="rounded-lg border px-3 py-2 text-sm" onClick={()=>post({action:"setTeamLeader",employeeId:Number(leadEmployee),teamId:Number(leadTeam),enabled:false})}>Ta bort</button></div>
 </div>
 {data?.viewer.isAdmin&&<div className="mt-5 flex flex-wrap items-end gap-3 rounded-lg bg-blue-50 p-3"><div className="flex-1"><p className="font-semibold">TEAM-ansvarig gruppchef</p><p className="text-xs text-slate-600">För befintliga TEAM kan administratören ange vem som får ändra medlemmar och utse TEAM-leaders.</p></div><button disabled={busy||!leadTeam||!leadEmployee} className="rounded-lg bg-blue-700 px-3 py-2 text-sm text-white" onClick={()=>post({action:"setTeamOwner",teamId:Number(leadTeam),employeeId:Number(leadEmployee)})}>Ge ansvar till vald person</button></div>}
 <div className="mt-5 grid gap-3 md:grid-cols-2"><div className="rounded-lg bg-slate-50 p-3"><h3 className="mb-2 font-semibold">Projektledare</h3>{access?.projectLeaders.map((p,i)=><p className="text-sm" key={i}>{data?.projects.find(x=>x.id===p.projectId)?.name} – {data?.employees.find(x=>x.id===p.employeeId)?.name||p.employeeId}</p>)}</div><div className="rounded-lg bg-slate-50 p-3"><h3 className="mb-2 font-semibold">TEAM-leaders</h3>{access?.teamLeaders.map((t,i)=><p className="text-sm" key={i}>{data?.employeeGroups.find(x=>x.id===t.teamId)?.name} – {data?.employees.find(x=>x.id===t.employeeId)?.name||t.employeeId}</p>)}</div></div>
 </section>
 </div></main>;
}
