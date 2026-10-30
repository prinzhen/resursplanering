export type ProjectSortInfo={id:number;name:string;code:string;priority:number};
export type ProjectSortAssignment={activityId:number;employeeId:number};
export type ProjectSortActivity={id:number;projectId:number};
export type ProjectSortOrder={employeeId:number;projectId:number;sortOrder:number};

export function defaultProjectOrder(
  employeeId:number,projects:ProjectSortInfo[],
  assignments:ProjectSortAssignment[],activities:ProjectSortActivity[]
){
 const ids=new Set(assignments.filter(a=>a.employeeId===employeeId).map(a=>activities.find(x=>x.id===a.activityId)?.projectId).filter((v):v is number=>v!==undefined));
 return [...projects].sort((a,b)=>
  Number(!ids.has(a.id))-Number(!ids.has(b.id))||
  (Number(a.priority)||3)-(Number(b.priority)||3)||
  a.name.localeCompare(b.name,"sv",{sensitivity:"base"})||
  a.code.localeCompare(b.code,"sv",{sensitivity:"base"})||a.id-b.id
 );
}

export function sortEmployeeProjects(
 employeeId:number,projects:ProjectSortInfo[],
 assignments:ProjectSortAssignment[],activities:ProjectSortActivity[],
 savedOrders:ProjectSortOrder[]
){
 const baseline=defaultProjectOrder(employeeId,projects,assignments,activities);
 const order=new Map(savedOrders.filter(o=>o.employeeId===employeeId).map(o=>[o.projectId,o.sortOrder]));
 if(!order.size)return baseline;
 const baselineIndex=new Map(baseline.map((p,i)=>[p.id,i]));
 return [...baseline].sort((a,b)=>{
  const aOrder=order.get(a.id),bOrder=order.get(b.id);
  if(aOrder!==undefined&&bOrder!==undefined)return aOrder-bOrder;
  if(aOrder!==undefined)return -1;
  if(bOrder!==undefined)return 1;
  return (baselineIndex.get(a.id)??0)-(baselineIndex.get(b.id)??0);
 });
}
