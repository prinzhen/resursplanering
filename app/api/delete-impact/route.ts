import {env} from "cloudflare:workers";
import {sessionIdentity,unauthorized,forbidden} from "@/lib/auth";
import {deletableKind,activityIdsInScope,deletionImpact} from "@/lib/delete-time-impact";
export const dynamic="force-dynamic";
export async function GET(req:Request){
 try{
  if(!env.DB)return Response.json({error:"Databasen saknas."},{status:500});
  const d=env.DB,user=await sessionIdentity(req,d);
  if(!user)return unauthorized();
  if(!user.isAdmin)return forbidden();
  const url=new URL(req.url),kind=url.searchParams.get("type"),id=Number(url.searchParams.get("id"));
  if(!deletableKind(kind)||!Number.isSafeInteger(id)||id<=0)
   return Response.json({error:"Ogiltigt projekt, uppdrag eller aktivitet."},{status:400});
  const table=kind==="project"?"projects":kind==="workPackage"?"work_packages":"activities";
  const entry=await d.prepare(`SELECT id FROM ${table} WHERE id=?`).bind(id).first();
  if(!entry)return Response.json({error:"Posten finns inte längre."},{status:404});
  const impact=await deletionImpact(d,kind,id);
  const scope=activityIdsInScope(kind);
  const choices=await d.prepare(`SELECT a.id,a.name,a.code,a.project_id projectId,p.code projectCode,p.name projectName
   FROM activities a JOIN projects p ON p.id=a.project_id
   WHERE a.id NOT IN (${scope})
   ORDER BY p.name,a.name,a.id LIMIT 1500`).bind(id).all<{
    id:number;name:string;code:string|null;projectId:number;projectCode:string;projectName:string
   }>();
  return Response.json({impact,targets:choices.results},{headers:{"cache-control":"no-store"}});
 }catch(error){
  console.error("delete-impact GET",error);
  return Response.json({error:"Kunde inte läsa kopplade tidrapporter."},{status:500});
 }
}
