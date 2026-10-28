import { env } from "cloudflare:workers";
export const dynamic = "force-dynamic";
type Item = {uid:string;week:string;category:string;title:string;projectCode?:string;hours?:number;outcome?:string;note?:string};
type Member = {projectCode:string;projectName?:string;state:string};
type Payload = {email:string;name:string;week:string;items:Item[];members:Member[]};
const validWeek = (s:string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s+"T00:00:00Z").getUTCDay()===1;
const clean = (v:unknown,max=250) => String(v??"").trim().slice(0,max);
function fail(message:string,status=400){return Response.json({error:message},{status})}
function getDb(){if(!env.DB)throw new Error("Databas saknas");return env.DB}
async function load(email:string,week:string){
 const db=getDb();
 const employee=await db.prepare("SELECT id,name,email FROM employees WHERE lower(email)=lower(?)").bind(email).first<{id:number;name:string;email:string}>();
 if(!employee)return {employee:null,items:[],members:[]};
 const items=await db.prepare("SELECT w.item_uid uid,w.week_start week,w.category,w.title,w.planned_hours hours,w.outcome,w.note,p.code projectCode FROM weekly_items w LEFT JOIN projects p ON p.id=w.project_id WHERE w.employee_id=? AND w.week_start IN (?,date(?,'-7 days')) ORDER BY w.week_start,w.id").bind(employee.id,week,week).all();
 const members=await db.prepare("SELECT p.code projectCode,p.name projectName,coalesce(s.activity_state,'Aktiv') state FROM project_members m JOIN projects p ON p.id=m.project_id LEFT JOIN weekly_project_state s ON s.project_id=m.project_id AND s.employee_id=m.employee_id WHERE m.employee_id=? ORDER BY p.code").bind(employee.id).all();
 return {employee,items:items.results,members:members.results};
}
export async function GET(request:Request){
 try{const u=new URL(request.url),email=clean(u.searchParams.get("email"),254).toLowerCase(),week=clean(u.searchParams.get("week"),10);
 if(!email||!validWeek(week))return fail("Ange e-postadress och måndagens datum (ÅÅÅÅ-MM-DD).");
 return Response.json(await load(email,week))}catch(e){console.error(e);return fail("Kunde inte läsa veckostatus",500)}
}
export async function POST(request:Request){
 try{
 const raw=await request.json() as Payload;
 const email=clean(raw.email,254).toLowerCase(),name=clean(raw.name,120),week=clean(raw.week,10);
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!name||!validWeek(week))return fail("Ogiltig medarbetare eller veckostart.");
 if(!Array.isArray(raw.items)||raw.items.length>300||!Array.isArray(raw.members)||raw.members.length>100)return fail("För många rader.");
 const db=getDb();
 // Validate every row before making any changes.
 const items=raw.items.map((r,i)=>{
  const title=clean(r.title,500),uid=clean(r.uid,100),w=clean(r.week,10),category=clean(r.category,30),projectCode=clean(r.projectCode,60),hours=Number(r.hours||0),outcome=clean(r.outcome,40),note=clean(r.note,1000);
  if(!title||!uid||!validWeek(w)||!["previous","current","next","upcoming"].includes(category)||!Number.isFinite(hours)||hours<0||hours>168)throw new Error("Ogiltig aktivitet på rad "+(i+1));
  return {uid,title,week:w,category,projectCode,hours,outcome,note};
 });
 if(new Set(items.map(i=>i.uid)).size!==items.length)return fail("Samma aktivitets-ID förekommer flera gånger.");
 const members=raw.members.map(m=>({code:clean(m.projectCode,60),name:clean(m.projectName,250),state:clean(m.state,30)}));
 if(members.some(m=>!m.code||!["Aktiv","Vilande"].includes(m.state)))return fail("Projektmedverkan har ogiltiga värden.");
 if(new Set(members.map(m=>m.code)).size!==members.length)return fail("Ett projekt förekommer flera gånger.");
 const oldEmployee=await db.prepare("SELECT id FROM employees WHERE lower(email)=?").bind(email).first<{id:number}>();
 if(!oldEmployee)await db.prepare("INSERT INTO employees(name,email,role,capacity_percent) VALUES (?,?,'Medarbetare',100)").bind(name,email).run();
 const employee=await db.prepare("SELECT id FROM employees WHERE lower(email)=?").bind(email).first<{id:number}>();
 if(!employee)return fail("Kunde inte skapa medarbetaren",500);
 const statements:D1PreparedStatement[]=[];
 // Existing data remain untouched if a row is omitted from a spreadsheet.
 for(const m of members){
   let project=await db.prepare("SELECT id FROM projects WHERE code=?").bind(m.code).first<{id:number}>();
   if(!project&&m.name){await db.prepare("INSERT INTO projects(code,name,color,status) VALUES (?,?,'#2563eb','Aktivt')").bind(m.code,m.name).run();project=await db.prepare("SELECT id FROM projects WHERE code=?").bind(m.code).first<{id:number}>()}
   if(!project)throw new Error("Okänt projekt "+m.code+" – ange projektnamn för att skapa det.");
   statements.push(db.prepare("INSERT OR IGNORE INTO project_members(project_id,employee_id) VALUES (?,?)").bind(project.id,employee.id));
   statements.push(db.prepare("INSERT INTO weekly_project_state(employee_id,project_id,activity_state) VALUES (?,?,?) ON CONFLICT(employee_id,project_id) DO UPDATE SET activity_state=excluded.activity_state,updated_at=CURRENT_TIMESTAMP").bind(employee.id,project.id,m.state));
 }
 for(const i of items){
   const p=i.projectCode?await db.prepare("SELECT id FROM projects WHERE code=?").bind(i.projectCode).first<{id:number}>():null;
   if(i.projectCode&&!p)throw new Error("Okänd projektkod: "+i.projectCode);
   const existing=await db.prepare("SELECT employee_id employeeId FROM weekly_items WHERE item_uid=?").bind(i.uid).first<{employeeId:number}>();
   if(existing&&existing.employeeId!==employee.id)throw new Error("Aktivitets-ID tillhör en annan medarbetare: "+i.uid);
   statements.push(db.prepare("INSERT INTO weekly_items(item_uid,employee_id,project_id,week_start,category,title,planned_hours,outcome,note) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(item_uid) DO UPDATE SET project_id=excluded.project_id,week_start=excluded.week_start,category=excluded.category,title=excluded.title,planned_hours=excluded.planned_hours,outcome=excluded.outcome,note=excluded.note,updated_at=CURRENT_TIMESTAMP").bind(i.uid,employee.id,p?.id??null,i.week,i.category,i.title,i.hours,i.outcome||"Planerad",i.note));
 }
 if(statements.length)await db.batch(statements);
 return Response.json({success:true,createdEmployee:!oldEmployee,updatedItems:items.length,updatedMemberships:members.length,...await load(email,week)});
 }catch(e){console.error(e);return fail(e instanceof Error?e.message:"Importen misslyckades",400)}
}
