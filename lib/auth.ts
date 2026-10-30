/** Worker-compatible password hashing and opaque session authentication. */
const ITERATIONS=310000;
const SESSION_SECONDS=12*60*60;
const encoder=new TextEncoder();
const hex=(bytes:Uint8Array)=>[...bytes].map(b=>b.toString(16).padStart(2,"0")).join("");
const unhex=(s:string)=>new Uint8Array((s.match(/.{2}/g)||[]).map(b=>parseInt(b,16)));
export function randomHex(n=32){return hex(crypto.getRandomValues(new Uint8Array(n)))}
export async function passwordHash(password:string,saltHex:string):Promise<string>{
 const key=await crypto.subtle.importKey("raw",encoder.encode(password),"PBKDF2",false,["deriveBits"]);
 const bits=await crypto.subtle.deriveBits({name:"PBKDF2",salt:unhex(saltHex) as BufferSource,iterations:ITERATIONS,hash:"SHA-256"},key,256);
 return hex(new Uint8Array(bits));
}
export async function tokenDigest(token:string):Promise<string>{
 const hash=await crypto.subtle.digest("SHA-256",encoder.encode(token));
 return hex(new Uint8Array(hash));
}
export function equalDigest(a:string,b:string):boolean{
 if(a.length!==b.length)return false;
 let different=0;for(let i=0;i<a.length;i++)different|=a.charCodeAt(i)^b.charCodeAt(i);
 return different===0;
}
export type Identity={accountId:number;email:string;employeeId:number|null;isAdmin:boolean;isGroupManager:boolean};
export async function sessionIdentity(req:Request,d:D1Database):Promise<Identity|null>{
 const cookies=req.headers.get("cookie")||"";
 const raw=cookies.split(";").map(c=>c.trim()).find(c=>c.startsWith("rp_session="))?.slice("rp_session=".length)||"";
 if(!/^[a-f0-9]{64}$/.test(raw))return null;
 const row=await d.prepare(`SELECT u.id accountId,u.email,u.employee_id employeeId,u.is_admin isAdmin,u.is_group_manager isGroupManager
 FROM user_sessions s JOIN user_accounts u ON u.id=s.user_id
 WHERE s.token_hash=? AND s.expires_at>? AND u.is_disabled=0`).bind(await tokenDigest(raw),Math.floor(Date.now()/1000)).first<{accountId:number;email:string;employeeId:number|null;isAdmin:number;isGroupManager:number}>();
 return row?{accountId:row.accountId,email:row.email,employeeId:row.employeeId,isAdmin:!!row.isAdmin,isGroupManager:!!row.isGroupManager}:null;
}
export function unauthorized(){return Response.json({error:"Du måste logga in.",loginRequired:true},{status:401,headers:{"cache-control":"no-store"}})}
export function forbidden(){return Response.json({error:"Du saknar behörighet för åtgärden."},{status:403,headers:{"cache-control":"no-store"}})}
export function setSessionCookie(req:Request,token:string){
 const secure=new URL(req.url).protocol==="https:"||req.headers.get("x-forwarded-proto")==="https";
 return `rp_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secure?"; Secure":""}`;
}
export function deleteSessionCookie(req:Request){
 const secure=new URL(req.url).protocol==="https:"||req.headers.get("x-forwarded-proto")==="https";
 return `rp_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure?"; Secure":""}`;
}
export function sameOrigin(req:Request){
 const origin=req.headers.get("origin");if(!origin)return true;
 try{
  const o=new URL(origin),u=new URL(req.url);
  const forwardedProto=req.headers.get("x-forwarded-proto"),forwardedHost=req.headers.get("x-forwarded-host");
  if(o.host===u.host&&(o.protocol===u.protocol||(forwardedProto==="https"&&o.protocol==="https:")))return true;
  // Loopback-only deployment can be fronted by Tailscale Serve / Nginx TLS.
  // Browsers cannot forge the reverse proxy header without a CORS preflight.
  return (u.hostname==="127.0.0.1"||u.hostname==="localhost")&&
   !!forwardedHost&&o.host===forwardedHost&&
   o.protocol===(forwardedProto==="https"?"https:":"http:");
 }catch{return false}
}
export async function issueSession(d:D1Database,userId:number){
 const token=randomHex(),expires=Math.floor(Date.now()/1000)+SESSION_SECONDS;
 await d.prepare("INSERT INTO user_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)").bind(await tokenDigest(token),userId,expires).run();
 return token;
}
export async function revokeSession(req:Request,d:D1Database){
 const raw=(req.headers.get("cookie")||"").split(";").map(c=>c.trim()).find(c=>c.startsWith("rp_session="))?.slice(11)||"";
 if(/^[a-f0-9]{64}$/.test(raw))await d.prepare("DELETE FROM user_sessions WHERE token_hash=?").bind(await tokenDigest(raw)).run();
}
export async function verifyPassword(d:D1Database,email:string,password:string):Promise<{id:number}|null>{
 const user=await d.prepare("SELECT id,password_salt salt,password_hash hash,failed_attempts failures,locked_until locked,is_disabled disabled FROM user_accounts WHERE lower(email)=lower(?)").bind(email).first<{id:number;salt:string;hash:string;failures:number;locked:number|null;disabled:number}>();
 // Perform hashing for unknown usernames too, to reduce username enumeration.
 const salt=user?.salt||"00000000000000000000000000000000";
 const derived=await passwordHash(password,salt);
 if(!user||user.disabled||Number(user.locked||0)>Math.floor(Date.now()/1000)||!equalDigest(user.hash,derived)){
  if(user&&!user.disabled)await d.prepare("UPDATE user_accounts SET failed_attempts=failed_attempts+1,locked_until=CASE WHEN failed_attempts>=4 THEN ? ELSE locked_until END WHERE id=?").bind(Math.floor(Date.now()/1000)+900,user.id).run();
  return null;
 }
 await d.prepare("UPDATE user_accounts SET failed_attempts=0,locked_until=NULL WHERE id=?").bind(user.id).run();
 return {id:user.id};
}
