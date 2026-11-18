import {createHash} from 'node:crypto';
import {ApiError,fields,str,uuid} from './auth';
import {database,transaction,type Executor} from './db';
import {aiRuntimeContext} from './ai-lifecycle';
import {caseContext} from './sales-knowledge';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
export async function learningEvidence(org:string,input:Record<string,unknown>,c:Executor=database){
 if(process.env.RRS_SALES_KNOWLEDGE_ENABLED!=='true')throw new ApiError(503,'knowledge_learning_disabled');
 const conversation=uuid(input.conversationId),message=uuid(input.messageId),excerpt=str(input.excerpt,'ข้อความที่ตรวจแล้ว',1800,true);
 const r=(await c.query(`SELECT m.content,i.account_id FROM messages m JOIN social_identities i ON i.org_id=m.org_id AND i.conversation_id=m.conversation_id
 WHERE m.org_id=$1 AND m.id=$2 AND m.conversation_id=$3 AND i.provider='whatsapp' AND m.role='agent' AND m.status='complete'
 AND m.author_member_id IS NOT NULL AND m.source_owner_only=0 AND i.opt_out=0
 AND NOT EXISTS (SELECT 1 FROM social_message_provenance p WHERE p.org_id=m.org_id AND p.message_id=m.id AND p.removed_at IS NOT NULL)
 AND NOT EXISTS (SELECT 1 FROM whatsapp_triage t WHERE t.org_id=m.org_id AND t.conversation_id=m.conversation_id AND t.review_state IN ('pending','held','suppressed'))`,[org,message,conversation])).rows[0];
 if(!r||!String(r.content).includes(excerpt)||/[\w.%+-]+@[\w.-]+\.[a-z]{2,}|https?:\/\/|(?:\+?\d[ ()-]*){8,}/iu.test(excerpt))throw new ApiError(409,'knowledge_evidence_requires_review');
 const scope='whatsapp:'+r.account_id;
 const context=await caseContext(c,org,conversation);
 const policy=await aiRuntimeContext(org,scope,'',c,context);
 return {scope,sourceVersion:policy.fingerprint,sourceHash:sha(String(r.content)),context};
}
export async function acceptLearningProposal(org:string,input:Record<string,unknown>){
 fields(input,['commandId','conversationId','messageId','excerpt','sourceHash','sourceVersion','summary','runId']);
 const id=uuid(input.commandId),message=uuid(input.messageId),runId=uuid(input.runId),summary=str(input.summary,'สรุป',5000,true);
 if(!/[ก-๙]/u.test(summary)||/[\w.%+-]+@[\w.-]+\.[a-z]{2,}|https?:\/\/|(?:\+?\d[ ()-]*){8,}/iu.test(summary))throw new ApiError(409,'knowledge_draft_requires_redaction');
 const contentHash=sha(JSON.stringify([id,input.conversationId,message,input.excerpt,input.sourceHash,input.sourceVersion,summary,runId]));
 return transaction(org,async c=>{
  const prior=(await c.query('SELECT payload_hash FROM sales_learning_receipts WHERE org_id=$1 AND command_id=$2',[org,id])).rows[0];
  if(prior){if(prior.payload_hash!==contentHash)throw new ApiError(409,'knowledge_command_changed');return {id,state:'captured'};}
  const source=await learningEvidence(org,input,c);
  if(source.sourceHash!==input.sourceHash||source.sourceVersion!==input.sourceVersion)throw new ApiError(409,'knowledge_source_changed');
  const at=new Date().toISOString(),title='ข้อเสนอจากคำตอบพนักงาน · '+message.slice(0,8),scopes=JSON.stringify([source.scope]);
  await c.query("INSERT INTO knowledge(id,org_id,title,content,scope_json,source_type,version,status,processing_status,updated_at) VALUES($1,$2,$3,$4,$5,'manual',1,'draft','ready',$6)",[id,org,title,summary,scopes,at]);
  await c.query("INSERT INTO knowledge_versions(org_id,source_id,version,title,content,scope_json,source_type,created_by,created_at) VALUES($1,$2,1,$3,$4,$5,'manual','knowledge-learning',$6)",[org,id,title,summary,scopes,at]);
  await c.query('INSERT INTO sales_knowledge_scope(org_id,source_id,version,applicability,evidence_message_id) VALUES($1,$2,1,$3,$4)',[org,id,JSON.stringify({...source.context,conversationId:input.conversationId}),message]);
  await c.query('INSERT INTO sales_learning_receipts(org_id,command_id,payload_hash,run_id,created_at) VALUES($1,$2,$3,$4,$5)',[org,id,contentHash,runId,at]);
  return {id,state:'captured'};
 });
}
