import {env} from "cloudflare:workers";
import {sessionIdentity,unauthorized,forbidden,sameOrigin} from "@/lib/auth";
import {accessScope} from "@/lib/permissions";
import {importDateSweden} from "@/lib/individual-priority";

export const dynamic="force-dynamic";
type InboxActivity={
  activityId:number;task:string;status:string;priority:number;
  startDate:string;endDate:string;employeeId:number;employeeName:string;
  assignmentEffort:number;plannedHours:number|null;sourceProjectId:number;
};

/** Inbox plus strictly guarded future-only project classification.
 * Past plan and recorded time must never be silently re-attributed.
 */
export async function GET(req:Request){
 try{
  const d=env.DB;if(!d)throw Error("Databasen saknas");
  const identity=await sessionIdentity(req,d);
  if(!identity)return unauthorized();
  const scope=await accessScope(d,identity);
  if(!identity.isAdmin&&!identity.isGroupManager)return forbidden();

  const result=await d.prepare(`SELECT a.id activityId,a.name task,a.status,a.priority,
    a.start_date startDate,a.end_date endDate,
    e.id employeeId,e.name employeeName,s.effort_percent assignmentEffort,
    (SELECT SUM(w.planned_hours) FROM weekly_plan_rows w
      WHERE w.activity_id=a.id AND w.employee_id=e.id) plannedHours,
    p.id sourceProjectId
    FROM projects p JOIN activities a ON a.project_id=p.id
      JOIN assignments s ON s.activity_id=a.id
      JOIN employees e ON e.id=s.employee_id
    WHERE p.code='INTERNAL-OVR'
    ORDER BY CASE WHEN a.status IN ('Klar','Fryst') THEN 1 ELSE 0 END,
      a.start_date,a.id,e.name LIMIT 5000`).all<InboxActivity>();
  const activities=result.results.filter(x=>
    scope.projectIds.has(x.sourceProjectId)&&scope.employeeIds.has(x.employeeId));
  const projects=await d.prepare("SELECT id,code,name,status FROM projects WHERE code NOT LIKE 'INTERNAL-%' ORDER BY code").all<{id:number;code:string;name:string;status:string}>();
  return Response.json({activities,total:activities.length,readOnly:false,projects:projects.results.filter(p=>scope.projectIds.has(p.id)&&p.status!=="Avslutat")},
    {headers:{"cache-control":"no-store"}});
 }catch(e){
  console.error(e);
  return Response.json({error:"Kunde inte läsa Övrigt arbete."},{status:500});
 }
}

/** A true project move is safe without splitting historical allocations only
 * when the activity has never started and no time entry has ever been booked.
 * Everything else is rejected rather than rewriting past workload or hours.
 */
