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
function scheduledBounds(row:WeeklyLoadRow){
 const start=new Date(Date.UTC(1970,0,1));
 // Resolve ISO week to actual calendar start, including year boundaries.
 const [year,num]=normalizeISOWeek(row.week).split("-V").map(Number);
 start.setTime(Date.UTC(year,0,4));
 start.setUTCDate(start.getUTCDate()-((start.getUTCDay()+6)%7)+(num-1)*7+(row.weekday===null?0:row.weekday-1));
 const finish=new Date(start);
 finish.setUTCDate(finish.getUTCDate()+row.durationDays-1);
 return {start,finish};
}
function workdays(from:Date,to:Date):number{
 if(to<from)return 0;
 const days=Math.floor((to.getTime()-from.getTime())/86400000)+1;
 const whole=Math.floor(days/7),extra=days%7;
 let total=whole*5;
 for(let i=0;i<extra;i++)if((from.getUTCDay()+i)%7!==0&&(from.getUTCDay()+i)%7!==6)total++;
 return total;
}
/** Explicit weekly activity rows REPLACE historical allocation for affected weeks,
 * never add to it. Calendar spans are spread across working days (Mon–Fri).
 */
export function weeklyOverridePercent(rows:WeeklyLoadRow[],activityId:number,employeeId:number,day:string):number|undefined{
 const date=new Date(day+"T00:00:00Z"),weekday=date.getUTCDay();
 if(Number.isNaN(date.getTime()))throw Error("Ogiltigt datum");
 const isoWeek=dateWeek(day);
 const [year,num]=isoWeek.split("-V").map(Number);
 const monday=new Date(Date.UTC(year,0,4));
 monday.setUTCDate(monday.getUTCDate()-((monday.getUTCDay()+6)%7)+(num-1)*7);
 const sunday=new Date(monday);sunday.setUTCDate(sunday.getUTCDate()+6);
 let found=false,hours=0;
 for(const row of rows){
  if(row.activityId!==activityId||row.employeeId!==employeeId)continue;
  const {start,finish}=scheduledBounds(row);
  if(start>sunday||finish<monday)continue;
  found=true;
  if(weekday===0||weekday===6||date<start||date>finish)continue;
  const count=workdays(start,finish);
  if(count)hours+=(row.hours??(count*8*(row.effort??0)/100))/count;
 }
 if(!found)return undefined;
 return Math.round(hours/8*100*100)/100;
}
