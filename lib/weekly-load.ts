import {normalizeISOWeek} from "./weekly-xlsx-v2.ts";

export type WeeklyLoadRow={
 activityId:number;employeeId:number;week:string;weekday:number|null;
 durationDays:number;effort:number|null;hours:number|null;
};
/** ISO week for a UTC YYYY-MM-DD date. */
export function dateWeek(day:string):string{
 if(!/^\d{4}-\d{2}-\d{2}$/.test(day))throw Error("Ogiltigt datum");
 const date=new Date(day+"T00:00:00Z");
 if(Number.isNaN(date.getTime())||date.toISOString().slice(0,10)!==day)throw Error("Ogiltigt datum");
 date.setUTCDate(date.getUTCDate()+3-((date.getUTCDay()+6)%7));
 const year=date.getUTCFullYear(),jan4=new Date(Date.UTC(year,0,4));
 jan4.setUTCDate(jan4.getUTCDate()-((jan4.getUTCDay()+6)%7));
 return normalizeISOWeek(year+"-V"+(1+Math.round((date.getTime()-jan4.getTime())/604800000)));
}
/**
 * Return undefined when legacy assignment_periods should determine load.
 * Return a number (including 0) when explicit weekly rows replace legacy
 * loading for this activity, person and ISO week.
 * Hours are never added on top of legacy assignment periods.
 */
export function weeklyOverridePercent(rows:WeeklyLoadRow[],activityId:number,employeeId:number,day:string):number|undefined{
 const date=new Date(day+"T00:00:00Z");
 const weekday=(date.getUTCDay()+6)%7+1;
 const week=dateWeek(day);
 const selected=rows.filter(r=>r.activityId===activityId&&r.employeeId===employeeId&&r.week===week);
 if(!selected.length)return undefined;
 if(weekday>5)return 0;
 let hours=0;
 for(const row of selected){
  const expected=row.hours??(row.weekday===null
   ?Math.min(row.durationDays,5)*8*(row.effort??0)/100
   :8*(row.effort??0)/100);
  if(row.weekday===null)hours+=expected/5;
  else if(row.weekday===weekday)hours+=expected;
 }
 return Math.round(hours/8*100*100)/100;
}
