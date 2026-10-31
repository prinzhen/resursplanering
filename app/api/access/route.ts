import {env} from "cloudflare:workers";
import {sessionIdentity,unauthorized,forbidden,sameOrigin,passwordHash,randomHex} from "@/lib/auth";
import {accessScope} from "@/lib/permissions";
export const dynamic="force-dynamic";
const db=()=>{if(!env.DB)throw Error("Databasen saknas");return env.DB};
async function activeOtherAdmins(d:D1Database,exceptId:number){
 const row=await d.prepare("SELECT COUNT(*) n FROM user_accounts WHERE is_admin=1 AND is_disabled=0 AND id<>?").bind(exceptId).first<{n:number}>();
 return Number(row?.n||0);
}
const adminRequired=()=>Response.json({error:"Minst en aktiv administratör måste finnas kvar."},{status:409});
export async function GET(req:Request){
 const user=await sessionIdentity(req,db());if(!user)return unauthorized();
 const scope=await accessScope(db(),user);
 const [accounts,projects,teams,workPackages]=await Promise.all([
 user.isAdmin?db().prepare("SELECT id,email,employee_id employeeId,is_admin isAdmin,is_group_manager isGroupManager,is_disabled isDisabled,created_at createdAt FROM user_accounts ORDER BY email").all():Promise.resolve({results:[]}),
 db().prepare("SELECT project_id projectId,employee_id employeeId FROM project_leaders ORDER BY project_id").all<{projectId:number;employeeId:number}>(),
 db().prepare("SELECT team_id teamId,employee_id employeeId FROM team_leaders ORDER BY team_id").all<{teamId:number;employeeId:number}>(),
 db().prepare("SELECT work_package_id workPackageId,employee_id employeeId FROM work_package_leaders ORDER BY work_package_id").all<{workPackageId:number;employeeId:number}>(),
 ]);
 const directory=(user.isAdmin||scope.projectLedIds.size>0||user.isGroupManager)?
   await db().prepare("SELECT id,name FROM employees ORDER BY name").all<{id:number;name:string}>():{results:[]};
 return Response.json({directoryEmployees:directory.results,accounts:accounts.results,
  projectLeaders:projects.results.filter(p=>user.isAdmin||scope.projectIds.has(p.projectId)),
  teamLeaders:teams.results.filter(t=>user.isAdmin||scope.teamIds.has(t.teamId)),
  workPackageLeaders:workPackages.results.filter(w=>user.isAdmin||scope.workPackageLedIds.has(w.workPackageId)||scope.workPackageIds.has(w.workPackageId)),
  viewer:{accountId:user.accountId,employeeId:user.employeeId,isAdmin:user.isAdmin}},{headers:{"cache-control":"no-store"}});
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
   if(!email.includes("@")||email.length>254||password.length<6||password.length>256)
    return Response.json({error:"E-post och lösenord (minst 6 tecken) krävs."},{status:400});
   const existing=await d.prepare("SELECT id,employee_id employeeId,is_admin isAdmin,is_disabled isDisabled FROM user_accounts WHERE lower(email)=lower(?)").bind(email).first<{id:number;employeeId:number|null;isAdmin:number;isDisabled:number}>();
   const explicitPerson=b.employeeId!==null&&b.employeeId!==undefined&&b.employeeId!=="";
   const match=explicitPerson?null:await d.prepare("SELECT id FROM employees WHERE lower(email)=lower(?)").bind(email).first<{id:number}>();
   const person=explicitPerson?employeeId:(match?.id??existing?.employeeId??null);
   if(person!==null&&(!Number.isSafeInteger(person)||person<=0||!await d.prepare("SELECT id FROM employees WHERE id=?").bind(person).first()))
    return Response.json({error:"Medarbetaren saknas."},{status:400});
   if(person!==null){
    const owner=await d.prepare("SELECT id FROM user_accounts WHERE employee_id=?").bind(person).first<{id:number}>();
    if(owner&&owner.id!==existing?.id)return Response.json({error:"Medarbetaren är redan kopplad till ett annat konto. Kontakta administratören innan konton sammanförs."},{status:409});
   }
   const salt=randomHex(16),hash=await passwordHash(password,salt),isAdmin=Number(Boolean(b.isAdmin)),groupManager=Number(Boolean(b.isGroupManager));
   if(existing?.isAdmin&&!isAdmin&&!existing.isDisabled&&!await activeOtherAdmins(d,existing.id))return adminRequired();
   if(existing){
    await d.prepare("UPDATE user_accounts SET employee_id=?,password_salt=?,password_hash=?,is_admin=?,is_group_manager=?,is_disabled=0,failed_attempts=0,locked_until=NULL WHERE id=?").bind(person,salt,hash,isAdmin,groupManager,existing.id).run();
    await d.prepare("DELETE FROM user_sessions WHERE user_id=?").bind(existing.id).run();
   }else{
    await d.prepare("INSERT INTO user_accounts(employee_id,email,password_salt,password_hash,is_admin,is_group_manager) VALUES(?,?,?,?,?,?)").bind(person,email,salt,hash,isAdmin,groupManager).run();
   }
  }else if(action==="linkAccount"){
   if(!user.isAdmin)return forbidden();
   const accountId=Number(b.accountId);
   const linkedEmployee=b.employeeId===null?null:Number(b.employeeId);
   if(!Number.isSafeInteger(accountId)||accountId<=0||linkedEmployee!==null&&(!Number.isSafeInteger(linkedEmployee)||linkedEmployee<=0))
    return Response.json({error:"Ogiltigt konto eller medarbetare."},{status:400});
   if(!await d.prepare("SELECT id FROM user_accounts WHERE id=?").bind(accountId).first())
    return Response.json({error:"Kontot finns inte."},{status:404});
   if(linkedEmployee!==null){
    if(!await d.prepare("SELECT id FROM employees WHERE id=?").bind(linkedEmployee).first())
     return Response.json({error:"Medarbetaren finns inte."},{status:404});
    const other=await d.prepare("SELECT id,email FROM user_accounts WHERE employee_id=? AND id<>?").bind(linkedEmployee,accountId).first<{id:number;email:string}>();
    if(other)return Response.json({error:"Medarbetaren är redan kopplad till "+other.email+". Lös kontokonflikten innan du länkar."},{status:409});
   }
   await d.prepare("UPDATE user_accounts SET employee_id=? WHERE id=?").bind(linkedEmployee,accountId).run();
  }else if(action==="setAccountRole"){
   if(!user.isAdmin)return forbidden();
   const target=Number(b.accountId),isAdmin=Number(Boolean(b.isAdmin));
   if(!Number.isSafeInteger(target)||target<=0)return Response.json({error:"Ogiltigt konto."},{status:400});
   const current=await d.prepare("SELECT id,is_admin isAdmin,is_disabled isDisabled FROM user_accounts WHERE id=?").bind(target).first<{id:number;isAdmin:number;isDisabled:number}>();
   if(!current)return Response.json({error:"Kontot finns inte."},{status:404});
   if(current.isAdmin&&!isAdmin&&!current.isDisabled&&!await activeOtherAdmins(d,target))return adminRequired();
   await d.prepare("UPDATE user_accounts SET is_admin=? WHERE id=?").bind(isAdmin,target).run();
   if(current.isAdmin!==isAdmin)await d.prepare("DELETE FROM user_sessions WHERE user_id=?").bind(target).run();
  }else if(action==="deleteAccount"){
   if(!user.isAdmin)return forbidden();
   const target=Number(b.accountId);
   if(!Number.isSafeInteger(target)||target<=0)return Response.json({error:"Ogiltigt konto."},{status:400});
   if(target===user.accountId)return Response.json({error:"Du kan inte radera kontot du är inloggad med."},{status:409});
   const current=await d.prepare("SELECT id,is_admin isAdmin,is_disabled isDisabled FROM user_accounts WHERE id=?").bind(target).first<{id:number;isAdmin:number;isDisabled:number}>();
   if(!current)return Response.json({error:"Kontot finns inte."},{status:404});
   if(current.isAdmin&&!current.isDisabled&&!await activeOtherAdmins(d,target))return adminRequired();
   // Preserve audit trails: project proposals and priority changes refer to login IDs.
   // Deleting such an account would break foreign keys or falsify old history.
   const proposalRef=await d.prepare("SELECT id FROM project_proposals WHERE submitted_by=? OR reviewed_by=? LIMIT 1").bind(target,target).first();
   const priorityRef=await d.prepare("SELECT id FROM activity_priority_history WHERE changed_by=? LIMIT 1").bind(target).first();
   if(proposalRef||priorityRef){
    await d.batch([
     d.prepare("UPDATE user_accounts SET is_admin=0,is_group_manager=0,is_disabled=1,failed_attempts=0,locked_until=NULL WHERE id=?").bind(target),
     d.prepare("DELETE FROM user_sessions WHERE user_id=?").bind(target)
    ]);
    return Response.json({archived:true,message:"Kontot har inaktiverats och fått sina behörigheter borttagna. Det ligger kvar i databasen för att bevara revisionshistoriken."});
   }
   await d.batch([d.prepare("DELETE FROM user_sessions WHERE user_id=?").bind(target),
    d.prepare("DELETE FROM user_accounts WHERE id=?").bind(target)]);
  }else if(action==="setEmployeePassword"){
   if(!user.isAdmin)return forbidden();
   const employeeId=Number(b.employeeId),password=String(b.password||"");
   if(!Number.isSafeInteger(employeeId)||employeeId<=0||password.length<6||password.length>256)
    return Response.json({error:"Välj medarbetare och ange ett lösenord med minst 6 tecken."},{status:400});
   const person=await d.prepare("SELECT id,email FROM employees WHERE id=?").bind(employeeId).first<{id:number;email:string|null}>();
   if(!person||!person.email||!person.email.includes("@"))
    return Response.json({error:"Medarbetaren måste ha en giltig e-postadress."},{status:400});
   const email=person.email.toLowerCase().trim();
   const byEmployee=await d.prepare("SELECT id FROM user_accounts WHERE employee_id=?").bind(employeeId).first<{id:number}>();
   const byEmail=await d.prepare("SELECT id,employee_id employeeId FROM user_accounts WHERE lower(email)=lower(?)").bind(email).first<{id:number;employeeId:number|null}>();
   if(byEmail&&byEmail.employeeId!==null&&byEmail.employeeId!==employeeId)
    return Response.json({error:"E-postadressen används av en annan användare."},{status:409});
   if(byEmployee&&byEmail&&byEmployee.id!==byEmail.id)
    return Response.json({error:"Medarbetarens konto och e-postadress pekar på olika konton."},{status:409});
   const salt=randomHex(16),hash=await passwordHash(password,salt);
   const existing=byEmployee||byEmail;
   if(existing?.id===user.accountId)return Response.json({error:"Byt ditt eget lösenord under Mitt konto."},{status:400});
   if(existing){
    await d.batch([
     d.prepare("UPDATE user_accounts SET email=?,employee_id=?,password_salt=?,password_hash=?,is_disabled=0,failed_attempts=0,locked_until=NULL WHERE id=?").bind(email,employeeId,salt,hash,existing.id),
     d.prepare("DELETE FROM user_sessions WHERE user_id=?").bind(existing.id)
    ]);
   }else await d.prepare("INSERT INTO user_accounts(employee_id,email,password_salt,password_hash) VALUES(?,?,?,?)").bind(employeeId,email,salt,hash).run();
    }else if(action==="setAccountDisabled"){
   if(!user.isAdmin)return forbidden();
   const target=Number(b.accountId);
   if(target===user.accountId)return Response.json({error:"Du kan inte inaktivera ditt eget administratörskonto."},{status:400});
   const disabled=Number(Boolean(b.disabled));
   const current=await d.prepare("SELECT id,is_admin isAdmin,is_disabled isDisabled FROM user_accounts WHERE id=?").bind(target).first<{id:number;isAdmin:number;isDisabled:number}>();
   if(!current)return Response.json({error:"Kontot finns inte."},{status:404});
   if(disabled&&current.isAdmin&&!current.isDisabled&&!await activeOtherAdmins(d,target))return adminRequired();
   await d.prepare("UPDATE user_accounts SET is_disabled=? WHERE id=?").bind(disabled,target).run();
   await d.prepare("DELETE FROM user_sessions WHERE user_id=?").bind(target).run();
  }else if(action==="replaceLeader"||action==="setWorkPackageLeader"){
   const kind=action==="setWorkPackageLeader"?"workPackage":String(b.kind||"");
   if(!["project","team","workPackage"].includes(kind))return Response.json({error:"Ogiltig ledartyp."},{status:400});
   const target=kind==="project"?projectId:kind==="team"?teamId:Number(b.workPackageId);
   if(!Number.isSafeInteger(target)||target<=0)return Response.json({error:"Välj ett projekt, uppdrag eller TEAM."},{status:400});
   const oldId=action==="setWorkPackageLeader"?null:(b.oldEmployeeId===null||b.oldEmployeeId===undefined?null:Number(b.oldEmployeeId));
   const newId=action==="setWorkPackageLeader"?(Boolean(b.enabled)?employeeId:null):(b.newEmployeeId===null||b.newEmployeeId===undefined?null:Number(b.newEmployeeId));
   const deleteOnly=action==="setWorkPackageLeader"&&!Boolean(b.enabled);
   if(newId===null&&oldId===null&&!deleteOnly)return Response.json({error:"Välj en person att tillsätta eller ersätta."},{status:400});
   if([oldId,newId].some(x=>x!==null&&(!Number.isSafeInteger(x)||x<=0)))return Response.json({error:"Ogiltigt medarbetar-ID."},{status:400});
   const toCheck=action==="setWorkPackageLeader"?employeeId:newId;
   if(toCheck!==null&&!await d.prepare("SELECT id FROM employees WHERE id=?").bind(toCheck).first())
    return Response.json({error:"Medarbetaren saknas."},{status:404});
   const targetInfo:{id:number;ownerId?:number|null;projectId?:number}|null=kind==="team"?
     await d.prepare("SELECT id,owner_id ownerId FROM employee_groups WHERE id=?").bind(target).first<{id:number;ownerId:number|null}>():
     kind==="workPackage"?
     await d.prepare("SELECT id,project_id projectId FROM work_packages WHERE id=?").bind(target).first<{id:number;projectId:number}>():
     await d.prepare("SELECT id FROM projects WHERE id=?").bind(target).first<{id:number}>();
   if(!targetInfo)return Response.json({error:"Projektet, uppdraget eller TEAMET saknas."},{status:404});
   const allowed=user.isAdmin||(user.isGroupManager&&(kind==="team"?
       targetInfo.ownerId===user.employeeId:
       scope.projectIds.has(kind==="project"?target:(targetInfo.projectId??0))));
   if(!allowed)return forbidden();
   const table=kind==="team"?"team_leaders":kind==="workPackage"?"work_package_leaders":"project_leaders";
   const col=kind==="team"?"team_id":kind==="workPackage"?"work_package_id":"project_id";
   const deletes:number[]=[];
   if(action==="setWorkPackageLeader"&&deleteOnly)deletes.push(employeeId);
   else if(oldId!==null)deletes.push(oldId);
   for(const old of deletes){
    if(!await d.prepare(`SELECT 1 FROM ${table} WHERE ${col}=? AND employee_id=?`).bind(target,old).first())
     return Response.json({error:"Den gamla ledaren finns inte längre på uppdraget."},{status:409});
   }
   const q:D1PreparedStatement[]=[];
   for(const old of deletes)q.push(d.prepare(`DELETE FROM ${table} WHERE ${col}=? AND employee_id=?`).bind(target,old));
   if(newId!==null){
    if(kind==="team")q.push(d.prepare("INSERT OR IGNORE INTO employee_group_members(group_id,employee_id) VALUES(?,?)").bind(target,newId));
    if(kind==="project")q.push(d.prepare("INSERT OR IGNORE INTO project_members(project_id,employee_id) VALUES(?,?)").bind(target,newId));
    if(kind==="workPackage")q.push(d.prepare("INSERT OR IGNORE INTO project_members(project_id,employee_id) VALUES(?,?)").bind(targetInfo.projectId,newId));
    q.push(d.prepare(`INSERT OR IGNORE INTO ${table}(${col},employee_id) VALUES(?,?)`).bind(target,newId));
   }
   if(q.length)await d.batch(q);
  }else if(action==="setTeamOwner"){
   if(!user.isAdmin)return forbidden();
   const teamId=Number(b.teamId);
   const managerId=b.employeeId===null?null:Number(b.employeeId);
   if(!Number.isSafeInteger(teamId)||teamId<=0||managerId!==null&&(!Number.isSafeInteger(managerId)||managerId<=0))
    return Response.json({error:"Ogiltigt TEAM eller gruppchef."},{status:400});
   await d.prepare("UPDATE employee_groups SET owner_id=? WHERE id=?").bind(managerId,teamId).run();
 }else if(action==="setProjectLeader"||action==="setTeamLeader"){
   if(!Number.isSafeInteger(employeeId)||employeeId<=0||!await d.prepare("SELECT id FROM employees WHERE id=?").bind(employeeId).first())
    return Response.json({error:"Välj en befintlig medarbetare."},{status:400});
   if(!user.isAdmin&&!user.isGroupManager)return forbidden();
   const enabled=Boolean(b.enabled);
   if(action==="setProjectLeader"){
    if(!Number.isSafeInteger(projectId)||projectId<=0||!await d.prepare("SELECT id FROM projects WHERE id=?").bind(projectId).first())
     return Response.json({error:"Projektet saknas."},{status:400});
    if(!user.isAdmin&&!scope.projectIds.has(projectId))return forbidden();
    if(enabled)await d.batch([d.prepare("INSERT OR IGNORE INTO project_members(project_id,employee_id) VALUES(?,?)").bind(projectId,employeeId),d.prepare("INSERT OR IGNORE INTO project_leaders(project_id,employee_id) VALUES(?,?)").bind(projectId,employeeId)]);
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
