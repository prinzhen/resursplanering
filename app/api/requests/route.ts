import {env} from "cloudflare:workers";
import {sessionIdentity,unauthorized,forbidden,sameOrigin} from "@/lib/auth";
import {accessScope,projectOfActivity} from "@/lib/permissions";
export const dynamic="force-dynamic";
const db=()=>{if(!env.DB)throw Error("Databasen saknas");return env.DB};
type RequestRow={id:number;activityId:number;requestedBy:number;recipientId:number;effortPercent:number;startDate:string;endDate:string;status:string;comment:string|null;projectId:number};
export async function GET(req:Request){
 const d=db(),user=await sessionIdentity(req,d);if(!user)return unauthorized();
 const scope=await accessScope(d,user);
 const rows=await d.prepare(`SELECT r.id,r.activity_id activityId,r.requested_by requestedBy,r.recipient_id recipientId,r.effort_percent effortPercent,
  r.start_date startDate,r.end_date endDate,r.status,r.comment,r.created_at createdAt,r.decided_at decidedAt,
  a.project_id projectId,a.name activityName,p.name projectName,p.code projectCode,src.name requestedByName,dst.name recipientName
 FROM assignment_requests r JOIN activities a ON a.id=r.activity_id JOIN projects p ON p.id=a.project_id
 JOIN employees src ON src.id=r.requested_by JOIN employees dst ON dst.id=r.recipient_id ORDER BY r.id DESC`).all<Record<string,unknown>>();
 const visibleProjectIds=[...scope.projectIds];
 const peopleInProjects=visibleProjectIds.length?await d.prepare(`SELECT DISTINCT e.id,e.name,e.email,p.id projectId
 FROM employees e JOIN project_members m ON m.employee_id=e.id JOIN projects p ON p.id=m.project_id
 WHERE p.id IN (${visibleProjectIds.map(()=>"?").join(",")})
 UNION SELECT DISTINCT e.id,e.name,e.email,p.id projectId FROM employees e
 JOIN assignments s ON s.employee_id=e.id JOIN activities a ON a.id=s.activity_id JOIN projects p ON p.id=a.project_id
 WHERE p.id IN (${visibleProjectIds.map(()=>"?").join(",")})`).bind(...visibleProjectIds,...visibleProjectIds).all<Record<string,unknown>>():{results:[]};
 return Response.json({requests:rows.results.filter(r=>user.isAdmin||
  r.requestedBy===user.employeeId||r.recipientId===user.employeeId||
  scope.managedIds.has(Number(r.recipientId))||scope.projectLedIds.has(Number((r as Record<string,unknown>).projectId))),eligibleRecipients:peopleInProjects.results},{headers:{"cache-control":"no-store"}});
}
export async function POST(req:Request){
 try{
  const d=db(),user=await sessionIdentity(req,d);
  if(!user)return unauthorized();if(!sameOrigin(req))return forbidden();
  const b=await req.json() as Record<string,unknown>,action=String(b.action||"");
  const self=user.employeeId;
  if(action==="request"){
   const activityId=Number(b.activityId),recipientId=Number(b.recipientId),percentage=Number(b.effortPercent??50),start=String(b.startDate||""),end=String(b.endDate||"");
   if(!self)return forbidden();
   if(!Number.isSafeInteger(activityId)||!Number.isSafeInteger(recipientId)||!Number.isInteger(percentage)||
      recipientId===self||percentage<0||percentage>200||!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end)||start>end)
    return Response.json({error:"Ogiltig aktivitet, resurs, beläggning eller period."},{status:400});
   const projectId=await projectOfActivity(d,activityId);
   const scope=await accessScope(d,user);
   if(!scope.projectIds.has(projectId))return forbidden();
   const target=await d.prepare("SELECT id FROM employees WHERE id=?").bind(recipientId).first();
   if(!target)return Response.json({error:"Medarbetaren saknas."},{status:404});
   // The recipient must be enrolled in the project before accepting.
   const member=await d.prepare(`SELECT 1 present FROM project_members WHERE project_id=? AND employee_id=?
     UNION SELECT 1 FROM assignments s JOIN activities a ON a.id=s.activity_id WHERE a.project_id=? AND s.employee_id=? LIMIT 1`).bind(projectId,recipientId,projectId,recipientId).first();
   if(!member)return Response.json({error:"Mottagaren måste först läggas till i projektet av gruppchef eller projektledare."},{status:400});
   if(await d.prepare("SELECT id FROM assignments WHERE activity_id=? AND employee_id=?").bind(activityId,recipientId).first())
    return Response.json({error:"Medarbetaren är redan bemannad på aktiviteten."},{status:409});
   if(await d.prepare("SELECT id FROM assignment_requests WHERE activity_id=? AND recipient_id=? AND status='pending'").bind(activityId,recipientId).first())
    return Response.json({error:"En obesvarad förfrågan finns redan."},{status:409});
   await d.prepare("INSERT INTO assignment_requests(activity_id,requested_by,recipient_id,effort_percent,start_date,end_date,comment) VALUES(?,?,?,?,?,?,?)").bind(activityId,self,recipientId,percentage,start,end,String(b.comment||"").slice(0,500)||null).run();
  }else if(action==="answer"){
   const id=Number(b.id),status=b.approve===true?"approved":"rejected";
   const request=await d.prepare(`SELECT r.id,r.activity_id activityId,r.recipient_id recipientId,r.requested_by requestedBy,
       r.effort_percent effortPercent,r.start_date startDate,r.end_date endDate,r.status,a.project_id projectId
       FROM assignment_requests r JOIN activities a ON a.id=r.activity_id WHERE r.id=?`).bind(id).first<RequestRow>();
   if(!request)return Response.json({error:"Förfrågan saknas."},{status:404});
   if(!user.isAdmin&&request.recipientId!==self)return forbidden();
   if(request.status!=="pending")return Response.json({error:"Förfrågan har redan hanterats."},{status:409});
   if(status==="approved"){
    if(await d.prepare("SELECT id FROM assignments WHERE activity_id=? AND employee_id=?").bind(request.activityId,request.recipientId).first())
     return Response.json({error:"Aktiviteten är redan tilldelad."},{status:409});
    const created=await d.prepare("INSERT INTO assignments(activity_id,employee_id,effort_percent,start_date,end_date,work_status,original_end_date) VALUES(?,?,?,?,?,?,?)").bind(request.activityId,request.recipientId,request.effortPercent,request.startDate,request.endDate,"Planerad",request.endDate).run();
    await d.batch([
     d.prepare("INSERT INTO assignment_periods(assignment_id,start_date,end_date,effort_percent) VALUES(?,?,?,?)").bind(Number(created.meta.last_row_id),request.startDate,request.endDate,request.effortPercent),
     d.prepare("UPDATE assignment_requests SET status=?,decided_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").bind(status,id)
    ]);
   }else await d.prepare("UPDATE assignment_requests SET status=?,decided_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").bind(status,id).run();
  }else if(action==="cancel"){
   const id=Number(b.id),request=await d.prepare("SELECT requested_by requester,status FROM assignment_requests WHERE id=?").bind(id).first<{requester:number;status:string}>();
   if(!request)return Response.json({error:"Förfrågan saknas"},{status:404});
   if(!user.isAdmin&&request.requester!==self)return forbidden();
   if(request.status!=="pending")return Response.json({error:"Förfrågan är redan hanterad"},{status:409});
   await d.prepare("UPDATE assignment_requests SET status='cancelled',decided_at=CURRENT_TIMESTAMP WHERE id=?").bind(id).run();
  }else return Response.json({error:"Okänd åtgärd"},{status:400});
  return GET(req);
 }catch(e){console.error(e);return Response.json({error:"Kunde inte hantera begäran."},{status:500})}
}
