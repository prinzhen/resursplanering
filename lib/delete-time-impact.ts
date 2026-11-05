/** Common, bound SQL scopes for safe deletion and relocation of logged time. */
export type DeletableKind="project"|"workPackage"|"activity";
export const deletableKind=(raw:unknown):raw is DeletableKind=>
 raw==="project"||raw==="workPackage"||raw==="activity";
export const activityIdsInScope=(kind:DeletableKind):string=>
 kind==="project"?"SELECT id FROM activities WHERE project_id=?":
 kind==="workPackage"?
  "WITH RECURSIVE tree(id) AS (SELECT id FROM activities WHERE work_package_id=? UNION SELECT a.id FROM activities a JOIN tree t ON a.parent_activity_id=t.id) SELECT id FROM tree":
  "WITH RECURSIVE tree(id) AS (SELECT id FROM activities WHERE id=? UNION SELECT a.id FROM activities a JOIN tree t ON a.parent_activity_id=t.id) SELECT id FROM tree";
export type DeleteImpact={
 kind:DeletableKind;
 id:number;
 entryCount:number;
 activeEntryCount:number;
 deletedEntryCount:number;
 runningEntryCount:number;
 totalSeconds:number;
 fingerprint:string;
};
export async function deletionImpact(d:D1Database,kind:DeletableKind,id:number):Promise<DeleteImpact>{
 const scope=activityIdsInScope(kind);
 const r=await d.prepare(`SELECT COUNT(*) entries,
 COALESCE(SUM(CASE WHEN deleted_at IS NULL AND ended_at IS NOT NULL THEN 1 ELSE 0 END),0) activeEntries,
 COALESCE(SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END),0) deletedEntries,
 COALESCE(SUM(CASE WHEN ended_at IS NULL THEN 1 ELSE 0 END),0) runningEntries,
 COALESCE(SUM(CASE WHEN deleted_at IS NULL THEN duration_seconds ELSE 0 END),0) seconds,
 COALESCE(MAX(id),0) maxId,
 COALESCE(SUM(id),0) sumIds,
 COALESCE(SUM(updated_at),0) sumUpdated
 FROM time_entries WHERE activity_id IN (${scope})`).bind(id).first<{
  entries:number;activeEntries:number;deletedEntries:number;runningEntries:number;
  seconds:number;maxId:number;sumIds:number;sumUpdated:number
 }>();
 const e=r??{entries:0,activeEntries:0,deletedEntries:0,runningEntries:0,seconds:0,maxId:0,sumIds:0,sumUpdated:0};
 return {kind,id,entryCount:e.entries,activeEntryCount:e.activeEntries,
  deletedEntryCount:e.deletedEntries,runningEntryCount:e.runningEntries,
  totalSeconds:e.seconds,
  fingerprint:[e.entries,e.maxId,e.sumIds,e.sumUpdated,e.seconds,e.runningEntries].join(":")};
}
