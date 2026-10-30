import {env} from "cloudflare:workers";
import {sessionIdentity,unauthorized,forbidden,sameOrigin,passwordHash,randomHex} from "@/lib/auth";
import {accessScope} from "@/lib/permissions";
import type {FormValues} from "@/lib/individual-xlsx";
import {importDateSweden,parseExcelPriority,splitAtPriorityChange,type Period} from "@/lib/individual-priority";
export const dynamic="force-dynamic";
const db=()=>{if(!env.DB)throw Error("Databasen saknas.");return env.DB};
const txt=(v:unknown)=>String(v??"").trim();
function week(raw:string,now=new Date()):string{
 let s=raw.toLowerCase().trim().replace(/\([^)]*\)/g,"").replace(/v\.\s*/g,"").replace(/v\s*/g,"").trim();
 const match=/^(?:(\d{4})(?:\s*[- ]\s*w|\s+))?(\d{1,2})$/.exec(s);
 if(!match)throw Error("Felaktig vecka: "+raw);
 const ref=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()));
 ref.setUTCDate(ref.getUTCDate()+4-(ref.getUTCDay()||7));
 const year=match[1]?Number(match[1]):ref.getUTCFullYear(),w=Number(match[2]);
 if(year<1900||year>2100||w<1||w>53)throw Error("Ogiltig vecka: "+raw);
 const test=new Date(Date.UTC(year,0,4));test.setUTCDate(test.getUTCDate()-(test.getUTCDay()+6)%7+(w-1)*7);
 const thu=new Date(test);thu.setUTCDate(thu.getUTCDate()+3);
 if(thu.getUTCFullYear()!==year)throw Error("Vecka finns inte detta år: "+raw);
 return year+"-W"+String(w).padStart(2,"0");
}
function monday(raw:string):string{const [y,w]=raw.split("-W").map(Number),d=new Date(Date.UTC(y,0,4));d.setUTCDate(d.getUTCDate()-(d.getUTCDay()+6)%7+(w-1)*7);return d.toISOString().slice(0,10)}
function friday(raw:string):string{const d=new Date(monday(raw)+"T00:00:00Z");d.setUTCDate(d.getUTCDate()+4);return d.toISOString().slice(0,10)}
const validStates=new Set(["Planerad","Pågående","Pausad","Klar","Fryst"]);
const cleanStatus=(s:string)=>s==="Pågår"?"Pågående":s||"Planerad";
const safeUID=(s:string)=>/^[a-zA-Z0-9_-]{1,100}$/.test(s);
async function employee(d:D1Database,email:string){return d.prepare("SELECT id,name,email,manager_id managerId FROM employees WHERE lower(email)=lower(?)").bind(email).first<{id:number;name:string;email:string;managerId:number|null}>()}
const validEmail=(value:string)=>/^[^\s@]{1,80}@[^\s@]{1,150}\.[^\s@]{2,40}$/.test(value)&&value.length<=254;
const validProjectCode=(code:string)=>/^[A-Z0-9][A-Z0-9._-]{0,39}$/.test(code)&&!code.startsWith("INTERNAL-");
async function updateActivityPriority(d:D1Database,activityId:number,newPriority:number,effectiveDate:string,accountId:number){
 const existing=await d.prepare("SELECT id,priority,start_date startDate FROM activities WHERE id=?").bind(activityId).first<{id:number;priority:number;startDate:string}>();
 if(!existing)throw Error("Aktiviteten saknas vid prioriteringsändring.");
 if(existing.priority===newPriority)return false; // Import of the same file is idempotent.
 const commands:D1PreparedStatement[]=[];
 const history=await d.prepare("SELECT id FROM activity_priority_history WHERE activity_id=? LIMIT 1").bind(activityId).first();
 if(!history&&existing.startDate<effectiveDate){
  commands.push(d.prepare("INSERT OR IGNORE INTO activity_priority_history(activity_id,effective_from,priority,changed_by,source) VALUES(?,?,?,?,?)").bind(activityId,existing.startDate,existing.priority,accountId,"initial"));
 }
 commands.push(d.prepare("INSERT INTO activity_priority_history(activity_id,effective_from,priority,changed_by,source) VALUES(?,?,?,?,?) ON CONFLICT(activity_id,effective_from) DO UPDATE SET priority=excluded.priority,changed_by=excluded.changed_by,source=excluded.source").bind(activityId,effectiveDate,newPriority,accountId,"excel"));
 commands.push(d.prepare("UPDATE activities SET priority=? WHERE id=?").bind(newPriority,activityId));
 // Changing global activity priority must not rewrite historical allocation.
 // Split ONLY currently active periods. End the old one the day before
 // the new period starts, preventing overlap in Gantt and workload totals.
 const active=await d.prepare(`SELECT p.id,p.assignment_id assignmentId,p.start_date startDate,p.end_date endDate,p.effort_percent effortPercent
 FROM assignment_periods p JOIN assignments s ON s.id=p.assignment_id
 WHERE s.activity_id=? AND s.completed_at IS NULL AND p.start_date<? AND p.end_date>=?`)
 .bind(activityId,effectiveDate,effectiveDate).all<Period>();
 for(const period of active.results){
  const split=splitAtPriorityChange(period,effectiveDate);
  if(!split?.before||!split.after)continue;
  commands.push(d.prepare("UPDATE assignment_periods SET end_date=? WHERE id=?").bind(split.before.endDate,split.before.id));
  commands.push(d.prepare("INSERT INTO assignment_periods(assignment_id,start_date,end_date,effort_percent) VALUES(?,?,?,?)").bind(split.after.assignmentId,split.after.startDate,split.after.endDate,split.after.effortPercent));
 }
 await d.batch(commands);
 return true;
}

