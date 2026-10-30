import {env} from "cloudflare:workers";
import {sessionIdentity,unauthorized,forbidden,sameOrigin,passwordHash,randomHex} from "@/lib/auth";
import {accessScope} from "@/lib/permissions";
export const dynamic="force-dynamic";
const db=()=>env.DB;
export async function GET(req:Request){
 const user=await sessionIdentity(req,db());if(!user)return unauthorized();
 const scope=await accessScope(db(),user);
 const [accounts,projects,teams]=await Promise.all([
 user.isAdmin?db().prepare("SELECT id,email,employee_id employeeId,is_admin isAdmin,is_group_manager isGroupManager,is_disabled isDisabled,created_at createdAt FROM user_accounts ORDER BY email").all():Promise.resolve({results:[]}),
 db().prepare("SELECT project_id projectId,employee_id employeeId FROM project_leaders ORDER BY project_id").all<{projectId:number;employeeId:number}>(),
 db().prepare("SELECT team_id teamId,employee_id employeeId FROM team_leaders ORDER BY team_id").all<{teamId:number;employeeId:number}>(),
 ]);
 return Response.json({accounts:accounts.results,
  projectLeaders:projects.results.filter(p=>user.isAdmin||scope.projectIds.has(p.projectId)),
  teamLeaders:teams.results.filter(t=>user.isAdmin||scope.teamIds.has(t.teamId)),
  viewer:{employeeId:user.employeeId,isAdmin:user.isAdmin}},{headers:{"cache-control":"no-store"}});
}
export async function POST(req:Request){
 try{
  const d=db(),user=await sessionIdentity(req,d);
  if(!user)return unauthorized();
  if(!sameOrigin(req))return forbidden();
  const b=await req.json() as Record<string,unknown>;
  const action=String(b.action||"");
  const employeeId=Number(b.employeeId),projectId=Number(b.projectId),teamId=Number(b.teamId);
  const scope=await accessScope(d,user);
  if(action==="saveAccount"){
   if(!user.isAdmin)return forbidden();
   const email=String(b.email||"").toLowerCase().trim();
   const password=String(b.password||"");
   if(!email.includes("@")||email.length>254||password.length<12||password.length>256)
    return Response.json({error:"E-post och lösenord (minst 12 tecken) krävs."},{status:400});
   const person=b.employeeId===null||b.employeeId===undefined||b.employeeId===""?null:employeeId;
   if(person!==null&&!await d.prepare("SELECT id FROM employees WHERE id=?").bind(person).first())
    return Response.json({error:"Medarbetaren saknas."},{status:400});
   const salt=randomHex(16),hash=await passwordHash(password,salt),isAdmin=Number(Boolean(b.isAdmin)),groupManager=Number(Boolean(b.isGroupManager));
   const existing=await d.prepare("SELECT id FROM user_accounts WHERE lower(email)=lower(?)").bind(email).first<{id:number}>();
   if(existing){
    await d.prepare("UPDATE user_accounts SET employee_id=?,password_salt=?,password_hash=?,is_admin=?,is_group_manager=?,is_disabled=0,failed_attempts=0,locked_until=NULL WHERE id=?").bind(person,salt,hash,isAdmin,groupManager,existing.id).run();
    await d.prepare("DELETE FROM user_sessions WHERE user_id=?").bind(existing.id).run();
   }else{
    await d.prepare("INSERT INTO user_accounts(employee_id,email,password_salt,password_hash,is_admin,is_group_manager) VALUES(?,?,?,?,?,?)").bind(person,email,salt,hash,isAdmin,groupManager).run();
   }
  }else if(action==="setAccountDisabled"){
   if(!user.isAdmin)return forbidden();
   const target=Number(b.accountId);
   if(target===user.accountId)return Response.json({error:"Du kan inte inaktivera ditt eget administratörskonto."},{status:400});
   await d.prepare("UPDATE user_accounts SET is_disabled=? WHERE id=?").bind(Number(Boolean(b.disabled)),target).run();
   await d.prepare("DELETE FROM user_sessions WHERE user_id=?").bind(target).run();
  }else if(action==="setProjectLeader"||action==="setTeamLeader"){
   if(!Number.isSafeInteger(employeeId)||employeeId<=0||!await d.prepare("SELECT id FROM employees WHERE id=?").bind(employeeId).first())
    return Response.json({error:"Välj en befintlig medarbetare."},{status:400});
   if(!user.isAdmin&&!scope.managedIds.has(employeeId))return forbidden();
   const enabled=Boolean(b.enabled);
   if(action==="setProjectLeader"){
    if(!Number.isSafeInteger(projectId)||projectId<=0||!await d.prepare("SELECT id FROM projects WHERE id=?").bind(projectId).first())
     return Response.json({error:"Projektet saknas."},{status:400});
    if(!user.isAdmin&&!scope.projectIds.has(projectId))return forbidden();
    if(enabled)await d.prepare("INSERT OR IGNORE INTO project_leaders(project_id,employee_id) VALUES(?,?)").bind(projectId,employeeId).run();
    else await d.prepare("DELETE FROM project_leaders WHERE project_id=? AND employee_id=?").bind(projectId,employeeId).run();
   }else{
    const team=await d.prepare("SELECT id,owner_id ownerId FROM employee_groups WHERE id=?").bind(teamId).first<{id:number;ownerId:number|null}>();
    if(!team)return Response.json({error:"TEAMET saknas."},{status:400});
    if(!user.isAdmin&&team.ownerId!==user.employeeId)return forbidden();
    if(enabled){
     await d.batch([
      d.prepare("INSERT OR IGNORE INTO employee_group_members(group_id,employee_id) VALUES(?,?)").bind(teamId,employeeId),
      d.prepare("INSERT OR IGNORE INTO team_leaders(team_id,employee_id) VALUES(?,?)").bind(teamId,employeeId)
     ]);
    }else await d.prepare("DELETE FROM team_leaders WHERE team_id=? AND employee_id=?").bind(teamId,employeeId).run();
   }
  }else return Response.json({error:"Okänd åtgärd."},{status:400});
  return GET(req);
 }catch(e){console.error(e);return Response.json({error:"Kunde inte spara behörigheter."},{status:500})}
}
