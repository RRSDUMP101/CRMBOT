import {randomUUID} from 'node:crypto';
import {ApiError,fields,requireAdmin,str,uuid,type Staff} from './auth';
import {transaction,type Executor} from './db';

export type WhatsAppConsentStatus={applicable:false}|{
  applicable:true;conversationId:string;leadId:string;revision:number;granted:boolean;optedOut:boolean;
  recordedAt:string|null;recordVersion:string|null;lastReview:null|{decision:'granted'|'revoked';evidenceNote:string;recordedAt:string;actorId:string};
  affectedConversations:number;inFlight:number;
};
const now=()=>new Date().toISOString().replace(/(\.\d{3})Z$/,(_,fraction)=>fraction+'000Z');

async function context(c:Executor,staff:Staff,conversationId:string){
  const conversation=(await c.query('SELECT lead_id FROM conversations WHERE org_id=$1 AND id=$2',[staff.orgId,conversationId])).rows[0];
  if(!conversation)throw new ApiError(404,'ไม่พบบทสนทนา');
  const identity=(await c.query("SELECT id,lead_id FROM social_identities WHERE org_id=$1 AND conversation_id=$2 AND provider='whatsapp'",[staff.orgId,conversationId])).rows[0];
  if(!identity)return null;
  if(identity.lead_id!==conversation.lead_id)throw new ApiError(409,'ความสัมพันธ์ข้อมูลลูกค้าต้องได้รับการตรวจสอบก่อน');
  const lead=(await c.query('SELECT contact_consent_at,contact_consent_version FROM leads WHERE org_id=$1 AND id=$2',[staff.orgId,conversation.lead_id])).rows[0];
  if(!lead)throw new ApiError(404,'ไม่พบลูกค้า');
  const scope=(await c.query("SELECT COUNT(*) AS total,MAX(opt_out) AS opted_out FROM social_identities WHERE org_id=$1 AND lead_id=$2 AND provider='whatsapp'",[staff.orgId,conversation.lead_id])).rows[0];
  const organization=(await c.query('SELECT revision FROM organizations WHERE id=$1',[staff.orgId])).rows[0];
  return {leadId:conversation.lead_id as string,lead,scope,revision:Number(organization.revision)};
}

/** The audit note is Admin-only; never copy it into visitor-visible lead facts or bridge events. */
export async function whatsappConsentStatus(staff:Staff,conversationId:string):Promise<WhatsAppConsentStatus>{
  requireAdmin(staff);uuid(conversationId);
  return transaction(staff.orgId,async c=>{
    const current=await context(c,staff,conversationId);if(!current)return {applicable:false};
    const audit=(await c.query("SELECT actor_id,created_at,metadata FROM audit_events WHERE org_id=$1 AND entity_id=$2 AND action IN ('whatsapp_consent.granted','whatsapp_consent.revoked') ORDER BY CAST(json_extract(metadata,'$.revision') AS INTEGER) DESC,created_at DESC,id DESC LIMIT 1",[staff.orgId,current.leadId])).rows[0];
    const inFlight=(await c.query("SELECT COUNT(*) AS total FROM social_outbound_commands o JOIN social_identities i ON i.org_id=o.org_id AND i.id=o.identity_id WHERE o.org_id=$1 AND i.lead_id=$2 AND o.provider='whatsapp' AND o.status IN ('sending','unknown')",[staff.orgId,current.leadId])).rows[0].total;
    return {applicable:true,conversationId,leadId:current.leadId,revision:current.revision,granted:!!current.lead.contact_consent_at&&!!current.lead.contact_consent_version,optedOut:!!current.scope.opted_out,
      recordedAt:current.lead.contact_consent_at||null,recordVersion:current.lead.contact_consent_version||null,affectedConversations:Number(current.scope.total),inFlight:Number(inFlight),
      lastReview:audit?{decision:audit.metadata.decision,evidenceNote:audit.metadata.evidenceNote,recordedAt:audit.created_at,actorId:audit.actor_id}:null};
  },staff);
}

