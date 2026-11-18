import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {ApiError} from './errors';
import {transaction} from './db';

const sourceVersion=createHash('sha256').update('rrs-spam-v1/semantic-review-v1').digest('hex');
const categories=['legitimate_inquiry','low_information','off_topic','suspected_spam','flood','unsafe_attachment_or_link','complaint_or_support','opt_out','prompt_injection'] as const;
const suggestion=z.object({category:z.enum(categories),summary:z.string().min(1).max(2000),quote:z.string().min(1).max(2000),model:z.string().min(1).max(120),runId:z.string().uuid(),evaluationId:z.string().uuid(),confidence:z.number().min(0).max(1),action:z.enum(['ALLOW','LIMITED_REPLY','QUARANTINED','TEMP_COOLDOWN','HUMAN_REVIEW'])}).strict();
const completion=z.object({messageId:z.string().uuid(),token:z.string().uuid(),suggestion:suggestion.nullable()}).strict();
const evidence=" FROM whatsapp_triage t JOIN messages m ON m.org_id=t.org_id AND m.id=t.message_id JOIN social_message_provenance p ON p.org_id=t.org_id AND p.message_id=t.message_id JOIN conversations v ON v.org_id=t.org_id AND v.id=t.conversation_id JOIN social_identities i ON i.org_id=t.org_id AND i.id=t.identity_id WHERE t.org_id=$1 AND p.provider='whatsapp' AND p.direction='in' AND p.provider_type='text' AND p.removed_at IS NULL AND m.source_owner_only=0 AND m.role='user' AND i.account_id=p.account_id AND i.remote_id=p.remote_id AND i.opt_out=0 AND v.customer_message_seq=t.source_seq AND v.version=t.source_version AND v.status='waiting_human' AND t.review_state='pending' AND NOT EXISTS(SELECT 1 FROM whatsapp_triage_suppressions s WHERE s.org_id=t.org_id AND s.identity_id=t.identity_id)";
function enabled(){if(process.env.RRS_SALES_SEMANTIC_SPAM_ENABLED!=='true')throw new ApiError(409,'Semantic review disabled');}
export async function claimSemanticSpam(orgId:string){
  enabled();
  return transaction(orgId,async c=>{
    const now=Date.now();
    await c.query("UPDATE whatsapp_triage SET semantic_status='unavailable',semantic_token=NULL WHERE org_id=$1 AND semantic_status='working' AND semantic_until<$2",[orgId,now]);
    const r=(await c.query('SELECT t.message_id,t.conversation_id,m.content,p.account_id,i.lead_id'+evidence+" AND t.semantic_status='pending' AND t.received_ms>$2 ORDER BY t.received_ms,t.message_id LIMIT 1",[orgId,now-30*60000])).rows[0];
    if(!r)return {candidate:null};
    const token=randomUUID();
    await c.query("UPDATE whatsapp_triage SET semantic_status='working',semantic_token=$3,semantic_until=$4 WHERE org_id=$1 AND message_id=$2",[orgId,r.message_id,token,now+120000]);
    return {candidate:{messageId:r.message_id,conversationId:r.conversation_id,leadId:r.lead_id,scope:'whatsapp:'+r.account_id,text:String(r.content).slice(0,2000),token,sourceVersion}};
  });
}
export async function finishSemanticSpam(orgId:string,raw:unknown){
  enabled();const parsed=completion.safeParse(raw);
  if(!parsed.success)throw new ApiError(400,'Invalid semantic review');
  const {messageId,token,suggestion}=parsed.data;
  return transaction(orgId,async c=>{
    const row=(await c.query('SELECT semantic_status,semantic_token,semantic_until FROM whatsapp_triage WHERE org_id=$1 AND message_id=$2',[orgId,messageId])).rows[0];
    if(row?.semantic_token!==token)throw new ApiError(409,'Review claim changed');
    if(['suggested','unavailable','stale'].includes(row.semantic_status))return {state:row.semantic_status};
    const current=(await c.query('SELECT m.content'+evidence+' AND t.message_id=$2',[orgId,messageId])).rows[0];
    if(current && suggestion && !String(current.content).slice(0,2000).includes(suggestion.quote))throw new ApiError(422,'Evidence quote changed');
    const state=!current||row.semantic_until<Date.now()?'stale':suggestion?'suggested':'unavailable';
    await c.query('UPDATE whatsapp_triage SET semantic_status=$3,semantic_suggestion=$4 WHERE org_id=$1 AND message_id=$2',[orgId,messageId,state,state==='suggested'?JSON.stringify(suggestion):null]);
    return {state};
  });
}
