import type {Identity} from "@/lib/auth";
import {accessScope} from "@/lib/permissions";

export type ProposalContext = "project" | "team" | "group";
export type ProposalPerson = {id:number;name:string};
export type ProposalChoice = {id:number;name:string};

type EmployeeRow = {id:number;name:string;managerId:number|null};
type ContextData = {
  eligibleRecipients:ProposalPerson[];
  teams:ProposalChoice[];
  groups:ProposalChoice[];
  allowed:boolean;
};

const validId=(value:unknown)=>Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):0;

/**
 * Assignment proposals always concern a particular project.
 * Team or manager-group selection further narrows that project's members.
 * Never trust the caller's recipient dropdown: POST calls this function again.
 */
export async function proposalRecipients(
 d:D1Database,user:Identity,projectId:number,context:ProposalContext="project",contextId=0
):Promise<ContextData>{
 const empty:ContextData={eligibleRecipients:[],teams:[],groups:[],allowed:false};
 if(!validId(projectId)||!["project","team","group"].includes(context))return empty;
 const project=await d.prepare("SELECT id FROM projects WHERE id=?").bind(projectId).first();
 if(!project)return empty;
 const self=user.employeeId;
 if(!self)return empty; // Approvals require a traceable employee, including for admins.
 const scope=await accessScope(d,user);
 const participant=await d.prepare(`SELECT 1 ok FROM project_members WHERE project_id=? AND employee_id=?
  UNION SELECT 1 FROM assignments s JOIN activities a ON a.id=s.activity_id WHERE a.project_id=? AND s.employee_id=?
  UNION SELECT 1 FROM project_leaders WHERE project_id=? AND employee_id=?
  UNION SELECT 1 FROM work_package_leaders l JOIN work_packages w ON w.id=l.work_package_id WHERE w.project_id=? AND l.employee_id=? LIMIT 1`)
  .bind(projectId,self,projectId,self,projectId,self,projectId,self).first();
 if(!user.isAdmin&&!participant&&!scope.projectLedIds.has(projectId))return empty;
 const [employees,members,teamMembers,teams,managerNames]=await Promise.all([
  d.prepare("SELECT id,name,manager_id managerId FROM employees ORDER BY name").all<EmployeeRow>(),
  d.prepare(`SELECT employee_id employeeId FROM project_members WHERE project_id=?
     UNION SELECT s.employee_id FROM assignments s JOIN activities a ON a.id=s.activity_id WHERE a.project_id=?
     UNION SELECT employee_id FROM project_leaders WHERE project_id=?
     UNION SELECT l.employee_id FROM work_package_leaders l JOIN work_packages w ON w.id=l.work_package_id WHERE w.project_id=?`)
   .bind(projectId,projectId,projectId,projectId).all<{employeeId:number}>(),
  d.prepare(`SELECT group_id teamId,employee_id employeeId FROM employee_group_members
     UNION SELECT team_id teamId,employee_id employeeId FROM team_leaders`).all<{teamId:number;employeeId:number}>(),
  d.prepare("SELECT id,name FROM employee_groups ORDER BY name").all<ProposalChoice>(),
  d.prepare("SELECT id,name FROM employees WHERE id IN (SELECT manager_id FROM employees WHERE manager_id IS NOT NULL) ORDER BY name").all<ProposalChoice>(),
 ]);
 const actor=employees.results.find(e=>e.id===self);
 if(!actor)return empty;
 const memberIds=new Set(members.results.map(m=>m.employeeId));
 const teamIds=new Set(teamMembers.results.filter(t=>t.employeeId===self).map(t=>t.teamId));
 const managerIds=new Set<number>();
 if(actor.managerId)managerIds.add(actor.managerId);
 if(employees.results.some(e=>e.managerId===self))managerIds.add(self);
 const teamChoices=teams.results.filter(t=>user.isAdmin||teamIds.has(t.id));
 const groupChoices=managerNames.results.filter(g=>user.isAdmin||managerIds.has(g.id));
 if(context==="team"&&(!validId(contextId)||!teamChoices.some(t=>t.id===contextId)))return {...empty,teams:teamChoices,groups:groupChoices};
 if(context==="group"&&(!validId(contextId)||!groupChoices.some(g=>g.id===contextId)))return {...empty,teams:teamChoices,groups:groupChoices};
 const contextTeamIds=context==="team"?new Set(teamMembers.results.filter(t=>t.teamId===contextId).map(t=>t.employeeId)):null;
 const recipients=employees.results.filter(e=>{
  if(e.id===self)return false;
  if(!user.isAdmin&&!memberIds.has(e.id))return false;
  if(contextTeamIds&&!contextTeamIds.has(e.id))return false;
  if(context==="group"&&e.id!==contextId&&e.managerId!==contextId)return false;
  return true;
 }).map(({id,name})=>({id,name}));
 return {allowed:true,eligibleRecipients:recipients,teams:teamChoices,groups:groupChoices};
}
