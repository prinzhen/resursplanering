import {env} from "cloudflare:workers";
import {sessionIdentity,unauthorized,forbidden,sameOrigin} from "@/lib/auth";
import {accessScope} from "@/lib/permissions";
import {POST as importIndividual} from "@/app/api/individual/route";
import {scheduleDates,hoursForSchedule} from "@/lib/activity-calendar";
import {normalizeISOWeek,parseDurationDays,type WeeklyV2Row} from "@/lib/weekly-xlsx-v2";
import type {FormValues,FormActivity} from "@/lib/individual-xlsx";
export const dynamic="force-dynamic";
const text=(v:unknown)=>String(v??"").trim();
/** Reuse the established v1 registration engine. NEVER create login passwords.
 * Bootstrap handles only missing activities; existing activities are managed by
 * /api/weekly-v2 with optimistic revision checks.
 */
export async function POST(req:Request){
 try{
  const db=env.DB;if(!db)throw Error("Databasen saknas.");
  const identity=await sessionIdentity(req,db);if(!identity)return unauthorized();
  if(!sameOrigin(req))return forbidden();
  const input=await req.json() as {name:string;email:string;rows:WeeklyV2Row[];commit:boolean};
  const name=text(input.name),email=text(input.email).toLowerCase(),rows=input.rows;
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254||name.length>150||!Array.isArray(rows)||rows.length>60)
   return Response.json({error:"Namn/e-post saknas eller filen har mer än 60 nya aktiviteter."},{status:400});
  const person=await db.prepare("SELECT id,name,manager_id managerId FROM employees WHERE lower(email)=lower(?)").bind(email).first<{id:number;name:string;managerId:number|null}>();
  if(!person&&!name)return Response.json({error:"Namn krävs för ny medarbetare."},{status:400});
  const scope=await accessScope(db,identity);
  const privileged=identity.isAdmin||identity.isGroupManager;
  if(!person&&!privileged)return forbidden();
  if(person&&!identity.isAdmin&&person.id!==identity.employeeId&&!(identity.isGroupManager&&person.managerId===identity.employeeId))return forbidden();
  if(!rows.length&&person)return Response.json({preview:{employeesCreated:0,projectsCreated:0,activitiesCreated:0},committed:false});
  const codes=new Set<string>();
  const tasks=new Set<string>();
  let projectsCreated=0;
  const activities:FormActivity[]=[];
  for(const row of rows){
   if(text(row.activityId)||text(row.rowKey))return Response.json({error:"Endast nya aktiviteter utan ID får registreras via den här funktionen."},{status:400});
   const kind=text(row.workType)||"Projekt";
   if(!["Projekt","Verksamhet","Övrigt"].includes(kind))throw Error("Felaktig typ av arbete.");
   const code=kind==="Verksamhet"?"INTERNAL-VERK":kind==="Övrigt"?"INTERNAL-OVR":text(row.projectCode).toUpperCase();
   if(kind==="Projekt"&&!/^[A-Z0-9][A-Z0-9._-]{0,39}$/.test(code))throw Error("Projektkod saknas eller är ogiltig.");
   if(!text(row.task)||text(row.task).length>200)throw Error("Aktivitetsnamn saknas eller är för långt.");
   normalizeISOWeek(row.week);
   const dates=scheduleDates(row);
   const duration=parseDurationDays(row.duration);
   if(duration>3650)throw Error("För lång aktivitet.");
   const key=code+"|"+row.task.toLocaleLowerCase("sv-SE")+"|"+row.firstWeek;
   if(tasks.has(key))throw Error("Samma nya aktivitet förekommer flera gånger: "+row.task);
   tasks.add(key);
   if(!codes.has(code)){
    codes.add(code);
    const existing=await db.prepare("SELECT id FROM projects WHERE code=? COLLATE NOCASE").bind(code).first<{id:number}>();
    if(!existing){
     if(!privileged&&kind==="Projekt")return forbidden();
     projectsCreated++;
    }else if(!privileged&&!scope.selfProjectIds.has(existing.id)&&!scope.projectLedIds.has(existing.id)){
     return forbidden();
    }
   }
   const effort=row.effort??0;
   if(!Number.isFinite(effort)||effort<0||effort>100)throw Error("Insats måste vara 0–100 %.");
   const hours=row.hours??hoursForSchedule({...row,effort})??0;
   if(!Number.isFinite(hours)||hours<0||hours>100000)throw Error("Ogiltiga timmar.");
   activities.push({uid:"",week:row.week.replace("-V","-W"),name:row.task,kind,
    link:text(row.projectName),projectCode:kind==="Projekt"?code:"",hours,
    status:row.status==="Flyttad"?"Planerad":row.status||"Planerad",priority:row.priority||"3",dueDate:row.deadline||"",
    comment:row.comment||"",firstWeek:(row.firstWeek||row.week).replace("-V","-W"),
    reason:row.moveReason||"",periodStart:dates.start,periodEnd:dates.end,effortPercent:effort});
  }
  const preview={employeesCreated:person?0:1,projectsCreated,activitiesCreated:activities.length};
  if(!input.commit)return Response.json({preview,committed:false});
  const payload:FormValues={name:name||person?.name||"",email,activities,members:[]};
  const forwarded=new Request(req.url,{method:"POST",headers:req.headers,body:JSON.stringify(payload)});
  const response=await importIndividual(forwarded);
  if(!response.ok){
   const message=await response.json().catch(()=>({error:"Registreringen misslyckades."})) as {error?:string};
   return Response.json({error:message.error||"Registreringen misslyckades."},{status:response.status});
  }
  return Response.json({preview,committed:true,details:await response.json()});
 }catch(e){console.error(e);return Response.json({error:e instanceof Error?e.message:"Kunde inte importera nya aktiviteter."},{status:400})}
}
