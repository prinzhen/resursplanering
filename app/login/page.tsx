"use client";
import {useState,useEffect} from "react";
import {useRouter} from "next/navigation";
export default function Login(){
 const router=useRouter(),[email,setEmail]=useState(""),[password,setPassword]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false);
 useEffect(()=>{fetch("/api/auth",{cache:"no-store"}).then(r=>r.json() as Promise<{user?:unknown}>).then(d=>{if(d.user)router.replace("/")}).catch(()=>{})},[router]);
 const submit=async(e:React.FormEvent)=>{e.preventDefault();setBusy(true);setError("");try{
  const r=await fetch("/api/auth",{method:"POST",headers:{"content-type":"application/json"},credentials:"same-origin",body:JSON.stringify({action:"login",email,password})});
  const d=await r.json() as {user?:unknown;error?:string};if(!r.ok)throw Error(d.error||"Inloggningen misslyckades");
  router.replace("/");
 }catch(e){setError(e instanceof Error?e.message:"Inloggningen misslyckades")}finally{setBusy(false)}};
 return <main className="flex min-h-screen items-center justify-center bg-slate-100 px-4 text-slate-900">
 <form onSubmit={submit} className="w-full max-w-md space-y-5 rounded-2xl border border-slate-200 bg-white p-8 shadow-xl">
 <div><p className="mb-1 text-xs font-bold uppercase tracking-widest text-blue-600">Resursplanering</p><h1 className="text-2xl font-bold">Logga in</h1><p className="mt-2 text-sm text-slate-600">Använd ditt personliga konto. Din behörighet styr vad du kan se och ändra.</p></div>
 <label className="block text-sm font-semibold">E-postadress<input type="email" autoComplete="username" required value={email} onChange={e=>setEmail(e.target.value)} className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 outline-blue-600"/></label>
 <label className="block text-sm font-semibold">Lösenord<input type="password" autoComplete="current-password" required value={password} onChange={e=>setPassword(e.target.value)} className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 outline-blue-600"/></label>
 {error&&<p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
 <button disabled={busy} className="w-full rounded-lg bg-blue-700 px-4 py-3 font-semibold text-white hover:bg-blue-800 disabled:opacity-50">{busy?"Loggar in…":"Logga in"}</button>
 <p className="text-xs text-slate-500">Om du saknar konto eller har glömt lösenordet, kontakta administratören eller din gruppchef.</p>
 </form></main>;
}
