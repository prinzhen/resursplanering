import {env} from "cloudflare:workers";
import {sessionIdentity,unauthorized,forbidden,sameOrigin} from "@/lib/auth";
import {accessScope,authorizePlanningAction} from "@/lib/permissions";
import {normalizeISOWeek,parseDurationDays,WEEK_DAYS,type WeeklyV2Row} from "@/lib/weekly-xlsx-v2";
export const dynamic="force-dynamic";
const db=()=>{if(!env.DB)throw Error("Databasen saknas");return env.DB};
type Plan={rowKey:string;employeeId:number;activityId:number;week:string;weekday:number|null;durationDays:number;effort:number|null;hours:number|null;workType:string;status:string;priority:number|null;deadline:string|null;firstWeek:string;comment:string;moveReason:string;revision:number};
const fields=["week","weekday","durationDays","effort","hours","workType","status","priority","deadline","firstWeek","comment","moveReason"] as const;
const select="SELECT row_key rowKey,employee_id employeeId,activity_id activityId,iso_week week,weekday,duration_days durationDays,effort_percent effort,planned_hours hours,work_type workType,status,priority,deadline,first_planned_week firstWeek,comment,move_reason moveReason,revision FROM weekly_plan_rows";
const safeDate=(x:string)=>!x||(/^\d{4}-\d{2}-\d{2}$/.test(x)&&!Number.isNaN(Date.parse(x+"T00:00:00Z"))&&new Date(x+"T00:00:00Z").toISOString().slice(0,10)===x);
function parse(row:WeeklyV2Row,employeeId:number,activityId:number):Plan{
 if(!/^[A-Za-z0-9_.:-]{5,180}$/.test(row.rowKey||""))throw Error("Radnyckel saknas i dold kolumn Q. Exportera ny XLSX.");
 const weekday=row.day?WEEK_DAYS.findIndex(x=>x.toLowerCase()===row.day.trim().toLowerCase()):null;
 if(weekday!==null&&weekday<1)throw Error("Ogiltig veckodag");
 const effort=row.effort,hours=row.hours,priority=row.priority.trim()?Number(row.priority):null;
 if(effort!==null&&(!Number.isFinite(effort)||effort<0||effort>100))throw Error("Insats måste vara 0–100 %");
 if(hours!==null&&(!Number.isFinite(hours)||hours<0||hours>100000))throw Error("Planerade timmar är ogiltiga");
 if(priority!==null&&(!Number.isInteger(priority)||priority<1||priority>5))throw Error("Prioritet ska vara 1–5");
 if(!safeDate(row.deadline))throw Error("Ogiltigt datum i Klart senast");
 const revision=Number(row.rowRevision??0);
 if(!Number.isInteger(revision)||revision<0)throw Error("Ogiltig revision");
 return {rowKey:row.rowKey!,employeeId,activityId,week:normalizeISOWeek(row.week),weekday,
  durationDays:parseDurationDays(row.duration),effort,hours,workType:row.workType.trim().slice(0,100),
  status:row.status.trim().slice(0,40)||"Planerad",priority,deadline:row.deadline||null,
  firstWeek:normalizeISOWeek(row.firstWeek||row.week),comment:row.comment.slice(0,500),
  moveReason:row.moveReason.slice(0,500),revision};
}
export async function GET(req:Request){
 try{
  const d=db(),user=await sessionIdentity(req,d);if(!user)return unauthorized();
  const employeeId=Number(new URL(req.url).searchParams.get("employeeId"));
  if(!Number.isSafeInteger(employeeId)||employeeId<1)return Response.json({error:"Medarbetare saknas"},{status:400});
  const scope=await accessScope(d,user);if(!scope.employeeIds.has(employeeId))return forbidden();
  const result=await d.prepare("SELECT w.row_key rowKey,w.employee_id employeeId,w.activity_id activityId,w.iso_week week,w.weekday,w.duration_days durationDays,w.effort_percent effort,w.planned_hours hours,w.work_type workType,w.status,w.priority,w.deadline,w.first_planned_week firstWeek,w.comment,w.move_reason moveReason,w.revision,a.project_id projectId,a.name task,p.code projectCode,p.name projectName FROM weekly_plan_rows w JOIN activities a ON a.id=w.activity_id JOIN projects p ON p.id=a.project_id WHERE w.employee_id=? ORDER BY w.iso_week,w.weekday,w.id LIMIT 5000").bind(employeeId).all<Record<string,unknown>>();
  return Response.json({rows:result.results.filter(r=>scope.projectIds.has(Number(r.projectId)))},{headers:{"cache-control":"no-store"}});
 }catch(e){console.error(e);return Response.json({error:"Kunde inte läsa veckoplanering"},{status:500})}
}
export async function POST(req:Request){
 try{
  const d=db(),user=await sessionIdentity(req,d);if(!user)return unauthorized();if(!sameOrigin(req))return forbidden();
  const body=await req.json() as {employeeId:number;rows:WeeklyV2Row[];commit?:boolean};
  const employeeId=Number(body?.employeeId);
  if(!Number.isSafeInteger(employeeId)||employeeId<1||!Array.isArray(body.rows)||body.rows.length>500)
   return Response.json({error:"Ogiltig import (max 500 rader)"},{status:400});
  const scope=await accessScope(d,user);if(!scope.employeeIds.has(employeeId))return forbidden();
  const seen=new Set<string>(),changes:{value:Plan;before:Plan|null;action:"new"|"update"|"unchanged"}[]=[];
  for(const row of body.rows){
   if(seen.has(row.rowKey||""))throw Error("Dubbel planeringsrad i filen");
   seen.add(row.rowKey||"");
   const match=/^(?:activity-(\d+)|employee-(\d+)-activity-(\d+))$/.exec(row.activityId);
   if(!match||match[2]&&Number(match[2])!==employeeId)throw Error("Ogiltigt eller felkopplat aktivitets-ID: "+row.activityId);
   const activityId=Number(match[1]||match[3]);
   const a=await d.prepare("SELECT a.name,a.project_id projectId,p.code projectCode FROM assignments s JOIN activities a ON a.id=s.activity_id JOIN projects p ON p.id=a.project_id WHERE s.employee_id=? AND a.id=?").bind(employeeId,activityId).first<{name:string;projectId:number;projectCode:string}>();
   if(!a||!scope.projectIds.has(a.projectId))return forbidden();
   if(a.name.trim()!==row.task.trim()||a.projectCode.toUpperCase()!==row.projectCode.trim().toUpperCase())throw Error("Aktivitet/projektkod matchar inte aktivitets-ID");
   if(!await authorizePlanningAction(d,user,"setAssignmentPeriods",{employeeId,activityId}))return forbidden();
   const value=parse(row,employeeId,activityId);
   const before=await d.prepare(select+" WHERE row_key=?").bind(value.rowKey).first<Plan>();
   if(before&&(before.employeeId!==employeeId||before.activityId!==activityId))throw Error("Radnyckeln hör till annan aktivitet");
   if(before&&before.revision!==value.revision)throw Error("Konflikt: planeringsraden har ändrats sedan exporten. Exportera på nytt.");
   const action=before?(fields.every(k=>(before[k]??null)===(value[k]??null))?"unchanged":"update"):"new";
   changes.push({value,before,action});
  }
  const preview={created:changes.filter(x=>x.action==="new").length,updated:changes.filter(x=>x.action==="update").length,unchanged:changes.filter(x=>x.action==="unchanged").length};
  if(!body.commit)return Response.json({preview,committed:false});
  const q:D1PreparedStatement[]=[];
  for(const {value:x,before,action} of changes){
   if(action==="unchanged")continue;
   const revision=before?before.revision+1:1;
   if(before){
    q.push(d.prepare("UPDATE weekly_plan_rows SET iso_week=?,weekday=?,duration_days=?,effort_percent=?,planned_hours=?,work_type=?,status=?,priority=?,deadline=?,first_planned_week=?,comment=?,move_reason=?,revision=?,updated_at=CURRENT_TIMESTAMP WHERE row_key=? AND revision=?")
    .bind(x.week,x.weekday,x.durationDays,x.effort,x.hours,x.workType,x.status,x.priority,x.deadline,x.firstWeek,x.comment,x.moveReason,revision,x.rowKey,before.revision));
   }else{
    q.push(d.prepare("INSERT INTO weekly_plan_rows(row_key,employee_id,activity_id,iso_week,weekday,duration_days,effort_percent,planned_hours,work_type,status,priority,deadline,first_planned_week,comment,move_reason,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)")
    .bind(x.rowKey,x.employeeId,x.activityId,x.week,x.weekday,x.durationDays,x.effort,x.hours,x.workType,x.status,x.priority,x.deadline,x.firstWeek,x.comment,x.moveReason));
   }
   q.push(d.prepare("INSERT INTO weekly_plan_row_history(row_key,revision,action,before_json,after_json,changed_by_account_id) VALUES(?,?,?,?,?,?)")
    .bind(x.rowKey,revision,action,before?JSON.stringify(before):null,JSON.stringify({...x,revision}),user.accountId));
  }
  if(q.length)await d.batch(q);
  return Response.json({preview,committed:true});
 }catch(e){console.error(e);return Response.json({error:e instanceof Error?e.message:"Importen misslyckades"},{status:400})}
}
