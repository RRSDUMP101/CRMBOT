import {createHash,createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {ApiError,fields,requireAdmin,str,uuid,type Staff} from './auth';
import {database,transaction,type Executor,type Row} from './db';
import {sealSocialSecret,openSocialSecret,socialTokenKeyRing,type Sealed} from './social-accounts';
import {boundedBytes} from './ai-lifecycle';
import {marketplaceSelection,marketplaceGrant,refreshMarketplace,tiktokAuthorization} from './external-marketplaces';
export type ConnectorProvider='gmail'|'outlook'|'shopify'|'hubspot'|'lazada'|'tiktokshop';
export type ConnectorOptions={env?:Record<string,string|undefined>;fetch?:typeof fetch};
export const CALLBACK='/api/admin/connectors/oauth/callback';
export const connectorProviders:ConnectorProvider[]=['gmail','outlook','shopify','hubspot','lazada','tiktokshop'];
export const stamp=()=>new Date().toISOString();
export const hash=(s:string|Uint8Array)=>createHash('sha256').update(s).digest('hex');
const json=(value:any)=>typeof value==='string'?JSON.parse(value):value;
const provider=(s:unknown)=>{if(!connectorProviders.includes(s as ConnectorProvider))throw new ApiError(400,'unsupported_connector');return s as ConnectorProvider;};
const envOf=(o:ConnectorOptions)=>o.env||process.env;
const fail=(code:string,status=409)=>new ApiError(status,code);
const same=(a:string,b:string)=>!!a&&!!b&&timingSafeEqual(createHash('sha256').update(a).digest(),createHash('sha256').update(b).digest());
export function shopDomain(value:unknown){const shop=str(value,'Shopify shop',100,true).toLowerCase();if(!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop))throw fail('shop_domain_invalid',400);return shop;}
function settings(p:ConnectorProvider,shop:string,env:Record<string,string|undefined>){
 const prefix=p.toUpperCase(),client=env[prefix+'_CLIENT_ID']||'',secret=env[prefix+'_CLIENT_SECRET']||'',origin=env.APP_ORIGIN||'';
 if(!client||!secret||!/^https:\/\/[^/]+$/.test(origin))throw fail('connector_app_not_configured',503);
 const endpoints={gmail:{authorize:'https://accounts.google.com/o/oauth2/v2/auth',token:'https://oauth2.googleapis.com/token'},outlook:{authorize:'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',token:'https://login.microsoftonline.com/common/oauth2/v2.0/token'},shopify:{authorize:`https://${shop}/admin/oauth/authorize`,token:`https://${shop}/admin/oauth/access_token`},hubspot:{authorize:'https://app.hubspot.com/oauth/authorize',token:'https://api.hubspot.com/oauth/v3/token'},lazada:{authorize:'https://auth.lazada.com/oauth/authorize',token:''},tiktokshop:{authorize:p==='tiktokshop'?tiktokAuthorization(env):'',token:''}}[p];
 return {...endpoints,client,secret,redirect:origin+CALLBACK};
}
const requested=(p:ConnectorProvider,send:boolean)=>p==='gmail'?['https://www.googleapis.com/auth/gmail.readonly',...(send?['https://www.googleapis.com/auth/gmail.send']:[])]:p==='outlook'?['offline_access','User.Read','Mail.Read',...(send?['Mail.Send']:[])]:p==='shopify'?['read_orders','read_customers']:p==='hubspot'?['oauth','crm.objects.contacts.read','crm.objects.deals.read']:[];
export async function connectorAudit(c:Executor,org:string,actor:string,action:string,id:string,detail:Record<string,unknown>={}){await c.query('INSERT INTO audit_events(id,org_id,actor_id,action,entity_id,metadata) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),org,actor,'connector.'+action,id,JSON.stringify(detail)]);}
/** Fixed provider hosts only. Pagination links must retain the exact API origin and path prefix. */
export function safeApiUrl(p:ConnectorProvider,key:string,value:string){
 const url=new URL(value),host=p==='gmail'?'gmail.googleapis.com':p==='outlook'?'graph.microsoft.com':p==='hubspot'?'api.hubspot.com':shopDomain(key);
 const path=p==='gmail'?'/gmail/v1/users/me/':p==='outlook'?'/v1.0/me/':p==='hubspot'?'/crm/v3/objects/':'/admin/api/';
 if(url.protocol!=='https:'||url.hostname!==host||url.port||url.username||url.password||url.hash||!url.pathname.startsWith(path))throw fail('provider_cursor_invalid');return url.href;
}
export class ConnectorHttpError extends ApiError{retrySeconds:number;constructor(status:number,retry=60){super(status===429?429:502,'provider_http_'+status);this.retrySeconds=Math.min(3600,Math.max(30,retry));}}
export async function providerJson(url:string,init:RequestInit,o:ConnectorOptions={}){
 const response=await(o.fetch||fetch)(url,{...init,redirect:'manual',signal:AbortSignal.timeout(15000)});
 if(!response.ok){await response.body?.cancel();throw new ConnectorHttpError(response.status,Number(response.headers.get('retry-after'))||60);}
 if(response.status===202||response.status===204){await response.body?.cancel();return {} as Row;}
 const bytes=await boundedBytes(response.body,2_000_000);try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as Row;}catch{throw fail('provider_response_invalid',502);}
}
export async function beginConnectorOAuth(staff:Staff,input:Record<string,unknown>,o:ConnectorOptions={}){
 requireAdmin(staff);fields(input,['provider','shop','authorizeSend']);const env=envOf(o);if(env.EXTERNAL_CONNECTORS_ENABLED!=='true')throw fail('connectors_disabled',503);
 const p=provider(input.provider),shop=p==='shopify'?shopDomain(input.shop):p==='lazada'||p==='tiktokshop'?marketplaceSelection(p,input.shop):'',app=settings(p,shop,env);socialTokenKeyRing(env);
 if(input.authorizeSend!==undefined&&typeof input.authorizeSend!=='boolean')throw fail('invalid_send_scope',400);
 const state=randomBytes(32).toString('base64url'),stateHash=hash(state),verifier=randomBytes(48).toString('base64url'),scopes=requested(p,input.authorizeSend===true),sealed=await sealSocialSecret(verifier,'external-oauth',[staff.orgId,p,stateHash,staff.id],env);
 await transaction(staff.orgId,async c=>{await c.query('INSERT INTO external_oauth_states(state_hash,org_id,member_id,provider,shop,verifier,requested_scopes,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[stateHash,staff.orgId,staff.id,p,shop,JSON.stringify(sealed),JSON.stringify(scopes),new Date(Date.now()+600_000).toISOString(),stamp()]);await connectorAudit(c,staff.orgId,staff.id,'oauth_started',p);},staff);
 const url=new URL(app.authorize);for(const [key,value]of Object.entries({client_id:app.client,redirect_uri:app.redirect,response_type:'code',state,scope:scopes.join(p==='shopify'?',':' ')}))url.searchParams.set(key,value);
 if(p==='lazada'){url.searchParams.delete('scope');url.searchParams.set('force_auth','true');}
 if(p==='tiktokshop'){for(const key of ['client_id','redirect_uri','response_type','scope'])url.searchParams.delete(key);}
 if(p==='gmail'||p==='outlook'){url.searchParams.set('code_challenge',createHash('sha256').update(verifier).digest('base64url'));url.searchParams.set('code_challenge_method','S256');}
 if(p==='gmail'){url.searchParams.set('access_type','offline');url.searchParams.set('prompt','consent');}
 return {url:url.href,expiresIn:600};
}
export async function completeConnectorOAuth(staff:Staff,url:URL,o:ConnectorOptions={}){
 requireAdmin(staff);const env=envOf(o);if(env.EXTERNAL_CONNECTORS_ENABLED!=='true')throw fail('connectors_disabled',503);
 const stateHash=hash(str(url.searchParams.get('state'),'state',200,true));
 const receipt=await transaction(staff.orgId,async c=>{const row=(await c.query('SELECT * FROM external_oauth_states WHERE state_hash=$1 AND org_id=$2 AND member_id=$3',[stateHash,staff.orgId,staff.id])).rows[0];if(!row||row.used_at||row.expires_at<=stamp())throw fail('oauth_state_invalid',403);await c.query('UPDATE external_oauth_states SET used_at=$2 WHERE state_hash=$1',[stateHash,stamp()]);return row;},staff);
 if(url.searchParams.has('error'))throw fail('owner_declined_oauth',400);
 const p=provider(receipt.provider),app=settings(p,receipt.shop,env),code=str(url.searchParams.get('code'),'code',3000,true),verifier=await openSocialSecret(json(receipt.verifier),'external-oauth',[staff.orgId,p,stateHash,staff.id],env);
 if(p==='shopify'){
  if(url.searchParams.get('shop')!==receipt.shop)throw fail('shop_account_mismatch',403);
  const entries=[...url.searchParams.entries()].filter(([key])=>key!=='hmac'&&key!=='signature').sort(([a],[b])=>a.localeCompare(b));const canonical=entries.map(([k,v])=>`${k}=${v}`).join('&');
  if(!same(createHmac('sha256',app.secret).update(canonical).digest('hex'),url.searchParams.get('hmac')||''))throw fail('shop_hmac_invalid',403);
 }
 const form=new URLSearchParams({client_id:app.client,client_secret:app.secret,grant_type:'authorization_code',code,redirect_uri:app.redirect});if(p==='gmail'||p==='outlook')form.set('code_verifier',verifier);if(p==='shopify')form.set('expiring','1');
 const market=p==='lazada'||p==='tiktokshop'?await marketplaceGrant(p,receipt.shop,code,o):null;
 const token:Row=market?market.token:await providerJson(app.token,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:form},o);if(typeof token.access_token!=='string'||!token.access_token)throw fail('oauth_token_missing',502);
 let key='',display='',granted:string[]=typeof token.scope==='string'?token.scope.split(/[ ,]+/):[];
 if(market){key=market.key;display=market.display;granted=market.granted;}
 else if(p==='gmail'){const me=await providerJson('https://gmail.googleapis.com/gmail/v1/users/me/profile',{headers:{Authorization:'Bearer '+token.access_token}},o);key=String(me.emailAddress||'').toLowerCase();display=key;}
 else if(p==='outlook'){const me=await providerJson('https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName',{headers:{Authorization:'Bearer '+token.access_token}},o);key=String(me.id||'');display=String(me.mail||me.userPrincipalName||'').toLowerCase();}
 else if(p==='hubspot'){const info=await providerJson('https://api.hubspot.com/oauth/v3/token/introspect',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:app.client,client_secret:app.secret,token:token.access_token})},o);key=String(info.hub_id||'');display=String(info.hub_domain||key);if(Array.isArray(info.scopes))granted=info.scopes;}
 else{key=receipt.shop;const version=env.SHOPIFY_API_VERSION||'2026-10';const shop=await providerJson(`https://${key}/admin/api/${version}/graphql.json`,{method:'POST',headers:{'content-type':'application/json','X-Shopify-Access-Token':token.access_token},body:JSON.stringify({query:'query { shop { myshopifyDomain name } }'})},o);if(shop.data?.shop?.myshopifyDomain!==key)throw fail('shop_account_mismatch',403);display=shop.data.shop.name;}
 if(!key||key.length>200||!display||display.length>300)throw fail('provider_identity_missing',502);
 const needed=requested(p,false).filter(s=>s!=='offline_access');if(needed.some(s=>!granted.includes(s)))throw fail('required_scope_missing',403);
 const expires=Number(token.expires_in)>0?new Date(Date.now()+Number(token.expires_in)*1000).toISOString():null;
 const sealed=await sealSocialSecret(JSON.stringify({access:token.access_token,refresh:token.refresh_token||'',subject:token.subject||'',refreshExpiresAt:Number(token.refresh_token_expires_in)>0?new Date(Date.now()+Number(token.refresh_token_expires_in)*1000).toISOString():null}),'external-account',[staff.orgId,p,key],env);
 const id=await transaction(staff.orgId,async c=>{if(market){const existing=(await c.query('SELECT id,org_id,account_key FROM external_accounts WHERE provider=$1 AND grant_subject=$2',[p,token.subject])).rows[0];if(existing&&(existing.org_id!==staff.orgId||existing.account_key!==key))throw fail('marketplace_grant_already_bound');}const old=(await c.query('SELECT id FROM external_accounts WHERE org_id=$1 AND provider=$2 AND account_key=$3',[staff.orgId,p,key])).rows[0],id=old?.id||randomUUID();
  if(old)await c.query("UPDATE external_accounts SET display_name=$3,scopes=$4,credential=$5,expires_at=$6,revision=revision+1,state='connected',enabled=1,send_enabled=0,test_marker='',test_passed_at=NULL,last_error='',next_sync_at='',refresh_lease='',refresh_lease_until='',updated_at=$7,connected_by=$8 WHERE org_id=$1 AND id=$2",[staff.orgId,id,display,JSON.stringify(granted),JSON.stringify(sealed),expires,stamp(),staff.id]);
  else await c.query('INSERT INTO external_accounts(id,org_id,provider,account_key,display_name,scopes,credential,expires_at,connected_by,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)',[id,staff.orgId,p,key,display,JSON.stringify(granted),JSON.stringify(sealed),expires,staff.id,stamp()]);if(market)await c.query('UPDATE external_accounts SET grant_subject=$3 WHERE org_id=$1 AND id=$2',[staff.orgId,id,token.subject]);await connectorAudit(c,staff.orgId,staff.id,'connected',id,{provider:p});return id;
 },staff);return {id};
}
export async function loadConnector(org:string,id:string,c:Executor=database){const row=(await c.query('SELECT * FROM external_accounts WHERE org_id=$1 AND id=$2',[org,uuid(id)])).rows[0];if(!row)throw fail('connector_not_found',404);return row;}
export async function connectorToken(account:Row,o:ConnectorOptions={}){
 const env=envOf(o),subject=[account.org_id,account.provider,account.account_key],current=json(await openSocialSecret(json(account.credential),'external-account',subject,env));
 if(!account.expires_at||Date.parse(account.expires_at)>Date.now()+60_000)return current.access as string;
 if(!current.refresh||current.refreshExpiresAt&&Date.parse(current.refreshExpiresAt)<=Date.now())throw fail('reconnect_required',401);
 const lease=randomUUID(),until=new Date(Date.now()+60_000).toISOString();
 await transaction(account.org_id,async c=>{const row=await loadConnector(account.org_id,account.id,c);if(row.revision!==account.revision||row.credential!==account.credential||row.refresh_lease_until>stamp())throw fail('token_refresh_busy');await c.query('UPDATE external_accounts SET refresh_lease=$3,refresh_lease_until=$4 WHERE org_id=$1 AND id=$2',[account.org_id,account.id,lease,until]);});
 try{const app=settings(account.provider,account.account_key,env),next:Row=account.provider==='lazada'||account.provider==='tiktokshop'?await refreshMarketplace(account.provider,account.account_key,current,o):await providerJson(app.token,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:app.client,client_secret:app.secret,grant_type:'refresh_token',refresh_token:current.refresh})},o);if(typeof next.access_token!=='string'||!Number(next.expires_in))throw fail('refresh_response_invalid',502);
  const sealed=await sealSocialSecret(JSON.stringify({access:next.access_token,refresh:next.refresh_token||current.refresh,subject:next.subject||current.subject||'',refreshExpiresAt:Number(next.refresh_token_expires_in)>0?new Date(Date.now()+next.refresh_token_expires_in*1000).toISOString():current.refreshExpiresAt}),'external-account',subject,env);
  await transaction(account.org_id,async c=>{const row=await loadConnector(account.org_id,account.id,c);if(row.refresh_lease!==lease||row.credential!==account.credential)throw fail('refresh_superseded');const scopes=next.market_scopes||(typeof next.scope==='string'?next.scope.split(/[ ,]+/):json(row.scopes));await c.query("UPDATE external_accounts SET credential=$3,expires_at=$4,refresh_lease='',refresh_lease_until='',last_error='',updated_at=$5,scopes=$6 WHERE org_id=$1 AND id=$2",[account.org_id,account.id,JSON.stringify(sealed),new Date(Date.now()+next.expires_in*1000).toISOString(),stamp(),JSON.stringify(scopes)]);});return next.access_token as string;
 }catch(error){await transaction(account.org_id,c=>c.query("UPDATE external_accounts SET state='expired',send_enabled=0,last_error='refresh_failed_reconnect',refresh_lease='',refresh_lease_until='' WHERE org_id=$1 AND id=$2 AND refresh_lease=$3",[account.org_id,account.id,lease]));throw error;}
}
export async function connectorOverview(staff:Staff,o:ConnectorOptions={}){
 const env=envOf(o),rows=(await database.query('SELECT id,provider,account_key,display_name,state,scopes,expires_at,revision,enabled,send_enabled,last_sync_at,last_error,test_passed_at,created_at FROM external_accounts WHERE org_id=$1 ORDER BY created_at DESC',[staff.orgId])).rows;
 const outbox=(await database.query('SELECT id,account_id,kind,status,error_code,created_at FROM external_send_commands WHERE org_id=$1 ORDER BY created_at DESC LIMIT 50',[staff.orgId])).rows;
 return {canManage:staff.role==='Admin',enabled:env.EXTERNAL_CONNECTORS_ENABLED==='true',emailSendEnabled:env.EMAIL_SEND_ENABLED==='true',providers:connectorProviders.map(p=>({provider:p,configured:!!env[p.toUpperCase()+'_CLIENT_ID']&&!!env[p.toUpperCase()+'_CLIENT_SECRET']&&(p!=='tiktokshop'||!!env.TIKTOKSHOP_AUTHORIZATION_URL),capability:p==='gmail'||p==='outlook'?'mail_read_reply':p==='shopify'?'orders_customers_read':p==='hubspot'?'contacts_deals_read':p==='lazada'?'orders_manual_import':'orders_incremental_read'})),accounts:rows.map(row=>({...row,scopes:json(row.scopes)})),outbox,unsupported:['Shopee: ยังเข้าถึงสัญญา API ทางการไม่ได้','แชท marketplace และ Lazada push: ยังไม่รองรับ']};
}
export async function controlConnector(staff:Staff,input:Record<string,unknown>){
 requireAdmin(staff);fields(input,['id','expectedRevision','action','confirm']);if(input.confirm!==true)throw fail('confirm_required',400);const action=String(input.action);if(!['pause','resume','enable_send','stop_send','disconnect'].includes(action))throw fail('invalid_action',400);
 await transaction(staff.orgId,async c=>{const row=await loadConnector(staff.orgId,uuid(input.id),c);if(row.revision!==input.expectedRevision)throw fail('connector_changed');if(action==='enable_send'&&(!row.test_passed_at||!['gmail','outlook'].includes(row.provider)||!row.enabled||row.state==='expired'))throw fail('self_test_readback_required');
  if(action==='disconnect')await c.query("UPDATE external_accounts SET enabled=0,send_enabled=0,state='disconnected',credential='',grant_subject='',revision=revision+1,updated_at=$3 WHERE org_id=$1 AND id=$2",[staff.orgId,row.id,stamp()]);
  else {
    if(action==='resume'&&['expired','disconnected'].includes(row.state))throw fail('reconnect_required');
    await c.query('UPDATE external_accounts SET enabled=$3,send_enabled=$4,state=$5,updated_at=$6,revision=revision+1 WHERE org_id=$1 AND id=$2',[staff.orgId,row.id,action==='pause'?0:action==='resume'?1:row.enabled,action==='enable_send'?1:action==='stop_send'||action==='pause'?0:row.send_enabled,action==='pause'?'paused':action==='resume'?'connected':row.state,stamp()]);
  }
  if(['pause','stop_send','disconnect'].includes(action)){
   await c.query("UPDATE messages SET status='interrupted' WHERE org_id=$1 AND id IN (SELECT message_id FROM external_send_commands WHERE org_id=$1 AND account_id=$2 AND status='queued')",[staff.orgId,row.id]);
   await c.query("UPDATE external_send_commands SET status='cancelled',error_code='account_stopped' WHERE org_id=$1 AND account_id=$2 AND status='queued'",[staff.orgId,row.id]);
  }
  await connectorAudit(c,staff.orgId,staff.id,action,row.id);
 },staff);return connectorOverview(staff);
}

