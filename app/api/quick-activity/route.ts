import {env} from "cloudflare:workers";
import {sessionIdentity,unauthorized,forbidden,sameOrigin} from "@/lib/auth";
import {proposalRecipients,type ProposalContext} from "@/lib/activity-proposals";

export const dynamic="force-dynamic";
const db=()=>{if(!env.DB)throw new Error("Databasen saknas");return env.DB};
const datePattern=/^\d{4}-\d{2}-\d{2}$/;
const goodDate=(date:string)=>{
 if(!datePattern.test(date))return false;
 const parsed=new Date(date+"T00:00:00Z");
 return !Number.isNaN(parsed.getTime())&&parsed.toISOString().slice(0,10)===date;
};
const numericId=(value:unknown)=>Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):0;
const optionalId=(value:unknown)=>value===null||value===undefined||value===""?null:numericId(value);
const clean=(v:unknown)=>String(v??"").trim();

export async function GET(req:Request){
 const d=db(),user=await sessionIdentity(req,d);
 if(!user)return unauthorized();
 const url=new URL(req.url);
 const projectId=numericId(url.searchParams.get("projectId"));
 const raw=url.searchParams.get("context")||"project";
 if(!["project","team","group"].includes(raw))return Response.json({error:"Ogiltig tillhörighet."},{status:400});
 const context=raw as ProposalContext,contextId=numericId(url.searchParams.get("contextId"));
 const result=await proposalRecipients(d,user,projectId,context,contextId);
 return Response.json(result,{headers:{"cache-control":"no-store"}});
}

export async function POST(req:Request){
 try{
  const d=db(),user=await sessionIdentity(req,d);
  if(!user)return unauthorized();
  if(!sameOrigin(req))return forbidden();
  const body=await req.json() as Record<string,unknown>;
  const self=user.employeeId;
  if(!self)return Response.json({error:"Kontot måste vara kopplat till en medarbetare för att skapa aktiviteter."},{status:403});
  const projectId=numericId(body.projectId);
  const recipientId=body.recipientId===null||body.recipientId===undefined||body.recipientId===""?self:numericId(body.recipientId);
  const rawContext=clean(body.context)||"project";
  if(!["project","team","group"].includes(rawContext))return Response.json({error:"Ogiltig tillhörighet."},{status:400});
  const context=rawContext as ProposalContext,contextId=numericId(body.contextId);
  const visibility=await proposalRecipients(d,user,projectId,context,contextId);
  if(!visibility.allowed||(!user.isAdmin&&recipientId!==self&&!visibility.eligibleRecipients.some(p=>p.id===recipientId))||
      (user.isAdmin&&recipientId!==self&&!visibility.eligibleRecipients.some(p=>p.id===recipientId)))
   return Response.json({error:"Mottagaren deltar inte i den valda projekt-/TEAM-/gruppkontexten."},{status:403});
  const workPackageId=optionalId(body.workPackageId),parentActivityId=optionalId(body.parentActivityId);
  if(workPackageId===0||parentActivityId===0)return Response.json({error:"Ogiltigt uppdrag eller huvudaktivitet."},{status:400});
  if(workPackageId&&!await d.prepare("SELECT 1 FROM work_packages WHERE id=? AND project_id=?").bind(workPackageId,projectId).first())
   return Response.json({error:"Uppdraget tillhör inte projektet."},{status:400});
  if(parentActivityId&&!await d.prepare("SELECT 1 FROM activities WHERE id=? AND project_id=?").bind(parentActivityId,projectId).first())
   return Response.json({error:"Huvudaktiviteten tillhör inte projektet."},{status:400});

  const name=clean(body.name),description=clean(body.description),code=clean(body.code);
  const startDate=clean(body.startDate),endDate=clean(body.endDate);
  const hours=body.estimatedHours===""||body.estimatedHours===null||body.estimatedHours===undefined?null:Number(body.estimatedHours);
  const priority=body.priority===undefined?3:Number(body.priority);
  const effort=body.effortPercent===undefined?(recipientId===self?0:50):Number(body.effortPercent);
  if(!projectId||name.length<1||name.length>150||!description||description.length>500||code.length>60||
     !goodDate(startDate)||!goodDate(endDate)||startDate>endDate||
     (hours!==null&&(!Number.isFinite(hours)||hours<0||hours>100000))||
     !Number.isInteger(priority)||priority<1||priority>5||
     !Number.isInteger(effort)||effort<0||effort>200)
   return Response.json({error:"Kontrollera namn, beskrivning (max 500 tecken), datum, prioritet och beläggning (0–200 %)."},{status:400});

  // D1 batch runs the statements in order, inside one SQLite transaction.
  // last_insert_rowid() connects the activity to its new assignment/request.
  const ops:D1PreparedStatement[]=[
   d.prepare(`INSERT INTO activities(project_id,work_package_id,parent_activity_id,code,name,description,start_date,end_date,estimated_hours,status,priority,created_by)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(projectId,workPackageId,parentActivityId,code||null,name,description,startDate,endDate,hours,"Planerad",priority,self)
  ];
  const isSelf=recipientId===self;
  if(isSelf){
   ops.push(d.prepare(`INSERT INTO assignments(activity_id,employee_id,effort_percent,start_date,end_date,work_status,original_end_date)
                 VALUES(last_insert_rowid(),?,?,?,?,?,?)`)
       .bind(self,effort,startDate,endDate,"Planerad",endDate));
   ops.push(d.prepare(`INSERT INTO assignment_periods(assignment_id,start_date,end_date,effort_percent)
                 VALUES(last_insert_rowid(),?,?,?)`).bind(startDate,endDate,effort));
  }else{
   ops.push(d.prepare(`INSERT INTO assignment_requests(activity_id,requested_by,recipient_id,effort_percent,start_date,end_date,comment)
                VALUES(last_insert_rowid(),?,?,?,?,?,?)`)
    .bind(self,recipientId,effort,startDate,endDate,clean(body.comment).slice(0,500)||null));
  }
  const result=await d.batch(ops);
  const activityId=Number(result[0].meta?.last_row_id);
  return Response.json({activityId,proposal:!isSelf,status:isSelf?"assigned":"pending"},{status:201});
 }catch(error){
  console.error("quick-activity",error);
  return Response.json({error:"Kunde inte skapa aktiviteten. Ingen delvis sparad aktivitet ska ha skapats."},{status:500});
 }
}
