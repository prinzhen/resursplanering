import {setAssignmentStatus,setWholeActivityStatus,reconcileActivityStatus,normalizeStatus,validStatuses} from "@/lib/assignment-status";
import { env } from "cloudflare:workers";
import {sessionIdentity,unauthorized,forbidden,sameOrigin,type Identity} from "@/lib/auth";
import {accessScope,authorizePlanningAction,filteredSnapshot,projectOfActivity} from "@/lib/permissions";
export const dynamic="force-dynamic";
type Row=Record<string,unknown>;
type Backup={version:number;data:{employees:Row[];projects:Row[];workPackages:Row[];activities:Row[];assignments:Row[];projectMembers?:Row[];assignmentPeriods?:Row[];individualFormItems?:Row[];individualWeekMoves?:Row[];individualProjectStates?:Row[];individualImportRuns?:Row[];employeeProjectOrders?:Row[];employeeGroups?:Row[];employeeGroupMembers?:Row[];projectLeaders?:Row[];teamLeaders?:Row[];assignmentRequests?:Row[]}};
const db=()=>{if(!env.DB)throw new Error("Databasen är inte tillgänglig");return env.DB};
const text=(v:unknown)=>String(v??"").trim();
const number=(v:unknown)=>v===""||v==null?null:Number(v);
const priority=(v:unknown)=>{const n=Number(v??3);if(!Number.isInteger(n)||n<1||n>5)throw Error("Prioritet ska vara 1–5 (1 är högst).");return n};
const requiredActivityDescription=(v:unknown)=>{const value=text(v);if(!value)throw new Error("Aktiviteten måste ha en beskrivning.");if(value.length>500)throw new Error("Aktivitetsbeskrivningen får vara högst 500 tecken.");return value};

async function seedIfEmpty(d:D1Database){const c=await d.prepare("SELECT COUNT(*) count FROM employees").first<{count:number}>();if((c?.count??0)>0)return;await d.batch([
  d.prepare("INSERT INTO employees (name,email,role,manager_id,capacity_percent) VALUES (?,?,?,?,?)").bind("Anna Lind","anna@example.se","Gruppchef",null,100),d.prepare("INSERT INTO employees (name,email,role,manager_id,capacity_percent) VALUES (?,?,?,?,?)").bind("Erik Holm","erik@example.se","Projektledare",1,100),d.prepare("INSERT INTO employees (name,email,role,manager_id,capacity_percent) VALUES (?,?,?,?,?)").bind("Sara Berg","sara@example.se","Systemingenjör",1,100),d.prepare("INSERT INTO employees (name,email,role,manager_id,capacity_percent) VALUES (?,?,?,?,?)").bind("Johan Nyström","johan@example.se","Tekniker",1,80),
  d.prepare("INSERT INTO projects (code,name,color) VALUES (?,?,?)").bind("P-1042","Modernisering styrsystem","#2563eb"),d.prepare("INSERT INTO projects (code,name,color) VALUES (?,?,?)").bind("P-1087","Nätverkssegmentering","#0f766e"),d.prepare("INSERT INTO projects (code,name,color) VALUES (?,?,?)").bind("P-1110","Underhållsrevision","#ca8a04"),
  d.prepare("INSERT INTO activities (project_id,name,start_date,end_date,estimated_hours,status,code) VALUES (?,?,?,?,?,?,?)").bind(1,"Systemdesign","2026-09-01","2026-12-18",420,"Pågår","A-10"),d.prepare("INSERT INTO activities (project_id,name,start_date,end_date,estimated_hours,status,code) VALUES (?,?,?,?,?,?,?)").bind(2,"Detaljprojektering","2026-10-01","2027-01-29",360,"Planerad","A-20"),d.prepare("INSERT INTO activities (project_id,name,start_date,end_date,estimated_hours,status,code) VALUES (?,?,?,?,?,?,?)").bind(3,"Granskning och provning","2026-11-02","2027-02-26",280,"Planerad","A-30"),d.prepare("INSERT INTO activities (project_id,name,start_date,end_date,estimated_hours,status,code) VALUES (?,?,?,?,?,?,?)").bind(1,"Driftsättning","2027-01-11","2027-03-31",300,"Planerad","A-40"),
  d.prepare("INSERT INTO assignments (activity_id,employee_id,effort_percent,start_date,end_date) VALUES (?,?,?,?,?)").bind(1,2,50,"2026-09-01","2026-12-18"),d.prepare("INSERT INTO assignments (activity_id,employee_id,effort_percent,start_date,end_date) VALUES (?,?,?,?,?)").bind(1,3,40,"2026-09-01","2026-12-18"),d.prepare("INSERT INTO assignments (activity_id,employee_id,effort_percent,start_date,end_date) VALUES (?,?,?,?,?)").bind(2,2,35,"2026-10-01","2027-01-29"),d.prepare("INSERT INTO assignments (activity_id,employee_id,effort_percent,start_date,end_date) VALUES (?,?,?,?,?)").bind(2,4,60,"2026-10-01","2027-01-29"),d.prepare("INSERT INTO assignments (activity_id,employee_id,effort_percent,start_date,end_date) VALUES (?,?,?,?,?)").bind(3,3,70,"2026-11-02","2027-02-26"),d.prepare("INSERT INTO assignments (activity_id,employee_id,effort_percent,start_date,end_date) VALUES (?,?,?,?,?)").bind(4,2,40,"2027-01-11","2027-03-31"),d.prepare("INSERT INTO assignments (activity_id,employee_id,effort_percent,start_date,end_date) VALUES (?,?,?,?,?)").bind(4,4,50,"2027-01-11","2027-03-31")]);}

