import { database } from './db';
import { ApiError, fields, str, uuid, type Staff } from './auth';
import { bridgePayloadHash } from './bridge-protocol';
import { conversationAction } from './service';

/** The service identity is fixed by deployment. Browser input never selects an organization. */
export async function handleBridgeCommand(body: unknown) {
  if(process.env.CRM_BRIDGE_ENABLED!=='true')throw new ApiError(503,'Bridge is disabled');
  if(!body||typeof body!=='object'||Array.isArray(body))throw new ApiError(400,'Invalid command');
  const input=body as Record<string,unknown>;
  fields(input,['commandId','conversationId','actorId','action','text']);
  const commandId=uuid(input.commandId),conversationId=uuid(input.conversationId),actorId=uuid(input.actorId);
  const action=str(input.action,'action',20,true);
  if(!['claim','reply','note','resolve'].includes(action))throw new ApiError(400,'Unsupported bridge command');
  const text=input.text===undefined?undefined:str(input.text,'text',6000,true);
  if((action==='reply'||action==='note')&&!text)throw new ApiError(400,'Message text required');
  if(action!=='reply'&&action!=='note'&&text!==undefined)throw new ApiError(400,'Unexpected message text');
  const orgId=process.env.CRM_BRIDGE_ORG_ID;
  let allowed:unknown;try{allowed=JSON.parse(process.env.CRM_BRIDGE_ALLOWED_MEMBER_IDS||'[]');}catch{throw new ApiError(503,'Bridge members are not configured');}
  if(!orgId||!Array.isArray(allowed)||!allowed.includes(actorId))throw new ApiError(403,'Bridge member is not permitted');
  const member=(await database.query('SELECT id,org_id,name,email,role,active FROM members WHERE org_id=$1 AND id=$2',[orgId,actorId])).rows[0];
  if(!member?.active)throw new ApiError(403,'Bridge member is inactive');
  const staff:Staff={id:member.id,orgId:member.org_id,name:member.name,email:member.email,role:member.role};
  const hash=await bridgePayloadHash(JSON.stringify({commandId,conversationId,actorId,action,text:text??null}));
  // conversationAction revalidates the active member and assignment inside the CAS transaction.
  await conversationAction(staff,conversationId,action,text===undefined?{}:{text},{id:commandId,hash});
  return {ok:true,commandId,conversationId};
}
