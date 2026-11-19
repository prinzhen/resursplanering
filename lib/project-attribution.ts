/** Resolve project ownership by calendar day, without changing original
 * assignments, effort periods, or time entries. All dates are YYYY-MM-DD.
 * A move from Övrigt to a project records the former project in sourceProjectId.
 */
export type Reclassification={
 activityId:number;sourceProjectId:number;targetProjectId:number;
 effectiveFrom:string;id:number;
};
export type ProjectSlice={projectId:number;start:string;end:string};
export function previousDay(iso:string){
 const d=new Date(iso+"T00:00:00Z");d.setUTCDate(d.getUTCDate()-1);
 return d.toISOString().slice(0,10);
}
export function projectSlices(currentProjectId:number,activityId:number,start:string,end:string,changes:Reclassification[]):ProjectSlice[]{
 if(start>end)return [];
 const events=changes.filter(x=>x.activityId===activityId)
  .sort((a,b)=>a.effectiveFrom.localeCompare(b.effectiveFrom)||a.id-b.id);
 const points=[start,...events.map(x=>x.effectiveFrom).filter(x=>x>start&&x<=end)].sort();
 return points.map((begin,i)=>{
  const finish=i+1<points.length?previousDay(points[i+1]):end;
  const next=events.find(x=>x.effectiveFrom>begin);
  const projectId=next?next.sourceProjectId:currentProjectId;
  return {projectId,start:begin,end:finish};
 });
}
export function projectAtDate(currentProjectId:number,activityId:number,date:string,changes:Reclassification[]){
 return projectSlices(currentProjectId,activityId,date,date,changes)[0]?.projectId??currentProjectId;
}
