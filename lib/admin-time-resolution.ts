import {activityIdsInScope,type DeletableKind} from "./delete-time-impact";

/**
 * Atomic statements for an ADMIN-approved resolution of time entries before
 * permanently deleting an activity tree or project.
 *
 * Transfer preserves the source entry ID, employee, work date, duration and
 * existing audit. Only its new activity/project linkage changes.
 * Purge archives a full snapshot plus one globally sequenced sync tombstone
 * before removing FK-dependent time_entry_audit and time_entries rows.
 */
export function timeResolutionStatements(
 d:D1Database,kind:DeletableKind,sourceId:number,mode:"transfer"|"purge",
 actor:number,at:number,targetId:number|null,reason:string
):D1PreparedStatement[]{
 const scope=activityIdsInScope(kind);
 const filter=`t.activity_id IN (${scope})`;
 if(mode==="transfer"){
  if(!targetId)throw Error("Mottagande aktivitet saknas.");
  return [
   d.prepare(`INSERT INTO time_entry_relocations(
    entry_id,employee_id,original_project_id,original_project_code,original_project_name,
    original_activity_id,original_activity_code,original_activity_name,
    target_project_id,target_project_code,target_project_name,
    target_activity_id,target_activity_code,target_activity_name,
    work_date,duration_seconds,actor_account_id,occurred_at,reason)
    SELECT t.id,t.employee_id,p.id,p.code,p.name,a.id,a.code,a.name,
    targetP.id,targetP.code,targetP.name,target.id,target.code,target.name,
    t.work_date,t.duration_seconds,?,?,?
    FROM time_entries t JOIN activities a ON a.id=t.activity_id
    JOIN projects p ON p.id=a.project_id
    CROSS JOIN activities target JOIN projects targetP ON targetP.id=target.project_id
    WHERE target.id=? AND ${filter}`).bind(actor,at,reason,targetId,sourceId),
   d.prepare(`UPDATE time_entries SET activity_id=?,updated_at=? WHERE activity_id IN (${scope})`)
    .bind(targetId,at,sourceId),
   // Use the existing 'update' audit event for the outbound Tidrapport adapter.
   d.prepare(`INSERT INTO time_entry_audit(time_entry_id,actor_account_id,action,old_seconds,new_seconds,changed_at)
    SELECT t.id,?,'update',t.duration_seconds,t.duration_seconds,? FROM time_entries t
    WHERE t.activity_id=? AND t.updated_at=? AND
      EXISTS(SELECT 1 FROM time_entry_relocations r WHERE r.entry_id=t.id AND r.actor_account_id=? AND r.occurred_at=?)`)
    .bind(actor,at,targetId,at,actor,at)
  ];
 }
 return [
  d.prepare(`UPDATE time_entries SET deleted_at=COALESCE(deleted_at,?),updated_at=? WHERE activity_id IN (${scope})`)
   .bind(at,at,sourceId),
  d.prepare(`INSERT INTO time_entry_audit(time_entry_id,actor_account_id,action,old_seconds,new_seconds,changed_at)
    SELECT t.id,?,'delete',t.duration_seconds,NULL,? FROM time_entries t
    WHERE ${filter}`).bind(actor,at,sourceId),
  d.prepare(`INSERT INTO time_entry_removal_archive(
    source_event_id,original_entry_id,employee_id,employee_email,employee_name,
    original_project_id,original_project_code,original_project_name,
    original_activity_id,original_activity_code,original_activity_name,
    work_date,started_at,ended_at,duration_seconds,note,source,updated_at,
    was_deleted,removed_by_account_id,removed_at,removal_reason)
    SELECT (SELECT MAX(j.id) FROM time_entry_audit j WHERE j.time_entry_id=t.id),
    t.id,t.employee_id,
    CASE WHEN e.is_group_ledger=1 THEN '' ELSE e.email END,
    CASE WHEN e.is_group_ledger=1 THEN 'Borttagen medarbetare' ELSE e.name END,
    p.id,p.code,p.name,
    a.id,a.code,a.name,t.work_date,t.started_at,t.ended_at,t.duration_seconds,
    t.note,t.source,t.updated_at,1,?,?,?
    FROM time_entries t JOIN employees e ON e.id=t.employee_id
    JOIN activities a ON a.id=t.activity_id JOIN projects p ON p.id=a.project_id
    WHERE ${filter}`).bind(actor,at,reason,sourceId),
  d.prepare(`DELETE FROM time_entry_audit WHERE time_entry_id IN
   (SELECT t.id FROM time_entries t WHERE ${filter})`).bind(sourceId),
  d.prepare(`DELETE FROM time_entries WHERE activity_id IN (${scope})`).bind(sourceId)
 ];
}