async function snapshot(d:D1Database){const [e,p,w,a,s,m,periods,formItems,weekMoves,projectStates,importRuns,orders,groups,groupMembers,projectLeaders,teamLeaders,assignmentRequests]=await Promise.all([
 d.prepare("SELECT id,name,email,role,manager_id managerId,capacity_percent capacityPercent FROM employees ORDER BY name").all<Row>(),
 d.prepare("SELECT id,code,name,color,description,status,priority FROM projects ORDER BY code").all<Row>(),
 d.prepare("SELECT id,project_id projectId,code,name,description FROM work_packages ORDER BY project_id,code").all<Row>(),
 d.prepare("SELECT id,project_id projectId,work_package_id workPackageId,parent_activity_id parentActivityId,code,name,description,start_date startDate,end_date endDate,estimated_hours estimatedHours,status FROM activities ORDER BY start_date,name").all<Row>(),
 d.prepare("SELECT s.id,s.activity_id activityId,s.employee_id employeeId,s.effort_percent effortPercent,s.start_date startDate,s.end_date endDate,s.completed_at completedAt,s.work_status workStatus,s.original_end_date originalEndDate,s.status_updated_at statusUpdatedAt FROM assignments s ORDER BY s.start_date,s.id").all<Row>(),
 d.prepare("SELECT project_id projectId,employee_id employeeId FROM project_members ORDER BY employee_id,project_id").all<Row>(),
 d.prepare("SELECT id,assignment_id assignmentId,start_date startDate,end_date endDate,effort_percent effortPercent FROM assignment_periods ORDER BY assignment_id,start_date,id").all<Row>(),
 d.prepare("SELECT item_uid itemUid,employee_id employeeId,activity_id activityId,first_week firstWeek,current_week currentWeek,updated_at updatedAt FROM individual_form_items ORDER BY item_uid").all<Row>(),
 d.prepare("SELECT id,item_uid itemUid,from_week fromWeek,to_week toWeek,reason,changed_at changedAt FROM individual_week_moves ORDER BY id").all<Row>(),
 d.prepare("SELECT employee_id employeeId,project_id projectId,state,updated_at updatedAt FROM individual_project_state ORDER BY employee_id,project_id").all<Row>(),
 d.prepare("SELECT id,employee_id employeeId,imported_at importedAt,row_count rowCount,created_count createdCount,updated_count updatedCount FROM individual_import_runs ORDER BY id").all<Row>(),
 d.prepare("SELECT employee_id employeeId,project_id projectId,sort_order sortOrder FROM employee_project_orders ORDER BY employee_id,sort_order").all<Row>(),
 d.prepare("SELECT id,name,description,owner_id ownerId,created_at createdAt FROM employee_groups ORDER BY name,id").all<Row>(),
 d.prepare("SELECT group_id groupId,employee_id employeeId FROM employee_group_members ORDER BY group_id,employee_id").all<Row>(),
 d.prepare("SELECT project_id projectId,employee_id employeeId FROM project_leaders ORDER BY project_id,employee_id").all<Row>(),
 d.prepare("SELECT team_id teamId,employee_id employeeId FROM team_leaders ORDER BY team_id,employee_id").all<Row>(),
 d.prepare("SELECT id,activity_id activityId,requested_by requestedBy,recipient_id recipientId,effort_percent effortPercent,start_date startDate,end_date endDate,status,comment,decided_at decidedAt,created_at createdAt FROM assignment_requests ORDER BY id").all<Row>()]);
 return {employees:e.results,projects:p.results,workPackages:w.results,activities:a.results,assignments:s.results,projectMembers:m.results,assignmentPeriods:periods.results,individualFormItems:formItems.results,individualWeekMoves:weekMoves.results,individualProjectStates:projectStates.results,individualImportRuns:importRuns.results,employeeProjectOrders:orders.results,employeeGroups:groups.results,employeeGroupMembers:groupMembers.results,projectLeaders:projectLeaders.results,teamLeaders:teamLeaders.results,assignmentRequests:assignmentRequests.results};}

async function visibleSnapshot(d:D1Database,user:Identity){
 const scope=await accessScope(d,user);
 const data=await snapshot(d);
 return {...filteredSnapshot(data,user,scope),projectDirectory:(user.isAdmin||user.isGroupManager)?data.projects.map(p=>({id:p.id,code:p.code,name:p.name,color:p.color,priority:p.priority})):data.projects.filter(p=>scope.projectIds.has(p.id)),viewer:{
  accountId:user.accountId,email:user.email,employeeId:user.employeeId,isAdmin:user.isAdmin,isGroupManager:user.isGroupManager,
  managedEmployeeIds:[...scope.managedIds],projectLeadIds:[...scope.projectLedIds],teamLeadIds:[...scope.teamLedIds],
  readableProjectIds:[...scope.projectIds]
 }};
}
export async function GET(req:Request){try{const d=db();const user=await sessionIdentity(req,d);if(!user)return unauthorized();await seedIfEmpty(d);return Response.json(await visibleSnapshot(d,user),{headers:{"cache-control":"no-store"}})}catch(e){console.error(e);return Response.json({error:"Kunde inte läsa planeringsdata."},{status:500})}}


