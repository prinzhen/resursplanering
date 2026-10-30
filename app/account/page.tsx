"use client";
import {useEffect,useState} from "react";
export default function Account(){
 const [email,setEmail]=useState(""),[current,setCurrent]=useState(""),[next,setNext]=useState(""),[confirm,setConfirm]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false),[ok,setOk]=useState("");
 useEffect(()=>{fetch("/api/auth",{cache:"no-store"}).then(r=>r.json() as Promise<{user?:{email:string}|null}>).then(x=>{if(!x.user)window.location.assign("/login");else setEmail(x.user.email)}).catch(()=>setError("Kunde inte läsa kontot."))},[]);
 const save=async(e:React.FormEvent)=>{e.preventDefault();setError("");setOk("");
  if(next!==confirm){setError("De nya lösenorden är olika.");return}
  if(next.length<6){setError("Använd minst 6 tecken.");return}
  setBusy(true);try{
   const r=await fetch("/api/auth",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"changePassword",currentPassword:current,newPassword:next})});
   const d=await r.json() as {error?:string};
   if(!r.ok)throw Error(d.error||"Kunde inte byta lösenord.");
   setOk("Lösenordet har ändrats. Logga in igen.");
   setCurrent("");setNext("");setConfirm("");
   setTimeout(()=>window.location.assign("/login"),800);
  }catch(e){setError(e instanceof Error?e.message:String(e))}finally{setBusy(false)}
 };
 return <main className="flex min-h-screen items-center justify-center bg-slate-100 p-5 text-slate-900"><form onSubmit={save} className="w-full max-w-md space-y-4 rounded-xl border bg-white p-7 shadow-sm"><a className="text-sm text-blue-700" href="/">← Till planeringen</a><h1 className="text-2xl font-bold">Mitt konto</h1><p className="text-sm text-slate-600">{email}</p>
 <p className="text-sm text-slate-600">Byt ditt tillfälliga lösenord första gången du loggar in. Alla tidigare inloggningar avslutas efter bytet.</p>
 <label className="block text-sm font-semibold">Nuvarande lösenord<input className="mt-1 w-full rounded-lg border p-2" type="password" autoComplete="current-password" value={current} onChange={e=>setCurrent(e.target.value)} required/></label>
 <label className="block text-sm font-semibold">Nytt lösenord<input className="mt-1 w-full rounded-lg border p-2" type="password" autoComplete="new-password" value={next} onChange={e=>setNext(e.target.value)} minLength={6} required/></label>
 <label className="block text-sm font-semibold">Upprepa nytt lösenord<input className="mt-1 w-full rounded-lg border p-2" type="password" autoComplete="new-password" value={confirm} onChange={e=>setConfirm(e.target.value)} minLength={6} required/></label>
 {error&&<p className="rounded-lg bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</p>}
 {ok&&<p className="rounded-lg bg-green-50 p-3 text-sm text-green-800">{ok}</p>}
 <button disabled={busy} className="w-full rounded-lg bg-blue-700 px-4 py-2 font-semibold text-white disabled:opacity-50">Byt lösenord</button></form></main>;
}
