/**
 * Chefsvy filter. A GRUPP follows managerId (organizational line);
 * TEAM uses the explicit employee_groups membership table.
 * Selecting one person is independent of organizational membership.
 * The caller supplies only the employees visible to the signed-in user.
 */
export type ScopeEmployee={id:number;managerId:number|null};
export type ScopeTeamMember={groupId:number;employeeId:number};
export function filterChefEmployees<T extends ScopeEmployee>(
 employees:T[],teamMembers:ScopeTeamMember[],scope:string
):T[]{
 if(scope==="all")return employees;
 const [kind,idText,...extra]=scope.split(":");
 const id=Number(idText);
 if(extra.length||!Number.isSafeInteger(id)||id<=0)return [];
 switch(kind){
  case "group":
   return employees.filter(e=>e.managerId===id||e.id===id);
  case "team": {
   const members=new Set(teamMembers.filter(m=>m.groupId===id).map(m=>m.employeeId));
   return employees.filter(e=>members.has(e.id));
  }
  case "person":
   return employees.filter(e=>e.id===id);
  default:return [];
 }
}
