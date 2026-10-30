import type {Identity} from "./auth";
export type AccessScope={
 employeeIds:Set<number>;projectIds:Set<number>;projectLedIds:Set<number>;
 managedIds:Set<number>;teamLedIds:Set<number>;teamIds:Set<number>;
};
const safe=(v:unknown)=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):0;
export async function accessScope(d:D1Database,user:Identity):Promise<AccessScope>{
 const result:AccessScope={employeeIds:new Set(),projectIds:new Set(),projectLedIds:new Set(),managedIds:new Set(),teamLedIds:new Set(),teamIds:new Set()};
 if(user.isAdmin){
  const [employees,projects,teams]=await Promise.all([
   d.prepare("SELECT id FROM employees").all<{id:number}>(),
   d.prepare("SELECT id FROM projects").all<{id:number}>(),
   d.prepare("SELECT id FROM employee_groups").all<{id:number}>()]);
  for(const x of employees.results)result.employeeIds.add(x.id);
  for(const x of projects.results)result.projectIds.add(x.id);
  for(const x of teams.results)result.teamIds.add(x.id);
  return result;
 }
 const self=user.employeeId;
 if(self===null)return result;
 result.employeeIds.add(self);
 const [managed,ledProjects,ledTeams,memberTeams]=await Promise.all([
  d.prepare("SELECT id FROM employees WHERE manager_id=?").bind(self).all<{id:number}>(),
  d.prepare("SELECT project_id id FROM project_leaders WHERE employee_id=?").bind(self).all<{id:number}>(),
  d.prepare("SELECT team_id id FROM team_leaders WHERE employee_id=?").bind(self).all<{id:number}>(),
  d.prepare("SELECT group_id id FROM employee_group_members WHERE employee_id=?").bind(self).all<{id:number}>()
 ]);
 for(const x of managed.results){result.managedIds.add(x.id);result.employeeIds.add(x.id)}
 for(const x of ledProjects.results){result.projectLedIds.add(x.id);result.projectIds.add(x.id)}
 for(const x of ledTeams.results){result.teamLedIds.add(x.id);result.teamIds.add(x.id)}
 for(const x of memberTeams.results)result.teamIds.add(x.id);
 if(result.teamLedIds.size){
  const m=await d.prepare("SELECT group_id teamId,employee_id employeeId FROM employee_group_members").all<{teamId:number;employeeId:number}>();
  for(const x of m.results)if(result.teamLedIds.has(x.teamId))result.employeeIds.add(x.employeeId);
 }
 // A person can read ALL activities within a project they have joined
 // (including assignments of coworkers), but cannot modify coworkers without permission.
 const membership=await d.prepare(`SELECT DISTINCT project_id id FROM project_members WHERE employee_id=?
 UNION SELECT DISTINCT a.project_id id FROM assignments s JOIN activities a ON a.id=s.activity_id WHERE s.employee_id=?`).bind(self,self).all<{id:number}>();
 for(const x of membership.results)result.projectIds.add(x.id);
 // A manager/TEAM leader can also see projects their people are working on.
 const ids=[...result.employeeIds];
 if(ids.length){
  const placeholders=ids.map(()=>"?").join(",");
  const q=await d.prepare(`SELECT DISTINCT project_id id FROM project_members WHERE employee_id IN (${placeholders})
   UNION SELECT DISTINCT a.project_id id FROM assignments s JOIN activities a ON a.id=s.activity_id WHERE s.employee_id IN (${placeholders})`).bind(...ids,...ids).all<{id:number}>();
  for(const x of q.results)result.projectIds.add(x.id);
 }
 // Project leads need to see every resource on their projects.
 if(result.projectLedIds.size){
  const ids=[...result.projectLedIds],inSql=ids.map(()=>"?").join(",");
  const results=await d.prepare(`SELECT DISTINCT s.employee_id id FROM assignments s JOIN activities a ON a.id=s.activity_id WHERE a.project_id IN (${inSql})`).bind(...ids).all<{id:number}>();
  for(const row of results.results)result.employeeIds.add(row.id);
 }
 return result;
}
export async function projectOfActivity(d:D1Database,id:unknown){
 const row=await d.prepare("SELECT project_id projectId FROM activities WHERE id=?").bind(safe(id)).first<{projectId:number}>();
 return row?.projectId||0;
}
export async function canReadEmployee(d:D1Database,user:Identity,id:number){
 const scope=await accessScope(d,user);
 return scope.employeeIds.has(id);
}
export async function authorizePlanningAction(d:D1Database,user:Identity,action:string,body:Record<string,unknown>):Promise<boolean>{
 if(user.isAdmin)return true;
 const scope=await accessScope(d,user);
 const self=user.employeeId||0;
 if(!self)return false;
 const project=safe(body.projectId),employee=safe(body.employeeId),activity=safe(body.activityId||body.id);
 const context=action==="activity"||action==="project"||action==="updateProject"||action==="workPackage"||action==="updateWorkPackage"?project:await projectOfActivity(d,activity);
 const isProjectLead=scope.projectLedIds.has(context);
 const managerOf=(id:number)=>scope.managedIds.has(id);
 switch(action){
 case "activity":
   // Any project participant can create an activity (automatically assigned to self).
   return scope.projectIds.has(project);
 case "updateProject":return scope.projectLedIds.has(safe(body.id));
 case "workPackage":return scope.projectLedIds.has(project);
 case "updateWorkPackage":{
  const old=await d.prepare("SELECT project_id projectId FROM work_packages WHERE id=?").bind(safe(body.id)).first<{projectId:number}>();
  return !!old&&scope.projectLedIds.has(old.projectId)&&scope.projectLedIds.has(project);
 }
 case "updateActivity":{
   const existingProject=await projectOfActivity(d,activity);
   const nextProject=safe(body.projectId);
   if(scope.projectLedIds.has(existingProject)&&scope.projectLedIds.has(nextProject))return true;
   const origin=await d.prepare("SELECT created_by employeeId FROM activities WHERE id=?").bind(activity).first<{employeeId:number|null}>();
   const teammates=await d.prepare("SELECT COUNT(*) count FROM assignments WHERE activity_id=? AND employee_id<>?").bind(activity,self).first<{count:number}>();
   return origin?.employeeId===self&&nextProject===existingProject&&(teammates?.count??0)===0;
 }
 case "setAssignmentStatus":
 case "setAssignmentPeriods":
   return employee===self||managerOf(employee)||isProjectLead;
 case "setActivityStatus":
   if(isProjectLead)return true;
   const c=await d.prepare("SELECT COUNT(*) n FROM assignments WHERE activity_id=? AND employee_id<>?").bind(activity,self).first<{n:number}>();
   return c?.n===0&&!!await d.prepare("SELECT id FROM assignments WHERE activity_id=? AND employee_id=?").bind(activity,self).first();
 case "setActivityAssignments":
   return isProjectLead;
 case "setProjectMemberships":
   return managerOf(employee);
 case "setEmployeeProjectOrder":
 case "resetEmployeeProjectOrder":
   return employee===self||managerOf(employee);
 case "saveEmployeeGroup":{
   // Group managers can create/update teams with only their own direct reports.
   const members=Array.isArray(body.employeeIds)?body.employeeIds.map(Number):[];
   if(!members.every(id=>id===self||managerOf(id)))return false;
   if(body.id!==undefined&&body.id!==null){
    const team=await d.prepare("SELECT owner_id ownerId FROM employee_groups WHERE id=?").bind(safe(body.id)).first<{ownerId:number|null}>();
    if(!team||team.ownerId!==self)return false;
    const rows=await d.prepare("SELECT employee_id id FROM employee_group_members WHERE group_id=?").bind(safe(body.id)).all<{id:number}>();
    return rows.results.every(r=>r.id===self||managerOf(r.id));
   }
   return scope.managedIds.size>0;
 }
 case "employee":
   return scope.managedIds.size>0;
 default:return false;
 }
}
export function filteredSnapshot<T extends Record<string,any>>(data:T,user:Identity,scope:AccessScope):T{
 if(user.isAdmin)return data;
 const activities=(data.activities||[]).filter((a:{projectId:number})=>scope.projectIds.has(a.projectId));
 const allowedActivities=new Set(activities.map((a:{id:number})=>a.id));
 const allowedEmployees=new Set(scope.employeeIds);
 const assignments=(data.assignments||[]).filter((a:{activityId:number;employeeId:number})=>allowedActivities.has(a.activityId)&&(allowedEmployees.has(a.employeeId)||scope.projectLedIds.has(activities.find((x:{id:number})=>x.id===a.activityId)?.projectId)));
 const visibleAssignmentIds=new Set(assignments.map((a:{id:number})=>a.id));
 const visibleTeams=new Set(scope.teamIds);
 return {...data,
  employees:(data.employees||[]).filter((e:{id:number})=>allowedEmployees.has(e.id)),
  projects:(data.projects||[]).filter((p:{id:number})=>scope.projectIds.has(p.id)),
  workPackages:(data.workPackages||[]).filter((w:{projectId:number})=>scope.projectIds.has(w.projectId)),
  activities,
  assignments,
  assignmentPeriods:(data.assignmentPeriods||[]).filter((p:{assignmentId:number})=>visibleAssignmentIds.has(p.assignmentId)),
  projectMembers:(data.projectMembers||[]).filter((x:{employeeId:number;projectId:number})=>allowedEmployees.has(x.employeeId)&&scope.projectIds.has(x.projectId)),
  employeeProjectOrders:(data.employeeProjectOrders||[]).filter((x:{employeeId:number;projectId:number})=>allowedEmployees.has(x.employeeId)&&scope.projectIds.has(x.projectId)),
  employeeGroups:(data.employeeGroups||[]).filter((x:{id:number})=>visibleTeams.has(x.id)),
  employeeGroupMembers:(data.employeeGroupMembers||[]).filter((x:{groupId:number;employeeId:number})=>visibleTeams.has(x.groupId)&&allowedEmployees.has(x.employeeId)),
  individualFormItems:[],
  individualWeekMoves:[],
  individualProjectStates:[],
  individualImportRuns:[],
  projectLeaders:(data.projectLeaders||[]).filter((x:{projectId:number})=>scope.projectIds.has(x.projectId)),
  teamLeaders:(data.teamLeaders||[]).filter((x:{teamId:number})=>visibleTeams.has(x.teamId)),
 };
}
