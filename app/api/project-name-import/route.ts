import {env} from "cloudflare:workers";
import {sessionIdentity,unauthorized,forbidden,sameOrigin} from "@/lib/auth";
export const dynamic="force-dynamic";
const validCode=/^[A-Z0-9][A-Z0-9._-]{0,39}$/;

export async function POST(request:Request){
 try{
  const d=env.DB;if(!d)return Response.json({error:"Databasen saknas."},{status:503});
  const user=await sessionIdentity(request,d);
  if(!user)return unauthorized();
  if(!user.isAdmin||!sameOrigin(request))return forbidden();
  const input=await request.json() as {changes?:unknown};
  if(!Array.isArray(input.changes)||input.changes.length<1||input.changes.length>1000)
   return Response.json({error:"Välj 1–1000 projektnamn att korrigera."},{status:400});
  const changes: {id:number;code:string;oldName:string;newName:string}[]=[];
  const seen=new Set<string>();
  for(const raw of input.changes){
   if(!raw||typeof raw!=="object")return Response.json({error:"Ogiltig rad."},{status:400});
   const x=raw as Record<string,unknown>;
   const code=String(x.code??"").trim().toUpperCase();
   const oldName=String(x.oldName??"").trim();
   const newName=String(x.newName??"").trim();
   if(!validCode.test(code)||!newName||newName.length>150||!oldName||seen.has(code))
    return Response.json({error:"Ogiltig eller upprepad projektkod/namn: "+code},{status:400});
   seen.add(code);
   const row=await d.prepare("SELECT id,name FROM projects WHERE code=? COLLATE NOCASE")
    .bind(code).first<{id:number;name:string}>();
   if(!row||row.name!==oldName)return Response.json({error:"Projektet "+code+" har ändrats eller saknas. Läs in aktuell projektlista igen."},{status:409});
   if(oldName!==newName)changes.push({id:row.id,code,oldName,newName});
  }
  if(!changes.length)return Response.json({updated:0});
  // Each update checks original name, so any concurrent rename aborts the batch.
  const statements=changes.map(x=>d.prepare(
   "UPDATE projects SET name=? WHERE id=? AND code=? AND name=?"
  ).bind(x.newName,x.id,x.code,x.oldName));
  const results=await d.batch(statements);
  if(results.some(x=>x.meta.changes!==1))
   throw Error("En eller flera uppdateringar kunde inte verifieras.");
  return Response.json({updated:changes.length});
 }catch(e){console.error("project-name-import",e);return Response.json({error:"Kunde inte genomföra korrigeringen."},{status:500})}
}
