import {createHash, randomUUID} from 'node:crypto';
import {ApiError, fields, requireAdmin, str, uuid, type Staff} from './auth';
import {transaction, type Executor, type Row} from './db';
import {recordCustomerFacts} from './sales-knowledge';

const policyVersion = 'rrs-spam-v1';
const defaultPolicy = {mode:'shadow', repeat_limit:5, window_seconds:60, revision:0};
const optOut = /^(stop|unsubscribe|หยุดติดต่อ|หยุด|ยกเลิกการติดต่อ)(?:$|\s|[.!])/i;
const requestQuote = /\b(?:please\s+(?:quote\b|(?:send|provide|prepare|issue)\b.{0,30}\b(?:quote|quotation)\b)|(?:can|could|would)\s+(?:you|i)\b.{0,40}\b(?:quote|quotation)\b|(?:i|we)\s+(?:need|want|request)\s+(?:a\s+)?(?:quotation|quote)\b|rfq\b)|(?:ขอ|รบกวน(?:ออก|ทำ|ส่ง)?|ช่วย(?:ออก|ทำ|ส่ง))\s*(?:ใบเสนอราคา|quotation)/iu;
const noQuote = /\b(?:no|not|don't|dont|cancel|withdraw|decline)\b.{0,40}\b(?:quote|quotation|rfq)\b|(?:ไม่|ยกเลิก).{0,20}ใบเสนอราคา/iu;
export const quotationRequested = (text:string) => requestQuote.test(text) && !noQuote.test(text);
type Attachment = {type:string; metadata:Record<string,unknown>};
const permittedMedia:Record<string,string[]> = {
  image:['image/jpeg','image/png'], sticker:['image/webp'], audio:['audio/aac','audio/mp4','audio/mpeg','audio/amr','audio/ogg'],
  video:['video/mp4','video/3gpp'], document:['application/pdf','image/jpeg','image/png','text/plain'],
};
function unsafeMedia(attachments:Attachment[]) {
  return attachments.some(a => {
    const mime = String(a.metadata.mime_type || '').split(';')[0].toLowerCase();
    const name = String(a.metadata.filename || '');
    return !permittedMedia[a.type]?.includes(mime) || /\.(?:exe|bat|cmd|js|vbs|msi|scr|ps1|hta|lnk|html?|svg)(?:$|\s)/i.test(name);
  });
}
type Decision = {category:string; action:string; reason:string};
function classify(text:string,type:string,unsafe:boolean,repeats:number,limit:number):Decision {
  if(optOut.test(text)) return {category:'opt_out',action:'HUMAN_REVIEW',reason:'ลูกค้าขอหยุดติดต่อ'};
  if(unsafe) return {category:'unsafe_attachment_or_link',action:'QUARANTINED',reason:'ชนิดไฟล์หรือ URL ต้องตรวจสอบก่อนเปิด'};
  if(/ร้องเรียน|ของเสีย|เสียหาย|ขอเคลม|\b(?:complaint|defective|broken|warranty claim)\b/i.test(text)) return {category:'complaint_or_support',action:'HUMAN_REVIEW',reason:'คำร้องเรียนหรืองานบริการหลังการขาย'};
  if(/ignore (?:all |your )?(?:previous|prior|system) instructions|เปิดเผย.{0,8}(?:system prompt|รหัสลับ)|ข้ามกฎทั้งหมด/i.test(text)) return {category:'prompt_injection',action:'HUMAN_REVIEW',reason:'พบคำขอให้ข้ามข้อกำหนดของระบบ'};
  if(type==='text' && repeats >= limit) return {category:'flood',action:'TEMP_COOLDOWN',reason:'ข้อความซ้ำจากผู้ส่งรายเดิมเกินเกณฑ์ในช่วงเวลาที่ตั้งไว้'};
  if(type==='text' && repeats>=2 && /https?:\/\//i.test(text) && /casino|betting|crypto promotion|สมัครพนัน|คาสิโน/i.test(text)) return {category:'suspected_spam',action:'QUARANTINED',reason:'ข้อความโฆษณาพร้อมลิงก์ซ้ำจากผู้ส่งรายเดิม'};
  if(/^(?:tell me a joke|เล่าเรื่องตลก|ขอหวย)[.!?\s]*$/i.test(text)) return {category:'off_topic',action:'LIMITED_REPLY',reason:'คำขอนอกเรื่องสินค้า'};
  if(type==='sticker'||/^(?:hi|hello|hey|สวัสดี(?:ครับ|ค่ะ)?|ทักครับ)[.!?\s]*$/iu.test(text)) return {category:'unclear',action:'LIMITED_REPLY',reason:'เริ่มสนทนา ข้อมูลยังไม่พอ'};
  return {category:'legitimate',action:'ALLOW',reason:'รับข้อความลูกค้าในบทสนทนา'};
}
async function settings(c:Executor,orgId:string) {
  return (await c.query('SELECT * FROM whatsapp_triage_settings WHERE org_id=$1',[orgId])).rows[0] || defaultPolicy;
}
export async function decideWhatsApp(c:Executor,orgId:string,identity:Row,text:string,type:string,attachments:Attachment[]) {
  const config = await settings(c,orgId);
  const fingerprint = createHash('sha256').update(text.trim().toLowerCase().replace(/\s+/g,' ')).digest('hex');
  const receivedMs = Date.now();
  const count = (await c.query('SELECT COUNT(*) AS total FROM whatsapp_triage WHERE org_id=$1 AND identity_id=$2 AND received_ms>$3 AND fingerprint=$4',
    [orgId,identity.id,receivedMs-config.window_seconds*1000,fingerprint])).rows[0].total;
  const suppressed = !!(await c.query('SELECT 1 FROM whatsapp_triage_suppressions WHERE org_id=$1 AND identity_id=$2',[orgId,identity.id])).rows.length;
  const unsafe = unsafeMedia(attachments) || /(?:https?:\/\/(?:localhost|127\.0\.0\.1)(?:[:/?\s]|$)|(?:javascript|file):\/\/)/i.test(text);
  const result = classify(text.trim(),type,unsafe,Number(count)+1,config.repeat_limit);
  const ambiguous = result.category==='legitimate' && type==='text' &&
    /https?:\/\/|รับสมัครตัวแทน|รวยเร็ว|\b(?:sponsor|affiliate|investment opportunity)\b/i.test(text) &&
    !quotationRequested(text) && !/\b(?:hilux|kit|d-max|product|vehicle)\b|ใบเสนอราคา|ชุดดั้ม|รถกระบะ/i.test(text);
  if(ambiguous)Object.assign(result,{category:'unclear',action:'HUMAN_REVIEW',reason:'ข้อความเชิญชวนหรือลิงก์ที่ยังระบุความเกี่ยวข้องกับงานขายไม่ได้'});
  const hardStop = unsafe || identity.opt_out || suppressed || ['opt_out','complaint_or_support','prompt_injection'].includes(result.category);
  const review = hardStop || ambiguous || ['QUARANTINED','TEMP_COOLDOWN'].includes(result.action);
  const eligible = !hardStop && !(config.mode==='enforce' && review);
  // Shadow mode preserves classification evidence. Cap duplicate automated reactions independently of quarantine.
  const limited = result.action==='LIMITED_REPLY' && Number(count)>0 || type==='text' && Number(count)>=config.repeat_limit*2;
  return {...result, mode:config.mode as string, fingerprint, receivedMs, unsafe, review, ambiguous:ambiguous&&!hardStop, eligible:eligible&&!limited, suppressed,
    contract:{version:1,policyVersion,policyRevision:config.revision,mode:config.mode,category:result.category,action:suppressed?'QUARANTINED':result.action,eligible:eligible&&!limited,quotationRequested:eligible&&!limited&&quotationRequested(text)}};
}
type Result = Awaited<ReturnType<typeof decideWhatsApp>>;
export async function triageBlocked(c:Executor,orgId:string,conversationId:string) {
  const blocked=await c.query('SELECT 1 FROM social_identities i JOIN conversations v ON v.org_id=i.org_id AND v.id=i.conversation_id WHERE i.org_id=$1 AND i.conversation_id=$2 AND (EXISTS(SELECT 1 FROM whatsapp_triage_suppressions s WHERE s.org_id=i.org_id AND s.identity_id=i.id) OR EXISTS(SELECT 1 FROM whatsapp_triage t WHERE t.org_id=i.org_id AND t.identity_id=i.id AND t.source_seq=v.customer_message_seq AND t.eligible=0))',[orgId,conversationId]);
  return blocked.rows.length>0;
}
export async function assertTriageEligible(c:Executor,orgId:string,conversationId:string) {
  if(await triageBlocked(c,orgId,conversationId))throw new ApiError(409,'ข้อความ WhatsApp อยู่ระหว่างตรวจสอบหรือระงับการตอบอัตโนมัติ');
}
export async function persistWhatsAppDecision(c:Executor,orgId:string,identity:Row,messageId:string,eventId:string,result:Result) {
  const state = result.suppressed?'suppressed':result.review?'pending':'clear';
  await c.query(
    'INSERT INTO whatsapp_triage(org_id,message_id,conversation_id,identity_id,event_id,source_seq,source_version,fresh,category,action,reason,mode,policy_version,fingerprint,received_ms,eligible,review_state,semantic_status) '+
    'SELECT $1,$2,id,$4,$5,customer_message_seq,version,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16 FROM conversations WHERE org_id=$1 AND id=$3',
    [orgId,messageId,identity.conversation_id,identity.id,eventId,!!identity.fresh,result.category,result.contract.action,result.reason,result.mode,policyVersion,result.fingerprint,result.receivedMs,result.eligible,state,result.ambiguous?'pending':'none']);
}

export async function spamQueue(staff:Staff,filter='pending',before=Number.MAX_SAFE_INTEGER,afterId='') {
  requireAdmin(staff);
  if(!['pending','held','released','suppressed','all'].includes(filter) || !Number.isSafeInteger(before)||before<0||afterId.length>40) throw new ApiError(400,'ตัวกรองไม่ถูกต้อง');
  return transaction(staff.orgId,async c=>{
    const policy = await settings(c,staff.orgId);
    const items = (await c.query("SELECT t.message_id,t.conversation_id,t.reason,t.category,t.mode,t.review_state,t.revision,t.received_ms,t.semantic_status,json_extract(t.semantic_suggestion,'$.summary') AS model_summary,json_extract(t.semantic_suggestion,'$.quote') AS model_quote,json_extract(t.semantic_suggestion,'$.action') AS model_action,json_extract(t.semantic_suggestion,'$.confidence') AS model_confidence,json_extract(t.semantic_suggestion,'$.model') AS model_name,m.content,l.name AS lead_name FROM whatsapp_triage t JOIN messages m ON m.org_id=t.org_id AND m.id=t.message_id JOIN conversations c ON c.org_id=t.org_id AND c.id=t.conversation_id JOIN leads l ON l.org_id=c.org_id AND l.id=c.lead_id WHERE t.org_id=$1 AND (t.review_state=$2 OR ($2='all' AND t.review_state!='clear')) AND (t.received_ms<$3 OR (t.received_ms=$3 AND t.message_id>$4)) ORDER BY t.received_ms DESC,t.message_id LIMIT 50",[staff.orgId,filter,before,afterId])).rows;
    const stats = (await c.query("SELECT COUNT(*) AS inspected,SUM(CASE WHEN review_state IN ('held','pending') THEN 1 ELSE 0 END) AS waiting,MIN(CASE WHEN review_state IN ('held','pending') THEN received_ms END) AS oldest_ms,SUM(CASE WHEN review_state='released' THEN 1 ELSE 0 END) AS released,SUM(category IN ('flood','suspected_spam')) AS spam_volume,SUM(review_state='released' AND category IN ('flood','suspected_spam')) AS confirmed_false_positive,COUNT(DISTINCT CASE WHEN review_state='released' AND eligible=1 AND category IN ('flood','suspected_spam') THEN identity_id END) AS recovered FROM whatsapp_triage WHERE org_id=$1",[staff.orgId])).rows[0];
    return {policy,items,stats};
  },staff);
}
export async function spamHistory(staff:Staff,messageId:string) {
  requireAdmin(staff);uuid(messageId);
  return transaction(staff.orgId,async c=>{
    const row=(await c.query('SELECT conversation_id,source_seq FROM whatsapp_triage WHERE org_id=$1 AND message_id=$2',[staff.orgId,messageId])).rows[0];
    if(!row)throw new ApiError(404,'ไม่พบข้อความ');
    const recent=(await c.query("SELECT id,content,created_at FROM messages WHERE org_id=$1 AND conversation_id=$2 AND role='user' AND customer_seq<=$3 ORDER BY customer_seq DESC LIMIT 5",[staff.orgId,row.conversation_id,row.source_seq])).rows;
    const audit=(await c.query("SELECT a.action,a.metadata,a.created_at,m.name AS reviewer FROM audit_events a LEFT JOIN members m ON m.org_id=a.org_id AND m.id=a.actor_id WHERE a.org_id=$1 AND a.entity_id=$2 AND a.action LIKE 'wa_triage.%' ORDER BY a.created_at DESC LIMIT 20",[staff.orgId,messageId])).rows;
    return {recent,audit};
  },staff);
}
function audit(c:Executor,staff:Staff,action:string,id:string,data:Record<string,unknown>) {
  return c.query('INSERT INTO audit_events(id,org_id,actor_id,action,entity_id,metadata) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),staff.orgId,staff.id,'wa_triage.'+action,id,JSON.stringify(data)]);
}
export async function configureSpam(staff:Staff,input:Record<string,unknown>) {
  requireAdmin(staff);fields(input,['mode','repeatLimit','windowSeconds','expectedRevision']);
  const {mode,repeatLimit,windowSeconds}=input;
  if(!['shadow','enforce'].includes(String(mode)) || !Number.isSafeInteger(repeatLimit)||Number(repeatLimit)<2||Number(repeatLimit)>100 ||
    !Number.isSafeInteger(windowSeconds)||Number(windowSeconds)<10||Number(windowSeconds)>3600) throw new ApiError(400,'ตรวจสอบโหมดและช่วงเวลาของเกณฑ์ข้อความซ้ำ');
  return transaction(staff.orgId,async c=>{
    const old=await settings(c,staff.orgId);
    if(input.expectedRevision!==old.revision)throw new ApiError(409,'มีการแก้ไขการตั้งค่าแล้ว กรุณาโหลดใหม่');
    await c.query('INSERT INTO whatsapp_triage_settings(org_id,mode,repeat_limit,window_seconds,revision) VALUES($1,$2,$3,$4,1) ON CONFLICT(org_id) DO UPDATE SET mode=excluded.mode,repeat_limit=excluded.repeat_limit,window_seconds=excluded.window_seconds,revision=whatsapp_triage_settings.revision+1',[staff.orgId,mode,repeatLimit,windowSeconds]);
    await audit(c,staff,'settings',staff.orgId,{mode,repeatLimit,windowSeconds,revision:old.revision+1});
    return {ok:true};
  },staff);
}
export async function reviewSpam(staff:Staff,input:Record<string,unknown>) {
  requireAdmin(staff);fields(input,['messageId','decision','expectedRevision','note']);
  const messageId=uuid(input.messageId),decision=str(input.decision,'การดำเนินการ',20,true),note=str(input.note,'เหตุผล',500,true);
  if(!['release','hold','suppress','unsuppress'].includes(decision))throw new ApiError(400,'ไม่รู้จักการดำเนินการ');
  return transaction(staff.orgId,async c=>{
    const r=(await c.query('SELECT t.*,m.content,p.metadata,p.account_id,p.removed_at,i.opt_out,i.lead_id,v.version,v.status,v.customer_message_seq FROM whatsapp_triage t JOIN messages m ON m.org_id=t.org_id AND m.id=t.message_id JOIN social_message_provenance p ON p.org_id=t.org_id AND p.message_id=t.message_id JOIN social_identities i ON i.org_id=t.org_id AND i.id=t.identity_id JOIN conversations v ON v.org_id=t.org_id AND v.id=t.conversation_id WHERE t.org_id=$1 AND t.message_id=$2',[staff.orgId,messageId])).rows[0];
    if(!r)throw new ApiError(404,'ไม่พบข้อความ');
    if(r.revision!==input.expectedRevision)throw new ApiError(409,'ข้อความผ่านการตรวจไปแล้ว กรุณาโหลดใหม่');
    if(decision==='unsuppress'){
      const s=(await c.query('SELECT message_id FROM whatsapp_triage_suppressions WHERE org_id=$1 AND identity_id=$2',[staff.orgId,r.identity_id])).rows[0];
      if(s?.message_id!==messageId)throw new ApiError(409,'เลือกข้อความต้นทางของการระงับ');
      await c.query('DELETE FROM whatsapp_triage_suppressions WHERE org_id=$1 AND identity_id=$2',[staff.orgId,r.identity_id]);
    }else if(!['pending','held'].includes(r.review_state))throw new ApiError(409,'รายการนี้ดำเนินการเสร็จแล้ว');
    const suppressed=(await c.query('SELECT 1 FROM whatsapp_triage_suppressions WHERE org_id=$1 AND identity_id=$2',[staff.orgId,r.identity_id])).rows.length>0;
    const current=!r.removed_at && !r.opt_out && !suppressed && r.source_version===r.version && r.source_seq===r.customer_message_seq && ['waiting_human','bot_active'].includes(r.status);
    const safeToResume=decision==='release' && current && !['opt_out','unsafe_attachment_or_link'].includes(r.category);
    const state=decision==='release'?'released':decision==='suppress'?'suppressed':'held';
    if(decision==='suppress'){
      await c.query('INSERT OR IGNORE INTO whatsapp_triage_suppressions(org_id,identity_id,message_id) VALUES($1,$2,$3)',[staff.orgId,r.identity_id,messageId]);
    }
    const time=new Date().toISOString();
    await c.query('UPDATE whatsapp_triage SET eligible=$3,review_state=$4,revision=revision+1,reviewed_by=$5,reviewed_at=$6 WHERE org_id=$1 AND message_id=$2',[staff.orgId,messageId,safeToResume,state,staff.id,time]);
    const contract={...r.metadata.rrsSales,category:safeToResume?'legitimate':r.category,action:safeToResume?'ALLOW':'HUMAN_REVIEW',eligible:safeToResume,quotationRequested:safeToResume && quotationRequested(r.content)};
    await c.query('UPDATE social_message_provenance SET metadata=$3 WHERE org_id=$1 AND message_id=$2',[staff.orgId,messageId,JSON.stringify({...r.metadata,rrsSales:contract})]);
    if(safeToResume && !r.eligible) {
      await recordCustomerFacts(c,staff.orgId,r.conversation_id,messageId,r.content);
      if(process.env.FLOWS_ENABLED==='true')await (await import('./flows')).enqueueFlowIngress(c,{orgId:staff.orgId,provider:'whatsapp',accountId:r.account_id,eventId:r.event_id,kind:'message',messageId,conversationId:r.conversation_id,leadId:r.lead_id,fresh:!!r.fresh,optOut:false,text:r.content});
    }
    await audit(c,staff,decision,messageId,{note,policyVersion,category:r.category,resumed:safeToResume&&!r.eligible,sourceVersion:r.source_version,reviewVersion:r.version});
    return {ok:true,resumed:safeToResume&&!r.eligible};
  },staff);
}