export async function GET(req:Request){
 try{
  const d=db(),identity=await sessionIdentity(req,d);if(!identity)return unauthorized();
  const u=new URL(req.url),email=txt(u.searchParams.get("email"));
  if(!email)return Response.json({error:"Välj en medarbetare."},{status:400});
  const e=await employee(d,email);if(!e)return Response.json({error:"Medarbetaren saknas."},{status:404});
  if(!identity.isAdmin&&identity.employeeId!==e.id&&!(identity.isGroupManager&&e.managerId===identity.employeeId))return forbidden(); // Manager may export direct report only.
  // Include existing project assignments as well as earlier spreadsheet items.
  const items=await d.prepare(`SELECT a.id activityId, COALESCE(i.item_uid,'employee-'||s.employee_id||'-activity-'||a.id) uid,
 COALESCE(i.current_week,'') savedWeek, COALESCE(i.first_week,'') firstWeek,
 a.name,a.description comment,a.status,a.priority,a.estimated_hours hours,a.start_date startDate,s.completed_at completedAt,s.work_status workStatus,
 p.code projectCode,p.name projectName,p.id projectId,
 CASE WHEN p.code='INTERNAL-VERK' THEN 'Verksamhet' WHEN p.code='INTERNAL-OVR' THEN 'Övrigt' ELSE 'Projekt' END kind
 FROM assignments s JOIN activities a ON a.id=s.activity_id JOIN projects p ON p.id=a.project_id
 LEFT JOIN individual_form_items i ON i.activity_id=a.id AND i.employee_id=s.employee_id
 WHERE s.employee_id=? ORDER BY a.start_date,a.name`).bind(e.id).all<Record<string,unknown>>();
  const tracked=await d.prepare(`SELECT i.item_uid uid,i.current_week savedWeek,i.first_week firstWeek,a.id activityId,a.name,a.description comment,a.status,a.priority,a.estimated_hours hours,a.start_date startDate,NULL completedAt,NULL workStatus,p.code projectCode,p.name projectName,p.id projectId,CASE WHEN p.code='INTERNAL-VERK' THEN 'Verksamhet' WHEN p.code='INTERNAL-OVR' THEN 'Övrigt' ELSE 'Projekt' END kind FROM individual_form_items i JOIN activities a ON a.id=i.activity_id JOIN projects p ON p.id=a.project_id LEFT JOIN assignments s ON s.activity_id=i.activity_id AND s.employee_id=i.employee_id WHERE i.employee_id=? AND s.id IS NULL ORDER BY a.start_date,a.name`).bind(e.id).all<Record<string,unknown>>();
  // A previously imported row must not disappear because its allocation link is missing.
  const sourceRows=[...items.results,...tracked.results];
  const iso=(raw:string)=>{const d=new Date(raw+'T00:00:00Z');if(Number.isNaN(d.getTime()))return '';d.setUTCDate(d.getUTCDate()+4-(d.getUTCDay()||7));const year=d.getUTCFullYear();const start=new Date(Date.UTC(year,0,1));return year+'-W'+String(Math.ceil(((d.getTime()-start.getTime())/86400000+1)/7)).padStart(2,'0')};
  const memberships=await d.prepare(`SELECT p.code,p.name,COALESCE(s.state,'Aktiv') state
 FROM project_members m JOIN projects p ON p.id=m.project_id
 LEFT JOIN individual_project_state s ON s.employee_id=m.employee_id AND s.project_id=p.id
 WHERE m.employee_id=? AND p.code NOT LIKE 'INTERNAL-%' ORDER BY p.code`).bind(e.id).all<{code:string;name:string;state:string}>();
  const result:FormValues={name:e.name,email:e.email,activities:sourceRows.filter(a=>u.searchParams.get("includeClosed")!=="0"||["Planerad","Pågående","Pausad","Pågår"].includes(String(a.workStatus||a.status))&&!a.completedAt).map(a=>({
   uid:String(a.uid),week:String(a.savedWeek||iso(String(a.startDate))),name:String(a.name),kind:String(a.kind),
   link:String(a.projectName||""),projectCode:String(a.projectCode).startsWith("INTERNAL-")?"":String(a.projectCode),
   hours:Number(a.hours||0),status:cleanStatus(String(a.workStatus||a.status)),priority:String(a.priority??3),dueDate:"",
   comment:String(a.comment||""),firstWeek:String(a.firstWeek||iso(String(a.startDate))),reason:""
  })),members:memberships.results};
  return Response.json(result);
 }catch(e){console.error(e);return Response.json({error:"Kunde inte läsa veckoplaneringen. Kontrollera att migrationen är körd."},{status:500})}
}
export async function POST(req:Request){
 try{
  const d=db(),identity=await sessionIdentity(req,d);if(!identity)return unauthorized();if(!sameOrigin(req))return forbidden();
  const input=await req.json() as FormValues;
  if(!input||!Array.isArray(input.activities)||input.activities.length>60||!Array.isArray(input.members)||input.members.length>34)return Response.json({error:"Ogiltig eller för stor import."},{status:400});
  const email=txt(input.email).toLowerCase();
  if(!validEmail(email))return Response.json({error:"E-postadressen är ogiltig."},{status:400});
  let e=await employee(d,email);
  const canCreate=identity.isAdmin||identity.isGroupManager;
  if(!e&&!canCreate)return Response.json({error:"Medarbetaren finns inte. Kontakta en gruppchef eller administratör för registrering."},{status:403});
  if(!identity.isAdmin&&e?.id!==identity.employeeId&&!(identity.isGroupManager&&(e===null||e.managerId===identity.employeeId)))return forbidden();
  if(!e&&(!txt(input.name)||txt(input.name).length>150))return Response.json({error:"Namn saknas eller är för långt för ny medarbetare."},{status:400});
  const importDate=importDateSweden();

  const allowed=await accessScope(d,identity);
  const changes:{uid:string;week:string;firstWeek:string;name:string;kind:string;projectCode:string;projectName:string;priority:number|null;hours:number;status:string;description:string;reason:string;activityId:number|null}[]=[];
  for(let i=0;i<input.activities.length;i++){
   const a=input.activities[i];const status=cleanStatus(txt(a.status));
   if(!txt(a.name)||txt(a.name).length>200)throw Error("Aktivitetsnamn saknas eller är för långt på rad "+(i+9));
   if(!validStates.has(status))throw Error("Ogiltig status på rad "+(i+9));
   const current=week(txt(a.week)),first=a.firstWeek?week(txt(a.firstWeek)):current;
   const hrs=Number(a.hours||0);if(!Number.isFinite(hrs)||hrs<0||hrs>100000)throw Error("Ogiltiga timmar på rad "+(i+9));
   const kind=txt(a.kind)||"Övrigt";if(!["Projekt","Verksamhet","Övrigt"].includes(kind))throw Error("Ogiltig typ på rad "+(i+9));
   const code=kind==="Verksamhet"?"INTERNAL-VERK":kind==="Övrigt"?"INTERNAL-OVR":txt(a.projectCode).toUpperCase();
   const priority=parseExcelPriority(a.priority);
   if(kind==="Projekt"&&!validProjectCode(code))throw Error("Ogiltig projektkod på rad "+(i+9));
   if(!code)throw Error("Projektkod saknas på rad "+(i+9));
   // A workbook created before the first successful import can have empty IDs.
   // Match only an unambiguous earlier import of the same activity for the
   // same employee, project and originally planned week; never guess otherwise.
   let uid=txt(a.uid);
   let matched:{itemUid:string;activityId:number}|null=null;
   if(!uid){
    const old=e?await d.prepare("SELECT i.item_uid itemUid,i.activity_id activityId FROM individual_form_items i JOIN activities t ON t.id=i.activity_id JOIN projects p ON p.id=t.project_id WHERE i.employee_id=? AND p.code=? AND lower(t.name)=lower(?) AND i.first_week=?").bind(e.id,code,txt(a.name),first).all<{itemUid:string;activityId:number}>():{results:[] as {itemUid:string;activityId:number}[]};
    if(old.results.length>1)throw Error("Flera befintliga aktiviteter matchar rad "+(i+9)+". Exportera på nytt för att få aktivitets-ID.");
    matched=old.results[0]||null;
    uid=matched?.itemUid||crypto.randomUUID();
   }
   if(!safeUID(uid))throw Error("Ogiltigt aktivitets-ID på rad "+(i+9));
   const legacy=/^activity-(\d+)$/.exec(uid);
   const scoped=/^employee-(\d+)-activity-(\d+)$/.exec(uid);
   if(scoped&&Number(scoped[1])!==e?.id)throw Error("Aktivitets-ID hör till en annan medarbetare.");
   const assignedId=legacy?Number(legacy[1]):scoped?Number(scoped[2]):null;
   const assigned=assignedId!==null&&e?await d.prepare("SELECT activity_id activityId FROM assignments WHERE activity_id=? AND employee_id=?").bind(assignedId,e.id).first<{activityId:number}>():null;
   const existing=assigned||matched||(e?await d.prepare("SELECT i.activity_id activityId FROM individual_form_items i WHERE i.item_uid=? AND i.employee_id=?").bind(uid,e.id).first<{activityId:number}>():null);
   if(a.uid&&!existing)throw Error("Aktivitets-ID "+uid+" tillhör inte denna medarbetare eller finns inte. Avbryter för att undvika dubbletter.");
   if(kind==="Projekt"){const p=await d.prepare("SELECT id FROM projects WHERE code=? COLLATE NOCASE").bind(code).first<{id:number}>();if(!p&&!canCreate)throw Error("Projektkoden "+code+" finns inte. Kontakta en gruppchef eller administratör.");if(p&&!canCreate&&!allowed.selfProjectIds.has(p.id)&&!allowed.projectLedIds.has(p.id))return forbidden()}
   changes.push({uid,week:current,firstWeek:first,name:txt(a.name),kind,projectCode:code,projectName:txt(a.link),priority,hours:hrs,status,description:txt(a.comment).slice(0,500),reason:txt(a.reason).slice(0,500),activityId:existing?.activityId??null});
  }
  const seenActivityIds=new Set<number>(),seenUIDs=new Set<string>();
  for(const a of changes){
    if(seenUIDs.has(a.uid))throw Error("Samma aktivitets-ID finns flera gånger i filen: "+a.uid);
    seenUIDs.add(a.uid);
    if(a.activityId!==null){
      if(seenActivityIds.has(a.activityId))throw Error("Samma projektaktivitet förekommer flera gånger i filen: "+a.name);
      seenActivityIds.add(a.activityId);
    }
  }
  const memberChanges:{code:string;name:string;state:string}[]=[];
  for(const m of input.members){
   const code=txt(m.code).toUpperCase();if(!code)continue;
   if(!validProjectCode(code))throw Error("Ogiltig projektkod under projektmedverkan: "+code);
   const project=await d.prepare("SELECT id FROM projects WHERE code=? COLLATE NOCASE").bind(code).first<{id:number}>();
   if(!project&&!canCreate)throw Error("Projektet "+code+" hittas inte.");
   if(project&&!canCreate&&!allowed.selfProjectIds.has(project.id)&&!allowed.projectLedIds.has(project.id))return forbidden();
   const state=txt(m.state)||"Aktiv";if(!["Aktiv","Vilande"].includes(state))throw Error("Ogiltigt projektmedlemskap");
   memberChanges.push({code,name:txt(m.name),state});
  }
  // All rows validated before any registration. New employee records do NOT get
  // a password automatically; an administrator sets their credentials separately.
  let employeesCreated=0,projectsCreated=0;
  if(!e){
   const result=await d.prepare("INSERT INTO employees(name,email,role,manager_id,capacity_percent) VALUES(?,?,?,?,?)")
    .bind(txt(input.name),email,"Medarbetare",identity.isGroupManager&&!identity.isAdmin?identity.employeeId:null,100).run();
   e=await employee(d,email);
   if(!e||Number(result.meta.last_row_id)!==e.id)throw Error("Kunde inte registrera medarbetaren.");
   // Create a disabled personal login with an unrecoverable random secret.
   // Admin activates it by setting the person's password under Behörigheter.
   const account=await d.prepare("SELECT id,employee_id employeeId FROM user_accounts WHERE lower(email)=lower(?)").bind(email).first<{id:number;employeeId:number|null}>();
   if(account&&account.employeeId!==null&&account.employeeId!==e.id)throw Error("E-postadressen används av ett annat konto.");
   if(account){
    await d.prepare("UPDATE user_accounts SET employee_id=? WHERE id=?").bind(e.id,account.id).run();
   }else{
    const salt=randomHex(16),secret=randomHex(48),hash=await passwordHash(secret,salt);
    await d.prepare("INSERT INTO user_accounts(employee_id,email,password_salt,password_hash,is_disabled) VALUES(?,?,?,?,1)").bind(e.id,email,salt,hash).run();
   }
   employeesCreated=1;
  }
  const projectNames=new Map<string,string>();
  for(const a of changes)if(a.kind==="Projekt")projectNames.set(a.projectCode,a.projectName||projectNames.get(a.projectCode)||a.projectCode);
  for(const m of memberChanges)projectNames.set(m.code,m.name||projectNames.get(m.code)||m.code);
  const uniqueCodes=new Set([...changes.map(a=>a.projectCode),...memberChanges.map(m=>m.code)]);
  for(const code of uniqueCodes){
   const old=await d.prepare("SELECT id FROM projects WHERE code=? COLLATE NOCASE").bind(code).first<{id:number}>();
   if(old)continue;
   if(!canCreate&&code!=="INTERNAL-VERK"&&code!=="INTERNAL-OVR")return forbidden();
   const label=code==="INTERNAL-VERK"?"Verksamhetsarbete":code==="INTERNAL-OVR"?"Övrigt arbete":(projectNames.get(code)||code).slice(0,150);
   const inserted=await d.prepare("INSERT INTO projects(code,name,color,status,priority) VALUES(?,?,?,?,?)")
    .bind(code,label,"#64748b","Aktivt",3).run();
   projectsCreated++;
   if(identity.isGroupManager&&!identity.isAdmin&&identity.employeeId){
    const id=Number(inserted.meta.last_row_id);
    await d.batch([
     d.prepare("INSERT OR IGNORE INTO project_leaders(project_id,employee_id) VALUES(?,?)").bind(id,identity.employeeId),
     d.prepare("INSERT OR IGNORE INTO project_members(project_id,employee_id) VALUES(?,?)").bind(id,identity.employeeId)
    ]);
   }
  }
  let created=0,updated=0,prioritiesChanged=0;
  for(const a of changes){
   const p=await d.prepare("SELECT id FROM projects WHERE code=?").bind(a.projectCode).first<{id:number}>();if(!p)throw Error("Projektet saknas.");
   if(a.activityId){
    const today=importDate;
    const person=await d.prepare("SELECT start_date startDate,end_date endDate,original_end_date originalEnd,completed_at completedAt FROM assignments WHERE activity_id=? AND employee_id=?").bind(a.activityId,e.id).first<{startDate:string;endDate:string;originalEnd:string|null;completedAt:string|null}>();
    if(!person)throw Error("Personens tilldelning saknas: "+a.name);
    const prior=await d.prepare("SELECT item_uid itemUid,current_week currentWeek FROM individual_form_items WHERE activity_id=? AND employee_id=?").bind(a.activityId,e.id).first<{itemUid:string;currentWeek:string}>();
    const storedUid=prior?.itemUid||(a.uid.startsWith("activity-")?`employee-${e.id}-activity-${a.activityId}`:a.uid);
    const done=a.status==="Klar";
    const finishDate=done?(person.completedAt||today):null;
    const plannedEnd=person.originalEnd||person.endDate;
    let startDate=person.startDate,plannedEndDate=plannedEnd;
    if(prior&&prior.currentWeek!==a.week){
      // A moved week means shifting an existing allocation, never collapsing a
      // multi-month assignment to a Monday-Friday window.
      const shift=(Date.parse(monday(a.week))-Date.parse(monday(prior.currentWeek)))/86400000;
      const add=(date:string)=>{const d=new Date(date+"T00:00:00Z");d.setUTCDate(d.getUTCDate()+shift);return d.toISOString().slice(0,10)};
      startDate=add(startDate);
      plannedEndDate=add(plannedEndDate);
    }
    const endDate=done&&finishDate&&finishDate>=startDate&&finishDate<plannedEndDate?finishDate:plannedEndDate;
    // Existing schedule stays unchanged on a status-only import. Reopening a
    // completed assignment restores its previous planned end date.
    const q:D1PreparedStatement[]=[
      d.prepare("INSERT INTO individual_form_items(item_uid,employee_id,activity_id,first_week,current_week) VALUES(?,?,?,?,?) ON CONFLICT(employee_id,activity_id) DO UPDATE SET current_week=excluded.current_week,updated_at=CURRENT_TIMESTAMP").bind(storedUid,e.id,a.activityId,a.firstWeek,a.week),
      d.prepare("UPDATE assignments SET work_status=?,status_updated_at=CURRENT_TIMESTAMP,completed_at=?,original_end_date=?,start_date=?,end_date=? WHERE activity_id=? AND employee_id=?").bind(a.status,finishDate,plannedEndDate,startDate,endDate,a.activityId,e.id)
    ];
    if(prior&&prior.currentWeek!==a.week){
      const delta=(Date.parse(monday(a.week))-Date.parse(monday(prior.currentWeek)))/86400000;
      if(!Number.isInteger(delta)||Math.abs(delta)>3650)throw Error("Ogiltig veckoförflyttning.");
      // Shift every effort segment as well; otherwise assignment and Gantt disagree.
      q.push(d.prepare("UPDATE assignment_periods SET start_date=date(start_date, ?),end_date=date(end_date, ?) WHERE assignment_id=(SELECT id FROM assignments WHERE activity_id=? AND employee_id=?)").bind(delta+" days",delta+" days",a.activityId,e.id));
      q.push(d.prepare("INSERT INTO individual_week_moves(item_uid,from_week,to_week,reason) VALUES(?,?,?,?)").bind(storedUid,prior.currentWeek,a.week,a.reason||null));
    }
    await d.batch(q);
    if(a.priority!==null&&await updateActivityPriority(d,a.activityId,a.priority,importDate,identity.accountId))prioritiesChanged++;
    const all=await d.prepare("SELECT work_status workStatus,completed_at completedAt FROM assignments WHERE activity_id=?").bind(a.activityId).all<{workStatus:string|null;completedAt:string|null}>();
    const statuses=all.results.map(x=>x.workStatus||(x.completedAt?"Klar":"Planerad"));
    const commonStatus=statuses.length&&statuses.every(x=>x==="Klar")?"Klar":
      statuses.some(x=>x==="Pågående"||x==="Pågår")?"Pågår":
      statuses.some(x=>x==="Planerad")?"Planerad":
      statuses.some(x=>x==="Pausad")?"Pausad":
      statuses.some(x=>x==="Fryst")?"Fryst":"Planerad";
    if(commonStatus==="Klar"){
     await d.prepare("UPDATE activities SET status=?,end_date=CASE WHEN ?>=start_date THEN MIN(end_date,?) ELSE end_date END WHERE id=?").bind(commonStatus,today,today,a.activityId).run();
    }else{
     // Keep the project active while other employees still have outstanding work.
     const planned=await d.prepare("SELECT MAX(COALESCE(original_end_date,end_date)) endDate FROM assignments WHERE activity_id=?").bind(a.activityId).first<{endDate:string|null}>();
     await d.prepare("UPDATE activities SET status=?,end_date=MAX(end_date,?) WHERE id=?").bind(commonStatus,planned?.endDate||plannedEndDate,a.activityId).run();
    }
    updated++;
   }else{
    const result=await d.prepare("INSERT INTO activities (project_id,name,description,start_date,end_date,estimated_hours,status,created_by,priority) VALUES(?,?,?,?,?,?,?,?,?)").bind(p.id,a.name,a.description||null,monday(a.week),friday(a.week),a.hours,a.status,e.id,a.priority??3).run();
    const activityId=Number(result.meta.last_row_id);
    await d.prepare("INSERT INTO activity_priority_history(activity_id,effective_from,priority,changed_by,source) VALUES(?,?,?,?,?)")
      .bind(activityId,monday(a.week),a.priority??3,identity.accountId,"excel").run();
    await d.batch([d.prepare("INSERT INTO assignments (activity_id,employee_id,effort_percent,start_date,end_date,completed_at,work_status,original_end_date,status_updated_at) VALUES(?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)").bind(activityId,e.id,Math.min(200,Math.round(a.hours/40*100)),monday(a.week),friday(a.week),a.status==="Klar"?importDate:null,a.status,friday(a.week)),d.prepare("INSERT INTO individual_form_items(item_uid,employee_id,activity_id,first_week,current_week) VALUES(?,?,?,?,?)").bind(a.uid,e.id,activityId,a.firstWeek,a.week),d.prepare("INSERT INTO assignment_periods(assignment_id,start_date,end_date,effort_percent) SELECT id,start_date,end_date,effort_percent FROM assignments WHERE activity_id=? AND employee_id=?").bind(activityId,e.id)]);created++;
   }
  }
  for(const m of memberChanges){
   const p=await d.prepare("SELECT id FROM projects WHERE code=? COLLATE NOCASE").bind(m.code).first<{id:number}>();
   if(!p)throw Error("Projektet saknas vid medlemsregistrering: "+m.code);
   await d.batch([
    d.prepare("INSERT OR IGNORE INTO project_members(project_id,employee_id) VALUES(?,?)").bind(p.id,e.id),
    d.prepare("INSERT INTO individual_project_state(employee_id,project_id,state) VALUES(?,?,?) ON CONFLICT(employee_id,project_id) DO UPDATE SET state=excluded.state,updated_at=CURRENT_TIMESTAMP").bind(e.id,p.id,m.state)
   ]);
  }
  // An imported activity implies membership even if the membership section was empty.
  for(const code of new Set(changes.filter(a=>a.kind==="Projekt").map(a=>a.projectCode))){
   await d.prepare("INSERT OR IGNORE INTO project_members(project_id,employee_id) SELECT id,? FROM projects WHERE code=? COLLATE NOCASE").bind(e.id,code).run();
  }
  await d.prepare("INSERT INTO individual_import_runs(employee_id,row_count,created_count,updated_count) VALUES(?,?,?,?)").bind(e.id,changes.length,created,updated).run();
  return Response.json({ok:true,created,updated,members:memberChanges.length,employeesCreated,projectsCreated,prioritiesChanged});
 }catch(e){console.error(e);return Response.json({error:e instanceof Error?e.message:"Importen misslyckades."},{status:400})}
}