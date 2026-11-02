import {createHash} from 'node:crypto';
import {ApiError,fields,uuid} from './auth';
import {database,type Executor,type Row} from './db';
import {aiRuntimeContext} from './ai-lifecycle';
import {selectKnowledge} from './bot';

export type AiPolicyProof={version:1;scope:string;conversationVersion:number;customerSeq:number;profileRevision:number;evaluationId:string;sourceFingerprint:string;policyHash:string};
export function parseAiPolicyProof(value:unknown):AiPolicyProof{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new ApiError(400,'ai_policy_proof_invalid');const p=value as Row;fields(p,['version','scope','conversationVersion','customerSeq','profileRevision','evaluationId','sourceFingerprint','policyHash']);
 if(p.version!==1||typeof p.scope!=='string'||!/^whatsapp:[0-9]{5,40}$/.test(p.scope)||!Number.isSafeInteger(p.conversationVersion)||p.conversationVersion<1||!Number.isSafeInteger(p.customerSeq)||p.customerSeq<0||!Number.isSafeInteger(p.profileRevision)||p.profileRevision<1||!/^([a-f0-9]{64})$/.test(p.sourceFingerprint)||!/^([a-f0-9]{64})$/.test(p.policyHash))throw new ApiError(400,'ai_policy_proof_invalid');uuid(p.evaluationId);return p as AiPolicyProof;
}
/** Sale remains the only social AI planner. This endpoint reads approved policy, never generates or sends. */
export async function resolveBridgeAiPolicy(orgId:string,input:Record<string,unknown>,c:Executor=database){
 fields(input,['conversationId','expectedVersion']);const conversationId=uuid(input.conversationId);if(!Number.isSafeInteger(input.expectedVersion)||Number(input.expectedVersion)<1)throw new ApiError(400,'ai_policy_version_invalid');
 if(process.env.CRM_AI_POLICY_BRIDGE_ENABLED!=='true')return {version:1 as const,enabled:false as const,owner:'sale' as const};
 const row=(await c.query('SELECT c.version,c.customer_message_seq,c.status,s.provider,s.account_id,s.opt_out FROM conversations c JOIN social_identities s ON s.org_id=c.org_id AND s.conversation_id=c.id WHERE c.org_id=$1 AND c.id=$2',[orgId,conversationId])).rows[0];
 if(!row||row.version!==input.expectedVersion)throw new ApiError(409,'ai_policy_conversation_changed');
 const base={version:1 as const,enabled:true as const,owner:'sale' as const,conversationId,conversationVersion:Number(row.version),customerSeq:Number(row.customer_message_seq),scope:row.provider+':'+row.account_id};
 const latest=(await c.query("SELECT content FROM messages WHERE org_id=$1 AND conversation_id=$2 AND role='user' ORDER BY customer_seq DESC,created_at DESC,id DESC LIMIT 1",[orgId,conversationId])).rows[0];
 const runtime=await aiRuntimeContext(orgId,base.scope,String(latest?.content||''),c),profile=(await c.query('SELECT revision,active_evaluation_id FROM ai_profiles WHERE org_id=$1 AND scope=$2',[orgId,base.scope])).rows[0];
 const selected=selectKnowledge(String(latest?.content||''),runtime.sources);let reason=process.env.AI_LIFECYCLE_ENABLED!=='true'?'lifecycle_disabled':row.provider!=='whatsapp'?'social_ai_owner_unsupported':row.opt_out?'opted_out':row.status==='resolved'?'conversation_closed':runtime.handoff?runtime.reason:!selected.length?'no_matching_approved_sources':'';
 if(Buffer.byteLength(JSON.stringify(selected))>180_000)reason='approved_context_too_large';
 if(reason)return {...base,active:false as const,handoff:true as const,reason,personality:'',sources:[],proof:null};
 const binding={version:1 as const,scope:base.scope,conversationVersion:base.conversationVersion,customerSeq:base.customerSeq,profileRevision:Number(profile.revision),evaluationId:String(profile.active_evaluation_id),sourceFingerprint:runtime.fingerprint};
 const policyHash=createHash('sha256').update(JSON.stringify({orgId,conversationId,...binding,personality:runtime.personality,sources:selected})).digest('hex');
 return {...base,active:true as const,handoff:false as const,reason:'',personality:runtime.personality,sources:selected,proof:{...binding,policyHash}};
}
export async function assertBridgeAiPolicy(orgId:string,conversationId:string,expectedVersion:number,proof:unknown,c:Executor=database){
 if(process.env.CRM_AI_POLICY_BRIDGE_ENABLED!=='true'&&proof===undefined)return;
 const parsed=parseAiPolicyProof(proof),current=await resolveBridgeAiPolicy(orgId,{conversationId,expectedVersion},c);
 if(!current.enabled||!current.active||!current.proof||Object.keys(parsed).some(key=>parsed[key as keyof AiPolicyProof]!==current.proof![key as keyof AiPolicyProof]))throw new ApiError(409,'ai_policy_changed_or_handoff');
}
export async function validateBridgeAiPolicyDispatch(row:Row){const payload=JSON.parse(row.payload_json);await assertBridgeAiPolicy(row.org_id,payload.conversationId,payload.expectedVersion,payload.source?.aiPolicy);}
