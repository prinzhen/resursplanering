"use client";
import {useEffect,useMemo,useState} from "react";
import {readIndividualXlsx} from "@/lib/individual-xlsx";

type Project={id:number;code:string;name:string};
type Candidate={code:string;newName:string;sources:string[]};
type Change={code:string;oldName:string;newName:string;selected:boolean};
const norm=(s:string)=>s.trim().toLocaleLowerCase("sv-SE");

export default function ProjectNameImport(){
 const [projects,setProjects]=useState<Project[]>([]);
 const [isAdmin,setIsAdmin]=useState(false);
 const [loading,setLoading]=useState(true);
 const [busy,setBusy]=useState(false);
 const [changes,setChanges]=useState<Change[]>([]);
 const [conflicts,setConflicts]=useState<string[]>([]);
 const [missing,setMissing]=useState<string[]>([]);
 const [unchanged,setUnchanged]=useState(0);
 const [error,setError]=useState("");
 const [notice,setNotice]=useState("");
 useEffect(()=>{(async()=>{
  try{
   const r=await fetch("/api/data",{cache:"no-store"});
   if(r.status===401){location.assign("/login");return;}
   if(!r.ok)throw Error("Kunde inte läsa projekten.");
   const j=await r.json() as {viewer?:{isAdmin:boolean};projects?:Project[]};
   setIsAdmin(!!j.viewer?.isAdmin);setProjects(j.projects||[]);
  }catch(e){setError(e instanceof Error?e.message:String(e))}
  finally{setLoading(false)}
 })()},[]);
 const selected=changes.filter(x=>x.selected);
 const scan=async(files:FileList|null)=>{
  if(!files)return;
  setError("");setNotice("");setChanges([]);setConflicts([]);setMissing([]);setUnchanged(0);
  if(files.length>30){setError("Välj högst 30 filer per import.");return;}
  setBusy(true);
  try{
   const codes=new Map<string,Candidate[]>();
   for(const file of Array.from(files)){
    const book=await readIndividualXlsx(file);
    for(const activity of book.activities){
     if(activity.kind!=="Projekt")continue;
     const code=activity.projectCode.trim().toUpperCase();
     const newName=activity.link.trim();
     if(!code||!newName)continue;
     const rows=codes.get(code)||[];
     rows.push({code,newName,sources:[file.name]});codes.set(code,rows);
    }
   }
   const next:Change[]=[],conflict:string[]=[],unmatched:string[]=[];
   let same=0;
   for(const [code,items] of codes){
    const names=[...new Map(items.map(x=>[norm(x.newName),x.newName])).values()];
    if(names.length>1){conflict.push(code+": "+names.join(" / "));continue;}
    const project=projects.find(p=>p.code.toUpperCase()===code);
    if(!project){unmatched.push(code+": "+names[0]);continue;}
    if(project.name===names[0])same++;
    else next.push({code,oldName:project.name,newName:names[0],selected:true});
   }
   setChanges(next);setConflicts(conflict);setMissing(unmatched);setUnchanged(same);
   if(!codes.size)setError("Hittade inga projektrader med projektkod (E) och namn (D). Kontrollera Excelmallarna.");
  }catch(e){setError(e instanceof Error?e.message:String(e))}
  finally{setBusy(false)}
 };
 const apply=async()=>{
  if(!selected.length||conflicts.length||busy)return;
  setBusy(true);setError("");setNotice("");
  try{
   const r=await fetch("/api/project-name-import",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({changes:selected.map(({code,oldName,newName})=>({code,oldName,newName}))})});
   const j=await r.json() as {error?:string;updated?:number};
   if(!r.ok)throw Error(j.error||"Importen misslyckades.");
   setNotice((j.updated||0)+" projektnamn korrigerades. Aktiviteter, resurser och tidrapporter ändrades inte.");
   setProjects(prev=>prev.map(p=>{const change=selected.find(c=>c.code===p.code);return change?{...p,name:change.newName}:p}));
   setChanges([]);
  }catch(e){setError(e instanceof Error?e.message:String(e))}
  finally{setBusy(false)}
 };
 const grouped=useMemo(()=>changes.length,[changes]);
 if(loading)return <main className="p-8">Läser projekt…</main>;
 if(!isAdmin)return <main className="p-8">Endast administratörer får korrigera projektnamn. <a href="/" className="text-blue-700 underline">Tillbaka</a></main>;
 return <main className="mx-auto max-w-5xl space-y-6 p-6 text-slate-900">
  <header><a href="/" className="text-sm text-blue-700 underline">← Till Projektstruktur</a>
   <h1 className="mt-3 text-3xl font-semibold">Korrigera projektnamn från Excel</h1>
   <p className="mt-2 text-slate-600">Läs in flera äldre veckoplaneringar. Kolumn B är aktivitet, D är projektnamn och E är projektkod. Endast projektnamn skrivs till databasen.</p>
  </header>
  {error&&<p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4 text-red-800">{error}</p>}
  {notice&&<p role="status" className="rounded-lg border border-green-300 bg-green-50 p-4 text-green-800">{notice}</p>}
  <section className="rounded-xl border bg-white p-5 shadow-sm">
   <label htmlFor="excel-files" className="block font-semibold">1. Välj korrigerade Excel-filer (.xlsx)</label>
   <input id="excel-files" type="file" accept=".xlsx" multiple disabled={busy} onChange={e=>void scan(e.target.files)} className="mt-3 block w-full rounded border p-3"/>
   <p className="mt-2 text-sm text-slate-600">Importen ignorerar Projektmedverkan och läser enbart projektuppgifter i aktivitetsraderna. Inga aktiviteter importeras.</p>
  </section>
  <section className="rounded-xl border bg-white p-5 shadow-sm">
   <h2 className="font-semibold">2. Granska projektnamn</h2>
   <p className="my-3 text-sm text-slate-600">{grouped} föreslagna namnändringar · {unchanged} redan korrekta · {conflicts.length} konflikter · {missing.length} projektkoder som saknas i databasen.</p>
   {!!conflicts.length&&<div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3"><strong>Konflikter – korrigera filerna före import:</strong>{conflicts.map(x=><p key={x}>{x}</p>)}</div>}
   {!!missing.length&&<div className="mb-4 rounded-lg border border-slate-300 p-3"><strong>Saknas i databasen (skapas inte):</strong>{missing.map(x=><p key={x}>{x}</p>)}</div>}
   <div className="overflow-auto"><table className="min-w-[750px] w-full text-left text-sm"><thead className="bg-slate-100"><tr><th className="p-2">Välj</th><th className="p-2">Projektkod</th><th className="p-2">Nuvarande namn</th><th className="p-2">Namn från D</th></tr></thead>
    <tbody>{changes.map(c=><tr key={c.code} className="border-t"><td className="p-2"><input type="checkbox" checked={c.selected} onChange={e=>setChanges(prev=>prev.map(v=>v.code===c.code?{...v,selected:e.target.checked}:v))}/></td><td className="p-2">{c.code}</td><td className="p-2">{c.oldName}</td><td className="p-2 font-medium">{c.newName}</td></tr>)}</tbody></table></div>
   <div className="mt-5 flex flex-wrap gap-3"><button type="button" className="rounded-lg bg-blue-700 px-4 py-2 font-semibold text-white disabled:opacity-40" disabled={busy||!selected.length||!!conflicts.length} onClick={()=>void apply()}>3. Uppdatera {selected.length} projektnamn</button><a className="rounded-lg border px-4 py-2" href="/">Avbryt</a></div>
   <p className="mt-2 text-xs text-slate-500">Om ett namn har ändrats sedan förhandsgranskningen avbryts korrigeringen. Säkerhetskopiera produktionsdatabasen innan du använder funktionen i produktion.</p>
  </section>
 </main>;
}
