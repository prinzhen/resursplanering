/**
 * Import uses Europe/Stockholm calendar dates (rather than UTC midnight).
 * Priority is global for an activity; effort periods are effective-dated per assignment.
 */
export const importDateSweden=(at:Date=new Date())=>new Intl.DateTimeFormat("sv-SE",{
 timeZone:"Europe/Stockholm",year:"numeric",month:"2-digit",day:"2-digit"
}).format(at);
export function previousISODate(iso:string){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(iso))throw Error("Ogiltigt datum");
 const date=new Date(iso+"T00:00:00Z");
 if(Number.isNaN(date.getTime()))throw Error("Ogiltigt datum");
 date.setUTCDate(date.getUTCDate()-1);
 return date.toISOString().slice(0,10);
}
export function parseExcelPriority(raw:unknown):number|null{
 const value=String(raw??"").trim();
 if(!value)return null; // Older templates without a priority preserve the stored value.
 if(!/^[1-5]$/.test(value))throw Error("Prioritet ska vara ett heltal mellan 1 och 5.");
 return Number(value);
}
export type Period={id:number;assignmentId:number;startDate:string;endDate:string;effortPercent:number};
export type SplitPeriod={before:{id:number;endDate:string}|null;after:{assignmentId:number;startDate:string;endDate:string;effortPercent:number}|null};
export function splitAtPriorityChange(p:Period,date:string):SplitPeriod|null{
 if(date<p.startDate||date>p.endDate)return null;
 if(p.startDate===date)return {before:null,after:null}; // Already starts on this date; avoid duplicate rows.
 return {before:{id:p.id,endDate:previousISODate(date)},after:{
  assignmentId:p.assignmentId,startDate:date,endDate:p.endDate,effortPercent:p.effortPercent
 }};
}
