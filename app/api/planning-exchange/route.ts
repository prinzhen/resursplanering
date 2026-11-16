import {env} from "cloudflare:workers";
import {sessionIdentity,unauthorized,forbidden,sameOrigin} from "@/lib/auth";
import {PLAN_COLUMNS,type ExchangeRow} from "@/lib/planning-exchange";
export const dynamic="force-dynamic";
const date=(s:string)=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&!Number.isNaN(Date.parse(s+"T00:00:00Z"))&&new Date(s+"T00:00:00Z").toISOString().slice(0,10)===s;
const code=/^[A-Z0-9][A-Z0-9._-]{0,39}$/;
const email=(s:string)=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)&&s.length<=254;
type ActivityRow={row:ExchangeRow;projectId:number|null;existingId:number|null;previousStart:string|null;previousEnd:string|null;newActivity:boolean};
export async function POST(req:Request){
 try{
  const db=env.DB;if(!db)throw Error("Databasen saknas.");
  const user=await sessionIdentity(req,db);
  if(!user)return unauthorized();
  if(!sameOrigin(req))return forbidden();
  // Administrative bulk import affects potentially multiple projects,
  // resources, assignments and hierarchy. Never let a project/group leader
  // escape scope by supplying another project's code.
  if(!user.isAdmin)return forbidden();
  const payload=await req.json() as {rows:ExchangeRow[];commit?:boolean};
  const rows=payload.rows;
  if(!Array.isArray(rows)||rows.length<1||rows.length>2000)
   return Response.json({error:"Importen måste innehålla 1–2000 rader."},{status:400});
  const projects=new Map<string,{name:string;id:number|null}>();
  const persons=new Map<string,{name:string;id:number|null}>();
  const work=new Map<string,{code:string;name:string;projectCode:string;id:number|null}>();
  const activities=new Map<string,ActivityRow>();
  const assignments=new Map<string,{activityKey:string;email:string;effort:number}>();
  const warnings:string[]=[];
  for(const [index,r] of rows.entries()){
   if(!r||typeof r!=="object"||PLAN_COLUMNS.some(k=>typeof r[k]!=="string"))
    throw Error("Felaktig tabellrad "+(index+2));
   const kind=r.record_type.trim().toLowerCase();
   if(kind!=="activity"&&kind!=="person")throw Error("Okänd posttyp på rad "+(index+2));
   if(kind==="person"){
    const mail=r.employee_email.trim().toLowerCase()||r.activity.trim().toLowerCase();
    if(!email(mail)||!r.employee_name.trim())throw Error("Personen behöver namn och e-post på rad "+(index+2));
    const prev=persons.get(mail);
    if(prev&&prev.name!==r.employee_name.trim())throw Error("Olika namn för e-post "+mail);
    persons.set(mail,{name:r.employee_name.trim().slice(0,150),id:prev?.id??null});continue;
   }
   const pcode=r.project_code.trim().toUpperCase(),pname=r.project_name.trim();
   if(!code.test(pcode)||!pname||pname.length>150)throw Error("Felaktig projektkod eller projektnamn på rad "+(index+2));
   const oldProject=projects.get(pcode);
   if(oldProject&&oldProject.name!==pname)throw Error("Projektkod "+pcode+" har olika projektnamn.");
   projects.set(pcode,{id:oldProject?.id??null,name:pname});
   const acode=r.activity_code.trim().toUpperCase(),aname=r.activity.trim();
   if(!acode||!aname||aname.length>200)throw Error("Aktivitet och kod krävs på rad "+(index+2));
   if(!code.test(acode)&&!/^RP-ID-\d+$/.test(acode))throw Error("Ogiltig aktivitetskod: "+acode);
   if(!date(r.start_date)||!date(r.end_date)||r.start_date>r.end_date)throw Error("Ogiltiga aktivitetsdatum: "+aname);
   if(r.description.length>500)throw Error("Beskrivning får vara högst 500 tecken.");
   const hours=r.estimated_hours.trim()?Number(r.estimated_hours):null;
   if(hours!==null&&(!Number.isFinite(hours)||hours<0||hours>100000))throw Error("Ogiltiga timmar för "+aname);
   if(r.work_package_code){
    const wcode=r.work_package_code.trim(),wk=pcode+"|"+wcode;
    if(!code.test(wcode.toUpperCase()))throw Error("Ogiltig uppdragskod: "+wcode);
    if(!work.has(wk))work.set(wk,{code:wcode,name:r.work_package_name||wcode,projectCode:pcode,id:null});
   }
   const key=pcode+"|"+acode;
   const prior=activities.get(key);
   if(prior&&[prior.row.activity,prior.row.start_date,prior.row.end_date,prior.row.work_package_code].join("|")!==
       [r.activity,r.start_date,r.end_date,r.work_package_code].join("|"))
    throw Error("Olika datum/namn för samma aktivitet: "+key);
   activities.set(key,prior||{row:r,projectId:null,existingId:null,previousStart:null,previousEnd:null,newActivity:true});
   if(r.employee_email){
    const mail=r.employee_email.trim().toLowerCase();
    if(!email(mail))throw Error("Felaktig e-postadress på rad "+(index+2));
    const name=r.employee_name.trim();
    const existingPerson=persons.get(mail);
    if(!existingPerson&&!name)throw Error("Namn saknas för ny resurs "+mail);
    if(existingPerson&&name&&existingPerson.name!==name)throw Error("Motstridiga namn för "+mail);
    persons.set(mail,{name:name||existingPerson!.name,id:existingPerson?.id??null});
    const percentage=r.effort_percent.trim()?Number(r.effort_percent):0;
    if(!Number.isFinite(percentage)||percentage<0||percentage>100)throw Error("Insats måste vara 0–100 %.");
    const akey=key+"|"+mail;
    if(assignments.has(akey)&&assignments.get(akey)!.effort!==percentage)
     throw Error("Samma resurs har motstridig beläggning på "+key);
    assignments.set(akey,{activityKey:key,email:mail,effort:percentage});
   }
  }
  for(const [key,p] of projects){
   const old=await db.prepare("SELECT id,name FROM projects WHERE code=? COLLATE NOCASE").bind(key).first<{id:number;name:string}>();
   if(old){p.id=old.id;if(old.name!==p.name)warnings.push("Befintligt projekt "+key+" behåller namnet "+old.name+".");}
  }
  for(const [mail,p] of persons){
   const old=await db.prepare("SELECT id,name FROM employees WHERE lower(email)=lower(?)").bind(mail).first<{id:number;name:string}>();
   if(old){p.id=old.id;if(old.name!==p.name)warnings.push("Befintlig person "+mail+" behåller namnet "+old.name+".");}
  }
  for(const [key,w] of work){
   const id=projects.get(w.projectCode)!.id;
   if(id!==null)w.id=(await db.prepare("SELECT id FROM work_packages WHERE project_id=? AND code=?").bind(id,w.code).first<{id:number}>())?.id??null;
  }
  for(const [key,a] of activities){
   const p=projects.get(a.row.project_code.toUpperCase())!,id=p.id;
   if(id!==null){
    const surrogate=/^RP-ID-(\d+)$/.exec(a.row.activity_code);
    const old=surrogate?
      await db.prepare("SELECT id,start_date startDate,end_date endDate FROM activities WHERE id=? AND project_id=?")
       .bind(Number(surrogate[1]),id).first<{id:number;startDate:string;endDate:string}>():
      await db.prepare("SELECT id,start_date startDate,end_date endDate FROM activities WHERE project_id=? AND code=?")
       .bind(id,a.row.activity_code).first<{id:number;startDate:string;endDate:string}>();
    if(old){a.existingId=old.id;a.newActivity=false;a.previousStart=old.startDate;a.previousEnd=old.endDate;}
    else if(surrogate)throw Error("Aktivitets-ID "+a.row.activity_code+" hör inte till projektet "+a.row.project_code);
   }else if(/^RP-ID-\d+$/.test(a.row.activity_code))throw Error("Intern aktivitetskod kan inte användas i ett nytt projekt.");
   // Never silently overwrite an activity with custom historical staffing.
   if(a.existingId!==null&&(a.previousStart!==a.row.start_date||a.previousEnd!==a.row.end_date)){
    const count=await db.prepare("SELECT COUNT(*) count FROM assignment_periods WHERE assignment_id IN (SELECT id FROM assignments WHERE activity_id=?)")
     .bind(a.existingId).first<{count:number}>();
    const assigned=await db.prepare("SELECT COUNT(*) count FROM assignments WHERE activity_id=?").bind(a.existingId).first<{count:number}>();
    if((count?.count||0)>(assigned?.count||0))throw Error("Aktiviteten "+key+" har flera beläggningsperioder. Ändra den via planeringsverktyget.");
    warnings.push("Gantt-datum ändras för "+key+"; kontrollera berörda resurser.");
   }
  }
  const preview={
   projectsCreated:[...projects.values()].filter(x=>x.id===null).length,
   peopleCreated:[...persons.values()].filter(x=>x.id===null).length,
   workPackagesCreated:[...work.values()].filter(x=>x.id===null).length,
   activitiesCreated:[...activities.values()].filter(x=>x.newActivity).length,
   activitiesUpdated:[...activities.values()].filter(x=>!x.newActivity).length,
   assignments:assignments.size,warnings
  };
  if(!payload.commit)return Response.json({preview,committed:false});
  // Build a single D1 batch. All SQL statements commit or roll back together.
  // Recheck project and resource references with subqueries at write time.
  const q:D1PreparedStatement[]=[];
  for(const [code,p] of projects)if(p.id===null)
   q.push(db.prepare("INSERT INTO projects(code,name,color,status,priority) VALUES(?,?,'#2563eb','Aktivt',3)").bind(code,p.name));
  for(const [mail,p] of persons)if(p.id===null)
   q.push(db.prepare("INSERT INTO employees(name,email,role,capacity_percent) VALUES(?,?,'Medarbetare',100)").bind(p.name,mail));
  for(const w of work.values())if(w.id===null)
   q.push(db.prepare("INSERT INTO work_packages(project_id,code,name) VALUES((SELECT id FROM projects WHERE code=? COLLATE NOCASE),?,?)")
    .bind(w.projectCode,w.code,w.name));
  for(const [key,a] of activities){
   const r=a.row;
   const workId=r.work_package_code?"(SELECT id FROM work_packages WHERE project_id=(SELECT id FROM projects WHERE code=? COLLATE NOCASE) AND code=?)":"NULL";
   // The update/insert SQL is fully determined by the server, never raw file values.
   const wp=r.work_package_code?
    await db.prepare("SELECT id FROM work_packages WHERE project_id=(SELECT id FROM projects WHERE code=? COLLATE NOCASE) AND code=?").bind(r.project_code,r.work_package_code).first<{id:number}>():null;
   if(a.existingId!==null){
    q.push(db.prepare("UPDATE activities SET name=?,description=?,start_date=?,end_date=?,estimated_hours=?,status=? WHERE id=? AND project_id=(SELECT id FROM projects WHERE code=? COLLATE NOCASE)")
     .bind(r.activity,r.description||null,r.start_date,r.end_date,r.estimated_hours?Number(r.estimated_hours):null,r.status||"Planerad",a.existingId,r.project_code));
   }else{
    q.push(db.prepare("INSERT INTO activities(project_id,work_package_id,code,name,description,start_date,end_date,estimated_hours,status) VALUES((SELECT id FROM projects WHERE code=? COLLATE NOCASE),(SELECT id FROM work_packages WHERE project_id=(SELECT id FROM projects WHERE code=? COLLATE NOCASE) AND code=?),?,?,?,?,?,?,?)")
     .bind(r.project_code,r.project_code,r.work_package_code||"__none__",r.activity_code,r.activity,r.description||null,
      r.start_date,r.end_date,r.estimated_hours?Number(r.estimated_hours):null,r.status||"Planerad"));
   }
  }
  // Attach resources only after all activities and people exist. No old
  // allocations are deleted by a general import.
  for(const a of assignments.values()){
   const activity=activities.get(a.activityKey)!,r=activity.row;
   const ref=a.existingId!==null?"id=?":"project_id=(SELECT id FROM projects WHERE code=? COLLATE NOCASE) AND code=?";
   const qargs=a.existingId!==null?[a.existingId]:[r.project_code,r.activity_code];
   const sql="INSERT INTO assignments(activity_id,employee_id,effort_percent,start_date,end_date,original_end_date,work_status) "+
    "SELECT t.id,e.id,?,?,?,? FROM activities t JOIN employees e ON lower(e.email)=lower(?) WHERE t."+ref+
    " ON CONFLICT(activity_id,employee_id) DO UPDATE SET effort_percent=excluded.effort_percent";
   q.push(db.prepare(sql).bind(a.effort,r.start_date,r.end_date,r.end_date,"Planerad",a.email,...qargs));
  }
  if(q.length)await db.batch(q);
  return Response.json({preview,committed:true});
 }catch(e){console.error(e);return Response.json({error:e instanceof Error?e.message:"Importen misslyckades."},{status:400})}
}
