/** Immutable history boundary for per-person planned effort imported from XLSX.
 * Overlay only explicitly provided future intervals, never flatten unrelated
 * future periods or re-write any day before effectiveDate.
 */
export type EffortSlice={startDate:string;endDate:string;effortPercent:number};
const nextDay=(date:string,days:number)=>{
 const d=new Date(date+"T00:00:00Z");
 d.setUTCDate(d.getUTCDate()+days);
 return d.toISOString().slice(0,10);
};
const sort=(items:EffortSlice[])=>items.slice().sort((a,b)=>a.startDate.localeCompare(b.startDate)||a.endDate.localeCompare(b.endDate));
function signature(items:EffortSlice[]){
 const merged:EffortSlice[]=[];
 for(const item of sort(items)){
  const prev=merged.at(-1);
  if(prev&&prev.effortPercent===item.effortPercent&&nextDay(prev.endDate,1)===item.startDate)
   prev.endDate=item.endDate;
  else merged.push({...item});
 }
 return JSON.stringify(merged);
}
export function overlayEffortPeriods(existing:EffortSlice[],requested:EffortSlice[],effectiveDate:string){
 let result=sort(existing);
 for(const proposal of sort(requested)){
  if(proposal.endDate<effectiveDate)continue;
  const start=proposal.startDate<effectiveDate?effectiveDate:proposal.startDate;
  const end=proposal.endDate;
  const remaining:EffortSlice[]=[];
  for(const previous of result){
   if(previous.endDate<start||previous.startDate>end){remaining.push(previous);continue}
   if(previous.startDate<start)remaining.push({...previous,endDate:nextDay(start,-1)});
   if(previous.endDate>end)remaining.push({...previous,startDate:nextDay(end,1)});
  }
  remaining.push({startDate:start,endDate:end,effortPercent:proposal.effortPercent});
  result=sort(remaining);
 }
 for(let i=1;i<result.length;i++){
  if(result[i-1].endDate>=result[i].startDate)throw Error("Överlappande insatsperioder efter sammanfogning.");
 }
 return {changed:signature(existing)!==signature(result),periods:result};
}
