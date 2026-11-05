/** Administrative resolution of a departing employee's recorded time.
 * Live entries retain FK and audit history via a non-person group ledger row;
 * no historical time record points to the deleted employee.
 */
export type EmployeeTimeImpact={
 employeeId:number;entryCount:number;activeEntryCount:number;deletedEntryCount:number;
 runningEntryCount:number;totalSeconds:number;fingerprint:string
};
export async function employeeTimeImpact(d:D1Database,employeeId:number):Promise<EmployeeTimeImpact>{
 const r=await d.prepare(`SELECT COUNT(*) entryCount,
 SUM(CASE WHEN ended_at IS NOT NULL AND deleted_at IS NULL THEN 1 ELSE 0 END) activeEntryCount,
 SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) deletedEntryCount,
 SUM(CASE WHEN ended_at IS NULL THEN 1 ELSE 0 END) runningEntryCount,
 COALESCE(SUM(CASE WHEN deleted_at IS NULL THEN duration_seconds ELSE 0 END),0) totalSeconds,
 COALESCE(MAX(id),0) maxId,
 COALESCE(SUM(id),0) sumIds,
 COALESCE(SUM(updated_at),0) sumUpdated
 FROM time_entries WHERE employee_id=?`).bind(employeeId).first<{
  entryCount:number;activeEntryCount:number|null;deletedEntryCount:number|null;runningEntryCount:number|null;
  totalSeconds:number;maxId:number;sumIds:number;sumUpdated:number
 }>();
 const row=r??{entryCount:0,activeEntryCount:0,deletedEntryCount:0,runningEntryCount:0,
  totalSeconds:0,maxId:0,sumIds:0,sumUpdated:0};
 return {employeeId,entryCount:row.entryCount,activeEntryCount:row.activeEntryCount??0,
  deletedEntryCount:row.deletedEntryCount??0,runningEntryCount:row.runningEntryCount??0,
  totalSeconds:row.totalSeconds,
  fingerprint:[row.entryCount,row.maxId,row.sumIds,row.sumUpdated,row.totalSeconds,row.runningEntryCount??0].join(":")};
}
const ledgerSelect="(SELECT id FROM employees WHERE is_group_ledger=1 AND ledger_group_id=?)";
export function employeeGroupRetention(
 d:D1Database,employeeId:number,groupId:number,actorId:number,at:number
):D1PreparedStatement[]{
 const email=`deleted-group-${groupId}@internal.invalid`;
 return [
  d.prepare(`INSERT INTO employees(name,email,role,manager_id,capacity_percent,is_group_ledger,ledger_group_id)
   SELECT 'Borttagen medarbetare',?,'Gruppbokföring',NULL,0,1,g.id
   FROM employee_groups g WHERE g.id=?
   AND NOT EXISTS(SELECT 1 FROM employees e WHERE e.is_group_ledger=1 AND e.ledger_group_id=g.id)`)
    .bind(email,groupId),
  // Preserve existing audit sequence and an administrator event on every item.
  d.prepare(`INSERT INTO time_entry_audit(time_entry_id,actor_account_id,action,old_seconds,new_seconds,changed_at)
   SELECT id,?,'update',duration_seconds,duration_seconds,? FROM time_entries WHERE employee_id=?`)
    .bind(actorId,at,employeeId),
  d.prepare(`UPDATE time_entries
   SET employee_id=${ledgerSelect},reporting_group_id=?,
       reporting_group_name=(SELECT name FROM employee_groups WHERE id=?),updated_at=?
   WHERE employee_id=?`).bind(groupId,groupId,groupId,at,employeeId),
  // These historical audit snapshots contain only the numeric employee ID.
  // Replace it too; never leave a link back to the deleted physical person.
  d.prepare(`UPDATE time_entry_relocations SET employee_id=${ledgerSelect}
   WHERE employee_id=?`).bind(groupId,employeeId),
  // Earlier project purges may have archived the same person's identity.
  // Remove it from the historical archive when anonymizing group attribution.
  d.prepare(`UPDATE time_entry_removal_archive
   SET employee_id=${ledgerSelect},employee_email='',employee_name='Borttagen medarbetare'
   WHERE employee_id=?`).bind(groupId,employeeId)
 ];
}
/** Permanent removal keeps a source-ID tombstone and an administrative archive,
 * so a later external Tidrapport integration can retract previously synced hours.
 */
export function employeeTimePurge(
 d:D1Database,employeeId:number,actorId:number,at:number
):D1PreparedStatement[]{
 return [
  d.prepare("UPDATE time_entries SET deleted_at=COALESCE(deleted_at,?),updated_at=? WHERE employee_id=?")
   .bind(at,at,employeeId),
  d.prepare(`INSERT INTO time_entry_audit(time_entry_id,actor_account_id,action,old_seconds,new_seconds,changed_at)
   SELECT id,?,'delete',duration_seconds,NULL,? FROM time_entries WHERE employee_id=?`)
   .bind(actorId,at,employeeId),
  d.prepare(`INSERT INTO time_entry_removal_archive (
   source_event_id,original_entry_id,employee_id,employee_email,employee_name,
   original_project_id,original_project_code,original_project_name,original_activity_id,
   original_activity_code,original_activity_name,work_date,started_at,ended_at,
   duration_seconds,note,source,updated_at,was_deleted,removed_by_account_id,
   removed_at,removal_reason)
   SELECT (SELECT MAX(j.id) FROM time_entry_audit j WHERE j.time_entry_id=t.id),
    t.id,t.employee_id,'','Borttagen medarbetare',
    p.id,p.code,p.name,a.id,a.code,a.name,t.work_date,t.started_at,t.ended_at,
    t.duration_seconds,t.note,t.source,t.updated_at,1,?,?,'Administrativ borttagning av medarbetare'
   FROM time_entries t JOIN activities a ON a.id=t.activity_id
   JOIN projects p ON p.id=a.project_id WHERE t.employee_id=?`)
   .bind(actorId,at,employeeId),
  d.prepare("DELETE FROM time_entry_audit WHERE time_entry_id IN (SELECT id FROM time_entries WHERE employee_id=?)")
   .bind(employeeId),
  d.prepare("DELETE FROM time_entries WHERE employee_id=?").bind(employeeId),
  d.prepare(`UPDATE time_entry_relocations SET employee_id=0 WHERE employee_id=?`).bind(employeeId),
  d.prepare(`UPDATE time_entry_removal_archive SET employee_id=0,employee_email='',employee_name='Borttagen medarbetare'
   WHERE employee_id=?`).bind(employeeId)
 ];
}
