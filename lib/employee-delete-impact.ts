/** Only the employee's active and soft-deleted time rows are included.
 * Caller must authorize the administrator before exposing this preview.
 */
export async function employeeDeletionImpact(d:D1Database,employeeId:number){
 const person=await d.prepare("SELECT id,name,email FROM employees WHERE id=?")
  .bind(employeeId).first<{id:number;name:string;email:string}>();
 if(!person)return null;
 const entries=await d.prepare("SELECT id,duration_seconds durationSeconds,updated_at updatedAt,deleted_at deletedAt,ended_at endedAt FROM time_entries WHERE employee_id=? ORDER BY id")
  .bind(employeeId).all<{id:number;durationSeconds:number|null;updatedAt:number;deletedAt:number|null;endedAt:number|null}>();
 const rows=entries.results;
 const runningEntryCount=rows.filter(x=>x.endedAt===null).length;
 const deletedEntryCount=rows.filter(x=>x.deletedAt!==null).length;
 const totalSeconds=rows.reduce((s,x)=>s+(x.durationSeconds||0),0);
 // Include every time row's revision markers so stale admin confirmations fail.
 const fingerprint=JSON.stringify([employeeId,...rows.map(x=>[x.id,x.updatedAt,x.durationSeconds,x.deletedAt,x.endedAt])]);
 const account=await d.prepare("SELECT id,email FROM user_accounts WHERE employee_id=?").bind(employeeId).first<{id:number;email:string}>();
 return {employee:person,entryCount:rows.length,deletedEntryCount,runningEntryCount,totalSeconds,fingerprint,linkedAccount:account?.email||null};
}
