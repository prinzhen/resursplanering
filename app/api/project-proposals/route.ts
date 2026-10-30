import {env} from "cloudflare:workers";
import {sessionIdentity,unauthorized,forbidden,sameOrigin} from "@/lib/auth";
export const dynamic="force-dynamic";
const db=()=>{if(!env.DB)throw Error("Databasen saknas");return env.DB};
type Proposal={id:number;submittedBy:number;code:string;name:string;description:string;color:string;priority:number;status:string;reviewedBy:number|null;comment:string|null;createdProjectId:number|null;createdAt:string};
const validCode=(v:unknown)=>typeof v==="string"&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$/.test(v.trim());
const validate=(b:Record<string,unknown>)=>{
 const code=String(b.code||"").trim().toUpperCase(),name=String(b.name||"").trim(),description=String(b.description||"").trim(),
 color=String(b.color||"#2563eb"),priority=Number(b.priority??3);
 if(!validCode(code)||name.length<3||name.length>150||description.length>1500||
 !/^#[0-9a-fA-F]{6}$/.test(color)||!Number.isInteger(priority)||priority<1||priority>5)return null;
 return {code,name,description,color,priority};
};
export async function GET(req:Request){
 try{
  const d=db(),user=await sessionIdentity(req,d);if(!user)return unauthorized();
  const reviewer=user.isAdmin||user.isGroupManager;
  const rows=await d.prepare(`SELECT r.id,r.submitted_by submittedBy,r.code,r.name,r.description,r.color,r.priority,r.status,
    r.reviewed_by reviewedBy,r.comment,r.created_project_id createdProjectId,r.created_at createdAt,
    u.email submittedByEmail,v.email reviewedByEmail
   FROM project_proposals r JOIN user_accounts u ON u.id=r.submitted_by
   LEFT JOIN user_accounts v ON v.id=r.reviewed_by
   WHERE (?=1 OR r.submitted_by=?) ORDER BY CASE WHEN r.status='pending' THEN 0 ELSE 1 END,r.id DESC`)
   .bind(reviewer?1:0,user.accountId).all<Proposal>();
  return Response.json({proposals:rows.results,canReview:reviewer},{headers:{"cache-control":"no-store"}});
 }catch(e){console.error(e);return Response.json({error:"Kunde inte läsa projektförslag."},{status:500})}
}
export async function POST(req:Request){
 try{
  const d=db(),user=await sessionIdentity(req,d);if(!user)return unauthorized();
  if(!sameOrigin(req))return forbidden();
  const b=await req.json() as Record<string,unknown>,action=String(b.action||"");
  if(action==="submit"){
   const details=validate(b);if(!details)return Response.json({error:"Ange giltig projektkod (max 40 tecken), projektnamn (3–150 tecken), färg och prioritet 1–5."},{status:400});
   const exists=await d.prepare("SELECT id FROM projects WHERE code=? COLLATE NOCASE").bind(details.code).first();
   if(exists)return Response.json({error:"Projektkoden används redan av ett befintligt projekt."},{status:409});
   const duplicate=await d.prepare("SELECT id FROM project_proposals WHERE code=? COLLATE NOCASE AND status='pending'").bind(details.code).first();
   if(duplicate)return Response.json({error:"Det finns redan ett obesvarat förslag med den projektkoden."},{status:409});
   await d.prepare("INSERT INTO project_proposals(submitted_by,code,name,description,color,priority) VALUES(?,?,?,?,?,?)")
    .bind(user.accountId,details.code,details.name,details.description,details.color,details.priority).run();
  }else if(action==="review"){
   if(!user.isAdmin&&!user.isGroupManager)return forbidden();
   const id=Number(b.id),approve=b.approve===true,comment=String(b.comment||"").trim();
   if(!Number.isSafeInteger(id)||id<=0||comment.length>500)return Response.json({error:"Ogiltigt förslag eller kommentar."},{status:400});
   const proposal=await d.prepare("SELECT id,code,status FROM project_proposals WHERE id=?").bind(id).first<{id:number;code:string;status:string}>();
   if(!proposal)return Response.json({error:"Projektförslaget hittades inte."},{status:404});
   if(proposal.status!=="pending")return Response.json({error:"Förslaget har redan hanterats."},{status:409});
   if(approve){
    if(await d.prepare("SELECT id FROM projects WHERE code=? COLLATE NOCASE").bind(proposal.code).first())
     return Response.json({error:"Projektkoden används redan. Avslå förslaget eller använd en annan kod i ett nytt förslag."},{status:409});
    // D1 batch is atomic. A project exists only if its proposal could be approved.
    await d.batch([
     d.prepare(`INSERT INTO projects(code,name,color,description,status,priority)
       SELECT code,name,color,NULLIF(description,''),'Aktivt',priority
       FROM project_proposals WHERE id=? AND status='pending'`).bind(id),
     d.prepare(`UPDATE project_proposals SET status='approved',reviewed_by=?,comment=?,reviewed_at=CURRENT_TIMESTAMP,
       created_project_id=(SELECT id FROM projects WHERE code=project_proposals.code COLLATE NOCASE)
       WHERE id=? AND status='pending'`).bind(user.accountId,comment||null,id)
    ]);
   }else{
    const result=await d.prepare("UPDATE project_proposals SET status='rejected',reviewed_by=?,comment=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").bind(user.accountId,comment||null,id).run();
    if(!result.meta.changes)return Response.json({error:"Förslaget har redan hanterats."},{status:409});
   }
  }else return Response.json({error:"Okänd åtgärd."},{status:400});
  return GET(req);
 }catch(e){console.error(e);return Response.json({error:"Kunde inte behandla projektförslaget."},{status:500})}
}
