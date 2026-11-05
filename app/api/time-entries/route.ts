import {env} from "cloudflare:workers";
import {sessionIdentity,unauthorized,forbidden,sameOrigin,type Identity} from "@/lib/auth";
import {availableActivityProjects} from "@/lib/activity-proposals";

export const dynamic="force-dynamic";
const db=()=>{if(!env.DB)throw Error("Databasen saknas");return env.DB};
const now=()=>Math.floor(Date.now()/1000);
const svDay=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Stockholm",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
const validDay=(v:unknown):v is string=>typeof v==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&
 !Number.isNaN(Date.parse(v+"T00:00:00Z"))&&new Date(v+"T00:00:00Z").toISOString().slice(0,10)===v;
const positiveId=(v:unknown)=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):0;
const minutes=(v:unknown)=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=1&&v<=1440?v:0;
const cleanNote=(v:unknown)=>typeof v==="string"?v.trim().slice(0,500):"";

type TimeRow={id:number;employeeId:number;activityId:number;projectId:number;employeeEmail:string|null;employeeName:string;reportingGroupId:number|null;reportingGroupName:string|null;projectCode:string;
 activityCode:string|null;activityName:string;workDate:string;startedAt:number;endedAt:number|null;
 durationSeconds:number|null;note:string;source:string;updatedAt:number;deletedAt:number|null};
const details=`SELECT t.id,t.employee_id employeeId,t.activity_id activityId,
 a.project_id projectId,CASE WHEN e.is_group_ledger=1 THEN NULL ELSE e.email END employeeEmail,
 CASE WHEN e.is_group_ledger=1 THEN 'Borttagen medarbetare' ELSE e.name END employeeName,
 t.reporting_group_id reportingGroupId,t.reporting_group_name reportingGroupName,p.code projectCode,a.code activityCode,a.name activityName,
 t.work_date workDate,t.started_at startedAt,t.ended_at endedAt,
 t.duration_seconds durationSeconds,t.note,t.source,t.updated_at updatedAt,t.deleted_at deletedAt
 FROM time_entries t JOIN employees e ON e.id=t.employee_id
 JOIN activities a ON a.id=t.activity_id JOIN projects p ON p.id=a.project_id`;
