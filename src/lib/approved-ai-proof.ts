import {randomUUID} from 'node:crypto';
import {ApiError} from './auth';
import {database,type Row} from './db';
import {signBridgeRequest} from './bridge-protocol';

export function approvedAiConfig(){
  if(process.env.CRM_APPROVED_AI_ENABLED!=='true'||process.env.CRM_BRIDGE_ENABLED!=='true')throw new ApiError(503,'Approved AI forwarding is disabled');
  const orgId=process.env.CRM_BRIDGE_ORG_ID||'',secret=process.env.CRM_BRIDGE_SECRET||'',origin=process.env.CRM_APPROVED_AI_SOURCE_ORIGIN||'';
  let url:URL;try{url=new URL(origin);}catch{throw new ApiError(503,'Approved AI source is not configured');}
  if(url.protocol!=='https:'||url.origin!==origin||url.username||url.password||!orgId||secret.length<32)throw new ApiError(503,'Approved AI source is not configured');
  return {orgId,secret,origin};
}
export async function verifyApprovedAiSource(row:Row,transport:typeof fetch=fetch){
  const config=approvedAiConfig();if(config.orgId!==row.org_id)throw new ApiError(403,'Approved AI organization mismatch');
  const nonce=randomUUID(),body=JSON.stringify({commandId:row.command_id,payloadHash:row.payload_hash,nonce}),url=config.origin+'/api/rrs/crm/approved-ai/validate';
  const response=await transport(url,{method:'POST',body,headers:await signBridgeRequest(url,{...config,method:'POST',body}),redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(8000)});
  if(!response.ok){await response.body?.cancel();throw new ApiError(response.status===409||response.status===403?409:503,'Source AI approval is unavailable or no longer valid');}
  const reader=response.body?.getReader();if(!reader)throw new ApiError(503,'Source AI proof missing');
  let text='',size=0;const decoder=new TextDecoder();
  try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>8192){await reader.cancel();throw new ApiError(503,'Source AI proof exceeds limit');}text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}finally{reader.releaseLock();}
  let proof:Row;try{proof=JSON.parse(text);}catch{throw new ApiError(503,'Source AI proof invalid');}
  if(proof?.version!==1||proof.valid!==true||proof.orgId!==row.org_id||proof.commandId!==row.command_id||proof.payloadHash!==row.payload_hash||proof.nonce!==nonce||!Number.isSafeInteger(proof.sourceRevision)||proof.sourceRevision<0||!Number.isFinite(proof.checkedAt)||Math.abs(Date.now()-proof.checkedAt)>30000)throw new ApiError(409,'Source AI proof does not match this command');
  return proof;
}
/** Called outside the mutation planner on every attempt, including the generic recovery runner. */
export async function validateApprovedAiDispatch(orgId:string,outboundCommandId:string,transport:typeof fetch=fetch){
  const row=(await database.query('SELECT * FROM crm_approved_ai_commands WHERE org_id=$1 AND outbound_command_id=$2',[orgId,outboundCommandId])).rows[0];
  if(row)await verifyApprovedAiSource(row,transport);
}
