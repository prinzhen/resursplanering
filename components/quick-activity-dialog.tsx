"use client";

import {useEffect,useState,type FormEvent} from "react";
import {Button} from "@/components/ui/button";
import {Dialog,DialogContent,DialogDescription,DialogFooter,DialogHeader,DialogTitle} from "@/components/ui/dialog";
import {Input} from "@/components/ui/input";
import {Textarea} from "@/components/ui/textarea";

type Context="project"|"team"|"group";
type Person={id:number;name:string};
type Choice={id:number;name:string};
type Project={id:number;code:string;name:string};
type WorkPackage={id:number;projectId:number;code:string;name:string};
type Activity={id:number;projectId:number;name:string;parentActivityId:number|null};
type Props={
 data:{viewer?:{employeeId:number|null};projects:Project[];workPackages:WorkPackage[];activities:Activity[]};
 preset?:{projectId?:number;teamId?:number;parentActivityId?:number};
 close:()=>void;
 onCreated:(id:number,proposal:boolean)=>Promise<void>|void;
};

const today=()=>new Date().toISOString().slice(0,10);
const twoWeeks=()=>new Date(Date.now()+14*86400000).toISOString().slice(0,10);

export default function QuickActivityDialog({data,preset,close,onCreated}:Props){
 const [projectId,setProjectId]=useState(preset?.projectId?String(preset.projectId):"");
 const [context,setContext]=useState<Context>(preset?.teamId?"team":"project");
 const [contextId,setContextId]=useState(preset?.teamId?String(preset.teamId):"");
 const [recipientId,setRecipientId]=useState(data.viewer?.employeeId?String(data.viewer.employeeId):"");
 const [workPackageId,setWorkPackageId]=useState("");
 const [parentActivityId,setParentActivityId]=useState(preset?.parentActivityId?String(preset.parentActivityId):"");
 const [effort,setEffort]=useState(0);
 const [eligible,setEligible]=useState<Person[]>([]);
 const [teams,setTeams]=useState<Choice[]>([]);
 const [groups,setGroups]=useState<Choice[]>([]);
 const [allowed,setAllowed]=useState(false);
 const [loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const self=String(data.viewer?.employeeId??"");
 const other=recipientId!==self;
 const selectClass="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm";
 useEffect(()=>{
  let alive=true;
  if(!projectId){setEligible([]);setAllowed(false);return;}
  setLoading(true);
  const params=new URLSearchParams({projectId,context,contextId:contextId||"0"});
  fetch("/api/quick-activity?"+params,{cache:"no-store"}).then(async response=>{
   if(response.status===401){window.location.assign("/login");return null;}
   const payload=await response.json() as {error?:string};
   if(!response.ok)throw Error(payload.error||"Kunde inte kontrollera mottagare");
   return payload as {allowed:boolean;eligibleRecipients:Person[];teams:Choice[];groups:Choice[]};
  }).then(result=>{
   if(!alive||!result)return;
   setAllowed(result.allowed);setEligible(result.eligibleRecipients||[]);
   setTeams(result.teams||[]);setGroups(result.groups||[]);
  }).catch(e=>alive&&setError(String(e))).finally(()=>alive&&setLoading(false));
  return ()=>{alive=false};
 },[projectId,context,contextId]);
 const changeProject=(value:string)=>{
  setProjectId(value);setWorkPackageId("");setParentActivityId("");setRecipientId(self);setEffort(0);setError("");
 };
 const changeContext=(value:Context)=>{
  setContext(value);setContextId("");setRecipientId(self);setEffort(0);
 };
 const changeRecipient=(value:string)=>{
  setRecipientId(value);setEffort(value===self?0:50);
 };
 const submit=async(event:FormEvent<HTMLFormElement>)=>{
  event.preventDefault();setError("");
  if(!projectId||!allowed||loading){setError("Välj ett projekt där du får skapa aktiviteter.");return}
  if(other&&!eligible.some(p=>String(p.id)===recipientId)){setError("Mottagaren saknar rätt till den valda projekt-/TEAM-/gruppkontexten.");return}
  const values=Object.fromEntries(new FormData(event.currentTarget));
  setBusy(true);
  try{
   const response=await fetch("/api/quick-activity",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({...values,projectId:Number(projectId),workPackageId:workPackageId||null,parentActivityId:parentActivityId||null,
     recipientId:Number(recipientId),effortPercent:effort,context,contextId:contextId?Number(contextId):0})
   });
   const result=await response.json() as {activityId?:number;proposal?:boolean;error?:string};
   if(response.status===401){window.location.assign("/login");return}
   if(!response.ok||!result.activityId)throw Error(result.error||"Aktiviteten kunde inte skapas.");
   await onCreated(result.activityId,!!result.proposal);
  }catch(e){setError(e instanceof Error?e.message:String(e))}
  finally{setBusy(false)}
 };
 return <Dialog open onOpenChange={isOpen=>!isOpen&&close()}>
  <DialogContent className="max-h-[94vh] overflow-y-auto sm:max-w-[720px]">
   <form className="grid gap-4" onSubmit={submit}>
    <DialogHeader><DialogTitle>Skapa aktivitet</DialogTitle>
     <DialogDescription>Förvalt för dig själv. Väljer du en kollega skickas ett förslag som personen måste godkänna innan någon beläggning tilldelas.</DialogDescription>
    </DialogHeader>
    <div className="grid gap-3 sm:grid-cols-2">
     <label className="grid gap-1 text-sm font-medium">Projekt
      <select className={selectClass} required value={projectId} onChange={e=>changeProject(e.target.value)}>
       <option value="">Välj projekt</option>{data.projects.map(p=><option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
      </select>
     </label>
     <label className="grid gap-1 text-sm font-medium">Uppdrag
      <select className={selectClass} value={workPackageId} onChange={e=>setWorkPackageId(e.target.value)} disabled={!projectId}>
       <option value="">Direkt i projektet</option>
       {data.workPackages.filter(w=>String(w.projectId)===projectId).map(w=><option value={w.id} key={w.id}>{w.code} · {w.name}</option>)}
      </select>
     </label>
     <label className="grid gap-1 text-sm font-medium">Tillhörighet
      <select className={selectClass} value={context} onChange={e=>changeContext(e.target.value as Context)}>
       <option value="project">Projekt</option><option value="team">TEAM inom projekt</option><option value="group">Chefsgrupp inom projekt</option>
      </select>
     </label>
     {context!=="project"&&<label className="grid gap-1 text-sm font-medium">{context==="team"?"TEAM":"Grupp"}
      <select className={selectClass} value={contextId} onChange={e=>{setContextId(e.target.value);setRecipientId(self);setEffort(0)}} required>
       <option value="">Välj {context==="team"?"TEAM":"grupp"}</option>
       {(context==="team"?teams:groups).map(group=><option key={group.id} value={group.id}>{group.name}</option>)}
      </select>
     </label>}
     <label className="grid gap-1 text-sm font-medium">Tilldela / föreslå till
      <select className={selectClass} value={recipientId} onChange={e=>changeRecipient(e.target.value)} required>
       {self&&<option value={self}>Mig själv (förvalt)</option>}
       {eligible.map(e=><option value={e.id} key={e.id}>{e.name} · kräver godkännande</option>)}
      </select>
     </label>
     <label className="grid gap-1 text-sm font-medium">Huvudaktivitet (valfritt)
      <select className={selectClass} value={parentActivityId} onChange={e=>setParentActivityId(e.target.value)}>
       <option value="">Ny huvudaktivitet</option>
       {data.activities.filter(a=>String(a.projectId)===projectId&&!a.parentActivityId).map(a=><option value={a.id} key={a.id}>{a.name}</option>)}
      </select>
     </label>
     <label className="grid gap-1 text-sm font-medium">Aktivitetskod (valfritt)<Input name="code" maxLength={60} placeholder="Ex. A-101"/></label>
     <label className="grid gap-1 text-sm font-medium">Namn<Input name="name" required maxLength={150} autoFocus/></label>
    </div>
    <label className="grid gap-1 text-sm font-medium">Beskrivning (max 500 tecken)
     <Textarea name="description" required maxLength={500} rows={3} placeholder="Beskriv vad som ska genomföras och förväntat resultat."/>
    </label>
    <div className="grid gap-3 sm:grid-cols-4">
     <label className="grid gap-1 text-sm font-medium">Startdatum<Input name="startDate" type="date" required defaultValue={today()}/></label>
     <label className="grid gap-1 text-sm font-medium">Slutdatum<Input name="endDate" type="date" required defaultValue={twoWeeks()}/></label>
     <label className="grid gap-1 text-sm font-medium">Prioritet
      <select className={selectClass} name="priority" defaultValue="3">{[1,2,3,4,5].map(n=><option value={n} key={n}>{n}{n===3?" – Normal":""}</option>)}</select>
     </label>
     <label className="grid gap-1 text-sm font-medium">Beläggning %
      <Input type="number" value={effort} onChange={e=>setEffort(Number(e.target.value))} min={0} max={200} required/>
     </label>
    </div>
    <label className="grid gap-1 text-sm font-medium">Uppskattade timmar (valfritt)<Input name="estimatedHours" type="number" min={0} max={100000} step="0.5"/></label>
    {other&&<label className="grid gap-1 text-sm font-medium">Meddelande till mottagaren (valfritt)
     <Textarea name="comment" maxLength={500} rows={2} placeholder="Varför behöver du hjälp med den här aktiviteten?"/>
    </label>}
    {other?<p className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">Aktiviteten skapas i projektet men mottagaren får ingen beläggning förrän förslaget godkänts under Aktivitetsförfrågningar.</p>
     :<p className="text-xs text-slate-600">Din aktivitet blir aktiv direkt. Beläggningen kan ändras senare.</p>}
    {!allowed&&projectId&&!loading&&<p role="alert" className="text-sm text-amber-800">Du deltar inte i den valda kontexten, eller så behöver du välja ett TEAM/en grupp.</p>}
    {error&&<p role="alert" className="text-sm text-red-700">{error}</p>}
    <DialogFooter><Button type="button" variant="outline" onClick={close}>Avbryt</Button>
     <Button type="submit" disabled={busy||loading||!projectId||!recipientId||!allowed}>{busy?"Sparar…":other?"Skicka aktivitetsförslag":"Skapa min aktivitet"}</Button>
    </DialogFooter>
   </form>
  </DialogContent>
 </Dialog>;
}
