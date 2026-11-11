/** Project effort is the sum of every active assignment's effective daily
 * percent, grouped by employee. Each assignment contributes its one period
 * covering the chosen date; historical segments are never added together.
 * Percentages may exceed 100%; this is intentional over-allocation.
 */
export type ProjectEffortAssignment={id:number;employeeId:number;activityId:number;startDate:string;endDate:string;effortPercent:number;completedAt:string|null;workStatus:string|null};
export type ProjectEffortPeriod={assignmentId:number;startDate:string;endDate:string;effortPercent:number};
export function projectEffortOnDay(
 activityIds:ReadonlySet<number>,
 assignments:readonly ProjectEffortAssignment[],
 periods:readonly ProjectEffortPeriod[],
 day:string
):Map<number,number>{
 const byAssignment=new Map<number,ProjectEffortPeriod[]>();
 for(const period of periods){
  const list=byAssignment.get(period.assignmentId)||[];
  list.push(period);
  byAssignment.set(period.assignmentId,list);
 }
 const totals=new Map<number,number>();
 for(const a of assignments){
  if(!activityIds.has(a.activityId)||a.completedAt||["Fryst","Pausad"].includes(a.workStatus||""))continue;
  const active=(byAssignment.get(a.id)||[{assignmentId:a.id,startDate:a.startDate,endDate:a.endDate,effortPercent:a.effortPercent}])
   .filter(p=>p.startDate<=day&&p.endDate>=day);
  if(!active.length)continue;
  const value=active.reduce((sum,p)=>sum+p.effortPercent,0);
  totals.set(a.employeeId,(totals.get(a.employeeId)||0)+value);
 }
 return totals;
}
