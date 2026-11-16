"use client";
import {useEffect,useMemo,useState} from "react";
import {createWeeklyV2Xlsx,readWeeklyV2Xlsx,normalizeISOWeek,durationLabel,splitPeriodIntoWeeks,currentWeekKey,shiftISOWeek,weekOptions,formatWeekLabel,weekMonday,WEEK_DAYS,type WeeklyV2Row} from "@/lib/weekly-xlsx-v2";
import type {FormValues} from "@/lib/individual-xlsx";
import {asWeeklyRows} from "@/lib/weekly-export";
import {scheduleDates,hoursForSchedule} from "@/lib/activity-calendar";

type Person={id:number;name:string;email:string};
export default function WeeklyV2Page(){
 const [people,setPeople]=useState<Person[]>([]),[selected,setSelected]=useState(""),[rows,setRows]=useState<WeeklyV2Row[]>([]);
 const [error,setError]=useState(""),[message,setMessage]=useState(""),[loading,setLoading]=useState(false);
 const [preview,setPreview]=useState<{created:number;updated:number;unchanged:number;employeesCreated:number;projectsCreated:number;activitiesCreated:number;assignedToInternal?:number;conflicts?:Array<{activityId:number;task:string;exportRevision:number;currentRevision:number}>}|null>(null);
 const [filePerson,setFilePerson]=useState<{name:string;email:string}|null>(null);
 const [fromFile,setFromFile]=useState(false);
 const [acceptStale,setAcceptStale]=useState(false);
 const [registered,setRegistered]=useState<Array<{projectCode:string;projectName:string;projectId:number;activityName:string;activityId:number;startDate:string;endDate:string}>>([]);
 const [selectedWeek,setSelectedWeek]=useState(()=>currentWeekKey());
 const [showAllWeeks,setShowAllWeeks]=useState(false);
 const weeks=useMemo(()=>weekOptions(currentWeekKey()),[]);
 const thisWeek=currentWeekKey();
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
 useEffect(()=>{if(!fromFile&&selected&&people.some(p=>p.email===selected)){void fetchRows(selected)}},[selected,people,fromFile]);
 const fetchRows=async(email:string)=>{setSelected(email);setRows([]);setPreview(null);setFilePerson(null);setFromFile(false);setError("");setMessage("");if(!email)return;setLoading(true);
  try{const r=await fetch("/api/individual?email="+encodeURIComponent(email)+"&includeClosed=1",{cache:"no-store"});
   const body=await r.json() as FormValues&{error?:string};if(!r.ok)throw Error(body.error||"API-fel");
   const person=people.find(p=>p.email===email);if(!person)throw Error("Välj en medarbetare.");
   const response=await fetch("/api/weekly-v2?employeeId="+person.id,{cache:"no-store"});
   const current=await response.json() as {rows:Array<{rowKey:string;employeeId:number;activityId:number;week:string;weekday:number|null;durationDays:number;effort:number|null;hours:number|null;workType:string;status:string;priority:number|null;deadline:string|null;firstWeek:string;comment:string;moveReason:string;revision:number;task:string;projectCode:string;projectName:string}>;identities:Array<{uid:string;activityId:number;startDate:string;endDate:string}>;error?:string};
   if(!response.ok)throw Error(current.error||"Kunde inte läsa sparade planeringsrader");
   const next=asWeeklyRows(body,person.id,current.identities);
   const stored=current.rows.map(w=>({week:w.week,day:WEEK_DAYS[w.weekday??0]||"",task:w.task,duration:durationLabel(w.durationDays),
    effort:w.effort,workType:w.workType,hours:w.hours,status:w.status,priority:String(w.priority??""),
    deadline:w.deadline||"",projectCode:w.projectCode,projectName:w.projectName,firstWeek:w.firstWeek,
    comment:w.comment,moveReason:w.moveReason,activityId:"activity-"+w.activityId,rowKey:w.rowKey,rowRevision:w.revision}));
   const savedByKey=new Map(stored.map(x=>[x.rowKey,x]));
   const chosen=next.map(x=>{
    const saved=savedByKey.get(x.rowKey||"");
    if(!saved)return x;
    // Gantt is canonical for start/end: if a task was moved in the web UI
    // since last Excel export, retain the newer dates from the project.
    const currentDates=scheduleDates(x),storedDates=scheduleDates(saved);
    if(currentDates.start!==storedDates.start||currentDates.end!==storedDates.end)
     return {...saved,week:x.week,day:x.day,duration:x.duration,rowRevision:saved.rowRevision};
    return saved;
   });
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
   const who=people.find(p=>p.email===selected);
   const blob=createWeeklyV2Xlsx(items,currentWeekKey(),{name:who?.name||filePerson?.name||"",email:selected||filePerson?.email||""});
   const url=URL.createObjectURL(blob),a=document.createElement("a");
   a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();
   setTimeout(()=>URL.revokeObjectURL(url),2000);
   setMessage("Exporterade "+items.length+" planeringsrader.");
  }catch(e){setError("Exporten misslyckades: "+(e instanceof Error?e.message:String(e)))}
 };
 const saveBlank=()=>{setError("");try{
  const who=people.find(p=>p.email===selected);
  const blob=createWeeklyV2Xlsx([],currentWeekKey(),{name:who?.name||"",email:who?.email||""}),url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url;a.download="veckoplanering-v2-mall.xlsx";document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),2000);
 }catch(e){setError("Kunde inte skapa mallen: "+String(e))}
 };
 const openFile=async(file:File|null)=>{if(!file)return;setError("");try{
  const parsed=await readWeeklyV2Xlsx(file);
  setRegistered([]);
  const email=parsed.email||selected;
  const known=people.find(p=>p.email.toLowerCase()===email.toLowerCase());
  if(!email)throw Error("E-postadress saknas i filen. Fyll i e-post i Excel och exportera/importera igen.");
  if(!parsed.name&&!known)throw Error("Namn saknas i den personliga Excel-filen.");
  setFilePerson({name:parsed.name||known?.name||"",email});
  setSelected(known?.email||"");
  setRows(parsed.rows);setFromFile(true);setPreview(null);setAcceptStale(false);
  setMessage("Läste "+parsed.rows.length+" aktivitetsrader för "+(parsed.name||known?.name||email)+
    ". Förhandsgranska vilka poster som ska skapas eller uppdateras.");
 }catch(e){setError(e instanceof Error?e.message:String(e))}
 };
 const importRows=async(commit:boolean)=>{
  if(!fromFile){setError("Läs in en personlig Excel-fil först.");return}
  const person=filePerson;
  if(!person?.email){setError("Excel-filen måste innehålla e-postadress.");return}
  const existing=people.find(p=>p.email.toLowerCase()===person.email.toLowerCase());
  const newRows=rows.filter(r=>!r.activityId.trim());
  const existingRows=rows.filter(r=>!!r.activityId.trim());
  if(existingRows.length&&!existing){
   setError("Filen innehåller befintliga aktivitets-ID:n, men medarbetaren finns inte eller är inte tillgänglig för dig.");
   return;
  }
  setError("");setLoading(true);
  try{
   let existingPreview:{created:number;updated:number;unchanged:number;conflicts?:Array<{activityId:number;task:string;exportRevision:number;currentRevision:number}>}={created:0,updated:0,unchanged:0};
   const request=async(url:string,body:unknown)=>{
    const response=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},
     body:JSON.stringify(body)});
    const result=await response.json() as {error?:string;preview?:{created:number;updated:number;unchanged:number;employeesCreated:number;projectsCreated:number;activitiesCreated:number;conflicts?:Array<{activityId:number;task:string;exportRevision:number;currentRevision:number}>};verified?:boolean;warnings?:string[];registered?:Array<{projectCode:string;projectName:string;projectId:number;activityName:string;activityId:number;startDate:string;endDate:string}>};
    if(!response.ok)throw Error(result.error||"Importen avbröts");
    return result;
   };
   // Always validate existing revision keys BEFORE any new objects are created.
   if(existingRows.length&&existing){
    const p=await request("/api/weekly-v2",{employeeId:existing.id,rows:existingRows,commit:false});
    existingPreview=p.preview||existingPreview;
   }
   let createdPreview={employeesCreated:0,projectsCreated:0,activitiesCreated:0,assignedToInternal:0};
   if(newRows.length||!existing){
    const p=await request("/api/weekly-v2/bootstrap",{name:person.name,email:person.email,rows:newRows,commit:false});
    createdPreview={...createdPreview,...p.preview};
   }
   const summary={...existingPreview,...createdPreview};
   setPreview(summary);
   if(!commit){
    setMessage((summary.conflicts?.length?"Obs: "+summary.conflicts.length+" aktiviteter avviker från sparad planering. ":"")+"Förhandsgranskning: "+summary.activitiesCreated+" nya aktiviteter, "+
      summary.projectsCreated+" nya projekt, "+summary.employeesCreated+" nya medarbetare, "+
      summary.updated+" ändrade aktiviteter och "+summary.unchanged+" oförändrade."+(summary.assignedToInternal?" "+summary.assignedToInternal+" aktiviteter utan projekt läggs på Övrigt arbete.":""));
    return;
   }
   if(!preview){throw Error("Klicka Förhandsgranska ändringar före Godkänn och spara.");}
   if((summary.conflicts?.length||0)>0&&!acceptStale)throw Error("Bekräfta först att Excel ska ersätta nyare planeringsrevisioner.");
   let created=false;
   let createdRecords:typeof registered=[];
   try{
    if(newRows.length||!existing){
     const result=await request("/api/weekly-v2/bootstrap",{name:person.name,email:person.email,rows:newRows,commit:true});
     created=true; // The POST succeeded and may have written data; never retry blindly.
     createdRecords=result.registered||[];
     if(result.verified===false)throw Error("Importen genomfördes, men kontroll av sparade aktiviteter misslyckades: "+(result.warnings||[]).join(" "));
    }
    if(existingRows.length&&existing){
     await request("/api/weekly-v2",{employeeId:existing.id,rows:existingRows,commit:true,acceptStaleRevisions:acceptStale});
    }
   }catch(e){
    if(created)throw Error("De nya posterna kan ha registrerats, men uppdatering av befintliga aktiviteter misslyckades. Kontrollera databasen och exportera på nytt innan du försöker igen. "+String(e));
    throw e;
   }
   setRegistered(createdRecords);
   setFromFile(false);setPreview(null);
   const email=person.email;
   const list=await fetch("/api/data",{cache:"no-store"}).then(r=>r.json()) as {
    employees:Person[];viewer?:{employeeId:number|null;isAdmin:boolean;isGroupManager:boolean;managedEmployeeIds:number[]}};
   const allowed=(list.employees||[]).filter(p=>list.viewer?.isAdmin||p.id===list.viewer?.employeeId||
    (list.viewer?.isGroupManager&&list.viewer.managedEmployeeIds.includes(p.id)));
   setPeople(allowed);
   const selectedPerson=allowed.find(p=>p.email.toLowerCase()===email.toLowerCase());
   if(selectedPerson){
    setSelected(selectedPerson.email);
    setMessage("Import genomförd. Excel-filens aktuella prognos har sparats och Gantt har uppdaterats. Exportera en ny XLSX för senaste revisionsnummer och aktivitets-ID:n.");
   }else setMessage("Import genomförd. Ladda om sidan för att visa personen.");
  }catch(e){setError(e instanceof Error?e.message:String(e))}
  finally{setLoading(false)}
 };
 return <main className="min-h-screen bg-slate-50 p-5 text-slate-900"><div className="mx-auto max-w-6xl space-y-5">
  <header className="flex flex-wrap justify-between gap-4"><div><p className="text-sm font-medium text-blue-700">Resursplanering · Utvecklingsversion</p><h1 className="text-3xl font-semibold">Veckoplanering XLSX v2</h1>
   <p className="mt-2 text-sm text-slate-600">16 kolumner: vecka, valfri veckodag och varaktighet i kalenderdagar (1v = 7 dagar, 1v3d = 10 dagar, 10 eller 10d = 10 dagar). Beläggning beräknas normalt på måndag–fredag, 8 h/dag och 40 h/vecka. Exporterad XLSX har även fliken Beläggning: veckovis från föregående vecka till 26 veckor framåt. Den räknas om i Excel när aktiviteter ändras och läses aldrig tillbaka vid import.</p></div>
   <a className="rounded-lg border bg-white px-4 py-2 text-sm" href="/individual">← Befintlig veckoplanering</a></header>
  {error&&<p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4 text-red-800">{error}</p>}
  {message&&<p className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-blue-900">{message}</p>}
  <section className="rounded-xl border bg-white p-5"><h2 className="mb-4 font-semibold">Personlig Excel-planering – namn och e-post identifierar medarbetaren</h2>
   <div className="flex flex-wrap items-center gap-3">
    <select className="min-w-64 rounded-lg border p-2" value={selected} onChange={e=>setSelected(e.target.value)}><option value="">Välj medarbetare</option>{people.map(p=><option key={p.id} value={p.email}>{p.name}</option>)}</select>
    <button disabled={loading||!selected} onClick={()=>fetchRows(selected)} className="rounded-lg border px-4 py-2 disabled:opacity-50">Hämta planering</button>
    <button disabled={loading||!selected||!rows.length} onClick={()=>save(rows,"veckoplanering-"+selected.replace(/[^a-z0-9._-]/gi,"_")+"-v2.xlsx")} className="rounded-lg bg-blue-700 px-4 py-2 text-white">Exportera XLSX</button>
    <button onClick={saveBlank} className="rounded-lg border px-4 py-2">Tom XLSX-mall</button>
    <label className="cursor-pointer rounded-lg border px-4 py-2">Läs XLSX<input type="file" accept=".xlsx" className="hidden" onChange={e=>openFile(e.currentTarget.files?.[0]||null)}/></label>
   </div>
   <div className="mt-4 flex flex-wrap gap-3">
    <button disabled={loading||!fromFile} onClick={()=>importRows(false)} className="rounded-lg border border-blue-400 px-4 py-2 disabled:opacity-50">Förhandsgranska ändringar</button>
    <button disabled={loading||!preview||((preview.conflicts?.length||0)>0&&!acceptStale)||!(preview.activitiesCreated+preview.projectsCreated+preview.employeesCreated+preview.created+preview.updated)} onClick={()=>importRows(true)} className="rounded-lg bg-emerald-700 px-4 py-2 text-white disabled:opacity-50">Godkänn och spara planeringsposter</button>
   </div>
   {(preview?.conflicts?.length||0)>0&&<div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
    <p className="font-semibold">{preview?.conflicts?.length} aktiviteter har en annan sparad revision eller andra Gantt-datum än Excelunderlaget.</p>
    <ul className="mt-2 space-y-1">{preview?.conflicts?.map(c=><li key={c.activityId}>{c.task} – filrevision {c.exportRevision}, aktuell revision {c.currentRevision}</li>)}</ul>
    <label className="mt-3 flex items-start gap-2"><input type="checkbox" checked={acceptStale} onChange={e=>setAcceptStale(e.target.checked)}/>
     <span>Jag har granskat avvikelserna och vill att Excel-filens startvecka, startdag och varaktighet ska ersätta den sparade prognosen för dessa aktiviteter.</span></label>
   </div>}
   {registered.length>0&&<div className="mt-3 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-950">
    <p className="font-semibold">Kontrollerat sparade projekt och aktiviteter ({registered.length})</p>
    <ul className="mt-2 space-y-1">{registered.map((r,i)=><li key={i}>Projekt <b>{r.projectName}</b> ({r.projectCode}, ID {r.projectId}) · Aktivitet <b>{r.activityName}</b> (ID {r.activityId}) · {r.startDate}–{r.endDate}</li>)}</ul>
   </div>}
   {filePerson&&<p className="mt-3 rounded-lg bg-blue-50 p-3 text-sm text-blue-900">Filens medarbetare: <b>{filePerson.name}</b> · {filePerson.email} {people.some(p=>p.email.toLowerCase()===filePerson.email.toLowerCase())?"(finns registrerad)":"(ny medarbetare – kräver administratör/gruppchef)"}</p>}
   <p className="mt-3 text-sm text-amber-800">Saknas projektkod på en ny aktivitet läggs den automatiskt på Övrigt arbete, som skapas om det saknas. Aktiviteten kan kopplas till rätt projekt senare. En aktivitet visas som en rad, även vid tio veckors varaktighet. Ändrad vecka/dag flyttar både start och slut; ändrad varaktighet ändrar bara slut. Vid godkänd import uppdateras Gantt och enkla resursperioder. Redan rapporterad tid ändras aldrig. För aktiviteter med särskilda resursperioder krävs manuell granskning. Saknade medarbetare, projekt och aktiviteter kan skapas från Excel enligt samma behörighetsregler som i version 1.</p>
  </section>
  <section className="rounded-xl border bg-white p-4 space-y-3">
   <h2 className="font-semibold">Välj planeringsvecka</h2>
   <div className="flex flex-wrap items-center gap-2">
    <button aria-label="Föregående vecka" onClick={()=>{setSelectedWeek(w=>shiftISOWeek(w,-1));setShowAllWeeks(false)}} className="rounded-lg border px-4 py-2">← Föregående</button>
    <select aria-label="Välj vecka" value={selectedWeek} onChange={e=>{setSelectedWeek(e.target.value);setShowAllWeeks(false)}} className="rounded-lg border px-4 py-2">
     {weeks.map(w=><option key={w} value={w}>{formatWeekLabel(w,thisWeek)}</option>)}
    </select>
    <button aria-label="Nästa vecka" onClick={()=>{setSelectedWeek(w=>shiftISOWeek(w,1));setShowAllWeeks(false)}} className="rounded-lg border px-4 py-2">Nästa →</button>
    <button onClick={()=>{setSelectedWeek(currentWeekKey());setShowAllWeeks(false)}} className="rounded-lg border px-4 py-2">Aktuell vecka</button>
    <label className="ml-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={showAllWeeks} onChange={e=>setShowAllWeeks(e.target.checked)}/> Visa alla veckor</label>
   </div>
   <p className="text-sm text-slate-600">Veckoväljaren startar på aktuell vecka. En aktivitet visas under alla veckor som dess start och varaktighet täcker – men exporteras bara på en rad.</p>
  </section>
  <section className="overflow-x-auto rounded-xl border bg-white p-4"><h2 className="mb-3 font-semibold">Förhandsgranskning ({visibleRows.length} av {rows.length} rader)</h2><table className="w-full min-w-[950px] text-left text-sm">
   <thead><tr className="border-b bg-slate-100"><th className="p-2">Vecka</th><th className="p-2">Dag</th><th className="p-2">Aktivitet</th><th className="p-2">Varaktighet</th><th className="p-2">Insats</th><th className="p-2">Startdatum</th><th className="p-2">Slutdatum</th><th className="p-2">Timmar</th><th className="p-2">Projekt</th></tr></thead>
   <tbody>{visibleRows.map((r,i)=><tr className="border-b" key={i}><td className="p-2">{formatWeekLabel(r.week,thisWeek)}</td><td className="p-2">{r.day||"Ej vald"}</td><td className="p-2">{r.task}</td><td className="p-2">{r.duration}</td><td className="p-2">{r.effort===null?"–":r.effort+" %"}</td><td className="p-2">{scheduleDates(r).start}</td><td className="p-2">{scheduleDates(r).end}</td><td className="p-2">{r.hours??hoursForSchedule(r)??"–"}</td><td className="p-2">{r.projectCode}</td></tr>)}</tbody></table>
  </section>
 </div></main>;
}