const bad=(message:string,status=400)=>Response.json({error:message},{status});
async function allowedActivity(d:D1Database,user:Identity,activityId:number){
 const a=await d.prepare("SELECT id,project_id projectId FROM activities WHERE id=?").bind(activityId).first<{id:number;projectId:number}>();
 if(!a)return null;
 const projects=await availableActivityProjects(d,user);
 return projects.some(p=>p.id===a.projectId)?a:null;
}
async function selfUser(req:Request){
 const d=db(),user=await sessionIdentity(req,d);
 return {d,user};
}
function csvCell(v:unknown){
 const raw=String(v??"");
 // Prevent spreadsheet formula execution when exporting user-provided labels.
 const escaped=/^[\s\r\n]*[=+\-@]/.test(raw)?"'"+raw:raw;
 return '"'+escaped.replaceAll('"','""')+'"';
}
function renderCsv(rows:TimeRow[]){
 const columns=["entry_id","source_system","employee_email","group_name","attribution","project_code","activity_code","activity_name","work_date",
  "duration_minutes","duration_hours","note","updated_at_utc","status"];
 const lines=[columns.map(csvCell).join(";")];
 for(const e of rows){
  if(e.endedAt===null)continue; // Active clocks are not billable time.
  const secs=e.durationSeconds??0;
  lines.push([e.id,"planering",e.employeeEmail??"",e.reportingGroupName??"",e.reportingGroupId!==null?"group":"employee",e.projectCode,e.activityCode||"",e.activityName,e.workDate,
   Math.round(secs/60),(secs/3600).toFixed(4).replace(".",","),e.note,new Date(e.updatedAt*1000).toISOString(),
   e.deletedAt===null?"active":"deleted"].map(csvCell).join(";"));
 }
 return "\uFEFF"+lines.join("\r\n")+"\r\n";
}
export async function GET(req:Request){
 try{
  const {d,user}=await selfUser(req);
  if(!user)return unauthorized();
  const u=new URL(req.url),scope=u.searchParams.get("scope")||"mine",
   all=scope==="all"&&user.isAdmin,historical=scope==="history",
   format=u.searchParams.get("format")||"json";
  if(!user.employeeId&&!all&&!historical)return bad("Kontot är inte kopplat till en medarbetare.",403);
  if(!["json","csv"].includes(format))return bad("Ogiltigt exportformat.");
  const from=u.searchParams.get("from"),to=u.searchParams.get("to");
  if(from&&!validDay(from)||to&&!validDay(to)||from&&to&&from>to)return bad("Ogiltigt datumintervall.");
  const filters:string[]=[],params:Array<string|number>=[];
  if(historical){
   filters.push("t.reporting_group_id IS NOT NULL");
   if(!user.isAdmin){
    filters.push(`((?=1 AND EXISTS(SELECT 1 FROM employee_groups g WHERE g.id=t.reporting_group_id AND g.owner_id=?))
      OR EXISTS(SELECT 1 FROM project_leaders l WHERE l.project_id=a.project_id AND l.employee_id=?))`);
    params.push(user.isGroupManager?1:0,user.employeeId??0,user.employeeId??0);
   }
  }else if(!all){
   filters.push("t.employee_id=? AND t.reporting_group_id IS NULL");
   params.push(user.employeeId??0);
  }else filters.push("1=1");
  filters.push(format==="csv"?"t.ended_at IS NOT NULL":"t.deleted_at IS NULL");
  if(from){filters.push("t.work_date>=?");params.push(from)}
  if(to){filters.push("t.work_date<=?");params.push(to)}
  const offsetRaw=u.searchParams.get("offset")||"0",offset=Number(offsetRaw);
  if(!Number.isSafeInteger(offset)||offset<0||offset>10000000)return bad("Ogiltig sidstart.");
  const pageSize=250,limit=format==="csv"?20001:pageSize+1;
  const entries=await d.prepare(details+" WHERE "+filters.join(" AND ")+" ORDER BY t.work_date DESC,t.started_at DESC,t.id DESC LIMIT ? OFFSET ?")
   .bind(...params,limit,format==="csv"?0:offset).all<TimeRow>();
  const aggregate=await d.prepare(`SELECT COUNT(*) entryCount,
    COALESCE(SUM(CASE WHEN t.ended_at IS NOT NULL AND t.deleted_at IS NULL THEN t.duration_seconds ELSE 0 END),0) totalSeconds
    FROM time_entries t JOIN activities a ON a.id=t.activity_id
    WHERE ${filters.join(" AND ")}`).bind(...params).first<{entryCount:number;totalSeconds:number}>();
  if(format==="csv"&&entries.results.length>20000)return bad("Exporten innehåller över 20 000 tidposter. Filtrera på datumintervall och exportera i delar.",413);
  if(format==="csv")return new Response(renderCsv(entries.results),{
   headers:{"content-type":"text/csv; charset=utf-8","content-disposition":'attachment; filename="planering-tidrapport.csv"',
    "cache-control":"no-store","x-content-type-options":"nosniff"}});
  const projects=await availableActivityProjects(d,user);
  const visibleIds=projects.map(p=>p.id);
  const acts=visibleIds.length?await d.prepare("SELECT id,project_id projectId,code,name,status FROM activities WHERE project_id IN ("+
   visibleIds.map(()=>"?").join(",")+") ORDER BY project_id,name LIMIT 3000").bind(...visibleIds)
   .all<{id:number;projectId:number;code:string|null;name:string;status:string}>():{results:[]};
  const groupOwner=user.employeeId&&user.isGroupManager?await d.prepare("SELECT id FROM employee_groups WHERE owner_id=? LIMIT 1").bind(user.employeeId).first():null;
  const projectLead=user.employeeId?await d.prepare("SELECT project_id FROM project_leaders WHERE employee_id=? LIMIT 1").bind(user.employeeId).first():null;
  return Response.json({viewer:{employeeId:user.employeeId,isAdmin:user.isAdmin,canViewGroupHistory:user.isAdmin||!!groupOwner||!!projectLead},
   entries:entries.results.slice(0,pageSize),projects,activities:acts.results,serverTime:now(),
   today:svDay(),hasMore:entries.results.length>pageSize,offset,
   entryCount:aggregate?.entryCount??0,totalSeconds:aggregate?.totalSeconds??0},{headers:{"cache-control":"no-store"}});
 }catch(error){console.error("time-entries GET",error);return bad("Kunde inte läsa tidrapporter.",500)}
}
export async function POST(req:Request){
 try{
  const {d,user}=await selfUser(req);
  if(!user)return unauthorized();
  if(!sameOrigin(req))return forbidden();
  const body=await req.json() as Record<string,unknown>;
  const action=String(body.action||"");
  const timestamp=now(),employeeId=user.employeeId;
  if(action==="adminUpdate"){
   if(!user.isAdmin)return forbidden();
   const entryId=positiveId(body.id),duration=minutes(body.durationMinutes),workDate=body.workDate;
   if(!entryId||!duration||!validDay(workDate))return bad("Ange giltigt ID, datum och 1–1440 minuter.");
   const old=await d.prepare("SELECT id,employee_id employeeId,activity_id activityId,duration_seconds durationSeconds FROM time_entries WHERE id=? AND ended_at IS NOT NULL AND deleted_at IS NULL")
    .bind(entryId).first<{id:number;employeeId:number;activityId:number;durationSeconds:number}>();
   if(!old)return bad("Tidposten finns inte, är borttagen eller pågår.",404);
   const destination=body.activityId===undefined?old.activityId:positiveId(body.activityId);
   if(!destination||!await d.prepare("SELECT id FROM activities WHERE id=?").bind(destination).first())
    return bad("Mottagande aktivitet finns inte.",404);
   const q:D1PreparedStatement[]=[];
   if(destination!==old.activityId){
    q.push(d.prepare(`INSERT INTO time_entry_relocations(
     entry_id,employee_id,original_project_id,original_project_code,original_project_name,
     original_activity_id,original_activity_code,original_activity_name,
     target_project_id,target_project_code,target_project_name,target_activity_id,
     target_activity_code,target_activity_name,work_date,duration_seconds,actor_account_id,occurred_at,reason)
     SELECT t.id,t.employee_id,p.id,p.code,p.name,a.id,a.code,a.name,
      targetP.id,targetP.code,targetP.name,target.id,target.code,target.name,
      t.work_date,t.duration_seconds,?,?,?
     FROM time_entries t JOIN activities a ON a.id=t.activity_id
     JOIN projects p ON p.id=a.project_id
     CROSS JOIN activities target JOIN projects targetP ON targetP.id=target.project_id
     WHERE t.id=? AND target.id=?`).bind(user.accountId,timestamp,"Administrativ ombokning av rapporterad tid",entryId,destination));
   }
   q.push(d.prepare(`UPDATE time_entries SET activity_id=?,duration_seconds=?,work_date=?,note=?,source='adjusted',
       ended_at=started_at+?,updated_at=? WHERE id=? AND ended_at IS NOT NULL AND deleted_at IS NULL`)
     .bind(destination,duration*60,workDate,cleanNote(body.note),duration*60,timestamp,entryId));
   q.push(d.prepare("INSERT INTO time_entry_audit(time_entry_id,actor_account_id,action,old_seconds,new_seconds) VALUES(?,?,'update',?,?)")
    .bind(entryId,user.accountId,old.durationSeconds,duration*60));
   await d.batch(q);
   return Response.json({ok:true},{headers:{"cache-control":"no-store"}});
  }
  if(action==="adminDelete"){
   if(!user.isAdmin)return forbidden();
   const entryId=positiveId(body.id);
   if(!entryId)return bad("Ogiltigt tidposts-ID.");
   const old=await d.prepare("SELECT id,duration_seconds durationSeconds FROM time_entries WHERE id=? AND ended_at IS NOT NULL AND deleted_at IS NULL")
    .bind(entryId).first<{id:number;durationSeconds:number}>();
   if(!old)return bad("Tidposten saknas, har redan tagits bort eller pågår.",404);
   await d.batch([
    d.prepare("UPDATE time_entries SET deleted_at=?,updated_at=? WHERE id=? AND ended_at IS NOT NULL AND deleted_at IS NULL").bind(timestamp,timestamp,entryId),
    d.prepare("INSERT INTO time_entry_audit(time_entry_id,actor_account_id,action,old_seconds,new_seconds) VALUES(?,?,'delete',?,NULL)")
     .bind(entryId,user.accountId,old.durationSeconds)
   ]);
   return Response.json({ok:true},{headers:{"cache-control":"no-store"}});
  }
  if(!employeeId)return bad("Kontot måste vara kopplat till en medarbetare för att kunna tidrapportera.",403);
  if(action==="start"){
   const activityId=positiveId(body.activityId);
   if(!activityId||!await allowedActivity(d,user,activityId))return bad("Du saknar tillgång till aktiviteten.",403);
   const current=await d.prepare("SELECT id,activity_id activityId FROM time_entries WHERE employee_id=? AND ended_at IS NULL")
    .bind(employeeId).first<{id:number;activityId:number}>();
   if(current)return bad("Du har redan en pågående tidtagning. Stoppa den innan du startar en ny.",409);
   await d.batch([
    d.prepare("INSERT INTO time_entries(employee_id,activity_id,work_date,started_at,source) VALUES(?,?,?,?,?)")
     .bind(employeeId,activityId,svDay(),timestamp,"timer"),
    d.prepare("INSERT INTO time_entry_audit(time_entry_id,actor_account_id,action,old_seconds,new_seconds) VALUES(last_insert_rowid(),?,'start',NULL,NULL)")
     .bind(user.accountId)
   ]);
  }else if(action==="stop"){
   const entryId=positiveId(body.id);
   const record=await d.prepare("SELECT id,started_at startedAt FROM time_entries WHERE id=? AND employee_id=? AND ended_at IS NULL")
    .bind(entryId,employeeId).first<{id:number;startedAt:number}>();
   if(!record)return bad("Tidtagningen finns inte, har redan stoppats eller tillhör en annan medarbetare.",409);
   const duration=Math.max(1,timestamp-record.startedAt);
   const changed=await d.prepare("UPDATE time_entries SET ended_at=?,duration_seconds=?,updated_at=? WHERE id=? AND employee_id=? AND ended_at IS NULL")
    .bind(timestamp,duration,timestamp,entryId,employeeId).run();
   if(!changed.meta.changes)return bad("Tidtagningen har redan stoppats.",409);
   await d.prepare("INSERT INTO time_entry_audit(time_entry_id,actor_account_id,action,old_seconds,new_seconds) VALUES(?,?,'stop',NULL,?)")
    .bind(entryId,user.accountId,duration).run();
  }else if(action==="manual"){
   const activityId=positiveId(body.activityId),duration=minutes(body.durationMinutes),workDate=body.workDate;
   if(!duration||!validDay(workDate))return bad("Ange ett giltigt datum och 1–1440 minuter.");
   if(!activityId||!await allowedActivity(d,user,activityId))return bad("Du saknar tillgång till aktiviteten.",403);
   const start=Math.floor(Date.parse(workDate+"T12:00:00Z")/1000);
   await d.batch([
    d.prepare("INSERT INTO time_entries(employee_id,activity_id,work_date,started_at,ended_at,duration_seconds,note,source) VALUES(?,?,?,?,?,?,?,?)")
     .bind(employeeId,activityId,workDate,start,start+duration*60,duration*60,cleanNote(body.note),"manual"),
    d.prepare("INSERT INTO time_entry_audit(time_entry_id,actor_account_id,action,old_seconds,new_seconds) VALUES(last_insert_rowid(),?,'manual',NULL,?)")
     .bind(user.accountId,duration*60)
   ]);
  }else if(action==="update"||action==="delete"){
   const entryId=positiveId(body.id);
   const old=await d.prepare("SELECT id,duration_seconds durationSeconds FROM time_entries WHERE id=? AND employee_id=? AND ended_at IS NOT NULL AND deleted_at IS NULL")
    .bind(entryId,employeeId).first<{id:number;durationSeconds:number}>();
   if(!old)return bad("Tidposten finns inte, pågår eller tillhör en annan medarbetare.",404);
   if(action==="delete"){
    await d.batch([
     d.prepare("UPDATE time_entries SET deleted_at=?,updated_at=? WHERE id=? AND employee_id=? AND deleted_at IS NULL").bind(timestamp,timestamp,entryId,employeeId),
     d.prepare("INSERT INTO time_entry_audit(time_entry_id,actor_account_id,action,old_seconds,new_seconds) VALUES(?,?,'delete',?,NULL)")
      .bind(entryId,user.accountId,old.durationSeconds)
    ]);
   }else{
    const duration=minutes(body.durationMinutes),workDate=body.workDate;
    if(!duration||!validDay(workDate))return bad("Ange ett giltigt datum och 1–1440 minuter.");
    await d.batch([
     d.prepare("UPDATE time_entries SET duration_seconds=?,work_date=?,note=?,source='adjusted',ended_at=started_at+?,updated_at=? WHERE id=? AND employee_id=? AND deleted_at IS NULL")
      .bind(duration*60,workDate,cleanNote(body.note),duration*60,timestamp,entryId,employeeId),
    d.prepare("INSERT INTO time_entry_audit(time_entry_id,actor_account_id,action,old_seconds,new_seconds) VALUES(?,?,'update',?,?)")
      .bind(entryId,user.accountId,old.durationSeconds,duration*60)
    ]);
   }
  }else return bad("Okänd tidrapportåtgärd.");
  return Response.json({ok:true},{headers:{"cache-control":"no-store"}});
 }catch(error){
  console.error("time-entries POST",error);
  if(String(error).includes("UNIQUE constraint failed"))return bad("En annan tidtagning är redan aktiv. Uppdatera sidan.",409);
  return bad("Tidrapporteringen kunde inte sparas.",500);
 }
}
