import {env} from "cloudflare:workers";
import {sessionIdentity,verifyPassword,issueSession,setSessionCookie,deleteSessionCookie,revokeSession,passwordHash,randomHex,sameOrigin} from "@/lib/auth";
export const dynamic="force-dynamic";
const d=()=>env.DB;
export async function GET(req:Request){
 const user=await sessionIdentity(req,d());
 return Response.json({user},{headers:{"cache-control":"no-store"}});
}
export async function POST(req:Request){
 try{
  if(!sameOrigin(req))return Response.json({error:"Otillåtet ursprung"},{status:403});
  const input=await req.json() as Record<string,unknown>,action=String(input.action||"login");
  if(action==="logout"){
   await revokeSession(req,d());
   return Response.json({ok:true},{headers:{"set-cookie":deleteSessionCookie(req),"cache-control":"no-store"}});
  }
  if(action==="changePassword"){
   const user=await sessionIdentity(req,d());
   if(!user)return Response.json({error:"Du måste logga in"},{status:401});
   const previous=String(input.currentPassword||""),next=String(input.newPassword||"");
   if(next.length<12||next.length>256)return Response.json({error:"Lösenordet måste vara minst 12 tecken."},{status:400});
   if(!await verifyPassword(d(),user.email,previous))return Response.json({error:"Nuvarande lösenord är fel."},{status:403});
   const salt=randomHex(16),hash=await passwordHash(next,salt);
   await d().batch([
    d().prepare("UPDATE user_accounts SET password_salt=?,password_hash=? WHERE id=?").bind(salt,hash,user.accountId),
    d().prepare("DELETE FROM user_sessions WHERE user_id=?").bind(user.accountId)
   ]);
   return Response.json({ok:true,requiresLogin:true},{headers:{"set-cookie":deleteSessionCookie(req),"cache-control":"no-store"}});
  }
  if(action!=="login")return Response.json({error:"Ogiltig åtgärd"},{status:400});
  const email=String(input.email||"").toLowerCase().trim(),password=String(input.password||"");
  if(email.length>255||password.length>256||!email||!password)return Response.json({error:"Ogiltig inloggning"},{status:400});
  const verified=await verifyPassword(d(),email,password);
  if(!verified)return Response.json({error:"Felaktig e-post eller lösenord."},{status:401,headers:{"cache-control":"no-store"}});
  const token=await issueSession(d(),verified.id);
  const user=await sessionIdentity(new Request(req.url,{headers:{cookie:"rp_session="+token}}),d());
  return Response.json({user},{headers:{"set-cookie":setSessionCookie(req,token),"cache-control":"no-store"}});
 }catch(e){console.error(e);return Response.json({error:"Inloggningsfel."},{status:500})}
}
