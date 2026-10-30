export const normalizeStatus=(status:string)=>status==="Pågår"?"Pågående":status;
export const validStatuses=["Planerad","Pågående","Pausad","Fryst","Klar"] as const;
export async function setAssignmentStatus(d:D1Database,activityId:number,employeeId:number,status:string){
 const row=await d.prepare("SELECT id,start_date startDate,end_date endDate,original_end_date originalEnd,completed_at completedAt FROM assignments WHERE activity_id=? AND employee_id=?").bind(activityId,employeeId).first<{id:number;startDate:string;endDate:string;originalEnd:string|null;completedAt:string|null}>();
 if(!row)return false;
 const today=new Date().toISOString().slice(0,10),end=row.originalEnd||row.endDate,done=status==="Klar";
 const actualEnd=done&&row.startDate<=today&&today<end?today:end;
 await d.prepare("UPDATE assignments SET work_status=?,completed_at=?,status_updated_at=CURRENT_TIMESTAMP,original_end_date=COALESCE(original_end_date,?),end_date=? WHERE id=?").bind(status,done?(row.completedAt||today):null,end,actualEnd,row.id).run();
 return true;
}
export async function reconcileActivityStatus(d:D1Database,id:number){
 const a=await d.prepare("SELECT work_status status,completed_at completedAt,original_end_date originalEnd,end_date endDate FROM assignments WHERE activity_id=?").bind(id).all<{status:string|null;completedAt:string|null;originalEnd:string|null;endDate:string}>();
 if(!a.results.length)return;
 const statuses=a.results.map(s=>normalizeStatus(s.status||(s.completedAt?"Klar":"Planerad")));
 const status=statuses.every(s=>s==="Klar")?"Klar":statuses.includes("Pågående")?"Pågår":statuses.includes("Planerad")?"Planerad":statuses.includes("Pausad")?"Pausad":statuses.includes("Fryst")?"Fryst":"Planerad";
 const plannedEnd=a.results.map(s=>s.originalEnd||s.endDate).sort().at(-1)!;
 const today=new Date().toISOString().slice(0,10);
 if(status==="Klar")await d.prepare("UPDATE activities SET status=?,end_date=CASE WHEN start_date<=? THEN MIN(end_date,?) ELSE end_date END WHERE id=?").bind(status,today,today,id).run();
 else await d.prepare("UPDATE activities SET status=?,end_date=MAX(end_date,?) WHERE id=?").bind(status,plannedEnd,id).run();
}
