import {randomUUID} from 'node:crypto';
import {ApiError,fields,uuid,type Staff} from './auth';
import {database,transaction,type Row,type Executor} from './db';
import {bridgePayloadHash,signBridgeRequest} from './bridge-protocol';
import {enqueueSocialReply,dispatchSocialReply,readSocialConfig} from './social-channels';
import {parseReviewedParts,stageReviewedSaleParts,type ReviewedSalePart} from './reviewed-sale-media';

export type ReviewedSaleEnvelope={version:1;kind:'reviewed-sale-message';commandId:string;conversationId:string;expectedVersion:number;expectedCustomerSeq:number;actorId:string;provider:'whatsapp';accountId:string;remoteId:string;text:string;template:null|{name:string;language:string};parts?:ReviewedSalePart[];source:{system:'rrs-sale-office';workspace:'live'|'domestic';messageId:string;messageHash:string;consentHash:string;ruleHash:string;reviewedBy:string;mode:'manual'|'followup';reviewAuditId:string}};
export function reviewedSaleConfig(){
  if(process.env.CRM_REVIEWED_SALE_ENABLED!=='true'||process.env.CRM_BRIDGE_ENABLED!=='true')throw new ApiError(503,'Reviewed Sale forwarding is disabled');
  const orgId=process.env.CRM_BRIDGE_ORG_ID||'',secret=process.env.CRM_BRIDGE_SECRET||'',origin=process.env.CRM_REVIEWED_SALE_SOURCE_ORIGIN||'';
  let url:URL;try{url=new URL(origin);}catch{throw new ApiError(503,'Reviewed Sale source is not configured');}
  if(!orgId||secret.length<32||url.protocol!=='https:'||url.origin!==origin||url.username||url.password)throw new ApiError(503,'Reviewed Sale source is not configured');return {orgId,secret,origin};
}
function object(p:unknown):Row{if(!p||typeof p!=='object'||Array.isArray(p))throw new ApiError(400,'Invalid reviewed message');return p as Row;}
function string(p:unknown,max:number){if(typeof p!=='string'||!p||p.length>max)throw new ApiError(400,'Invalid reviewed message field');return p;}
export function parseReviewedSale(raw:unknown):ReviewedSaleEnvelope{
  const p=object(raw);fields(p,['version','kind','commandId','conversationId','expectedVersion','expectedCustomerSeq','actorId','provider','accountId','remoteId','text','template','source','parts']);
  const s=object(p.source);fields(s,['system','workspace','messageId','messageHash','consentHash','ruleHash','reviewedBy','mode','reviewAuditId']);
  if(p.version!==1||p.kind!=='reviewed-sale-message'||p.provider!=='whatsapp'||s.system!=='rrs-sale-office'||!['live','domestic'].includes(s.workspace)||!['manual','followup'].includes(s.mode))throw new ApiError(400,'Unsupported reviewed message');
  for(const v of[p.commandId,p.conversationId,p.actorId])uuid(v);
  if(!Number.isSafeInteger(p.expectedVersion)||p.expectedVersion<1||!Number.isSafeInteger(p.expectedCustomerSeq)||p.expectedCustomerSeq<0)throw new ApiError(400,'Invalid reviewed generation');
  if(!/^[A-Za-z0-9-]{1,150}$/.test(string(s.messageId,150))||!/^\d{5,40}$/.test(string(p.accountId,40))||! /^[1-9]\d{7,14}$/.test(string(p.remoteId,15)))throw new ApiError(400,'Invalid reviewed recipient');
  string(p.text,4096);string(s.reviewedBy,200);if(typeof s.reviewAuditId!=='string'||s.reviewAuditId.length>150||s.mode==='followup'&&!s.reviewAuditId)throw new ApiError(400,'Reviewed followup evidence required');
  for(const hash of[s.messageHash,s.consentHash,s.ruleHash])if(!/^[a-f0-9]{64}$/.test(hash))throw new ApiError(400,'Invalid reviewed evidence hash');
  if(p.template!==null){const t=object(p.template);fields(t,['name','language']);if(!/^[a-z0-9_]{1,512}$/.test(string(t.name,512))||! /^[a-zA-Z_]{2,20}$/.test(string(t.language,20)))throw new ApiError(400,'Invalid template');}
  parseReviewedParts(p.parts,{text:p.text,template:p.template});return p as ReviewedSaleEnvelope;
}
async function bounded(response:Response,max=256000){const reader=response.body?.getReader();if(!reader)throw new ApiError(502,'Empty reviewed response');let text='',n=0;const decoder=new TextDecoder();try{while(true){const r=await reader.read();if(r.done)break;n+=r.value.length;if(n>max){await reader.cancel();throw new ApiError(502,'Reviewed response exceeds limit');}text+=decoder.decode(r.value,{stream:true});}return JSON.parse(text+decoder.decode());}finally{reader.releaseLock();}}
export async function reviewedSaleTemplates(transport:typeof fetch=fetch){
  const bridge=reviewedSaleConfig(),config=readSocialConfig('whatsapp');
  if(config.orgId!==bridge.orgId||config.owner!=='crm'||!config.accessToken||!/^\d{5,40}$/.test(config.wabaId||'')||!/^v\d+\.\d+$/.test(config.apiVersion||''))throw new ApiError(503,'CRM WhatsApp template account is not configured');
  const response=await transport(`https://graph.facebook.com/${config.apiVersion}/${config.wabaId}/message_templates?fields=name,status,language,components&limit=100`,{headers:{Authorization:'Bearer '+config.accessToken},redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(8000)});
  if(!response.ok){await response.body?.cancel();throw new ApiError(503,'Template verification unavailable');}const result=await bounded(response);
  if(!Array.isArray(result.data))throw new ApiError(502,'Invalid template list');
  return {templates:result.data.map((t:Row)=>({name:t.name,status:t.status,language:t.language,components:t.components})),hasMore:!!result.paging?.next};
}
async function templateProof(payload:ReviewedSaleEnvelope,transport:typeof fetch){
  if(!payload.template)return;
  const list=await reviewedSaleTemplates(transport),t=list.templates.find((t:Row)=>t.name===payload.template!.name&&t.language===payload.template!.language&&t.status==='APPROVED');
  if(!t||!Array.isArray(t.components)||t.components.length!==1||t.components[0].type!=='BODY'||typeof t.components[0].text!=='string'||t.components[0].text.includes('{{')||t.components[0].text!==payload.text)throw new ApiError(409,'Current approved BODY-only template must exactly match the reviewed text');
}
async function verifySource(row:Row,transport:typeof fetch=fetch){
  const config=reviewedSaleConfig();if(config.orgId!==row.org_id)throw new ApiError(403,'Reviewed organization mismatch');
  const nonce=randomUUID(),body=JSON.stringify({commandId:row.command_id,payloadHash:row.payload_hash,nonce}),url=config.origin+'/api/rrs/crm/reviewed-messages/validate';
  const response=await transport(url,{method:'POST',body,headers:await signBridgeRequest(url,{...config,method:'POST',body}),redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(8000)});
  if(!response.ok){await response.body?.cancel();throw new ApiError(response.status===403||response.status===409?409:503,'Sale review is unavailable or no longer valid');}
  const proof=await bounded(response,8192);if(proof?.version!==1||proof.valid!==true||proof.orgId!==row.org_id||proof.commandId!==row.command_id||proof.payloadHash!==row.payload_hash||proof.nonce!==nonce||!Number.isSafeInteger(proof.sourceRevision)||!Number.isFinite(proof.checkedAt)||Math.abs(Date.now()-proof.checkedAt)>30000)throw new ApiError(409,'Sale proof does not match this command');
}
/** Generic runner must revalidate this distinct evidence before every claim and before the external effect. */
export async function validateReviewedSaleDispatch(orgId:string,outboundId:string,transport:typeof fetch=fetch){
  const row=(await database.query('SELECT * FROM crm_reviewed_sale_commands WHERE org_id=$1 AND outbound_command_id=$2',[orgId,outboundId])).rows[0];
  if(row){
    let allowed:unknown;try{allowed=JSON.parse(process.env.CRM_BRIDGE_ALLOWED_MEMBER_IDS||'[]');}catch{throw new ApiError(503,'Bridge members invalid');}
    const member=(await database.query('SELECT active,role FROM members WHERE org_id=$1 AND id=$2',[orgId,row.actor_id])).rows[0];
    if(!Array.isArray(allowed)||!allowed.includes(row.actor_id)||!member?.active||!['Admin','Agent'].includes(member.role))throw new ApiError(403,'Reviewed actor is no longer permitted');
    await verifySource(row,transport);await templateProof(parseReviewedSale(JSON.parse(row.payload_json)),transport);
  }
}
export async function reviewedSalePayload(c:Executor,orgId:string,outboundId:string){
  const row=(await c.query('SELECT payload_json FROM crm_reviewed_sale_commands WHERE org_id=$1 AND outbound_command_id=$2',[orgId,outboundId])).rows[0];
  return row?parseReviewedSale(JSON.parse(row.payload_json)):null;
}
export async function reviewedSaleStatus(commandId:string){
  const config=reviewedSaleConfig();uuid(commandId);
  const row=(await database.query('SELECT a.command_id,a.message_id,a.outbound_command_id,o.status,o.provider_message_id,o.error_code FROM crm_reviewed_sale_commands a JOIN social_outbound_commands o ON o.org_id=a.org_id AND o.id=a.outbound_command_id WHERE a.org_id=$1 AND a.command_id=$2',[config.orgId,commandId])).rows[0];if(!row)throw new ApiError(404,'Reviewed message not found');
  return {version:1,commandId:row.command_id,messageId:row.message_id,outboundCommandId:row.outbound_command_id,status:row.status,providerMessageId:row.provider_message_id||'',errorCode:row.error_code||''};
}
export async function acceptReviewedSale(raw:unknown,options:{fetch?:typeof fetch;dispatch?:boolean}={}){
  const config=reviewedSaleConfig(),p=parseReviewedSale(raw),serialized=JSON.stringify(p),hash=await bridgePayloadHash(serialized);
  let allow:unknown;try{allow=JSON.parse(process.env.CRM_BRIDGE_ALLOWED_MEMBER_IDS||'[]');}catch{throw new ApiError(503,'Bridge actor configuration invalid');}
  const member=(await database.query('SELECT * FROM members WHERE org_id=$1 AND id=$2',[config.orgId,p.actorId])).rows[0];
  if(!Array.isArray(allow)||!allow.includes(p.actorId)||!member?.active||!['Admin','Agent'].includes(member.role))throw new ApiError(403,'Reviewed actor is not permitted');
  const staff:Staff={id:p.actorId,orgId:config.orgId,name:member.name,email:member.email,role:member.role};
  const existing=(await database.query('SELECT payload_hash FROM crm_reviewed_sale_commands WHERE org_id=$1 AND command_id=$2',[config.orgId,p.commandId])).rows[0];
  if(existing&&existing.payload_hash!==hash)throw new ApiError(409,'Reviewed command ID conflict');
  if(!existing){await verifySource({org_id:config.orgId,command_id:p.commandId,payload_hash:hash},options.fetch);await templateProof(p,options.fetch||fetch);}
  const outbound=await transaction(config.orgId,async c=>{
    const previous=(await c.query('SELECT * FROM crm_reviewed_sale_commands WHERE org_id=$1 AND command_id=$2',[config.orgId,p.commandId])).rows[0];if(previous){if(previous.payload_hash!==hash)throw new ApiError(409,'Reviewed command ID conflict');return previous.outbound_command_id as string;}
    if((await c.query('SELECT 1 FROM crm_bridge_commands WHERE org_id=$1 AND command_id=$2',[config.orgId,p.commandId])).rows.length)throw new ApiError(409,'Command ID already used');
    const conversation=(await c.query('SELECT * FROM conversations WHERE org_id=$1 AND id=$2',[config.orgId,p.conversationId])).rows[0],identity=(await c.query("SELECT * FROM social_identities WHERE org_id=$1 AND conversation_id=$2 AND provider='whatsapp'",[config.orgId,p.conversationId])).rows[0];
    if(!conversation||!identity||identity.lead_id!==conversation.lead_id||identity.opt_out||identity.remote_id!==p.remoteId||identity.account_id!==p.accountId||conversation.status!=='human_active'||conversation.assignee_id!==p.actorId||conversation.version!==p.expectedVersion||conversation.customer_message_seq!==p.expectedCustomerSeq)throw new ApiError(409,'Reviewed recipient, assignment or customer generation changed');
    const messageId=randomUUID(),time=new Date().toISOString().replace(/(\.\d{3})Z$/,(_,fraction)=>fraction+'000Z');
    await c.query("INSERT INTO messages(id,org_id,conversation_id,role,content) VALUES($1,$2,$3,'agent',$4)",[messageId,config.orgId,p.conversationId,p.text]);
    const intent=await enqueueSocialReply(c,config.orgId,p.conversationId,messageId,p.text);if(!intent.commandId)throw new ApiError(409,'WhatsApp intent required');
    await stageReviewedSaleParts(c,config.orgId,{id:intent.commandId,accountId:p.accountId,remoteId:p.remoteId},parseReviewedParts(p.parts,p));
    await c.query('UPDATE social_message_provenance SET provider_type=$3,metadata=$4 WHERE org_id=$1 AND message_id=$2',[config.orgId,messageId,p.template?'template':'text',JSON.stringify({approval:'reviewed_sale',commandId:intent.commandId,reviewedSale:{bridgeCommandId:p.commandId,sourceWorkspace:p.source.workspace,sourceMessageId:p.source.messageId,messageHash:p.source.messageHash}})]);
    await c.query('INSERT INTO crm_reviewed_sale_commands(org_id,command_id,payload_hash,payload_json,source_workspace,source_message_id,actor_id,conversation_id,message_id,outbound_command_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[config.orgId,p.commandId,hash,serialized,p.source.workspace,p.source.messageId,p.actorId,p.conversationId,messageId,intent.commandId,time]);
    await c.query('INSERT INTO crm_bridge_commands(org_id,command_id,payload_hash,actor_id,conversation_id,result_json) VALUES($1,$2,$3,$4,$5,$6)',[config.orgId,p.commandId,hash,p.actorId,p.conversationId,JSON.stringify({kind:p.kind,messageId,outboundCommandId:intent.commandId})]);
    await c.query('UPDATE conversations SET updated_at=$3 WHERE org_id=$1 AND id=$2',[config.orgId,p.conversationId,time]);return intent.commandId;
  },staff);
  if(options.dispatch!==false)await dispatchSocialReply(config.orgId,outbound,{fetch:options.fetch}).catch(()=>{/* Durable queue retries only after fresh proof; unknown never resends. */});
  return reviewedSaleStatus(p.commandId);
}
