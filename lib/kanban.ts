export const KANBAN_COLUMNS=["Planerad","Pågående","Pausad","Fryst","Klar"] as const;
export type KanbanStatus=typeof KANBAN_COLUMNS[number];
export type KEmployee={id:number;name:string};
export type KProject={id:number;name:string;code:string;color:string};
export type KActivity={id:number;projectId:number;name:string;code:string|null;status:string;startDate:string;endDate:string;description?:string|null};
export type KAssignment={id:number;activityId:number;employeeId:number;startDate:string;endDate:string;completedAt:string|null;workStatus:string|null};
export type KanbanCard={
 key:string;activityId:number;employeeId:number|null;
 title:string;project:string;projectColor:string;people:string[];
 startDate:string;endDate:string;status:KanbanStatus;
 description:string;
};
export const normalizeKanbanStatus=(s:string|null|undefined):KanbanStatus=>{
 if(s==="Klar"||s==="Fryst"||s==="Pausad"||s==="Planerad")return s;
 return "Pågående";
};
/** In a person/group board each assignment is one card, so distinct employee statuses are never merged. */
export function kanbanForPeople(ids:readonly number[],people:readonly KEmployee[],projects:readonly KProject[],activities:readonly KActivity[],assignments:readonly KAssignment[]):KanbanCard[]{
 const include=new Set(ids),activityById=new Map(activities.map(a=>[a.id,a])),
 projectById=new Map(projects.map(p=>[p.id,p])),personById=new Map(people.map(e=>[e.id,e]));
 return assignments.filter(a=>include.has(a.employeeId)).flatMap(assignment=>{
  const task=activityById.get(assignment.activityId);
  if(!task)return [];
  const project=projectById.get(task.projectId);
  return [{key:"assignment-"+assignment.id,activityId:task.id,employeeId:assignment.employeeId,
   title:(task.code?task.code+" · ":"")+task.name,project:(project?.code||"")+" · "+(project?.name||"Okänt projekt"),
   projectColor:project?.color||"#2563eb",people:[personById.get(assignment.employeeId)?.name||"Okänd"],
   startDate:assignment.startDate,endDate:assignment.endDate,
   status:assignment.completedAt?"Klar":normalizeKanbanStatus(assignment.workStatus||task.status),
   description:task.description||""}];
 }).sort((a,b)=>a.project.localeCompare(b.project,"sv")||a.title.localeCompare(b.title,"sv")||a.people[0].localeCompare(b.people[0],"sv"));
}
/** Project board shows one card per project activity; its status applies to all its assignments. */
export function kanbanForActivities(tasks:readonly KActivity[],people:readonly KEmployee[],projects:readonly KProject[],assignments:readonly KAssignment[]):KanbanCard[]{
 const projectById=new Map(projects.map(p=>[p.id,p])),personById=new Map(people.map(p=>[p.id,p]));
 return tasks.map(task=>{
  const project=projectById.get(task.projectId);
  return {key:"activity-"+task.id,activityId:task.id,employeeId:null,
   title:(task.code?task.code+" · ":"")+task.name,
   project:(project?.code||"")+" · "+(project?.name||"Okänt projekt"),
   projectColor:project?.color||"#2563eb",
   people:assignments.filter(s=>s.activityId===task.id).map(s=>personById.get(s.employeeId)?.name||"Okänd"),
   startDate:task.startDate,endDate:task.endDate,
   status:normalizeKanbanStatus(task.status),description:task.description||""};
 }).sort((a,b)=>a.project.localeCompare(b.project,"sv")||a.title.localeCompare(b.title,"sv"));
}
