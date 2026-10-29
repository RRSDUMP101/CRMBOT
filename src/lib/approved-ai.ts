import {randomUUID} from 'node:crypto';
import {ApiError,fields,uuid,type Staff} from './auth';
import {database,transaction,type Row} from './db';
import {bridgePayloadHash} from './bridge-protocol';
import {approvedAiConfig,verifyApprovedAiSource} from './approved-ai-proof';
import {enqueueSocialReply,dispatchSocialReply} from './social-channels';
import {bridgeConfig} from './chat-bridge';

export type ApprovedAiEnvelope={version:1;kind:'approved-ai-text';commandId:string;conversationId:string;expectedVersion:number;actorId:string;provider:'whatsapp';accountId:string;remoteId:string;text:string;source:{system:'rrs-sale-office';workspace:'live'|'domestic';outboxId:string;jobId:string;jobVersion:number;resultId:string;resultHash:string;resultPayload:string;sourceHash:string;sourceRevision:number;approvalId:string;approvedBy:string;approvedAt:string}};
function object(v:unknown):Row{if(!v||typeof v!=='object'||Array.isArray(v))throw new ApiError(400,'Invalid approved AI command');return v as Row;}
function bounded(v:unknown,max:number){if(typeof v!=='string'||!v||v.length>max)throw new ApiError(400,'Invalid approved AI text field');return v;}
export async function parseApprovedAiEnvelope(raw:unknown):Promise<ApprovedAiEnvelope>{
  const p=object(raw);fields(p,['version','kind','commandId','conversationId','expectedVersion','actorId','provider','accountId','remoteId','text','source']);
  const s=object(p.source);fields(s,['system','workspace','outboxId','jobId','jobVersion','resultId','resultHash','resultPayload','sourceHash','sourceRevision','approvalId','approvedBy','approvedAt']);
  if(p.version!==1||p.kind!=='approved-ai-text'||p.provider!=='whatsapp'||s.system!=='rrs-sale-office'||!['live','domestic'].includes(s.workspace))throw new ApiError(400,'Unsupported approved AI command');
  for(const v of [p.commandId,p.conversationId,p.actorId,s.outboxId,s.jobId,s.resultId,s.approvalId])uuid(v);
  for(const v of [p.expectedVersion,s.jobVersion])if(!Number.isSafeInteger(v)||v<1)throw new ApiError(400,'Invalid approval version');
  if(!Number.isSafeInteger(s.sourceRevision)||s.sourceRevision<0||!/^\d{5,40}$/.test(bounded(p.accountId,40))||! /^[1-9]\d{7,14}$/.test(bounded(p.remoteId,15)))throw new ApiError(400,'Invalid approved AI recipient');
  if(p.commandId!==s.outboxId)throw new ApiError(400,'Approved AI command must retain its source outbox ID');
  bounded(p.text,4096);bounded(s.approvedBy,200);bounded(s.approvedAt,64);bounded(s.resultPayload,256000);
  if(!Number.isFinite(Date.parse(s.approvedAt))||Date.parse(s.approvedAt)>Date.now()+300000||! /^[a-f0-9]{64}$/.test(s.resultHash)||! /^[a-f0-9]{64}$/.test(s.sourceHash))throw new ApiError(400,'Invalid approval evidence');
  if(await bridgePayloadHash(s.resultPayload)!==s.resultHash)throw new ApiError(409,'Original AI result hash mismatch');
  let result:Row;try{result=object(JSON.parse(s.resultPayload));}catch{throw new ApiError(400,'Original AI result is invalid');}
  if(result.customer_reply?.text!==p.text||!Array.isArray(result.customer_reply?.claims)||result.customer_reply?.missing_information?.length||result.customer_reply?.required_source?.length)throw new ApiError(409,'Exact approved customer reply required');
  return p as ApprovedAiEnvelope;
}
async function actor(id:string,orgId:string):Promise<Staff>{
  let allowed:unknown;try{allowed=JSON.parse(process.env.CRM_BRIDGE_ALLOWED_MEMBER_IDS||'[]');}catch{throw new ApiError(503,'Bridge members are not configured');}
  if(!Array.isArray(allowed)||!allowed.includes(id))throw new ApiError(403,'Approved AI actor not permitted');
  const member=(await database.query('SELECT * FROM members WHERE org_id=$1 AND id=$2',[orgId,id])).rows[0];
  if(!member?.active||member.role!=='Admin')throw new ApiError(403,'Active Admin approval required');
  return {id,orgId,name:member.name,email:member.email,role:'Admin'};
}
export async function approvedAiStatus(commandId:string){
  const config=bridgeConfig();uuid(commandId);
  const row=(await database.query('SELECT a.command_id,a.message_id,a.outbound_command_id,o.status,o.provider_message_id,o.error_code FROM crm_approved_ai_commands a JOIN social_outbound_commands o ON o.org_id=a.org_id AND o.id=a.outbound_command_id WHERE a.org_id=$1 AND a.command_id=$2',[config.orgId,commandId])).rows[0];
  if(!row)throw new ApiError(404,'Approved AI command not found');
  return {version:1,commandId:row.command_id,messageId:row.message_id,outboundCommandId:row.outbound_command_id,status:row.status,providerMessageId:row.provider_message_id||'',errorCode:row.error_code||''};
}
export async function acceptApprovedAi(raw:unknown,options:{fetch?:typeof fetch;dispatch?:boolean}={}){
  const config=approvedAiConfig(),payload=await parseApprovedAiEnvelope(raw),staff=await actor(payload.actorId,config.orgId),serialized=JSON.stringify(payload),hash=await bridgePayloadHash(serialized);
  const existing=(await database.query('SELECT * FROM crm_approved_ai_commands WHERE org_id=$1 AND command_id=$2',[config.orgId,payload.commandId])).rows[0];
  if(existing&&existing.payload_hash!==hash)throw new ApiError(409,'Approved AI command ID conflict');
  if(!existing)await verifyApprovedAiSource({org_id:config.orgId,command_id:payload.commandId,payload_hash:hash},options.fetch);
  const outbound=await transaction(config.orgId,async c=>{
    const prior=(await c.query('SELECT * FROM crm_approved_ai_commands WHERE org_id=$1 AND command_id=$2',[config.orgId,payload.commandId])).rows[0];
    if(prior){if(prior.payload_hash!==hash)throw new ApiError(409,'Approved AI command ID conflict');return prior.outbound_command_id as string;}
    if((await c.query('SELECT 1 FROM crm_bridge_commands WHERE org_id=$1 AND command_id=$2',[config.orgId,payload.commandId])).rows.length)throw new ApiError(409,'Command ID already used');
    const conversation=(await c.query('SELECT * FROM conversations WHERE org_id=$1 AND id=$2',[config.orgId,payload.conversationId])).rows[0];
    const identity=(await c.query("SELECT * FROM social_identities WHERE org_id=$1 AND conversation_id=$2 AND provider='whatsapp'",[config.orgId,payload.conversationId])).rows[0];
    if(!conversation||!identity)throw new ApiError(404,'Approved AI conversation not found');
    if(conversation.version!==payload.expectedVersion||conversation.status!=='human_active'||conversation.assignee_id!==staff.id||identity.account_id!==payload.accountId||identity.remote_id!==payload.remoteId||identity.opt_out||identity.lead_id!==conversation.lead_id)throw new ApiError(409,'Approved AI recipient, assignment or generation changed');
    const lead=(await c.query('SELECT contact_consent_at,contact_consent_version FROM leads WHERE org_id=$1 AND id=$2',[config.orgId,identity.lead_id])).rows[0];
    if(!lead?.contact_consent_at||!lead.contact_consent_version)throw new ApiError(409,'Recorded CRM consent required');
    const messageId=randomUUID(),time=new Date().toISOString().replace(/(\.\d{3})Z$/,(_,f)=>f+'000Z');
    await c.query("INSERT INTO messages(id,org_id,conversation_id,role,content) VALUES($1,$2,$3,'agent',$4)",[messageId,config.orgId,payload.conversationId,payload.text]);
    const command=await enqueueSocialReply(c,config.orgId,payload.conversationId,messageId,payload.text);if(!command.commandId)throw new ApiError(409,'WhatsApp intent required');
    await c.query('UPDATE social_message_provenance SET metadata=$3 WHERE org_id=$1 AND message_id=$2',[config.orgId,messageId,JSON.stringify({approval:'approved_ai',approvedBy:staff.id,commandId:command.commandId,approvedAi:{bridgeCommandId:payload.commandId,sourceSystem:payload.source.system,workspace:payload.source.workspace,jobId:payload.source.jobId,resultId:payload.source.resultId,resultHash:payload.source.resultHash,sourceHash:payload.source.sourceHash,approvalId:payload.source.approvalId,sourceOutboxId:payload.source.outboxId}})]);
    await c.query('INSERT INTO crm_approved_ai_commands(org_id,command_id,payload_hash,payload_json,source_workspace,source_outbox_id,source_job_id,result_hash,actor_id,conversation_id,message_id,outbound_command_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',[config.orgId,payload.commandId,hash,serialized,payload.source.workspace,payload.source.outboxId,payload.source.jobId,payload.source.resultHash,staff.id,payload.conversationId,messageId,command.commandId,time]);
    await c.query('INSERT INTO crm_bridge_commands(org_id,command_id,payload_hash,actor_id,conversation_id,result_json) VALUES($1,$2,$3,$4,$5,$6)',[config.orgId,payload.commandId,hash,staff.id,payload.conversationId,JSON.stringify({kind:'approved-ai-text',messageId,outboundCommandId:command.commandId})]);
    await c.query('INSERT INTO audit_events(id,org_id,actor_id,action,entity_id,metadata) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),config.orgId,staff.id,'approved_ai.accepted',messageId,JSON.stringify({commandId:payload.commandId,resultHash:payload.source.resultHash,sourceHash:payload.source.sourceHash})]);
    await c.query('UPDATE conversations SET updated_at=$3 WHERE org_id=$1 AND id=$2',[config.orgId,payload.conversationId,time]);
    return command.commandId;
  },staff);
  if(options.dispatch!==false)await dispatchSocialReply(config.orgId,outbound,{fetch:options.fetch}).catch(()=>{/* Durable queued intent remains visible; recovery revalidates the source. */});
  return approvedAiStatus(payload.commandId);
}
