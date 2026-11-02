import {createHash,createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {ApiError,fields,requireAdmin,rateLimit,str,uuid,type Staff} from './auth';
import {database,transaction,withDatabase,type D1Binding,type Executor,type Row} from './db';
import {sealSocialSecret,openSocialSecret,type Sealed} from './social-accounts';

type Env=Record<string,string|undefined>;
const scopes=['leads:read','conversations:read'],eventTypes=['lead.changed','conversation.changed'];
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const deny=(status:number,code:string)=>new ApiError(status,code);
const encryptionEnv=(env:Env)=>({SOCIAL_TOKEN_KEYS:env.CRM_WEBHOOK_SECRET_KEYS,SOCIAL_TOKEN_KEY_CURRENT:env.CRM_WEBHOOK_SECRET_KEY_CURRENT});
const noStore={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
function choices(value:unknown,allowed:string[]){if(!Array.isArray(value)||!value.length||value.length>allowed.length||value.some(x=>typeof x!=='string'||!allowed.includes(x))||new Set(value).size!==value.length)throw deny(400,'invalid_scope');return value as string[];}
async function audit(c:Executor,s:Staff,action:string,id:string){await c.query('INSERT INTO audit_events(id,org_id,actor_id,action,entity_id,metadata) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),s.orgId,s.id,action,id,'{}']);}
const keyView=(r:Row)=>({id:r.id,name:r.name,hint:r.token_hint,scopes:JSON.parse(r.scopes_json),expiresAt:r.expires_at,revokedAt:r.revoked_at,lastUsedAt:r.last_used_at,createdAt:r.created_at});
const hookView=(r:Row)=>({id:r.id,name:r.name,url:r.url,events:JSON.parse(r.events_json),state:r.state,version:r.version,cursor:r.cursor,signingVersion:r.signing_version,createdAt:r.created_at,updatedAt:r.updated_at});
export function webhookTarget(input:unknown,env:Env=process.env){
 const text=str(input,'URL',2000,true);let u:URL,origins:unknown;try{u=new URL(text);origins=JSON.parse(env.CRM_WEBHOOK_ALLOWED_ORIGINS||'[]');}catch{throw deny(400,'webhook_origin_not_allowed');}
 if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.port||!Array.isArray(origins)||!origins.includes(u.origin)||/^(?:\d+\.){3}\d+$/.test(u.hostname)||u.hostname.includes(':')||u.hostname.endsWith('.')||!u.hostname.includes('.')||/(^|\.)(localhost|local|internal|lan|home|arpa)$/.test(u.hostname))throw deny(400,'webhook_origin_not_allowed');
 return u.href;
}
export async function integrationOverview(staff:Staff,env:Env=process.env){
 requireAdmin(staff);
 const [keys,hooks,deliveries,attempts]=await Promise.all([
 database.query('SELECT * FROM crm_public_api_keys WHERE org_id=$1 ORDER BY created_at DESC LIMIT 100',[staff.orgId]),
 database.query('SELECT * FROM crm_public_webhooks WHERE org_id=$1 ORDER BY created_at DESC LIMIT 50',[staff.orgId]),
 database.query('SELECT id,subscription_id,sequence,event_id,status,attempts,http_status,last_error,created_at,updated_at FROM crm_public_webhook_deliveries WHERE org_id=$1 ORDER BY created_at DESC,id LIMIT 100',[staff.orgId]),
 database.query('SELECT delivery_id,attempt,http_status,error_code,duration_ms,created_at FROM crm_public_webhook_attempts WHERE org_id=$1 ORDER BY created_at DESC LIMIT 100',[staff.orgId])]);
 let origins:string[]=[];try{const raw=JSON.parse(env.CRM_WEBHOOK_ALLOWED_ORIGINS||'[]');if(Array.isArray(raw))origins=raw.filter(x=>typeof x==='string');}catch{}
 return {keys:keys.rows.map(keyView),webhooks:hooks.rows.map(hookView),deliveries:deliveries.rows,attempts:attempts.rows,scopes,eventTypes,gates:{api:env.CRM_PUBLIC_API_ENABLED==='true',webhooks:env.CRM_PUBLIC_WEBHOOKS_ENABLED==='true',runner:env.CRM_PUBLIC_WEBHOOK_RUNNER_ENABLED==='true',allowedOrigins:origins}};
}
export async function createApiKey(staff:Staff,input:Record<string,unknown>){
 requireAdmin(staff);fields(input,['name','scopes','expiresInDays','rotateId']);
 const rotateId=input.rotateId===undefined?null:uuid(input.rotateId),days=input.expiresInDays??90;
 if(!Number.isInteger(days)||Number(days)<1||Number(days)>365)throw deny(400,'invalid_expiry');
 const id=randomUUID(),secret='rrs_'+id+'_'+randomBytes(32).toString('hex'),now=Date.now();
 const result=await transaction(staff.orgId,async c=>{
  const old=rotateId?(await c.query('SELECT * FROM crm_public_api_keys WHERE org_id=$1 AND id=$2 AND revoked_at IS NULL',[staff.orgId,rotateId])).rows[0]:null;
  if(rotateId&&!old)throw deny(404,'key_not_found');
  const count=(await c.query('SELECT COUNT(*) AS n FROM crm_public_api_keys WHERE org_id=$1 AND revoked_at IS NULL AND expires_at>$2',[staff.orgId,now])).rows[0].n;
  if(count>=20)throw deny(409,'key_limit');
  const name=old?old.name:str(input.name,'ชื่อ',80,true),allowed=old?JSON.parse(old.scopes_json):choices(input.scopes,scopes),expiresAt=now+Number(days)*86400000;
  await c.query('INSERT INTO crm_public_api_keys(id,org_id,created_by,name,token_hash,token_hint,scopes_json,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,staff.orgId,staff.id,name,hash(secret),secret.slice(0,12)+'…'+secret.slice(-4),JSON.stringify(allowed),expiresAt,now]);
  if(old)await c.query('UPDATE crm_public_api_keys SET expires_at=MIN(expires_at,$1) WHERE org_id=$2 AND id=$3',[now+600000,staff.orgId,old.id]);
  await audit(c,staff,old?'integration.key.rotated':'integration.key.created',id);return {id,name,scopes:allowed,expiresAt};
 },staff);
 return {...result,secret,previousExpiresInSeconds:rotateId?600:null};
}
export async function revokeApiKey(staff:Staff,input:Record<string,unknown>){
 requireAdmin(staff);fields(input,['id']);const id=uuid(input.id);
 await transaction(staff.orgId,async c=>{const row=(await c.query('SELECT id FROM crm_public_api_keys WHERE org_id=$1 AND id=$2',[staff.orgId,id])).rows[0];if(!row)throw deny(404,'key_not_found');await c.query('UPDATE crm_public_api_keys SET revoked_at=$1 WHERE org_id=$2 AND id=$3',[Date.now(),staff.orgId,id]);await audit(c,staff,'integration.key.revoked',id);},staff);return {ok:true};
}
export async function publicRead(request:Request,resource:string){
 try{
  if(process.env.CRM_PUBLIC_API_ENABLED!=='true')throw deny(503,'public_api_disabled');
  if(request.method!=='GET'||!['leads','conversations'].includes(resource))throw deny(404,'not_found');
  if(new URL(request.url).protocol!=='https:'||request.headers.has('origin')||request.headers.has('cookie'))throw deny(403,'server_authentication_required');
  const token=/^Bearer (rrs_[0-9a-f-]{36}_[0-9a-f]{64})$/.exec(request.headers.get('authorization')||'')?.[1];if(!token)throw deny(401,'invalid_api_key');
  const id=token.slice(4,40),row=(await database.query("SELECT k.* FROM crm_public_api_keys k JOIN members m ON m.org_id=k.org_id AND m.id=k.created_by WHERE k.id=$1 AND k.revoked_at IS NULL AND k.expires_at>$2 AND m.active=1 AND m.role='Admin'",[id,Date.now()])).rows[0];
  if(!row||!timingSafeEqual(Buffer.from(hash(token),'hex'),Buffer.from(row.token_hash,'hex')))throw deny(401,'invalid_api_key');
  if(!JSON.parse(row.scopes_json).includes(resource+':read'))throw deny(403,'api_scope_denied');
  await rateLimit('public-api:'+row.org_id+':'+id,60,60);
  const u=new URL(request.url),after=u.searchParams.get('after')||'',limit=Number(u.searchParams.get('limit')||50);
  if(!Number.isSafeInteger(limit)||limit<1||limit>100||[...u.searchParams.keys()].some(k=>!['after','limit'].includes(k))||[...u.searchParams.keys()].some(k=>u.searchParams.getAll(k).length!==1))throw deny(400,'invalid_page');if(after)uuid(after);
  const columns=resource==='leads'?'id,name,phone,email,market,stage,source,tags,assignee_id,created_at,updated_at':'id,lead_id,status,version,assignee_id,created_at,updated_at';
  const rows=(await database.query('SELECT '+columns+' FROM '+resource+' WHERE org_id=$1 AND id>$2 ORDER BY id LIMIT $3',[row.org_id,after,limit+1])).rows;
  await database.query('UPDATE crm_public_api_keys SET last_used_at=$1 WHERE id=$2 AND org_id=$3',[Date.now(),id,row.org_id]);
  return Response.json({version:1,data:rows.slice(0,limit),nextCursor:rows.length>limit?rows[limit-1].id:null},{headers:noStore});
 }catch(e){return Response.json({error:e instanceof ApiError?e.message:'public_api_unavailable'},{status:e instanceof ApiError?e.status:503,headers:noStore});}
}
export async function saveWebhook(staff:Staff,input:Record<string,unknown>,env:Env=process.env){
 requireAdmin(staff);fields(input,['name','url','events']);
 const id=randomUUID(),name=str(input.name,'ชื่อ',80,true),url=webhookTarget(input.url,env),events=choices(input.events,eventTypes),secret=randomBytes(32).toString('hex'),now=Date.now();
 const sealed=await sealSocialSecret(secret,'public-webhook',[staff.orgId,id],encryptionEnv(env));
 await transaction(staff.orgId,async c=>{
  if((await c.query('SELECT COUNT(*) AS n FROM crm_public_webhooks WHERE org_id=$1',[staff.orgId])).rows[0].n>=20)throw deny(409,'webhook_limit');
  const head=Number((await c.query('SELECT sequence FROM crm_bridge_state WHERE org_id=$1',[staff.orgId])).rows[0]?.sequence||0);
  await c.query("INSERT INTO crm_public_webhooks(id,org_id,created_by,name,url,events_json,secret_json,cursor,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)",[id,staff.orgId,staff.id,name,url,JSON.stringify(events),JSON.stringify(sealed),head,now]);await audit(c,staff,'integration.webhook.created',id);
 },staff);return {id,secret,signingVersion:1,state:'paused'};
}
export async function controlWebhook(staff:Staff,input:Record<string,unknown>,env:Env=process.env){
 requireAdmin(staff);fields(input,['id','version','action','confirmed','deliveryId']);const id=uuid(input.id),action=input.action;
 if(!['enable','pause','rotate','retry'].includes(String(action)))throw deny(400,'invalid_action');
 let issued:string|undefined;
 const result=await transaction(staff.orgId,async c=>{
  const row=(await c.query('SELECT * FROM crm_public_webhooks WHERE org_id=$1 AND id=$2',[staff.orgId,id])).rows[0];if(!row)throw deny(404,'webhook_not_found');if(input.version!==row.version)throw deny(409,'webhook_changed');
  if(action==='enable'){if(input.confirmed!==true)throw deny(400,'confirmation_required');webhookTarget(row.url,env);await c.query("UPDATE crm_public_webhooks SET state='active',version=version+1,updated_at=$1 WHERE id=$2 AND org_id=$3",[Date.now(),id,staff.orgId]);}
  if(action==='pause')await c.query("UPDATE crm_public_webhooks SET state='paused',version=version+1,updated_at=$1 WHERE id=$2 AND org_id=$3",[Date.now(),id,staff.orgId]);
  if(action==='rotate'){issued=randomBytes(32).toString('hex');const sealed=await sealSocialSecret(issued,'public-webhook',[staff.orgId,id],encryptionEnv(env));await c.query("UPDATE crm_public_webhooks SET state='paused',secret_json=$1,signing_version=signing_version+1,version=version+1,updated_at=$2 WHERE id=$3 AND org_id=$4",[JSON.stringify(sealed),Date.now(),id,staff.orgId]);}
  if(action==='retry'){const deliveryId=uuid(input.deliveryId),delivery=(await c.query("SELECT id FROM crm_public_webhook_deliveries WHERE id=$1 AND org_id=$2 AND subscription_id=$3 AND status='dead'",[deliveryId,staff.orgId,id])).rows[0];if(!delivery)throw deny(404,'delivery_not_found');await c.query("UPDATE crm_public_webhook_deliveries SET status='pending',next_attempt_at=0,max_attempts=attempts+5,last_error='',updated_at=$1 WHERE id=$2 AND org_id=$3",[Date.now(),deliveryId,staff.orgId]);}
  await audit(c,staff,'integration.webhook.'+action,id);return {ok:true,signingVersion:row.signing_version+(action==='rotate'?1:0)};
 },staff);return {...result,...(issued?{secret:issued}:{})};
}
async function captureSubscription(orgId:string,id:string){
 await transaction(orgId,async c=>{
  const sub=(await c.query("SELECT w.* FROM crm_public_webhooks w JOIN members m ON m.org_id=w.org_id AND m.id=w.created_by WHERE w.org_id=$1 AND w.id=$2 AND w.state='active' AND m.active=1 AND m.role='Admin'",[orgId,id])).rows[0];if(!sub)return;
  const pending=Number((await c.query("SELECT COUNT(*) AS n FROM crm_public_webhook_deliveries WHERE org_id=$1 AND subscription_id=$2 AND status IN ('pending','sending')",[orgId,id])).rows[0].n);if(pending>=1000)return;
  const events=(await c.query('SELECT sequence,event_id,entity,record_id,occurred_at FROM crm_bridge_events WHERE org_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3',[orgId,sub.cursor,Math.min(50,1000-pending)])).rows;
  if(events.some((event,index)=>Number(event.sequence)!==Number(sub.cursor)+index+1))throw deny(503,'webhook_log_gap');
  const selected=JSON.parse(sub.events_json) as string[],now=Date.now();
  for(const event of events){const type=event.entity+'.changed';if(!selected.includes(type))continue;
   const deliveryId=randomUUID(),body=JSON.stringify({version:1,id:event.event_id,type,orgId,sequence:event.sequence,occurredAt:event.occurred_at,data:{id:event.record_id,resource:event.entity==='lead'?'leads':'conversations'}});
   await c.query('INSERT OR IGNORE INTO crm_public_webhook_deliveries(id,org_id,subscription_id,sequence,event_id,body,body_hash,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)',[deliveryId,orgId,id,event.sequence,event.event_id,body,hash(body),now]);
  }
  if(events.length)await c.query('UPDATE crm_public_webhooks SET cursor=$1,updated_at=$2 WHERE org_id=$3 AND id=$4',[events.at(-1)!.sequence,now,orgId,id]);
 });
}
async function sendBounded(url:string,body:string,headers:Headers,transport:typeof fetch){
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 const attempt=async()=>{const response=await transport(url,{method:'POST',body,headers,redirect:'manual',signal:controller.signal,cache:'no-store'});await response.body?.cancel();return response.status;};
 try{return await Promise.race([attempt(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('timeout'));},5000);})]);}finally{if(timer)clearTimeout(timer);}
}
/** At-least-once metadata hooks. Receivers deduplicate the stable delivery ID before side effects. */
export async function runPublicWebhooks(binding:D1Binding,env:Record<string,unknown>,transport:typeof fetch=fetch){
 if(env.CRM_PUBLIC_WEBHOOKS_ENABLED!=='true'||env.CRM_PUBLIC_WEBHOOK_RUNNER_ENABLED!=='true')return {status:'disabled',sent:0,failed:0};
 const config=env as Env;return withDatabase(binding,async()=>{
  const started=Date.now();let sent=0,failed=0;
  const subs=(await database.query("SELECT w.org_id,w.id FROM crm_public_webhooks w JOIN members m ON m.org_id=w.org_id AND m.id=w.created_by WHERE w.state='active' AND m.active=1 AND m.role='Admin' ORDER BY w.updated_at LIMIT 10")).rows;
  for(const sub of subs){if(Date.now()-started>20000)break;try{await captureSubscription(sub.org_id,sub.id);}catch{failed++;}}
  const due=(await database.query("SELECT d.* FROM crm_public_webhook_deliveries d JOIN crm_public_webhooks w ON w.id=d.subscription_id AND w.org_id=d.org_id JOIN members m ON m.id=w.created_by AND m.org_id=w.org_id WHERE w.state='active' AND m.active=1 AND m.role='Admin' AND d.status IN ('pending','sending') AND d.next_attempt_at<=$1 AND d.lease_until<=$1 ORDER BY d.next_attempt_at,d.created_at LIMIT 10",[Date.now()])).rows;
  for(const row of due){
   if(Date.now()-started>25000)break;
   const sub=(await database.query("SELECT w.* FROM crm_public_webhooks w JOIN members m ON m.id=w.created_by AND m.org_id=w.org_id WHERE w.id=$1 AND w.org_id=$2 AND w.state='active' AND m.active=1 AND m.role='Admin'",[row.subscription_id,row.org_id])).rows[0];if(!sub)continue;
   const lease=randomUUID(),at=Date.now();
   const claim=await database.query("UPDATE crm_public_webhook_deliveries SET status='sending',lease=$1,lease_until=$2,attempts=attempts+1,updated_at=$3 WHERE id=$4 AND org_id=$5 AND status IN ('pending','sending') AND next_attempt_at<=$3 AND lease_until<=$3 AND EXISTS(SELECT 1 FROM crm_public_webhooks WHERE id=$6 AND org_id=$5 AND state='active' AND version=$7)",[lease,at+15000,at,row.id,row.org_id,sub.id,sub.version]);if(!claim.rowCount)continue;
   let http:number|null=null,error='',success=false,permanent=false;
   try{
    const url=webhookTarget(sub.url,config),secret=await openSocialSecret(JSON.parse(sub.secret_json) as Sealed,'public-webhook',[row.org_id,sub.id],encryptionEnv(config));
    if(hash(row.body)!==row.body_hash)throw deny(409,'webhook_payload_changed');
    // Decryption can yield. Reauthorize immediately before network work so a
    // pause, key rotation or issuer revocation during that yield cannot send.
    const current=(await database.query("SELECT w.id FROM crm_public_webhooks w JOIN members m ON m.org_id=w.org_id AND m.id=w.created_by WHERE w.id=$1 AND w.org_id=$2 AND w.version=$3 AND w.state='active' AND m.active=1 AND m.role='Admin'",[sub.id,row.org_id,sub.version])).rows[0];
    if(!current||config.CRM_PUBLIC_WEBHOOKS_ENABLED!=='true'||config.CRM_PUBLIC_WEBHOOK_RUNNER_ENABLED!=='true'){
      await database.query("UPDATE crm_public_webhook_deliveries SET status='pending',attempts=MAX(0,attempts-1),lease='',lease_until=0,next_attempt_at=$1,updated_at=$2 WHERE id=$3 AND org_id=$4 AND lease=$5",[Date.now()+30000,Date.now(),row.id,row.org_id,lease]);
      continue;
    }
    const time=String(Date.now()),signature=createHmac('sha256',secret).update(['rrs-webhook-v1','POST',url,row.org_id,time,row.id,String(sub.signing_version),row.body_hash].join('\n')).digest('hex');
    http=await sendBounded(url,row.body,new Headers({'Content-Type':'application/json','X-RRS-Webhook-Org':row.org_id,'X-RRS-Webhook-Time':time,'X-RRS-Webhook-Delivery':row.id,'X-RRS-Webhook-Key-Id':String(sub.signing_version),'X-RRS-Webhook-Signature':signature}),transport);
    success=http>=200&&http<300;permanent=!success&&http<500&&![408,429].includes(http);error=success?'':'webhook_http_'+http;
   }catch(e){error=e instanceof ApiError&&['webhook_origin_not_allowed','webhook_payload_changed'].includes(e.message)?e.message:'webhook_unavailable';permanent=error!=='webhook_unavailable';}
   const attempt=Number(row.attempts)+1,status=success?'delivered':permanent||attempt>=row.max_attempts?'dead':'pending',now=Date.now(),next=now+Math.min(3600000,30000*2**Math.min(attempt-1,7));
   await database.query('UPDATE crm_public_webhook_deliveries SET status=$1,http_status=$2,last_error=$3,next_attempt_at=$4,lease=\'\',lease_until=0,updated_at=$5 WHERE id=$6 AND org_id=$7 AND lease=$8',[status,http,error,next,now,row.id,row.org_id,lease]);
   await database.query('INSERT INTO crm_public_webhook_attempts(id,org_id,delivery_id,attempt,http_status,error_code,duration_ms,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),row.org_id,row.id,attempt,http,error,now-at,now]);
   if(success)sent++;else failed++;
  }
  return {status:failed?'partial':'ok',sent,failed};
 });
}

