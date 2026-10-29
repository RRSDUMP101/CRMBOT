import {randomUUID} from 'node:crypto';
import {ApiError,fields,uuid,type Staff} from './auth';
import {database,transaction,type Row,type Executor} from './db';
import {bridgePayloadHash,signBridgeRequest} from './bridge-protocol';
import {enqueueSocialReply,dispatchSocialReply} from './social-channels';

export type DomesticEnvelope={version:1;kind:'reviewed-domestic-message';commandId:string;conversationId:string;expectedVersion:number;expectedCustomerSeq:number;actorId:string;provider:'line'|'facebook';accountId:string;remoteId:string;text:string;source:{system:'rrs-sale-office';workspace:'domestic';messageId:string;threadId:string;generation:number;messageHash:string;knowledgeHash:string;reviewedBy:string}};
export function domesticConfig(){
 if(process.env.CRM_DOMESTIC_REVIEW_ENABLED!=='true'||process.env.CRM_BRIDGE_ENABLED!=='true')throw new ApiError(503,'Domestic review forwarding is disabled');
 const orgId=process.env.CRM_BRIDGE_ORG_ID||'',secret=process.env.CRM_BRIDGE_SECRET||'',origin=process.env.CRM_DOMESTIC_SOURCE_ORIGIN||'';let url:URL;try{url=new URL(origin);}catch{throw new ApiError(503,'Domestic source is not configured');}
 if(!orgId||secret.length<32||url.protocol!=='https:'||url.origin!==origin||url.username||url.password)throw new ApiError(503,'Domestic source is not configured');return {orgId,secret,origin};
}
function object(p:unknown):Row{if(!p||typeof p!=='object'||Array.isArray(p))throw new ApiError(400,'Invalid domestic message');return p as Row;}
export function parseDomestic(raw:unknown):DomesticEnvelope{
 const p=object(raw),s=object(p.source);fields(p,['version','kind','commandId','conversationId','expectedVersion','expectedCustomerSeq','actorId','provider','accountId','remoteId','text','source']);fields(s,['system','workspace','messageId','threadId','generation','messageHash','knowledgeHash','reviewedBy']);
 if(p.version!==1||p.kind!=='reviewed-domestic-message'||!['line','facebook'].includes(p.provider)||s.system!=='rrs-sale-office'||s.workspace!=='domestic')throw new ApiError(400,'Unsupported domestic message');
 for(const id of[p.commandId,p.conversationId,p.actorId])uuid(id);
 for(const n of[p.expectedVersion,p.expectedCustomerSeq,s.generation])if(!Number.isSafeInteger(n)||n<0)throw new ApiError(400,'Invalid domestic generation');if(p.expectedVersion<1)throw new ApiError(400,'Invalid domestic version');
 for(const id of[s.messageId,s.threadId,p.accountId,p.remoteId])if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,150}$/.test(id))throw new ApiError(400,'Invalid domestic identity');
 if(typeof p.text!=='string'||!p.text.trim()||p.text.length>2000||typeof s.reviewedBy!=='string'||!s.reviewedBy||s.reviewedBy.length>200)throw new ApiError(400,'Invalid domestic reviewed text');
 for(const hash of[s.messageHash,s.knowledgeHash])if(typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash))throw new ApiError(400,'Invalid domestic evidence hash');return p as DomesticEnvelope;
}
async function member(orgId:string,actorId:string){
 let allowed:unknown;try{allowed=JSON.parse(process.env.CRM_BRIDGE_ALLOWED_MEMBER_IDS||'[]');}catch{throw new ApiError(503,'Bridge member configuration invalid');}
 const row=(await database.query('SELECT * FROM members WHERE org_id=$1 AND id=$2',[orgId,actorId])).rows[0];if(!Array.isArray(allowed)||!allowed.includes(actorId)||!row?.active||!['Admin','Agent'].includes(row.role))throw new ApiError(403,'Domestic reviewer is not permitted');return row;
}
async function verifySource(row:Row,transport:typeof fetch=fetch){
 const c=domesticConfig();if(c.orgId!==row.org_id)throw new ApiError(403,'Domestic organization mismatch');const nonce=randomUUID(),body=JSON.stringify({commandId:row.command_id,payloadHash:row.payload_hash,nonce}),url=c.origin+'/api/rrs/crm/domestic/validate';
 const response=await transport(url,{method:'POST',body,headers:await signBridgeRequest(url,{...c,method:'POST',body}),redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(8000)});if(!response.ok){await response.body?.cancel();throw new ApiError(response.status===403||response.status===409?409:503,'Domestic source review unavailable or revoked');}
 const reader=response.body?.getReader();if(!reader)throw new ApiError(503,'Domestic proof missing');let text='',size=0;const decoder=new TextDecoder();try{while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>8192){await reader.cancel();throw new ApiError(503,'Domestic proof limit');}text+=decoder.decode(r.value,{stream:true});}text+=decoder.decode();}finally{reader.releaseLock();}
 const p=JSON.parse(text);if(p?.version!==1||p.valid!==true||p.orgId!==row.org_id||p.commandId!==row.command_id||p.payloadHash!==row.payload_hash||p.nonce!==nonce||!Number.isSafeInteger(p.sourceRevision)||p.sourceRevision<0||!Number.isFinite(p.checkedAt)||Math.abs(Date.now()-p.checkedAt)>30000)throw new ApiError(409,'Domestic proof mismatch');
}
/** Called before claim and again immediately before provider effect, including recovery/monitor. */
export async function validateDomesticDispatch(orgId:string,outboundId:string,transport:typeof fetch=fetch){const row=(await database.query('SELECT * FROM crm_domestic_review_commands WHERE org_id=$1 AND outbound_command_id=$2',[orgId,outboundId])).rows[0];if(row){await member(orgId,row.actor_id);await verifySource(row,transport);}}
export async function domesticPayload(c:Executor,orgId:string,outboundId:string){const row=(await c.query('SELECT payload_json FROM crm_domestic_review_commands WHERE org_id=$1 AND outbound_command_id=$2',[orgId,outboundId])).rows[0];return row?parseDomestic(JSON.parse(row.payload_json)):null;}
export async function domesticStatus(commandId:string){const c=domesticConfig();uuid(commandId);const row=(await database.query('SELECT d.command_id,d.message_id,d.outbound_command_id,o.status,o.provider_message_id,o.error_code FROM crm_domestic_review_commands d JOIN social_outbound_commands o ON o.org_id=d.org_id AND o.id=d.outbound_command_id WHERE d.org_id=$1 AND d.command_id=$2',[c.orgId,commandId])).rows[0];if(!row)throw new ApiError(404,'Domestic command not found');return {version:1,commandId:row.command_id,messageId:row.message_id,outboundCommandId:row.outbound_command_id,status:row.status,providerMessageId:row.provider_message_id||'',errorCode:row.error_code||''};}
export async function acceptDomestic(raw:unknown,options:{fetch?:typeof fetch;dispatch?:boolean}={}){
 const config=domesticConfig(),p=parseDomestic(raw),serialized=JSON.stringify(p),hash=await bridgePayloadHash(serialized),reviewer=await member(config.orgId,p.actorId),staff:Staff={id:p.actorId,orgId:config.orgId,name:reviewer.name,email:reviewer.email,role:reviewer.role};
 const existing=(await database.query('SELECT payload_hash FROM crm_domestic_review_commands WHERE org_id=$1 AND command_id=$2',[config.orgId,p.commandId])).rows[0];if(existing&&existing.payload_hash!==hash)throw new ApiError(409,'Domestic command ID conflict');if(!existing)await verifySource({org_id:config.orgId,command_id:p.commandId,payload_hash:hash},options.fetch);
 const outbound=await transaction(config.orgId,async c=>{
  const previous=(await c.query('SELECT * FROM crm_domestic_review_commands WHERE org_id=$1 AND command_id=$2',[config.orgId,p.commandId])).rows[0];if(previous){if(previous.payload_hash!==hash)throw new ApiError(409,'Domestic command ID conflict');return previous.outbound_command_id as string;}
  if((await c.query('SELECT 1 FROM crm_bridge_commands WHERE org_id=$1 AND command_id=$2',[config.orgId,p.commandId])).rows.length)throw new ApiError(409,'Bridge command ID already used');
  const conversation=(await c.query('SELECT * FROM conversations WHERE org_id=$1 AND id=$2',[config.orgId,p.conversationId])).rows[0],identities=(await c.query('SELECT * FROM social_identities WHERE org_id=$1 AND conversation_id=$2',[config.orgId,p.conversationId])).rows,identity=identities[0];
  if(!conversation||identities.length!==1||!identity||identity.provider!==p.provider||identity.lead_id!==conversation.lead_id||identity.opt_out||identity.remote_id!==p.remoteId||identity.account_id!==p.accountId||conversation.status!=='human_active'||conversation.assignee_id!==p.actorId||conversation.version!==p.expectedVersion||conversation.customer_message_seq!==p.expectedCustomerSeq)throw new ApiError(409,'Domestic recipient, assignment or generation changed');
  const messageId=randomUUID(),time=new Date().toISOString().replace(/(\.\d{3})Z$/,(_,f)=>f+'000Z');await c.query("INSERT INTO messages(id,org_id,conversation_id,role,content) VALUES($1,$2,$3,'agent',$4)",[messageId,config.orgId,p.conversationId,p.text]);const intent=await enqueueSocialReply(c,config.orgId,p.conversationId,messageId,p.text);if(!intent.commandId)throw new ApiError(409,'Domestic social intent required');
  await c.query('UPDATE social_message_provenance SET metadata=$3 WHERE org_id=$1 AND message_id=$2',[config.orgId,messageId,JSON.stringify({approval:'reviewed_domestic',commandId:intent.commandId,reviewedDomestic:{bridgeCommandId:p.commandId,sourceMessageId:p.source.messageId,messageHash:p.source.messageHash,knowledgeHash:p.source.knowledgeHash}})]);
  await c.query('INSERT INTO crm_domestic_review_commands(org_id,command_id,payload_hash,payload_json,source_message_id,actor_id,conversation_id,message_id,outbound_command_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[config.orgId,p.commandId,hash,serialized,p.source.messageId,p.actorId,p.conversationId,messageId,intent.commandId,time]);
  await c.query('INSERT INTO crm_bridge_commands(org_id,command_id,payload_hash,actor_id,conversation_id,result_json) VALUES($1,$2,$3,$4,$5,$6)',[config.orgId,p.commandId,hash,p.actorId,p.conversationId,JSON.stringify({kind:p.kind,messageId,outboundCommandId:intent.commandId})]);await c.query('UPDATE conversations SET updated_at=$3 WHERE org_id=$1 AND id=$2',[config.orgId,p.conversationId,time]);return intent.commandId;
 },staff);
 if(options.dispatch!==false)await dispatchSocialReply(config.orgId,outbound,{fetch:options.fetch}).catch(()=>{});return domesticStatus(p.commandId);
}
