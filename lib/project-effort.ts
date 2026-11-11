/** Historical project staffing load: sum assignments for each employee,
 * never historical period rows. A period average is weighted by weekdays.
 */
export type ProjectEffortAssignment={id:number;employeeId:number;activityId:number;startDate:string;endDate:string;effortPercent:number;completedAt:string|null;workStatus:string|null};
export type ProjectEffortPeriod={assignmentId:number;startDate:string;endDate:string;effortPercent:number};
const weekdays=(from:string,to:string)=>{
 if(from>to)return 0;
 const d=new Date(from+"T00:00:00Z"),end=new Date(to+"T00:00:00Z");
 let count=0;
 for(;d<=end;d.setUTCDate(d.getUTCDate()+1))if(d.getUTCDay()!==0&&d.getUTCDay()!==6)count++;
 return count;
};
export function projectEffortForPeriod(
 activityIds:ReadonlySet<number>,
 assignments:readonly ProjectEffortAssignment[],
 periods:readonly ProjectEffortPeriod[],
 start:string,end:string,
 today=new Date().toISOString().slice(0,10)
):Map<number,number>{
 const duration=weekdays(start,end);
 if(!duration)return new Map();
 const byAssignment=new Map<number,ProjectEffortPeriod[]>();
 for(const p of periods){
  const list=byAssignment.get(p.assignmentId)||[];
  list.push(p);byAssignment.set(p.assignmentId,list);
 }
 const totals=new Map<number,number>();
 for(const a of assignments){
  if(!activityIds.has(a.activityId))continue;
  // Paused/frozen status is current-state metadata, not historical status.
  if(end>=today&&["Fryst","Pausad"].includes(a.workStatus||""))continue;
  const effectiveEnd=a.completedAt&&a.completedAt<end?a.completedAt:end;
  const timeline=byAssignment.get(a.id)||[{assignmentId:a.id,startDate:a.startDate,endDate:a.endDate,effortPercent:a.effortPercent}];
  let personWeighted=0;
  for(const p of timeline){
   const first=p.startDate>start?p.startDate:start;
   const last=p.endDate<effectiveEnd?p.endDate:effectiveEnd;
   personWeighted+=p.effortPercent*weekdays(first,last);
  }
  if(personWeighted)totals.set(a.employeeId,(totals.get(a.employeeId)||0)+personWeighted/duration);
 }
 return new Map([...totals].map(([id,value])=>[id,Math.round(value*100)/100]));
}
export function projectEffortOnDay(
 activityIds:ReadonlySet<number>,assignments:readonly ProjectEffortAssignment[],periods:readonly ProjectEffortPeriod[],day:string
):Map<number,number>{
 // A one-day date lookup also includes weekends, where planned effort
 // still has a defined value (the same daily allocation as weekdays).
 const byAssignment=new Map<number,ProjectEffortPeriod[]>();
 for(const p of periods){const list=byAssignment.get(p.assignmentId)||[];list.push(p);byAssignment.set(p.assignmentId,list)}
 const totals=new Map<number,number>();
 const today=new Date().toISOString().slice(0,10);
 for(const a of assignments){
  if(!activityIds.has(a.activityId))continue;
  if(day>=today&&["Fryst","Pausad"].includes(a.workStatus||""))continue;
  if(a.completedAt&&day>a.completedAt)continue;
  for(const p of byAssignment.get(a.id)||[{assignmentId:a.id,startDate:a.startDate,endDate:a.endDate,effortPercent:a.effortPercent}]){
   if(p.startDate<=day&&p.endDate>=day)totals.set(a.employeeId,(totals.get(a.employeeId)||0)+p.effortPercent);
  }
 }
 return totals;
}
