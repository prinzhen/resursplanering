import {rowCalendarRange,parseDurationDays,normalizeISOWeek,weekKeyForDate,WEEK_DAYS,type WeeklyV2Row} from "./weekly-xlsx-v2.ts";

/** Calendar duration is inclusive: a 10-week activity starting Tuesday ends Monday 69 days later. */
export function scheduleDates(row:Pick<WeeklyV2Row,"week"|"day"|"duration">){
 return rowCalendarRange(normalizeISOWeek(row.week),row.day,parseDurationDays(row.duration));
}
export function rowFromDates(start:string,end:string):Pick<WeeklyV2Row,"week"|"day"|"duration">{
 const first=new Date(start+"T00:00:00Z"),last=new Date(end+"T00:00:00Z");
 if(Number.isNaN(first.getTime())||Number.isNaN(last.getTime())||first.toISOString().slice(0,10)!==start||
  last.toISOString().slice(0,10)!==end||last<first)throw Error("Ogiltigt start- eller slutdatum");
 const days=Math.round((last.getTime()-first.getTime())/86400000)+1;
 const weeks=Math.floor(days/7),rest=days%7;
 const duration=weeks?(weeks+" "+(weeks===1?"vecka":"veckor")+(rest?" "+rest+" "+(rest===1?"dag":"dagar"):"")):
   days+" "+(days===1?"dag":"dagar");
 const weekday=(first.getUTCDay()+6)%7+1;
 return {week:weekKeyForDate(start),day:WEEK_DAYS[weekday],duration};
}
export function workdaysBetween(start:string,end:string):number{
 const from=new Date(start+"T00:00:00Z"),to=new Date(end+"T00:00:00Z");
 if(Number.isNaN(from.getTime())||Number.isNaN(to.getTime())||to<from)return 0;
 let count=0;
 for(let d=from;d<=to;d.setUTCDate(d.getUTCDate()+1)){
  const wd=d.getUTCDay();if(wd!==0&&wd!==6)count++;
 }
 return count;
}
export function hoursForSchedule(row:Pick<WeeklyV2Row,"week"|"day"|"duration"|"effort">):number|null{
 if(row.effort===null)return null;
 const dates=scheduleDates(row);
 return Math.round(workdaysBetween(dates.start,dates.end)*8*row.effort)/100;
}
