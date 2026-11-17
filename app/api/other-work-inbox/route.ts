import {env} from "cloudflare:workers";
import {sessionIdentity,unauthorized,forbidden} from "@/lib/auth";
import {accessScope} from "@/lib/permissions";

export const dynamic="force-dynamic";
type InboxActivity={
  activityId:number;task:string;status:string;priority:number;
  startDate:string;endDate:string;employeeId:number;employeeName:string;
  assignmentEffort:number;plannedHours:number|null;sourceProjectId:number;
};

/** Read-only inbox. Reclassification is deliberately not exposed until
 * effective-dated project attribution and audit-safe migration are available.
 * Never mutate existing time entries from this endpoint.
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
  return Response.json({activities,total:activities.length,readOnly:true},
    {headers:{"cache-control":"no-store"}});
 }catch(e){
  console.error(e);
  return Response.json({error:"Kunde inte läsa Övrigt arbete."},{status:500});
 }
}
