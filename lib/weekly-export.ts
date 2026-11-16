import {normalizeISOWeek,currentWeekKey,type WeeklyV2Row} from "./weekly-xlsx-v2.ts";
import {rowFromDates,hoursForSchedule} from "./activity-calendar.ts";
import type {FormValues} from "./individual-xlsx.ts";

const parseOldWeek=(value:string)=>{const m=/^(\d{4})-[VW](\d{1,2})/i.exec(value.trim());return m?normalizeISOWeek(m[1]+"-V"+m[2]):"";};
function rangeDuration(start:string,end:string):number|null{
 if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end))return null;
 const a=Date.parse(start+"T00:00:00Z"),b=Date.parse(end+"T00:00:00Z");
 return b>=a?Math.round((b-a)/86400000)+1:null;
}
function weekFromDate(date:string):string{
 const d=new Date(date+"T00:00:00Z");d.setUTCDate(d.getUTCDate()+3-((d.getUTCDay()+6)%7));
 const year=d.getUTCFullYear(),first=new Date(Date.UTC(year,0,4));
 first.setUTCDate(first.getUTCDate()-((first.getUTCDay()+6)%7));
 const number=1+Math.round((d.getTime()-first.getTime())/604800000);
 return normalizeISOWeek(year+"-V"+number);
}
/** One exported row per employee/activity, even when legacy allocations contain many periods. */
export function asWeeklyRows(data:FormValues,employeeId:number,identities:Array<{uid:string;activityId:number;startDate:string;endDate:string}>):WeeklyV2Row[]{
 const byUid=new Map(identities.map(x=>[x.uid,x]));
 const groups=new Map<string,FormValues["activities"]>();
 for(const a of data.activities){
  const list=groups.get(a.uid)||[];list.push(a);groups.set(a.uid,list);
 }
 return [...groups.entries()].map(([uid,periods]):WeeklyV2Row=>{
  const first=periods[0],identity=byUid.get(uid),activityId=identity?.activityId;
  const starts=periods.map(p=>p.periodStart).filter((x):x is string=>!!x&&/^\d{4}-\d{2}-\d{2}$/.test(x));
  const ends=periods.map(p=>p.periodEnd).filter((x):x is string=>!!x&&/^\d{4}-\d{2}-\d{2}$/.test(x));
  const start=identity?.startDate||starts.sort()[0],end=identity?.endDate||ends.sort().at(-1);
  const dates=start&&end&&end>=start?rowFromDates(start,end):
   {week:parseOldWeek(first.week)||currentWeekKey(),day:"",duration:"1 vecka"};
  const effort=periods.at(-1)?.effortPercent??first.effortPercent??null;
  const projectCode=first.projectCode||(first.kind==="Verksamhet"?"INTERNAL-VERK":first.kind==="Övrigt"?"INTERNAL-OVR":"");
  return {...dates,task:first.name,effort,workType:first.kind,
   hours:effort===null?first.hours??null:hoursForSchedule({...dates,effort}),status:first.status,priority:first.priority,
   deadline:first.dueDate||"",projectCode,projectName:first.link,
   firstWeek:parseOldWeek(first.firstWeek)||dates.week,comment:first.comment,moveReason:first.reason,
   activityId:activityId?"activity-"+activityId:uid,
   rowKey:activityId?"plan-"+employeeId+"-"+activityId:"",
   rowRevision:0};
 });
}
