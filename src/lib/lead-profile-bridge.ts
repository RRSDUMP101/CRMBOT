import {randomUUID} from 'node:crypto';
import {ApiError, assignee, fields, str, uuid} from './auth';
import {transaction} from './db';
import {bridgePayloadHash} from './bridge-protocol';

type Input = Record<string, unknown>;
const invalid = () => new ApiError(400,'CRM_LEAD_INVALID');

export async function bridgeLeadProfile(orgId: string, input: Input) {
  const write=input.action==='update';
  if(!write&&input.action!=='read')throw invalid();
  fields(input,write?['action','actorId','conversationId','leadId','market','version','commandId','changes']:['action','actorId','conversationId','leadId','market']);
  const actorId=uuid(input.actorId), conversationId=uuid(input.conversationId), leadId=uuid(input.leadId);
  const market=input.market;
  if(market!=='export'&&market!=='domestic')throw invalid();
  let allowed:unknown;
  try {allowed=JSON.parse(process.env.CRM_BRIDGE_ALLOWED_MEMBER_IDS||'[]');}
  catch {throw new ApiError(503,'CRM_ACTORS_UNAVAILABLE');}
  if(!Array.isArray(allowed)||!allowed.includes(actorId))throw new ApiError(403,'CRM_ACTOR_NOT_MAPPED');
  const changes: {name?:string;email?:string;assigneeId?:string|null}={};
  let commandId='',version=0,hash='';
  if(write){
    commandId=uuid(input.commandId);
    if(typeof input.version!=='number'||!Number.isSafeInteger(input.version)||input.version<0)throw invalid();
    version=input.version;
    if(!input.changes||typeof input.changes!=='object'||Array.isArray(input.changes))throw invalid();
    const edit=input.changes as Input;
    fields(edit,['name','email','assigneeId']);
    if(!Object.keys(edit).length)throw invalid();
    if('name' in edit)changes.name=str(edit.name,'ชื่อ',254,true);
    if('email' in edit){
      if(typeof edit.email!=='string')throw invalid();
      changes.email=str(edit.email,'อีเมล',254);
      if(changes.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(changes.email))throw invalid();
    }
    if('assigneeId' in edit)changes.assigneeId=edit.assigneeId===null?null:uuid(edit.assigneeId);
    hash=await bridgePayloadHash(JSON.stringify(['lead.profile',orgId,actorId,conversationId,leadId,market,version,changes]));
  }
  return transaction(orgId,async c=>{
    const staff=(await c.query('SELECT role,active FROM members WHERE org_id=$1 AND id=$2',[orgId,actorId])).rows[0];
    if(!staff?.active||!['Admin','Agent'].includes(staff.role))throw new ApiError(403,'CRM_ACTOR_NOT_MAPPED');
    const lead=(await c.query(`SELECT l.id,l.name,l.email,l.assignee_id,
      COALESCE((SELECT MAX(e.sequence) FROM crm_bridge_events e WHERE e.org_id=l.org_id AND e.entity='lead' AND e.record_id=l.id),0) version
      FROM leads l JOIN conversations v ON v.org_id=l.org_id AND v.lead_id=l.id
      WHERE l.org_id=$1 AND v.id=$2 AND l.id=$3 AND l.market=$4`,[orgId,conversationId,leadId,market])).rows[0];
    if(!lead)throw new ApiError(404,'CRM_LEAD_NOT_FOUND');
    if(!write){
      const members=(await c.query('SELECT id,name FROM members WHERE org_id=$1 AND active=1 ORDER BY name,id',[orgId])).rows;
      return {id:lead.id,name:lead.name,email:lead.email,assigneeId:lead.assignee_id,version:Number(lead.version),members};
    }
    const prior=(await c.query('SELECT actor_id,conversation_id,payload_hash FROM crm_bridge_commands WHERE org_id=$1 AND command_id=$2',[orgId,commandId])).rows[0];
    if(prior){
      if(prior.actor_id!==actorId||prior.conversation_id!==conversationId||prior.payload_hash!==hash)throw new ApiError(409,'CRM_COMMAND_ID_CONFLICT');
      return {ok:true,commandId};
    }
    if(Number(lead.version)!==version)throw new ApiError(409,'CRM_LEAD_CHANGED');
    const owner=changes.assigneeId===undefined?lead.assignee_id:await assignee(c,orgId,changes.assigneeId);
    await c.query("UPDATE leads SET name=$3,email=$4,assignee_id=$5,updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') WHERE org_id=$1 AND id=$2",
      [orgId,leadId,changes.name??lead.name,changes.email??lead.email,owner]);
    await c.query('INSERT INTO audit_events(id,org_id,actor_id,action,entity_id,metadata) VALUES($1,$2,$3,$4,$5,$6)',
      [randomUUID(),orgId,actorId,'updateLead',leadId,JSON.stringify({source:'sales_office',changedFields:Object.keys(changes),commandId})]);
    await c.query('INSERT INTO crm_bridge_commands(org_id,command_id,payload_hash,actor_id,conversation_id,result_json) VALUES($1,$2,$3,$4,$5,$6)',
      [orgId,commandId,hash,actorId,conversationId,JSON.stringify({ok:true,action:'lead.profile'})]);
    return {ok:true,commandId};
  });
}