export async function POST(req:Request){
 try{
  const d=env.DB;if(!d)throw Error("Databasen saknas");
  const identity=await sessionIdentity(req,d);if(!identity)return unauthorized();
  if(!sameOrigin(req))return forbidden();
  if(!identity.isAdmin&&!identity.isGroupManager)return forbidden();
  const body=await req.json() as {activityId?:unknown;targetProjectId?:unknown;effectiveFrom?:unknown;note?:unknown};
  const activityId=Number(body.activityId),targetProjectId=Number(body.targetProjectId);
  if(!Number.isSafeInteger(activityId)||activityId<1||!Number.isSafeInteger(targetProjectId)||targetProjectId<1)
   return Response.json({error:"Välj en giltig aktivitet och ett projekt."},{status:400});
  const today=importDateSweden();
  const effectiveFrom=body.effectiveFrom===undefined?today:String(body.effectiveFrom);
  if(effectiveFrom!==today)
   return Response.json({error:"Den här säkra snabbflytten gäller från dagens datum. Historiska eller framtida projektbyten kräver periodindelad hantering."},{status:400});
  const note=String(body.note??"").trim().slice(0,500);
  const a=await d.prepare(`SELECT a.id,a.name,a.start_date startDate,a.end_date endDate,a.project_id sourceProjectId,
    a.parent_activity_id parentId,a.work_package_id workPackageId,p.code sourceCode
    FROM activities a JOIN projects p ON p.id=a.project_id WHERE a.id=?`).bind(activityId)
   .first<{id:number;name:string;startDate:string;endDate:string;sourceProjectId:number;parentId:number|null;workPackageId:number|null;sourceCode:string}>();
  if(!a||a.sourceCode!=="INTERNAL-OVR")
   return Response.json({error:"Aktiviteten finns inte längre i Övrigt arbete. Uppdatera inkorgen."},{status:409});
  const target=await d.prepare("SELECT id,code,name,status FROM projects WHERE id=?").bind(targetProjectId)
   .first<{id:number;code:string;name:string;status:string}>();
  if(!target||target.code.startsWith("INTERNAL-")||target.status==="Avslutat")
   return Response.json({error:"Välj ett öppet, vanligt projekt."},{status:400});
  const scope=await accessScope(d,identity);
  if(!scope.projectIds.has(a.sourceProjectId)||!scope.projectIds.has(target.id))return forbidden();
  const resources=await d.prepare("SELECT employee_id employeeId,start_date startDate,completed_at completedAt FROM assignments WHERE activity_id=?")
   .bind(activityId).all<{employeeId:number;startDate:string;completedAt:string|null}>();
  if(!identity.isAdmin&&(!scope.selfProjectIds.has(target.id)||
    resources.results.some(r=>!scope.managedIds.has(r.employeeId)&&r.employeeId!==identity.employeeId)))
   return forbidden();
  const historical=await d.prepare(`SELECT
    (SELECT COUNT(*) FROM time_entries WHERE activity_id=?) recorded,
    (SELECT COUNT(*) FROM assignment_periods p JOIN assignments s ON s.id=p.assignment_id
       WHERE s.activity_id=? AND p.start_date<?) historicPeriods,
    (SELECT COUNT(*) FROM weekly_plan_rows WHERE activity_id=? AND first_planned_week<?) olderWeekRows,
    (SELECT COUNT(*) FROM activities WHERE parent_activity_id=?) children,
    (SELECT COUNT(*) FROM assignment_requests WHERE activity_id=? AND status='pending') requests`)
   .bind(activityId,activityId,effectiveFrom,activityId,effectiveFrom.slice(0,4)+"-W"+isoWeekNumber(effectiveFrom),activityId,activityId)
   .first<{recorded:number;historicPeriods:number;olderWeekRows:number;children:number;requests:number}>();
  if(a.startDate<effectiveFrom||a.parentId!==null||a.workPackageId!==null||
    resources.results.some(r=>r.startDate<effectiveFrom||r.completedAt!==null)||
    (historical?.recorded||0)>0||(historical?.historicPeriods||0)>0||(historical?.olderWeekRows||0)>0||
    (historical?.children||0)>0||(historical?.requests||0)>0)
   return Response.json({error:"Aktiviteten har historik, rapporterad tid, äldre planering eller beroenden. Säker snabbflytt avbryts för att skydda historiken. Den behöver historikdelas i ett separat arbetsflöde."},{status:422});
  // One SQLite transaction: either the activity, membership and audit all move,
  // or none do. Never update historical time entries or assignment periods.
  const statements:D1PreparedStatement[]=[
   d.prepare("UPDATE activities SET project_id=? WHERE id=? AND project_id=?")
    .bind(target.id,activityId,a.sourceProjectId),
   ...resources.results.map(x=>d.prepare("INSERT OR IGNORE INTO project_members(project_id,employee_id) VALUES(?,?)")
    .bind(target.id,x.employeeId)),
   d.prepare(`INSERT INTO activity_project_reclassifications(activity_id,source_project_id,target_project_id,effective_from,changed_by_account_id,note)
    SELECT id,?,?,?, ?,? FROM activities WHERE id=? AND project_id=?`)
    .bind(a.sourceProjectId,target.id,effectiveFrom,identity.accountId,note,activityId,target.id)
  ];
  await d.batch(statements);
  return Response.json({ok:true,activityId,from:"INTERNAL-OVR",projectCode:target.code,projectName:target.name,effectiveFrom});
 }catch(e){
  console.error(e);
  return Response.json({error:"Kunde inte klassificera aktiviteten. Kontrollera migration och databaslogg."},{status:500});
 }
}
function isoWeekNumber(date:string){
 const d=new Date(date+"T00:00:00Z");d.setUTCDate(d.getUTCDate()+4-(d.getUTCDay()||7));
 const year=d.getUTCFullYear(),start=new Date(Date.UTC(year,0,1));
 return String(Math.ceil(((d.getTime()-start.getTime())/86400000+1)/7)).padStart(2,"0");
}