async function importRows(d:D1Database,rows:Array<Record<string,string>>){const limited=rows.slice(0,2000);for(const r of limited){if((r.record_type||"").toLowerCase()==="person"&&r.email&&r.name)await d.prepare("INSERT INTO employees (name,email,role,manager_id,capacity_percent) VALUES (?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET name=excluded.name,role=excluded.role,capacity_percent=excluded.capacity_percent").bind(r.name,r.email,r.role||"Medarbetare",null,Number(r.capacity_percent||100)).run()}for(const r of limited){if((r.record_type||"").toLowerCase()==="person"&&r.email&&r.manager_email){const m=await d.prepare("SELECT id FROM employees WHERE lower(email)=lower(?)").bind(r.manager_email).first<{id:number}>();if(m)await d.prepare("UPDATE employees SET manager_id=? WHERE lower(email)=lower(?)").bind(m.id,r.email).run()}}
 for(const r of limited){
  if((r.record_type||"").toLowerCase()==="person")continue;
  if(!r.project_code||!r.project_name)continue;await d.prepare("INSERT INTO projects (code,name,color,description,status) VALUES (?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name,description=excluded.description,status=excluded.status").bind(r.project_code,r.project_name,r.color||"#2563eb",r.project_description||null,r.project_status||"Aktivt").run();const p=await d.prepare("SELECT id FROM projects WHERE code=?").bind(r.project_code).first<{id:number}>();if(!p||!r.activity)continue;
  let wp:number|null=null;if(r.work_package_code||r.work_package_name){const code=r.work_package_code||r.work_package_name;await d.prepare("INSERT INTO work_packages (project_id,code,name,description) VALUES (?,?,?,?) ON CONFLICT(project_id,code) DO UPDATE SET name=excluded.name,description=excluded.description").bind(p.id,code,r.work_package_name||code,r.work_package_description||null).run();wp=(await d.prepare("SELECT id FROM work_packages WHERE project_id=? AND code=?").bind(p.id,code).first<{id:number}>())?.id??null}
  let parent:number|null=null;if(r.parent_activity_code)parent=(await d.prepare("SELECT id FROM activities WHERE project_id=? AND code=?").bind(p.id,r.parent_activity_code).first<{id:number}>())?.id??null;
  const description=(text(r.description)||"Beskrivning saknas i importerad data.").slice(0,500);let activity=r.activity_code?await d.prepare("SELECT id FROM activities WHERE project_id=? AND code=?").bind(p.id,r.activity_code).first<{id:number}>():await d.prepare("SELECT id FROM activities WHERE project_id=? AND name=? AND start_date=? AND end_date=?").bind(p.id,r.activity,r.start_date,r.end_date).first<{id:number}>();
  if(activity)await d.prepare("UPDATE activities SET work_package_id=?,parent_activity_id=?,code=?,name=?,description=?,start_date=?,end_date=?,estimated_hours=?,status=? WHERE id=?").bind(wp,parent,r.activity_code||null,r.activity,description,r.start_date,r.end_date,number(r.estimated_hours),r.status||"Planerad",activity.id).run();else{const x=await d.prepare("INSERT INTO activities (project_id,work_package_id,parent_activity_id,code,name,description,start_date,end_date,estimated_hours,status) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(p.id,wp,parent,r.activity_code||null,r.activity,description,r.start_date,r.end_date,number(r.estimated_hours),r.status||"Planerad").run();activity={id:Number(x.meta.last_row_id)}}
  if(r.employee_email&&r.effort_percent){const e=await d.prepare("SELECT id FROM employees WHERE lower(email)=lower(?)").bind(r.employee_email).first<{id:number}>();if(e)await d.prepare("INSERT INTO assignments (activity_id,employee_id,effort_percent,start_date,end_date) VALUES (?,?,?,?,?) ON CONFLICT(activity_id,employee_id) DO UPDATE SET effort_percent=excluded.effort_percent,start_date=excluded.start_date,end_date=excluded.end_date").bind(activity.id,e.id,Number(r.effort_percent),r.start_date,r.end_date).run()}
}}

async function restore(d:D1Database,b:Backup){
 if(![1,2,3].includes(b.version)||!b.data||!Array.isArray(b.data.projects)||!Array.isArray(b.data.assignments))throw Error("Ogiltig säkerhetskopia");
 const q:D1PreparedStatement[]=[
  d.prepare("DELETE FROM individual_week_moves"),d.prepare("DELETE FROM individual_form_items"),
  d.prepare("DELETE FROM individual_project_state"),d.prepare("DELETE FROM individual_import_runs"),d.prepare("DELETE FROM assignment_requests"),d.prepare("DELETE FROM team_leaders"),d.prepare("DELETE FROM project_leaders"),d.prepare("DELETE FROM employee_group_members"),d.prepare("DELETE FROM employee_groups"),d.prepare("DELETE FROM assignment_periods"),
  d.prepare("DELETE FROM project_members"),d.prepare("DELETE FROM employee_project_orders"),d.prepare("DELETE FROM assignments"),
  d.prepare("DELETE FROM activities"),d.prepare("DELETE FROM work_packages"),
  d.prepare("DELETE FROM projects"),d.prepare("DELETE FROM employees")
 ];
 for(const x of b.data.employees)q.push(d.prepare("INSERT INTO employees(id,name,email,role,manager_id,capacity_percent) VALUES(?,?,?,?,?,?)").bind(x.id,x.name,x.email,x.role,x.managerId??null,x.capacityPercent));
 for(const x of b.data.projects)q.push(d.prepare("INSERT INTO projects(id,code,name,color,description,status,priority) VALUES(?,?,?,?,?,?,?)").bind(x.id,x.code,x.name,x.color,x.description??null,x.status??"Aktivt",priority(x.priority)));
 for(const x of b.data.workPackages||[])q.push(d.prepare("INSERT INTO work_packages(id,project_id,code,name,description) VALUES(?,?,?,?,?)").bind(x.id,x.projectId,x.code,x.name,x.description??null));
 for(const x of b.data.activities)q.push(d.prepare("INSERT INTO activities(id,project_id,work_package_id,parent_activity_id,code,name,description,start_date,end_date,estimated_hours,status) VALUES(?,?,?,?,?,?,?,?,?,?,?)").bind(x.id,x.projectId,x.workPackageId??null,x.parentActivityId??null,x.code??null,x.name,x.description??null,x.startDate,x.endDate,x.estimatedHours??null,x.status));
 for(const x of b.data.assignments)q.push(d.prepare("INSERT INTO assignments(id,activity_id,employee_id,effort_percent,start_date,end_date,completed_at,work_status,original_end_date,status_updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(x.id,x.activityId,x.employeeId,x.effortPercent,x.startDate,x.endDate,x.completedAt??null,x.workStatus??null,b.version===3?(x.originalEndDate??null):x.endDate,x.statusUpdatedAt??null));
 for(const x of b.data.projectMembers||[])q.push(d.prepare("INSERT INTO project_members(project_id,employee_id) VALUES(?,?)").bind(x.projectId,x.employeeId));
 if(b.version===3&&Array.isArray(b.data.assignmentPeriods)){
  for(const p of b.data.assignmentPeriods)q.push(d.prepare("INSERT INTO assignment_periods(id,assignment_id,start_date,end_date,effort_percent) VALUES(?,?,?,?,?)").bind(p.id,p.assignmentId,p.startDate,p.endDate,p.effortPercent));
 }else{
  for(const x of b.data.assignments)q.push(d.prepare("INSERT INTO assignment_periods(assignment_id,start_date,end_date,effort_percent) VALUES(?,?,?,?)").bind(x.id,x.startDate,x.originalEndDate??x.endDate,x.effortPercent));
 }
 if(b.version===3){
  for(const x of b.data.individualFormItems||[])q.push(d.prepare("INSERT INTO individual_form_items(item_uid,employee_id,activity_id,first_week,current_week,updated_at) VALUES(?,?,?,?,?,?)").bind(x.itemUid,x.employeeId,x.activityId,x.firstWeek,x.currentWeek,x.updatedAt||new Date().toISOString()));
  for(const x of b.data.individualWeekMoves||[])q.push(d.prepare("INSERT INTO individual_week_moves(id,item_uid,from_week,to_week,reason,changed_at) VALUES(?,?,?,?,?,?)").bind(x.id,x.itemUid,x.fromWeek,x.toWeek,x.reason??null,x.changedAt||new Date().toISOString()));
  for(const x of b.data.individualProjectStates||[])q.push(d.prepare("INSERT INTO individual_project_state(employee_id,project_id,state,updated_at) VALUES(?,?,?,?)").bind(x.employeeId,x.projectId,x.state,x.updatedAt||new Date().toISOString()));
  for(const x of b.data.individualImportRuns||[])q.push(d.prepare("INSERT INTO individual_import_runs(id,employee_id,imported_at,row_count,created_count,updated_count) VALUES(?,?,?,?,?,?)").bind(x.id,x.employeeId,x.importedAt,x.rowCount,x.createdCount,x.updatedCount));
  for(const x of b.data.employeeProjectOrders||[])q.push(d.prepare("INSERT INTO employee_project_orders(employee_id,project_id,sort_order) VALUES(?,?,?)").bind(x.employeeId,x.projectId,x.sortOrder));
  for(const x of b.data.employeeGroups||[])q.push(d.prepare("INSERT INTO employee_groups(id,name,description,owner_id,created_at) VALUES(?,?,?,?,?)").bind(x.id,x.name,x.description??null,x.ownerId??null,x.createdAt??new Date().toISOString()));
  for(const x of b.data.employeeGroupMembers||[])q.push(d.prepare("INSERT INTO employee_group_members(group_id,employee_id) VALUES(?,?)").bind(x.groupId,x.employeeId));
  for(const x of b.data.projectLeaders||[])q.push(d.prepare("INSERT INTO project_leaders(project_id,employee_id) VALUES(?,?)").bind(x.projectId,x.employeeId));
  for(const x of b.data.teamLeaders||[])q.push(d.prepare("INSERT INTO team_leaders(team_id,employee_id) VALUES(?,?)").bind(x.teamId,x.employeeId));
  for(const x of b.data.assignmentRequests||[])q.push(d.prepare("INSERT INTO assignment_requests(id,activity_id,requested_by,recipient_id,effort_percent,start_date,end_date,status,comment,decided_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").bind(x.id,x.activityId,x.requestedBy,x.recipientId,x.effortPercent,x.startDate,x.endDate,x.status,x.comment??null,x.decidedAt??null,x.createdAt??new Date().toISOString()));
 }
 await d.batch(q);
 // Authentication records are not included in planning exports.
 // Re-associate active user accounts with employee records after replacement.
 await d.prepare("UPDATE user_accounts SET employee_id=(SELECT e.id FROM employees e WHERE lower(e.email)=lower(user_accounts.email)) WHERE employee_id IS NULL").run();
}
export async function POST(request:Request){try{const d=db();const user=await sessionIdentity(request,d);if(!user)return unauthorized();
 if(!sameOrigin(request))return forbidden();
 const b=await request.json() as Record<string,unknown>;const action=text(b.action);
 if(!await authorizePlanningAction(d,user,action,b))return forbidden();
 if(action==="employee"){
 const managerId=user.isAdmin?number(b.managerId):user.employeeId;
 await d.prepare("INSERT INTO employees (name,email,role,manager_id,capacity_percent) VALUES (?,?,?,?,?)").bind(text(b.name),text(b.email),text(b.role)||"Medarbetare",managerId,Number(b.capacityPercent||100)).run();
 }
 else if(action==="project")await d.prepare("INSERT INTO projects (code,name,color,description,status,priority) VALUES (?,?,?,?,?,?)").bind(text(b.code),text(b.name),text(b.color)||"#2563eb",text(b.description)||null,text(b.status)||"Aktivt",priority(b.priority)).run();
 else if(action==="updateProject")await d.prepare("UPDATE projects SET code=?,name=?,color=?,description=?,status=?,priority=? WHERE id=?").bind(text(b.code),text(b.name),text(b.color)||"#2563eb",text(b.description)||null,text(b.status)||"Aktivt",priority(b.priority),Number(b.id)).run();
 else if(action==="workPackage")await d.prepare("INSERT INTO work_packages (project_id,code,name,description) VALUES (?,?,?,?)").bind(Number(b.projectId),text(b.code),text(b.name),text(b.description)||null).run();
 else if(action==="updateWorkPackage")await d.prepare("UPDATE work_packages SET project_id=?,code=?,name=?,description=? WHERE id=?").bind(Number(b.projectId),text(b.code),text(b.name),text(b.description)||null,Number(b.id)).run();
 else if(action==="activity"){
  const projectId=Number(b.projectId),start=text(b.startDate),end=text(b.endDate);
  if(start>end)return Response.json({error:"Slutdatum måste vara efter startdatum."},{status:400});
  const workId=number(b.workPackageId),parentId=number(b.parentActivityId);
  if(workId&&!await d.prepare("SELECT id FROM work_packages WHERE id=? AND project_id=?").bind(workId,projectId).first())return Response.json({error:"Uppdraget tillhör inte valt projekt."},{status:400});
  if(parentId&&!await d.prepare("SELECT id FROM activities WHERE id=? AND project_id=?").bind(parentId,projectId).first())return Response.json({error:"Huvudaktiviteten tillhör inte valt projekt."},{status:400});
  const result=await d.prepare("INSERT INTO activities (project_id,work_package_id,parent_activity_id,code,name,description,start_date,end_date,estimated_hours,status,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(projectId,workId,parentId,text(b.code)||null,text(b.name),requiredActivityDescription(b.description),start,end,number(b.estimatedHours),text(b.status)||"Planerad",user.employeeId).run();
  if(!user.isAdmin&&user.employeeId){
   const id=Number(result.meta.last_row_id);
   const ass=await d.prepare("INSERT INTO assignments(activity_id,employee_id,effort_percent,start_date,end_date,work_status,original_end_date) VALUES(?,?,?,?,?,?,?)").bind(id,user.employeeId,0,start,end,"Planerad",end).run();
   await d.prepare("INSERT INTO assignment_periods(assignment_id,start_date,end_date,effort_percent) VALUES(?,?,?,?)").bind(Number(ass.meta.last_row_id),start,end,0).run();
  }
 }
 else if(action==="setAssignmentPeriods"){
  const activityId=Number(b.activityId),employeeId=Number(b.employeeId);
  if(!Number.isSafeInteger(activityId)||!Number.isSafeInteger(employeeId)||activityId<=0||employeeId<=0)
    return Response.json({error:"Ogiltigt ID."},{status:400});
  const activity=await d.prepare("SELECT id,status FROM activities WHERE id=?").bind(activityId).first<{id:number;status:string}>();
  const employee=await d.prepare("SELECT id FROM employees WHERE id=?").bind(employeeId).first<{id:number}>();
  if(!activity||!employee)return Response.json({error:"Aktiviteten eller medarbetaren saknas."},{status:404});
  const rows=b.periods;
  if(!Array.isArray(rows)||!rows.length||rows.length>52)return Response.json({error:"Ange 1–52 perioder per resurs."},{status:400});
  const periods=rows.map((v:unknown)=>{
   const x=v as Record<string,unknown>;
   return {startDate:text(x.startDate),endDate:text(x.endDate),effortPercent:Number(x.effortPercent)};
  }).sort((a,b)=>a.startDate.localeCompare(b.startDate));
  const date=/^\d{4}-\d{2}-\d{2}$/;
  const validDate=(value:string)=>{
   if(!date.test(value))return false;
   const day=new Date(value+"T00:00:00Z");
   return !Number.isNaN(day.getTime())&&day.toISOString().slice(0,10)===value;
  };
  if(periods.some(p=>!validDate(p.startDate)||!validDate(p.endDate)||p.startDate>p.endDate||
     !Number.isInteger(p.effortPercent)||p.effortPercent<0||p.effortPercent>200))
   return Response.json({error:"Varje period behöver giltiga datum och beläggning 0–200 %."},{status:400});
  if(periods.some((p,i)=>i>0&&periods[i-1].endDate>=p.startDate))
   return Response.json({error:"Perioder för samma person får inte överlappa. Dela vid behov upp dem."},{status:400});
  let assignment=await d.prepare("SELECT id,completed_at completedAt FROM assignments WHERE activity_id=? AND employee_id=?").bind(activityId,employeeId).first<{id:number;completedAt:string|null}>();
  const startDate=periods[0].startDate,endDate=periods.at(-1)!.endDate;
  // Save all validated periods in a transaction. Existing completion state survives.
  if(!assignment){
   const created=await d.prepare("INSERT INTO assignments(activity_id,employee_id,effort_percent,start_date,end_date,original_end_date,work_status) VALUES(?,?,?,?,?,?,?)").bind(activityId,employeeId,periods[0].effortPercent,startDate,endDate,endDate,"Planerad").run();
   assignment={id:Number(created.meta.last_row_id),completedAt:null};
  }
  const aid=assignment.id;
  const q:D1PreparedStatement[]=[
   d.prepare("DELETE FROM assignment_periods WHERE assignment_id=?").bind(aid),
   ...periods.map(p=>d.prepare("INSERT INTO assignment_periods(assignment_id,start_date,end_date,effort_percent) VALUES(?,?,?,?)").bind(aid,p.startDate,p.endDate,p.effortPercent)),
   d.prepare("UPDATE assignments SET start_date=?,end_date=?,original_end_date=?,effort_percent=? WHERE id=?")
      .bind(startDate,assignment.completedAt&&assignment.completedAt>=startDate&&assignment.completedAt<endDate?assignment.completedAt:endDate,endDate,periods[0].effortPercent,aid)
  ];
  await d.batch(q);
  if(activity.status==="Klar"&&!assignment.completedAt)
   await reconcileActivityStatus(d,activityId);
 }
 else if(action==="saveEmployeeGroup"){
  const id=b.id===undefined||b.id===null?null:Number(b.id);
  const name=text(b.name),description=text(b.description);
  if(!name||name.length>100||description.length>500)return Response.json({error:"Gruppnamn krävs (max 100 tecken) och beskrivning får vara högst 500 tecken."},{status:400});
  const members=b.employeeIds;
  if(!Array.isArray(members)||members.length>500)return Response.json({error:"Ange en giltig medlemslista."},{status:400});
  const employeeIds=members.map(Number);
  if(employeeIds.some(x=>!Number.isSafeInteger(x)||x<=0)||new Set(employeeIds).size!==employeeIds.length)return Response.json({error:"Medlemslistan innehåller dubbletter eller ogiltiga ID."},{status:400});
  if(id!==null&&(!Number.isSafeInteger(id)||id<=0||!await d.prepare("SELECT id FROM employee_groups WHERE id=?").bind(id).first()))return Response.json({error:"Gruppen finns inte."},{status:404});
  if(employeeIds.length){
   const all=await d.prepare("SELECT id FROM employees").all<{id:number}>();
   const valid=new Set(all.results.map(e=>e.id));
   if(employeeIds.some(x=>!valid.has(x)))return Response.json({error:"En vald medarbetare saknas."},{status:400});
  }
  const conflict=await d.prepare("SELECT id FROM employee_groups WHERE lower(name)=lower(?) AND (? IS NULL OR id<>?)").bind(name,id,id).first();
  if(conflict)return Response.json({error:"Gruppnamnet används redan."},{status:409});
  let groupId=id;
  if(groupId===null){
   const created=await d.prepare("INSERT INTO employee_groups(name,description,owner_id) VALUES(?,?,?)").bind(name,description||null,user.employeeId).run();
   groupId=Number(created.meta.last_row_id);
  }
  const commands:D1PreparedStatement[]=[];
  if(id!==null)commands.push(d.prepare("UPDATE employee_groups SET name=?,description=? WHERE id=?").bind(name,description||null,id));
  commands.push(d.prepare("DELETE FROM employee_group_members WHERE group_id=?").bind(groupId));
  for(const employeeId of employeeIds)commands.push(d.prepare("INSERT INTO employee_group_members(group_id,employee_id) VALUES(?,?)").bind(groupId,employeeId));
  await d.batch(commands);
 }
 else if(action==="setEmployeeProjectOrder"||action==="resetEmployeeProjectOrder"){
  const employeeId=Number(b.employeeId);
  if(!Number.isSafeInteger(employeeId)||employeeId<=0)return Response.json({error:"Ogiltig medarbetare."},{status:400});
  if(!await d.prepare("SELECT id FROM employees WHERE id=?").bind(employeeId).first())return Response.json({error:"Medarbetaren finns inte."},{status:404});
  const choices=action==="resetEmployeeProjectOrder"?[]:b.projectIds;
  if(!Array.isArray(choices)||choices.length>250)return Response.json({error:"Ogiltig projektordning."},{status:400});
  const ordered=choices.map(x=>Number(x));
  if(ordered.some(x=>!Number.isSafeInteger(x)||x<=0)||new Set(ordered).size!==ordered.length)return Response.json({error:"Projektordningen innehåller ogiltiga eller dubbla ID."},{status:400});
  const permitted=await d.prepare(`SELECT p.id FROM projects p
    WHERE EXISTS(SELECT 1 FROM project_members m WHERE m.project_id=p.id AND m.employee_id=?)
       OR EXISTS(SELECT 1 FROM assignments s JOIN activities a ON a.id=s.activity_id WHERE a.project_id=p.id AND s.employee_id=?)`)
      .bind(employeeId,employeeId).all<{id:number}>();
  const available=new Set(permitted.results.map(x=>x.id));
  if(ordered.some(x=>!available.has(x)))return Response.json({error:"Enbart medarbetarens projekt kan sorteras."},{status:400});
  const q:D1PreparedStatement[]=[d.prepare("DELETE FROM employee_project_orders WHERE employee_id=?").bind(employeeId)];
  for(let i=0;i<ordered.length;i++)q.push(d.prepare("INSERT INTO employee_project_orders(employee_id,project_id,sort_order) VALUES(?,?,?)").bind(employeeId,ordered[i],i));
  await d.batch(q);
 }
 else if(action==="setActivityStatus"||action==="setAssignmentStatus"){
 const id=Number(b.activityId),raw=text(b.status),status=normalizeStatus(raw);
 if(!Number.isSafeInteger(id)||id<=0||!validStatuses.some(x=>x===status))return Response.json({error:"Ogiltig aktivitet eller status."},{status:400});
 const exists=await d.prepare("SELECT id FROM activities WHERE id=?").bind(id).first();
 if(!exists)return Response.json({error:"Aktiviteten saknas."},{status:404});
 if(action==="setAssignmentStatus"){
  const employeeId=Number(b.employeeId);
  if(!Number.isSafeInteger(employeeId)||employeeId<=0||!(await setAssignmentStatus(d,id,employeeId,status)))return Response.json({error:"Personen saknar bemanning på aktiviteten."},{status:404});
  await reconcileActivityStatus(d,id);
 }else{
  const resources=await d.prepare("SELECT employee_id employeeId FROM assignments WHERE activity_id=?").bind(id).all<{employeeId:number}>();
  if(resources.results.length)await setWholeActivityStatus(d,id,status);
  if(resources.results.length)await reconcileActivityStatus(d,id);
  else await d.prepare("UPDATE activities SET status=? WHERE id=?").bind(status==="Pågående"?"Pågår":status,id).run();
 }
 }
 else if(action==="updateActivity"){
  if(!user.isAdmin){
   const nextProject=Number(b.projectId);
   const access=await accessScope(d,user);
   if(!access.projectIds.has(nextProject))return forbidden();
  }

  const id=Number(b.id);
  const original=await d.prepare("SELECT id,start_date startDate,end_date endDate,status FROM activities WHERE id=?").bind(id).first<{id:number;startDate:string;endDate:string;status:string}>();
  if(!original)return Response.json({error:"Aktiviteten saknas."},{status:404});
  const start=text(b.startDate),end=text(b.endDate);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end)||start>end)
   return Response.json({error:"Felaktig start- eller slutdag."},{status:400});
  const people=await d.prepare("SELECT work_status workStatus,completed_at completedAt FROM assignments WHERE activity_id=?").bind(id).all<{workStatus:string|null;completedAt:string|null}>();
  const states=people.results.map(x=>x.workStatus||(x.completedAt?"Klar":original.status));
  const state=states.length===0?(text(b.status)||original.status):
    states.every(x=>x==="Klar")?"Klar":
    states.some(x=>x==="Pågående"||x==="Pågår")?"Pågår":
    states.some(x=>x==="Planerad")?"Planerad":
    states.some(x=>x==="Pausad")?"Pausad":
    states.some(x=>x==="Fryst")?"Fryst":"Planerad";
  const q:D1PreparedStatement[]=[
   d.prepare("UPDATE activities SET project_id=?,work_package_id=?,parent_activity_id=?,code=?,name=?,description=?,start_date=?,end_date=?,estimated_hours=?,status=? WHERE id=?")
    .bind(Number(b.projectId),number(b.workPackageId),number(b.parentActivityId),text(b.code)||null,text(b.name),requiredActivityDescription(b.description),start,end,number(b.estimatedHours),state,id)
  ];
  // Preserve person-specific dates when editing a project activity.
  // Synchronize only allocations that still mirror the previous project window.
  if(start!==original.startDate||end!==original.endDate){
   q.push(d.prepare("UPDATE assignments SET start_date=CASE WHEN start_date=? THEN ? ELSE start_date END,end_date=CASE WHEN end_date=? THEN ? ELSE end_date END,original_end_date=CASE WHEN original_end_date=? THEN ? ELSE original_end_date END WHERE activity_id=? AND completed_at IS NULL")
    .bind(original.startDate,start,original.endDate,end,original.endDate,end,id));
  }
  // Only align a single resource period when it exactly mirrored the old
  // project dates. Custom/multi-period allocation dates are never overwritten.
  if(start!==original.startDate||end!==original.endDate){
   q.push(d.prepare(`UPDATE assignment_periods SET start_date=?,end_date=?
      WHERE start_date=? AND end_date=? AND assignment_id IN (
       SELECT s.id FROM assignments s
       WHERE s.activity_id=? AND s.completed_at IS NULL
        AND (SELECT COUNT(*) FROM assignment_periods pp WHERE pp.assignment_id=s.id)=1
      )`).bind(start,end,original.startDate,original.endDate,id));
  }
  await d.batch(q);
 }
 else if(action==="assignment"){const a=await d.prepare("SELECT start_date startDate,end_date endDate FROM activities WHERE id=?").bind(Number(b.activityId)).first<{startDate:string;endDate:string}>();if(!a)return Response.json({error:"Aktiviteten saknas."},{status:404});await d.prepare("INSERT INTO assignments (activity_id,employee_id,effort_percent,start_date,end_date,work_status,original_end_date) VALUES (?,?,?,?,?,?,?) ON CONFLICT(activity_id,employee_id) DO UPDATE SET effort_percent=excluded.effort_percent,start_date=CASE WHEN assignments.completed_at IS NULL THEN excluded.start_date ELSE assignments.start_date END,end_date=CASE WHEN assignments.completed_at IS NULL THEN excluded.end_date ELSE assignments.end_date END").bind(Number(b.activityId),Number(b.employeeId),Number(b.effortPercent),text(b.startDate)||a.startDate,text(b.endDate)||a.endDate,"Planerad",text(b.endDate)||a.endDate).run();
   await d.prepare("INSERT INTO assignment_periods(assignment_id,start_date,end_date,effort_percent) SELECT s.id,s.start_date,COALESCE(s.original_end_date,s.end_date),s.effort_percent FROM assignments s WHERE s.activity_id=? AND s.employee_id=? AND NOT EXISTS(SELECT 1 FROM assignment_periods p WHERE p.assignment_id=s.id)").bind(Number(b.activityId),Number(b.employeeId)).run();}
 else if(action==="setActivityAssignments"){
  const activityId=Number(b.activityId);
  const activity=await d.prepare("SELECT id,start_date startDate,end_date endDate,status FROM activities WHERE id=?").bind(activityId).first<{id:number;startDate:string;endDate:string;status:string}>();
  if(!activity)return Response.json({error:"Aktiviteten hittades inte."},{status:404});
  if(!Array.isArray(b.resources)||b.resources.length>100)return Response.json({error:"Ogiltig bemanningslista."},{status:400});
  const resources=b.resources.map((row:unknown)=>{
   const x=row as Record<string,unknown>;return {employeeId:Number(x.employeeId),effortPercent:Number(x.effortPercent)};
  });
  if(resources.some(x=>!Number.isInteger(x.employeeId)||x.employeeId<=0||!Number.isFinite(x.effortPercent)||x.effortPercent<0||x.effortPercent>100)||new Set(resources.map(x=>x.employeeId)).size!==resources.length)
   return Response.json({error:"Ogiltig eller dubblerad medarbetare/beläggning."},{status:400});
  const existingPeriods=await d.prepare("SELECT s.employee_id employeeId,s.effort_percent effortPercent,COUNT(p.id) periodCount FROM assignments s LEFT JOIN assignment_periods p ON p.assignment_id=s.id WHERE s.activity_id=? GROUP BY s.id").bind(activityId).all<{employeeId:number;effortPercent:number;periodCount:number}>();
  if(resources.some(x=>existingPeriods.results.some(old=>old.employeeId===x.employeeId&&old.periodCount>1&&old.effortPercent!==x.effortPercent)))
   return Response.json({error:"Resursen har flera bemanningsperioder. Ändra procent för varje period via Ändra perioder."},{status:400});
  const valid=await d.prepare("SELECT id FROM employees").all<{id:number}>();
  const ids=new Set(valid.results.map(x=>x.id));
  if(resources.some(x=>!ids.has(x.employeeId)))return Response.json({error:"Någon medarbetare saknas."},{status:400});
  const prev=await d.prepare("SELECT employee_id employeeId FROM assignments WHERE activity_id=?").bind(activityId).all<{employeeId:number}>();
  const keep=new Set(resources.map(x=>x.employeeId));
  const q:D1PreparedStatement[]=[];
  for(const x of prev.results)if(!keep.has(x.employeeId)){
   q.push(d.prepare("DELETE FROM assignments WHERE activity_id=? AND employee_id=?").bind(activityId,x.employeeId));
   // Remove the obsolete spreadsheet identity for this particular assignment.
   q.push(d.prepare("DELETE FROM individual_week_moves WHERE item_uid IN (SELECT item_uid FROM individual_form_items WHERE activity_id=? AND employee_id=?)").bind(activityId,x.employeeId));
   q.push(d.prepare("DELETE FROM individual_form_items WHERE activity_id=? AND employee_id=?").bind(activityId,x.employeeId));
  }
  for(const x of resources)q.push(d.prepare("INSERT INTO assignments(activity_id,employee_id,effort_percent,start_date,end_date,completed_at,work_status,original_end_date) VALUES(?,?,?,?,?,NULL,?,?) ON CONFLICT(activity_id,employee_id) DO UPDATE SET effort_percent=excluded.effort_percent").bind(activityId,x.employeeId,x.effortPercent,activity.startDate,activity.endDate,"Planerad",activity.endDate));
  // If a new colleague joins an activity that was already completed, reopen the project activity.
  if(activity.status==="Klar"&&resources.some(x=>!prev.results.some(y=>y.employeeId===x.employeeId)))
   q.push(d.prepare("UPDATE activities SET status='Pågår' WHERE id=?").bind(activityId));
  if(q.length)await d.batch(q);
  // A single-period resource can still change its percent in the quick staffing dialog.
  for(const row of resources)await d.prepare("UPDATE assignment_periods SET effort_percent=? WHERE assignment_id=(SELECT id FROM assignments WHERE activity_id=? AND employee_id=?) AND (SELECT COUNT(*) FROM assignment_periods WHERE assignment_id=(SELECT id FROM assignments WHERE activity_id=? AND employee_id=?))=1").bind(row.effortPercent,activityId,row.employeeId,activityId,row.employeeId).run();
  // Initialize a period for new assignees, preserving customized existing periods.
  await d.prepare("INSERT INTO assignment_periods(assignment_id,start_date,end_date,effort_percent) SELECT s.id,s.start_date,COALESCE(s.original_end_date,s.end_date),s.effort_percent FROM assignments s WHERE s.activity_id=? AND NOT EXISTS (SELECT 1 FROM assignment_periods p WHERE p.assignment_id=s.id)").bind(activityId).run();
 }
 else if(action==="setSingleProjectMember"){
   const projectId=Number(b.projectId),employeeId=Number(b.employeeId);
   if(!Number.isSafeInteger(projectId)||!Number.isSafeInteger(employeeId)||projectId<=0||employeeId<=0)return Response.json({error:"Ogiltigt projekt eller medarbetare"},{status:400});
   if(!await d.prepare("SELECT id FROM projects WHERE id=?").bind(projectId).first()||!await d.prepare("SELECT id FROM employees WHERE id=?").bind(employeeId).first())return Response.json({error:"Projektet eller medarbetaren saknas"},{status:404});
   if(Boolean(b.enabled))await d.prepare("INSERT OR IGNORE INTO project_members(project_id,employee_id) VALUES(?,?)").bind(projectId,employeeId).run();
   else await d.prepare("DELETE FROM project_members WHERE project_id=? AND employee_id=?").bind(projectId,employeeId).run();
 }
 else if(action==="setProjectMemberships"){const employeeId=Number(b.employeeId),projectIds=Array.isArray(b.projectIds)?[...new Set(b.projectIds.map(Number).filter(Number.isInteger))]:[];if(!employeeId)return Response.json({error:"Medarbetare saknas."},{status:400});const q=[d.prepare("DELETE FROM project_members WHERE employee_id=?").bind(employeeId),...projectIds.map(projectId=>d.prepare("INSERT INTO project_members (project_id,employee_id) VALUES (?,?)").bind(projectId,employeeId))];await d.batch(q)}
 else if(action==="import")await importRows(d,Array.isArray(b.rows)?b.rows as Array<Record<string,string>>:[]);
 else if(action==="restore")await restore(d,b.backup as Backup);
 else return Response.json({error:"Okänd åtgärd."},{status:400});return Response.json(await visibleSnapshot(d,user));
 }catch(e){console.error(e);return Response.json({error:e instanceof Error?e.message:"Kunde inte spara ändringen."},{status:500})}}

export async function DELETE(request:Request){try{const d=db();const user=await sessionIdentity(request,d);if(!user)return unauthorized();if(!sameOrigin(request))return forbidden();const u=new URL(request.url);const type=u.searchParams.get("type");const id=Number(u.searchParams.get("id"));if(!Number.isSafeInteger(id)||id<=0)return Response.json({error:"ID saknas."},{status:400});
 if(!user.isAdmin){
  const access=await accessScope(d,user);
  const canDelete=type==="employee"?access.managedIds.has(id):
   type==="group"?!!await d.prepare("SELECT id FROM employee_groups WHERE id=? AND owner_id=?").bind(id,user.employeeId).first():
   type==="activity"?access.projectLedIds.has(await projectOfActivity(d,id)):
   type==="workPackage"?access.projectLedIds.size>0&&!!await d.prepare("SELECT id FROM work_packages WHERE id=? AND project_id IN ("+[...access.projectLedIds].map(()=>"?").join(",")+")").bind(id,...access.projectLedIds).first():false;
  if(!canDelete)return forbidden();
 }
 if(type==="group")await d.batch([d.prepare("DELETE FROM employee_group_members WHERE group_id=?").bind(id),d.prepare("DELETE FROM employee_groups WHERE id=?").bind(id)]);
 else if(type==="employee")await d.batch([d.prepare("UPDATE employees SET manager_id=NULL WHERE manager_id=?").bind(id),d.prepare("DELETE FROM project_members WHERE employee_id=?").bind(id),d.prepare("DELETE FROM employee_group_members WHERE employee_id=?").bind(id),d.prepare("DELETE FROM assignments WHERE employee_id=?").bind(id),d.prepare("DELETE FROM employees WHERE id=?").bind(id)]);
 else if(type==="project")await d.batch([d.prepare("DELETE FROM project_members WHERE project_id=?").bind(id),d.prepare("DELETE FROM assignments WHERE activity_id IN (SELECT id FROM activities WHERE project_id=?)").bind(id),d.prepare("DELETE FROM activities WHERE project_id=?").bind(id),d.prepare("DELETE FROM work_packages WHERE project_id=?").bind(id),d.prepare("DELETE FROM projects WHERE id=?").bind(id)]);
 else if(type==="workPackage")await d.batch([d.prepare("DELETE FROM assignments WHERE activity_id IN (WITH RECURSIVE tree(id) AS (SELECT id FROM activities WHERE work_package_id=? UNION ALL SELECT a.id FROM activities a JOIN tree t ON a.parent_activity_id=t.id) SELECT id FROM tree)").bind(id),d.prepare("DELETE FROM activities WHERE id IN (WITH RECURSIVE tree(id) AS (SELECT id FROM activities WHERE work_package_id=? UNION ALL SELECT a.id FROM activities a JOIN tree t ON a.parent_activity_id=t.id) SELECT id FROM tree)").bind(id),d.prepare("DELETE FROM work_packages WHERE id=?").bind(id)]);
 else if(type==="activity")await d.batch([d.prepare("DELETE FROM assignments WHERE activity_id IN (WITH RECURSIVE tree(id) AS (SELECT id FROM activities WHERE id=? UNION ALL SELECT a.id FROM activities a JOIN tree t ON a.parent_activity_id=t.id) SELECT id FROM tree)").bind(id),d.prepare("DELETE FROM activities WHERE id IN (WITH RECURSIVE tree(id) AS (SELECT id FROM activities WHERE id=? UNION ALL SELECT a.id FROM activities a JOIN tree t ON a.parent_activity_id=t.id) SELECT id FROM tree)").bind(id)]);
 else return Response.json({error:"Okänd typ."},{status:400});return Response.json(await visibleSnapshot(d,user));
 }catch(e){console.error(e);return Response.json({error:"Kunde inte ta bort posten."},{status:500})}}