export async function reviewWhatsAppConsent(staff:Staff,conversationId:string,input:Record<string,unknown>):Promise<WhatsAppConsentStatus>{
  requireAdmin(staff);uuid(conversationId);fields(input,['decision','evidenceNote','expectedRevision','confirm']);
  if(!['granted','revoked'].includes(String(input.decision)))throw new ApiError(400,'เลือกรายการยินยอมหรือถอนความยินยอม');
  if(input.confirm!==true)throw new ApiError(422,'กรุณายืนยันว่าตรวจสอบหลักฐานแล้ว');
  const decision=input.decision as 'granted'|'revoked',evidenceNote=str(input.evidenceNote,'หลักฐาน',1000,true);
  if(evidenceNote.length<3)throw new ApiError(400,'กรุณาระบุที่มาและรายละเอียดหลักฐาน');
  if(typeof input.expectedRevision!=='number'||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)throw new ApiError(400,'กรุณาโหลดสถานะล่าสุดก่อนบันทึก');
  await transaction(staff.orgId,async c=>{
    const current=await context(c,staff,conversationId);
    if(!current)throw new ApiError(409,'บทสนทนานี้ไม่ได้เชื่อมกับ WhatsApp');
    if(current.revision!==input.expectedRevision)throw new ApiError(409,'ข้อมูลเปลี่ยนระหว่างตรวจสอบ กรุณาโหลดสถานะล่าสุดและตรวจอีกครั้ง');
    // Recording evidence never clears an unsubscribe or a source-imported opt-out.
    if(decision==='granted'&&current.scope.opted_out)throw new ApiError(409,'ลูกค้าปฏิเสธการติดต่ออยู่ ไม่สามารถเปิดความยินยอมจากหน้านี้ได้');
    const time=now(),eventId=randomUUID();
    await c.query('UPDATE leads SET contact_consent_at=$3,contact_consent_version=$4,updated_at=$5 WHERE org_id=$1 AND id=$2',[staff.orgId,current.leadId,decision==='granted'?time:null,decision==='granted'?`whatsapp-admin-v1:${eventId}`:null,time]);
    // A newly recorded permission must not release an old blocked/queued reply either.
    // In-flight sends remain receipt-driven: they may already have reached the provider.
    const scoped="SELECT conversation_id FROM social_identities WHERE org_id=$1 AND lead_id=$2 AND provider='whatsapp'";
    await c.query(`UPDATE social_message_provenance SET delivery_status='cancelled' WHERE org_id=$1 AND message_id IN (SELECT message_id FROM social_outbound_commands WHERE org_id=$1 AND provider='whatsapp' AND conversation_id IN (${scoped}) AND status='queued')`,[staff.orgId,current.leadId]);
    await c.query(`UPDATE social_outbound_commands SET status='cancelled',error_code='consent_review_changed',updated_at=$3 WHERE org_id=$1 AND provider='whatsapp' AND conversation_id IN (${scoped}) AND status='queued'`,[staff.orgId,current.leadId,time]);
    await c.query(`UPDATE messages SET status='interrupted' WHERE org_id=$1 AND conversation_id IN (${scoped}) AND status='generating'`,[staff.orgId,current.leadId]);
    await c.query(`UPDATE conversations SET version=version+1,generating_client_id=NULL,generation_started_at=NULL,updated_at=$3 WHERE org_id=$1 AND id IN (${scoped})`,[staff.orgId,current.leadId,time]);
    await c.query('INSERT INTO audit_events(id,org_id,actor_id,action,entity_id,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[eventId,staff.orgId,staff.id,`whatsapp_consent.${decision}`,current.leadId,JSON.stringify({decision,evidenceNote,revision:current.revision+1,conversationId,previousRecordedAt:current.lead.contact_consent_at||null,previousVersion:current.lead.contact_consent_version||null,optOutPreserved:!!current.scope.opted_out,affectedConversations:Number(current.scope.total)}),time]);
  },staff);
  return whatsappConsentStatus(staff,conversationId);
}
