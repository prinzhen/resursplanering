import {env} from "cloudflare:workers";
import {sessionIdentity,unauthorized,forbidden} from "@/lib/auth";
import {employeeTimeImpact} from "@/lib/employee-time-ledger";
export const dynamic="force-dynamic";
export async function GET(req:Request){
 try{
  const d=env.DB;
  if(!d)return Response.json({error:"Databasen saknas."},{status:500});
  const user=await sessionIdentity(req,d);
  if(!user)return unauthorized();
  if(!user.isAdmin)return forbidden();
  const id=Number(new URL(req.url).searchParams.get("id"));
  if(!Number.isSafeInteger(id)||id<1)return Response.json({error:"Ogiltigt medarbetar-ID."},{status:400});
  const employee=await d.prepare("SELECT id,manager_id managerId FROM employees WHERE id=? AND is_group_ledger=0").bind(id)
    .first<{id:number;managerId:number|null}>();
  if(!employee)return Response.json({error:"Medarbetaren finns inte."},{status:404});
  const groups=await d.prepare("SELECT id,name,owner_id ownerId FROM employee_groups ORDER BY name")
    .all<{id:number;name:string;ownerId:number|null}>();
  const memberships=await d.prepare("SELECT group_id groupId FROM employee_group_members WHERE employee_id=?").bind(id)
    .all<{groupId:number}>();
  const memberIds=new Set(memberships.results.map(x=>x.groupId));
  const suggested=groups.results.find(g=>memberIds.has(g.id))??
   groups.results.find(g=>g.ownerId!==null&&g.ownerId===employee.managerId);
  const impact=await employeeTimeImpact(d,id);
  return Response.json({impact,groups:groups.results,suggestedGroupId:suggested?.id??null},
   {headers:{"cache-control":"no-store"}});
 }catch(e){console.error("employee-delete-impact",e);
  return Response.json({error:"Kunde inte kontrollera medarbetarens tid."},{status:500});
 }
}
