import { randomUUID } from 'node:crypto';
import { database, transaction, camel, demoMode, getDatabase, type Executor, type Row } from './db';
import { refreshSaleContextIfStale, saleContextForLead } from './sale-context';
import { ApiError, type Staff, type Visitor, fields, str, uuid, oneOf, tags, isoDate, assignee, requireAdmin, hashPassword, hashToken, newToken, rateLimit } from './auth';
import { extractFacts, summarizeFacts, selectKnowledge, generateReply, providerName, type BotInput } from './bot';
import { enqueueSocialReply, dispatchSocialReply } from './social-channels';
import { messageOrder } from './message-order';

const settingsDefaults = {botName:'RRS ผู้ช่วย AI',personality:'สุภาพ กระชับ ถามครั้งละหนึ่งเรื่อง',businessHours:'ทีมงานจะยืนยันเวลาติดต่อกลับ',handoffRule:'ราคา สต็อก ส่วนลด และนัดหมายให้ทีมงานยืนยัน',aiEnabled:true};
const rows = (items: Row[]) => items.map(camel);
const publicMember = (staff: Staff) => ({id:staff.id,name:staff.name,email:staff.email,role:staff.role});
export {publicMember};

async function audit(executor: Executor, orgId: string, actorId: string, action: string, entityId: string, metadata:Row={}) {
  await executor.query('INSERT INTO audit_events(id,org_id,actor_id,action,entity_id,metadata) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),orgId,actorId,action,entityId,JSON.stringify(metadata)]);
}
async function scopedConversation(executor: Executor, orgId: string, id: string, lock=false) {
  const result=await executor.query(`SELECT * FROM conversations WHERE org_id=$1 AND id=$2${lock?"":''}`,[orgId,id]);
  if(!result.rows[0])throw new ApiError(404,'ไม่พบบทสนทนา');return result.rows[0];
}
async function scopedLead(executor: Executor, orgId: string, id: string) {
  const result=await executor.query('SELECT * FROM leads WHERE org_id=$1 AND id=$2',[orgId,id]);
  if(!result.rows[0])throw new ApiError(404,'ไม่พบลูกค้า');return result.rows[0];
}
function conversationView(row: Row) {
  const result=camel(row); delete result.generatingClientId;delete result.generationStartedAt;delete result.orgId;return result;
}
function leadView(row: Row) {const result=camel(row);delete result.orgId;return result;}
function messageView(row: Row) {
  return {id:row.id,role:row.role,content:row.content,status:row.status,createdAt:row.created_at instanceof Date?row.created_at.toISOString():row.created_at,sources:row.sources};
}
async function orgSettings(orgId: string, executor: Executor=database) {
  const result=await executor.query('SELECT settings FROM organizations WHERE id=$1',[orgId]);
  if(!result.rows[0])throw new ApiError(404,'ไม่พบองค์กร');return {...settingsDefaults,...result.rows[0].settings};
}

export async function createVisitor(context:'web'|'widget'='web'): Promise<{token:string;visitor:Visitor}> {
  const org=(await database.query('SELECT id FROM organizations WHERE slug=$1',[process.env.PUBLIC_ORG_SLUG||'rrs'])).rows[0];
  if(!org)throw new ApiError(503,'ยังไม่ได้ตั้งค่าธุรกิจสำหรับเว็บแชต');
  return transaction(org.id, async connection=>{
    const leadId=randomUUID();const conversationId=randomUUID();const token=newToken();
    await connection.query('INSERT INTO leads(id,org_id) VALUES($1,$2)',[leadId,org.id]);
    await connection.query('INSERT INTO conversations(id,org_id,lead_id) VALUES($1,$2,$3)',[conversationId,org.id,leadId]);
    await connection.query("INSERT INTO visitors(token_hash,org_id,conversation_id,expires_at,context) VALUES($1,$2,$3,(strftime('%Y-%m-%dT%H:%M:%f','now','+30 days')||'000Z'),$4)",[hashToken(token),org.id,conversationId,context]);
    await audit(connection,org.id,'visitor','conversation.created',conversationId);
    return {token,visitor:{orgId:org.id,conversationId}};
  });
}

export async function conversationDetail(orgId:string,id:string,internal=false,admin=false) {
  const conversation=await scopedConversation(database,orgId,id);
  const lead=await scopedLead(database,orgId,conversation.lead_id);
  // Staff only: Sale-owned deal context. Visitor responses never include it.
  let saleContext=null;if(internal){const binding=await getDatabase();await refreshSaleContextIfStale(binding,process.env).catch(()=>undefined);saleContext=await saleContextForLead(binding,orgId,lead.id).catch(()=>null);}
  const messages=await database.query(`SELECT m.*,p.provider,p.delivery_status FROM messages m LEFT JOIN social_message_provenance p ON p.org_id=m.org_id AND p.message_id=m.id WHERE m.org_id=$1 AND m.conversation_id=$2 ${internal?'':"AND m.role IN ('user','assistant','agent')"} AND ($3=1 OR (m.source_owner_only=0 AND COALESCE(json_extract(p.metadata,'$.sourceOwnerOnly'),0)!=1)) ORDER BY ${messageOrder('m')}`,[orgId,id,admin?1:0]);
  const attachments=internal?(await database.query("SELECT a.id,a.message_id,a.media_type,a.storage_state,a.metadata FROM social_message_attachments a JOIN messages m ON m.org_id=a.org_id AND m.id=a.message_id WHERE a.org_id=$1 AND m.conversation_id=$2 AND a.removed_at IS NULL",[orgId,id])).rows:[];
  return {conversation:conversationView(conversation),lead:leadView(lead),...(internal?{saleContext}:{}),messages:messages.rows.map(m=>({...messageView(m),...(internal?{provider:m.provider||null,deliveryStatus:m.delivery_status||null,attachments:attachments.filter(a=>{const meta=typeof a.metadata==='string'?JSON.parse(a.metadata):a.metadata||{};return a.message_id===m.id&&(admin||!meta.sourceOwnerOnly&&!meta.sourceScopeUnknown);}).map(a=>{const meta=typeof a.metadata==='string'?JSON.parse(a.metadata):a.metadata||{};return {id:a.id,type:a.media_type,state:a.storage_state,...(typeof meta.name==='string'?{name:meta.name}:{}),...(typeof meta.deliveryStatus==='string'?{deliveryStatus:meta.deliveryStatus}:{}),...(typeof meta.archiveState==='string'?{archiveState:meta.archiveState}:{}),...(admin&&typeof meta.archiveError==='string'?{archiveError:meta.archiveError}:{})};})}:{})}))};
}
export async function visitorDetail(visitor: Visitor) {
  const detail=await conversationDetail(visitor.orgId,visitor.conversationId);
  const lead=detail.lead;
  // CRM notes, tags, staff summary and pipeline state are never part of a visitor response.
  const publicLead={id:lead.id,name:lead.name,phone:lead.phone,email:lead.email,market:lead.market,facts:lead.facts,createdAt:lead.createdAt,updatedAt:lead.updatedAt};
  const conversation=detail.conversation;
  const publicConversation={id:conversation.id,leadId:conversation.leadId,status:conversation.status,version:conversation.version,createdAt:conversation.createdAt,updatedAt:conversation.updatedAt};
  const settings=await orgSettings(visitor.orgId);
  return {...detail,conversation:publicConversation,lead:publicLead,demo:demoMode(),provider:providerName(),settings:{botName:settings.botName,businessHours:settings.businessHours,aiEnabled:settings.aiEnabled}};
}

export async function handoff(visitor:Visitor) {
  await transaction(visitor.orgId, async connection=>{
    const conversation=await scopedConversation(connection,visitor.orgId,visitor.conversationId,true);
    if(conversation.status==='waiting_human'||conversation.status==='human_active')return;
    await connection.query("UPDATE conversations SET status='waiting_human',version=version+1,generating_client_id=NULL,generation_started_at=NULL,handoff_at=COALESCE(handoff_at,(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') WHERE org_id=$1 AND id=$2",[visitor.orgId,visitor.conversationId]);
    await audit(connection,visitor.orgId,'visitor','conversation.handoff',visitor.conversationId);
  });
}

export async function saveContact(visitor:Visitor,body:Record<string,unknown>) {
  fields(body,['name','phone','email','consent']);
  if(body.consent!==true)throw new ApiError(400,'กรุณายินยอมให้ทีมงานบันทึกข้อมูลเพื่อติดต่อกลับ');
  const name=str(body.name,'ชื่อ',120);const phone=str(body.phone,'เบอร์โทร',32).replace(/[\s()-]/g,'');const email=str(body.email,'อีเมล',254).toLowerCase();
  if(!phone&&!email)throw new ApiError(400,'กรุณาระบุเบอร์โทรหรืออีเมลอย่างน้อยหนึ่งช่องทาง');
  if(phone&&!/^\+?[0-9]{7,16}$/.test(phone))throw new ApiError(400,'เบอร์โทรไม่ถูกต้อง');
  if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new ApiError(400,'อีเมลไม่ถูกต้อง');
  await transaction(visitor.orgId, async connection=>{
    const conversation=await scopedConversation(connection,visitor.orgId,visitor.conversationId,true);
    // A visitor remains bound to the same lead; never merge by unverified contact data across browsers.
    await connection.query("UPDATE leads SET name=$3,phone=$4,email=$5,contact_consent_at=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'),contact_consent_version='contact-v1',updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') WHERE org_id=$1 AND id=$2",[visitor.orgId,conversation.lead_id,name,phone,email]);
    await audit(connection,visitor.orgId,'visitor','contact.consent.contact-v1',conversation.lead_id);
  });
  return {ok:true};
}

export async function appointmentPreview(visitor:Visitor,body:Record<string,unknown>) {
  fields(body,['at','notes']);const at=isoDate(body.at,'เวลานัดหมาย');const notes=str(body.notes,'รายละเอียด',1500);
  if(Date.parse(at)<=Date.now()||Date.parse(at)>Date.now()+365*86400000)throw new ApiError(400,'เลือกเวลานัดหมายภายในหนึ่งปีข้างหน้า');
  return transaction(visitor.orgId, async connection=>{
    const conversation=await scopedConversation(connection,visitor.orgId,visitor.conversationId,true);const id=randomUUID();
    await connection.query("UPDATE tasks SET status='cancelled',updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') WHERE org_id=$1 AND visitor_conversation_id=$2 AND status='draft'",[visitor.orgId,visitor.conversationId]);
    await connection.query("INSERT INTO tasks(id,org_id,lead_id,title,due_at,kind,status,notes,visitor_conversation_id) VALUES($1,$2,$3,$4,$5,'appointment','draft',$6,$7)",[id,visitor.orgId,conversation.lead_id,'คำขอนัดหมายจากลูกค้า',at,notes,visitor.conversationId]);
    return {id,at,notes,status:'draft'};
  });
}
export async function appointmentConfirm(visitor:Visitor,body:Record<string,unknown>) {
  fields(body,['id']);const id=uuid(body.id);
  return transaction(visitor.orgId, async connection=>{
    const task=(await connection.query("SELECT * FROM tasks WHERE org_id=$1 AND id=$2 AND visitor_conversation_id=$3",[visitor.orgId,id,visitor.conversationId])).rows[0];
    if(!task)throw new ApiError(404,'ไม่พบคำขอนัดหมาย');
    if(task.status==='pending')return {ok:true,status:'pending'};
    if(task.status!=='draft')throw new ApiError(409,'คำขอนัดหมายนี้ไม่อยู่ในสถานะรอยืนยันรายละเอียด');
    if(new Date(task.due_at).getTime()<=Date.now())throw new ApiError(400,'เวลานัดหมายผ่านไปแล้ว กรุณาเลือกเวลาใหม่');
    await connection.query("UPDATE tasks SET status='pending',confirmed_by_customer_at=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') WHERE org_id=$1 AND id=$2",[visitor.orgId,id]);
    await audit(connection,visitor.orgId,'visitor','appointment.customer_confirmed.pending_staff',id);
    return {ok:true,status:'pending'};
  });
}

export async function conversationAction(staff:Staff,id:string,action:string,body:Record<string,unknown>,bridgeCommand?:{id:string;hash:string}) {
  uuid(id);fields(body,['text']);
  if(!['claim','release','reply','note','resolve','summarize'].includes(action))throw new ApiError(404,'ไม่พบคำสั่ง');
  const queuedCommand=await transaction(staff.orgId, async connection=>{
    if(bridgeCommand){
      const prior=(await connection.query('SELECT payload_hash,actor_id,conversation_id FROM crm_bridge_commands WHERE org_id=$1 AND command_id=$2',[staff.orgId,bridgeCommand.id])).rows[0];
      if(prior){
        if(prior.payload_hash!==bridgeCommand.hash||prior.actor_id!==staff.id||prior.conversation_id!==id)throw new ApiError(409,'รหัสคำสั่งนี้ถูกใช้กับข้อมูลอื่นแล้ว');
        return;
      }
    }
    const conversation=await scopedConversation(connection,staff.orgId,id,true);
    let outboundCommand:string|null=null;
    if(action==='claim') {
      if(conversation.status==='human_active'&&conversation.assignee_id!==staff.id)throw new ApiError(409,'มีเจ้าหน้าที่รับผิดชอบแล้ว กรุณาประสานงานก่อนรับช่วง');
      await connection.query("UPDATE conversations SET status='human_active',assignee_id=$3,version=version+1,generating_client_id=NULL,generation_started_at=NULL,handoff_at=COALESCE(handoff_at,(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') WHERE org_id=$1 AND id=$2",[staff.orgId,id,staff.id]);
      await connection.query("UPDATE leads SET assignee_id=$3,updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') WHERE org_id=$1 AND id=$2",[staff.orgId,conversation.lead_id,staff.id]);
    } else if(action==='release'||action==='resolve') {
      if(conversation.status==='human_active'&&conversation.assignee_id!==staff.id&&staff.role!=='Admin')throw new ApiError(403,'เฉพาะผู้รับผิดชอบหรือผู้ดูแลระบบที่เปลี่ยนสถานะได้');
      await connection.query("UPDATE conversations SET status=$3,version=version+1,generating_client_id=NULL,generation_started_at=NULL,updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') WHERE org_id=$1 AND id=$2",[staff.orgId,id,action==='release'?'bot_active':'resolved']);
    } else if(action==='reply'||action==='note') {
      const text=str(body.text,action==='note'?'บันทึก':'ข้อความ',6000,true);
      if(action==='reply'&&(conversation.status!=='human_active'||conversation.assignee_id!==staff.id))throw new ApiError(409,'กรุณารับช่วงบทสนทนาก่อนตอบลูกค้า');
      const messageId=randomUUID();
      await connection.query('INSERT INTO messages(id,org_id,conversation_id,role,content) VALUES($1,$2,$3,$4,$5)',[messageId,staff.orgId,id,action==='reply'?'agent':'note',text]);
      if(action==='reply')outboundCommand=(await enqueueSocialReply(connection,staff.orgId,id,messageId,text)).commandId;
      await connection.query(`UPDATE conversations SET updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')${action==='reply'?",first_agent_at=COALESCE(first_agent_at,(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'))":''} WHERE org_id=$1 AND id=$2`,[staff.orgId,id]);
    } else if(action==='summarize') {
      const lead=await scopedLead(connection,staff.orgId,conversation.lead_id);
      await connection.query("UPDATE leads SET summary=$3,updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') WHERE org_id=$1 AND id=$2",[staff.orgId,lead.id,JSON.stringify(summarizeFacts(lead.facts))]);
    }
    await audit(connection,staff.orgId,staff.id,`conversation.${action}`,id,{previousStatus:conversation.status,previousAssigneeId:conversation.assignee_id,...(action==='claim'?{nextStatus:'human_active',nextAssigneeId:staff.id}:action==='release'?{nextStatus:'bot_active'}:action==='resolve'?{nextStatus:'resolved'}:{})});
    if(bridgeCommand)await connection.query('INSERT INTO crm_bridge_commands(org_id,command_id,payload_hash,actor_id,conversation_id,result_json) VALUES($1,$2,$3,$4,$5,$6)',[staff.orgId,bridgeCommand.id,bridgeCommand.hash,staff.id,id,JSON.stringify({ok:true,action})]);
    return outboundCommand;
  }, staff);
  if(queuedCommand)await dispatchSocialReply(staff.orgId,queuedCommand).catch(()=>{console.error('[rrs] social_dispatch_deferred');});
  return conversationDetail(staff.orgId,id,true,staff.role==='Admin');
}

export async function adminAction(staff:Staff,body:Record<string,unknown>) {
  fields(body,['action','id','values']);const action=str(body.action,'คำสั่ง',50,true);
  if(!['updateLead','createTask','updateTask','saveKnowledge','deleteKnowledge','updateSettings','createMember','updateMember','revokeMemberSessions'].includes(action))throw new ApiError(400,'ไม่รองรับคำสั่งนี้');
  if(body.values!==undefined&&(!body.values||typeof body.values!=='object'||Array.isArray(body.values)))throw new ApiError(400,'ค่าข้อมูลไม่ถูกต้อง');
  const values=(body.values||{}) as Record<string,unknown>;
  if(['saveKnowledge','deleteKnowledge','updateSettings','createMember','updateMember','revokeMemberSessions'].includes(action))requireAdmin(staff);
  await transaction(staff.orgId, async connection=>{
    let entityId=body.id?uuid(body.id):staff.orgId;let detail='';let metadata:Row={changedFields:Object.keys(values)};
    if(action==='updateLead') {
      fields(values,['name','phone','email','tags','interests','source','market','stage','assigneeId']);
      const old=await scopedLead(connection,staff.orgId,uuid(body.id));const next={...old};
      for(const key of ['name','phone','email','interests'])if(values[key]!==undefined)next[key]=str(values[key],key,key==='interests'?2000:254);
      if(values.source!==undefined)next.source=str(values.source,'แหล่งที่มา',100,true);
      if(values.tags!==undefined)next.tags=tags(values.tags);
      if(values.market!==undefined)next.market=oneOf(values.market,['unknown','domestic','export'],'ตลาด');
      if(values.stage!==undefined){next.stage=oneOf(values.stage,['New','Qualified','Follow-up','Won','Lost'],'สถานะ');detail=` ${old.stage} → ${next.stage}`;}
      if(values.assigneeId!==undefined)next.assignee_id=await assignee(connection,staff.orgId,values.assigneeId);
      metadata={...metadata,previousStage:old.stage,nextStage:next.stage,previousAssigneeId:old.assignee_id,nextAssigneeId:next.assignee_id};
      if(next.phone&&!/^\+?[0-9 ()-]{7,32}$/.test(next.phone))throw new ApiError(400,'เบอร์โทรไม่ถูกต้อง');
      if(next.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.email))throw new ApiError(400,'อีเมลไม่ถูกต้อง');
      await connection.query("UPDATE leads SET name=$3,phone=$4,email=$5,tags=$6,interests=$7,market=$8,stage=$9,assignee_id=$10,source=$11,updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') WHERE org_id=$1 AND id=$2",[staff.orgId,old.id,next.name,next.phone,next.email,JSON.stringify(next.tags),next.interests,next.market,next.stage,next.assignee_id,next.source]);
    } else if(action==='createTask') {
      fields(values,['leadId','title','dueAt','kind','assigneeId','notes']);
      const lead=await scopedLead(connection,staff.orgId,uuid(values.leadId));
      const kind=values.kind===undefined?'followup':oneOf(values.kind,['followup'],'ชนิดงาน');
      entityId=randomUUID();const owner=values.assigneeId===undefined?staff.id:await assignee(connection,staff.orgId,values.assigneeId);
      await connection.query('INSERT INTO tasks(id,org_id,lead_id,title,due_at,kind,assignee_id,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[entityId,staff.orgId,lead.id,str(values.title,'ชื่องาน',200,true),isoDate(values.dueAt,'วันติดตาม'),kind,owner,str(values.notes,'หมายเหตุ',2000)]);
    } else if(action==='updateTask') {
      fields(values,['status','title','dueAt','assigneeId','notes']);entityId=uuid(body.id);
      const old=(await connection.query("SELECT * FROM tasks WHERE org_id=$1 AND id=$2",[staff.orgId,entityId])).rows[0];
      if(!old)throw new ApiError(404,'ไม่พบงาน');const next={...old};
      if(values.status!==undefined) {
        next.status=oneOf(values.status,old.kind==='appointment'?['confirmed','done','cancelled']:['open','done','cancelled'],'สถานะงาน');
        if(next.status==='confirmed'&&(old.status!=='pending'||!old.confirmed_by_customer_at))throw new ApiError(409,'ลูกค้าต้องตรวจสอบและส่งคำขอนัดหมายก่อน');
        if(old.kind==='appointment'&&next.status==='done'&&old.status!=='confirmed')throw new ApiError(409,'ต้องยืนยันนัดหมายก่อนบันทึกว่าเสร็จแล้ว');
      }
      if(values.title!==undefined)next.title=str(values.title,'ชื่องาน',200,true);
      if(values.notes!==undefined)next.notes=str(values.notes,'หมายเหตุ',2000);
      if(values.dueAt!==undefined) {
        if(old.kind==='appointment')throw new ApiError(409,'หากเปลี่ยนเวลานัดหมาย ให้ลูกค้าส่งคำขอและตรวจสอบรายละเอียดใหม่');
        next.due_at=isoDate(values.dueAt,'วันติดตาม');
      }
      if(values.assigneeId!==undefined)next.assignee_id=await assignee(connection,staff.orgId,values.assigneeId);
      metadata={...metadata,previousStatus:old.status,nextStatus:next.status,previousDueAt:old.due_at,nextDueAt:next.due_at,previousAssigneeId:old.assignee_id,nextAssigneeId:next.assignee_id};
      await connection.query("UPDATE tasks SET title=$3,due_at=$4,status=$5,assignee_id=$6,notes=$7,confirmed_by_staff_at=CASE WHEN $5='confirmed' THEN (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') ELSE confirmed_by_staff_at END,updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') WHERE org_id=$1 AND id=$2",[staff.orgId,entityId,next.title,next.due_at,next.status,next.assignee_id,next.notes]);detail=` ${old.status} → ${next.status}`;
    } else if(action==='saveKnowledge') {
      fields(values,['title','content','tags','status','sourceUrl','expiresAt']);
      const title=str(values.title,'หัวข้อ',200,true);const content=str(values.content,'เนื้อหา',30000,true);
      const docTags=values.tags===undefined?[]:tags(values.tags);const status=oneOf(values.status,['draft','published'],'สถานะเอกสาร');
      const sourceUrl=str(values.sourceUrl,'แหล่งข้อมูล',2000);if(sourceUrl){let url:URL;try{url=new URL(sourceUrl);}catch{throw new ApiError(400,'ลิงก์แหล่งข้อมูลไม่ถูกต้อง');}if(!['http:','https:'].includes(url.protocol))throw new ApiError(400,'ลิงก์แหล่งข้อมูลไม่ถูกต้อง');}
      const expiresAt=values.expiresAt?isoDate(values.expiresAt,'วันหมดอายุ'):null;
      if(body.id) {
        if(!(await connection.query('SELECT id FROM knowledge WHERE org_id=$1 AND id=$2',[staff.orgId,entityId])).rows.length)throw new ApiError(404,'ไม่พบเอกสาร');
        await connection.query("UPDATE knowledge SET title=$3,content=$4,tags=$5,status=$6,source_url=$7,expires_at=$8,version=version+1,processing_status='ready',error=NULL,updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') WHERE org_id=$1 AND id=$2",[staff.orgId,entityId,title,content,JSON.stringify(docTags),status,sourceUrl,expiresAt]);
      } else {entityId=randomUUID();await connection.query('INSERT INTO knowledge(id,org_id,title,content,tags,status,source_url,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[entityId,staff.orgId,title,content,JSON.stringify(docTags),status,sourceUrl,expiresAt]);}
    } else if(action==='deleteKnowledge') {
      fields(values,[]);entityId=uuid(body.id);
      if(!(await connection.query('SELECT id FROM knowledge WHERE org_id=$1 AND id=$2',[staff.orgId,entityId])).rows.length)throw new ApiError(404,'ไม่พบเอกสาร');
      await connection.query('DELETE FROM knowledge WHERE org_id=$1 AND id=$2',[staff.orgId,entityId]);
    } else if(action==='updateSettings') {
      fields(values,['botName','personality','businessHours','handoffRule','aiEnabled']);const settings=await orgSettings(staff.orgId,connection);
      for(const key of ['botName','personality','businessHours','handoffRule'])if(values[key]!==undefined)settings[key]=str(values[key],key,key==='botName'?80:1500,true);
      if(values.aiEnabled!==undefined){if(typeof values.aiEnabled!=='boolean')throw new ApiError(400,'สถานะ AI ไม่ถูกต้อง');settings.aiEnabled=values.aiEnabled;}
      await connection.query('UPDATE organizations SET settings=$2 WHERE id=$1',[staff.orgId,JSON.stringify(settings)]);
      if(settings.aiEnabled===false)await connection.query("UPDATE conversations SET version=version+1,generating_client_id=NULL,generation_started_at=NULL WHERE org_id=$1 AND status='bot_active'",[staff.orgId]);
    } else if(action==='createMember') {
      fields(values,['name','email','role','password']);entityId=randomUUID();
      const email=str(values.email,'อีเมล',254,true).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new ApiError(400,'อีเมลไม่ถูกต้อง');
      const password=str(values.password,'รหัสผ่าน',200,true);if(password.length<12)throw new ApiError(400,'รหัสผ่านต้องยาวอย่างน้อย 12 ตัวอักษร');
      const exists=await connection.query('SELECT id FROM members WHERE email=$1',[email]);if(exists.rows.length)throw new ApiError(409,'ไม่สามารถใช้อีเมลนี้ได้');
      await connection.query('INSERT INTO members(id,org_id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5,$6)',[entityId,staff.orgId,str(values.name,'ชื่อ',120,true),email,await hashPassword(password),oneOf(values.role,['Admin','Agent'],'บทบาท')]);
    } else if(action==='updateMember'||action==='revokeMemberSessions') {
      entityId=uuid(body.id);
      fields(values,action==='revokeMemberSessions'?[]:['name','role','active','password']);
      // Serialize administration per organization, including concurrent attempts to remove its final administrator.
      await connection.query("SELECT id FROM organizations WHERE id=$1",[staff.orgId]);
      const old=(await connection.query("SELECT * FROM members WHERE org_id=$1 AND id=$2",[staff.orgId,entityId])).rows[0];
      if(!old)throw new ApiError(404,'ไม่พบสมาชิก');
      if(action==='updateMember') {
        const name=values.name===undefined?old.name:str(values.name,'ชื่อ',120,true);
        const role=values.role===undefined?old.role:oneOf(values.role,['Admin','Agent'],'บทบาท');
        const active=values.active===undefined?old.active:values.active;
        if(typeof active!=='boolean')throw new ApiError(400,'สถานะสมาชิกไม่ถูกต้อง');
        if(old.active&&old.role==='Admin'&&(!active||role!=='Admin')) {
          const count=(await connection.query("SELECT count(*) AS total FROM members WHERE org_id=$1 AND role='Admin' AND active=true",[staff.orgId])).rows[0].total;
          if(count<=1)throw new ApiError(409,'องค์กรต้องมีผู้ดูแลระบบที่ใช้งานได้อย่างน้อยหนึ่งคน');
        }
        let passwordHash=old.password_hash;
        if(values.password!==undefined) {const password=str(values.password,'รหัสผ่าน',200,true);if(password.length<12)throw new ApiError(400,'รหัสผ่านต้องยาวอย่างน้อย 12 ตัวอักษร');passwordHash=await hashPassword(password);}
        await connection.query('UPDATE members SET name=$3,role=$4,active=$5,password_hash=$6 WHERE org_id=$1 AND id=$2',[staff.orgId,entityId,name,role,active,passwordHash]);
        metadata={...metadata,previousRole:old.role,nextRole:role,previousActive:old.active,nextActive:active};
      }
      await connection.query('DELETE FROM staff_sessions WHERE org_id=$1 AND member_id=$2',[staff.orgId,entityId]);
    }
    await audit(connection,staff.orgId,staff.id,action+detail,entityId,metadata);
  }, staff);
  return {ok:true};
}

function dateRange(url:URL) {
  const localNow=new Date(Date.now()+7*3600000);const today=localNow.toISOString().slice(0,10);
  const defaultFrom=new Date(localNow.getTime()-29*86400000).toISOString().slice(0,10);
  const from=url.searchParams.get('from')||defaultFrom;const to=url.searchParams.get('to')||today;
  for(const value of [from,to])if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)!==value)throw new ApiError(400,'รูปแบบช่วงวันที่ไม่ถูกต้อง');
  const start=new Date(`${from}T00:00:00+07:00`);const end=new Date(Date.parse(`${to}T00:00:00+07:00`)+86400000);
  if(start>=end||end.getTime()-start.getTime()>366*86400000)throw new ApiError(400,'เลือกช่วงวันที่ไม่เกินหนึ่งปี');
  return {start:isoDate(start.toISOString(),"วันเริ่มต้น"),end:isoDate(end.toISOString(),"วันสิ้นสุด"),from,to};
}
export async function snapshot(staff:Staff,url:URL) {
  const range=dateRange(url);const p=[staff.orgId,range.start,range.end];
  const results=await Promise.all([
    database.query(`SELECT c.*,l.name AS lead_name,l.tags,(SELECT m.content FROM messages m WHERE m.org_id=c.org_id AND m.conversation_id=c.id AND m.role IN ('user','assistant','agent') AND ($2=1 OR m.source_owner_only=0) ORDER BY ${messageOrder('m',true)} LIMIT 1) AS last_message FROM conversations c JOIN leads l ON l.org_id=c.org_id AND l.id=c.lead_id WHERE c.org_id=$1 ORDER BY c.updated_at DESC LIMIT 1000`,[staff.orgId,staff.role==='Admin'?1:0]),
    database.query('SELECT * FROM leads WHERE org_id=$1 ORDER BY updated_at DESC LIMIT 2000',[staff.orgId]),
    database.query('SELECT * FROM tasks WHERE org_id=$1 ORDER BY due_at LIMIT 2000',[staff.orgId]),
    database.query('SELECT * FROM knowledge WHERE org_id=$1 ORDER BY updated_at DESC',[staff.orgId]),
    database.query('SELECT id,name,email,role,active FROM members WHERE org_id=$1 ORDER BY name',[staff.orgId]),
    database.query('SELECT id,actor_id,action,entity_id,metadata,created_at FROM audit_events WHERE org_id=$1 ORDER BY created_at DESC LIMIT 100',[staff.orgId]),
    database.query("SELECT count(*) AS total,count(*) FILTER(WHERE handoff_at IS NOT NULL) AS handed_off,avg((julianday(first_ai_at)-julianday(first_customer_at))*86400000) FILTER(WHERE first_ai_at IS NOT NULL) AS ai_ms,avg((julianday(first_agent_at)-julianday(handoff_at))*86400000) FILTER(WHERE first_agent_at>=handoff_at) AS human_ms FROM conversations WHERE org_id=$1 AND created_at >= $2 AND created_at < $3",p),
    database.query("SELECT stage,count(*) AS total FROM leads WHERE org_id=$1 AND created_at >= $2 AND created_at < $3 GROUP BY stage",p),
    database.query("SELECT count(*) AS total FROM tasks WHERE org_id=$1 AND status IN ('open','pending','confirmed') AND due_at<=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')",[staff.orgId]),
    database.query("SELECT sum(input_tokens) AS input_tokens,sum(output_tokens) AS output_tokens,sum(estimated_cost_usd) AS cost FROM messages WHERE org_id=$1 AND created_at >= $2 AND created_at < $3",p)
  ]);
  const count=results[6].rows[0];const usage=results[9].rows[0];const stages:Record<string,number>={New:0,Qualified:0,'Follow-up':0,Won:0,Lost:0};
  for(const row of results[7].rows)stages[row.stage]=row.total;
  const nullable=(value:unknown)=>value===null||value===undefined?null:Number(value);
  const visibleAudit=results[5].rows.filter(row=>staff.role==='Admin'||!/^whatsapp_consent\.|^social_channel\./.test(String(row.action)));
  return {user:publicMember(staff),conversations:results[0].rows.map(conversationView),leads:results[1].rows.map(leadView),tasks:rows(results[2].rows),knowledge:rows(results[3].rows),members:rows(results[4].rows),settings:await orgSettings(staff.orgId),audit:rows(visibleAudit),integrations:{sheets:'not_connected',drive:'not_connected',channels:'see_channel_settings'},
    metrics:{conversations:count.total,newLeads:Object.values(stages).reduce((a,b)=>a+b,0),stages,dueTasks:results[8].rows[0].total,handoffRate:count.total?count.handed_off/count.total:0,aiFirstResponseMs:nullable(count.ai_ms),humanFirstResponseMs:nullable(count.human_ms),inputTokens:nullable(usage.input_tokens),outputTokens:nullable(usage.output_tokens),estimatedCostUsd:nullable(usage.cost),timezone:'Asia/Bangkok'},range:{from:range.from,to:range.to},
    metricDefinitions:{cohort:'บทสนทนาและลีดที่สร้างในช่วงวันที่กรุงเทพฯ; Pipeline แสดงสถานะปัจจุบันของกลุ่มนี้',handoff:'บทสนทนาในช่วงวันที่ที่เคยส่งต่ออย่างน้อยหนึ่งครั้ง / บทสนทนาทั้งหมดในช่วงวันที่',aiFirstResponse:'เวลาจากข้อความลูกค้าแรกถึงส่วนข้อความ AI แรกที่ส่งได้',humanFirstResponse:'เวลาจากส่งต่อครั้งแรกถึงคำตอบสาธารณะแรกของพนักงาน; ไม่รวมบันทึกภายใน',dueTasks:'งานที่ยังเปิด รอยืนยัน หรือยืนยันแล้ว และถึงกำหนด ณ เวลาปัจจุบัน ทุกช่วงวันที่',usage:'ผลรวม usage ที่ผู้ให้บริการรายงานสำหรับข้อความในช่วงวันที่; null หมายถึงไม่มีข้อมูล'}};
}

type Prepared = {conversationId:string;orgId:string;clientId:string;version:number;input:BotInput;sources:Row[];skip?:boolean};
async function prepareMessage(visitor:Visitor,body:Record<string,unknown>):Promise<Prepared> {
  fields(body,['text','clientId','retry']);const text=str(body.text,'ข้อความ',4000,true);const clientId=str(body.clientId,'รหัสข้อความ',100,true);
  if(!/^[a-zA-Z0-9_-]{8,100}$/.test(clientId))throw new ApiError(400,'รหัสข้อความไม่ถูกต้อง');
  if(body.retry!==undefined&&typeof body.retry!=='boolean')throw new ApiError(400,'สถานะลองใหม่ไม่ถูกต้อง');
  await rateLimit(`chat:${visitor.orgId}:${visitor.conversationId}`,30,60);
  return transaction(visitor.orgId, async connection=>{
    const c=await scopedConversation(connection,visitor.orgId,visitor.conversationId,true);
    const lead=await scopedLead(connection,visitor.orgId,c.lead_id);const settings=await orgSettings(visitor.orgId,connection);
    const existing=(await connection.query("SELECT * FROM messages WHERE org_id=$1 AND conversation_id=$2 AND client_id=$3 AND role='user'",[visitor.orgId,c.id,clientId])).rows[0];
    if(existing&&existing.content!==text)throw new ApiError(409,'รหัสข้อความนี้ใช้กับข้อความอื่นแล้ว');
    const recent=c.generation_started_at&&new Date(c.generation_started_at).getTime()>Date.now()-120000;
    if(c.generating_client_id&&recent) {
      if(c.generating_client_id===clientId&&existing&&!body.retry)return {conversationId:c.id,orgId:visitor.orgId,clientId,version:c.version,input:{history:[],facts:{},knowledge:[],settings},sources:[],skip:true};
      throw new ApiError(409,'กำลังตอบข้อความก่อนหน้า กรุณารอสักครู่');
    }
    if(existing) {
      const reply=await connection.query("SELECT id FROM messages WHERE org_id=$1 AND conversation_id=$2 AND reply_to_client_id=$3 AND role='assistant' AND status='complete'",[visitor.orgId,c.id,clientId]);
      if(reply.rows.length||!body.retry||existing.status==='complete')return {conversationId:c.id,orgId:visitor.orgId,clientId,version:c.version,input:{history:[],facts:{},knowledge:[],settings},sources:[],skip:true};
      if(existing.status!=='failed'&&existing.status!=='interrupted'&&existing.status!=='generating')throw new ApiError(409,'ข้อความนี้ไม่จำเป็นต้องลองใหม่');
    } else {
      if(c.status==='resolved') {
        // A new customer message reopens the team's queue; it never silently resumes the bot.
        await connection.query("UPDATE conversations SET status='waiting_human',version=version+1,handoff_at=COALESCE(handoff_at,(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')),generating_client_id=NULL,generation_started_at=NULL WHERE org_id=$1 AND id=$2",[visitor.orgId,c.id]);
        c.status='waiting_human';c.version=Number(c.version)+1;
        await audit(connection,visitor.orgId,'visitor','conversation.reopened_by_customer',c.id);
      }
      const seq=Number(c.customer_message_seq)+1;
      await connection.query('UPDATE conversations SET customer_message_seq=$3 WHERE org_id=$1 AND id=$2',[visitor.orgId,c.id,seq]);
      await connection.query("INSERT INTO messages(id,org_id,conversation_id,role,content,client_id,status,customer_seq) VALUES($1,$2,$3,'user',$4,$5,'complete',$6)",[randomUUID(),visitor.orgId,c.id,text,clientId,seq]);
      const facts=extractFacts(text,lead.facts||{});
      // Contact fields are saved only through the explicit consent endpoint; fact extraction is requirement memory.
      for(const key of Object.keys(facts))if(/phone|email|name|โทร|อีเมล|ชื่อ/i.test(key))delete facts[key];
      const market=facts.market==='domestic'||facts.market==='export'?facts.market:lead.market;
      await connection.query("UPDATE leads SET facts=$3,market=$4,interests=$5,updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') WHERE org_id=$1 AND id=$2",[visitor.orgId,lead.id,JSON.stringify(facts),market,facts.product||lead.interests]);
      lead.facts=facts;
    }
    await connection.query("UPDATE conversations SET first_customer_at=COALESCE(first_customer_at,(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') WHERE org_id=$1 AND id=$2",[visitor.orgId,c.id]);
    if(c.status==='bot_active' && providerName()==='disabled') {
      await connection.query("UPDATE conversations SET status='waiting_human',version=version+1,handoff_at=COALESCE(handoff_at,(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')),generating_client_id=NULL,generation_started_at=NULL WHERE org_id=$1 AND id=$2",[visitor.orgId,c.id]);
      await audit(connection,visitor.orgId,'system','ai.disabled.handoff',c.id);
      c.status='waiting_human';c.version=Number(c.version)+1;
    }
    if(c.status!=='bot_active'||!settings.aiEnabled)return {conversationId:c.id,orgId:visitor.orgId,clientId,version:c.version,input:{history:[],facts:{},knowledge:[],settings},sources:[],skip:true};
    const cap=Math.max(1,Math.min(10000,Number.parseInt(process.env.AI_DAILY_CALL_LIMIT||'500',10)||500));
    const day=new Date(Date.now()+7*3600000).toISOString().slice(0,10);
    const usage=(await connection.query('SELECT calls FROM ai_daily_usage WHERE org_id=$1 AND day=$2',[visitor.orgId,day])).rows[0];
    if(Number(usage?.calls||0)>=cap) {
      await connection.query("UPDATE conversations SET status='waiting_human',version=version+1,handoff_at=COALESCE(handoff_at,(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') WHERE org_id=$1 AND id=$2",[visitor.orgId,c.id]);
      await audit(connection,visitor.orgId,'system','ai.daily_cap.handoff',c.id);
      return {conversationId:c.id,orgId:visitor.orgId,clientId,version:c.version+1,input:{history:[],facts:{},knowledge:[],settings},sources:[],skip:true};
    }
    await connection.query('INSERT INTO ai_daily_usage(org_id,day,calls) VALUES($1,$2,1) ON CONFLICT(org_id,day) DO UPDATE SET calls=ai_daily_usage.calls+1',[visitor.orgId,day]);
    const version=c.version+1;
    await connection.query("UPDATE conversations SET version=$3,generating_client_id=$4,generation_started_at=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') WHERE org_id=$1 AND id=$2",[visitor.orgId,c.id,version,clientId]);
    await connection.query("UPDATE messages SET status='generating',generation_version=$4 WHERE org_id=$1 AND conversation_id=$2 AND client_id=$3",[visitor.orgId,c.id,clientId,version]);
    const history=await connection.query(`SELECT role,content FROM messages WHERE org_id=$1 AND conversation_id=$2 AND role IN ('user','assistant','agent') AND (role='user' OR status='complete') ORDER BY ${messageOrder('',true)} LIMIT 30`,[visitor.orgId,c.id]);
    const knowledge=await connection.query("SELECT id,title,content,tags,version,source_url FROM knowledge WHERE org_id=$1 AND status='published' AND processing_status='ready' AND (expires_at IS NULL OR expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'))",[visitor.orgId]);
    const selected=selectKnowledge(text,rows(knowledge.rows) as BotInput['knowledge']);
    const messages=history.rows.reverse().map(row=>({role:row.role,content:row.content}));
    if(!existing)messages.push({role:'user',content:text});
    return {conversationId:c.id,orgId:visitor.orgId,clientId,version,input:{history:messages.slice(-30),facts:lead.facts,knowledge:selected,settings},sources:selected.map(source=>({id:source.id,title:source.title,version:source.version,content:source.content}))};
  });
}

export async function messageStream(visitor:Visitor,body:Record<string,unknown>,signal:AbortSignal):Promise<Response> {
  const prepared=await prepareMessage(visitor,body);const encoder=new TextEncoder();
  const stream=new ReadableStream({async start(controller) {
    let text='';let closed=false;let first=true;let usage:{inputTokens:number;outputTokens:number;estimatedCostUsd:number|null}|undefined;
    const abort=new AbortController();signal.addEventListener('abort',()=>abort.abort(),{once:true});
    const emit=(event:Row)=>{if(!closed){try{controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));}catch{closed=true;abort.abort();}}};
    const active=async()=>{
      const result=await database.query("SELECT id FROM conversations WHERE org_id=$1 AND id=$2 AND status='bot_active' AND version=$3 AND generating_client_id=$4",[prepared.orgId,prepared.conversationId,prepared.version,prepared.clientId]);return result.rows.length>0;
    };
    const finish=async(status:'complete'|'failed'|'interrupted')=>transaction(prepared.orgId, async connection=>{
      const c=await scopedConversation(connection,prepared.orgId,prepared.conversationId,true);
      const current=c.status==='bot_active'&&c.version===prepared.version&&c.generating_client_id===prepared.clientId;
      const actual=status==='complete'&&!current?'interrupted':status;
      if(text)await connection.query("INSERT INTO messages(id,org_id,conversation_id,role,content,status,reply_to_client_id,generation_version,sources,input_tokens,output_tokens,estimated_cost_usd) VALUES($1,$2,$3,'assistant',$4,$5,$6,$7,$8,$9,$10,$11)",[randomUUID(),prepared.orgId,prepared.conversationId,text,actual,prepared.clientId,prepared.version,JSON.stringify(prepared.sources),usage?.inputTokens??null,usage?.outputTokens??null,usage?.estimatedCostUsd??null]);
      await connection.query('UPDATE messages SET status=$4 WHERE org_id=$1 AND conversation_id=$2 AND client_id=$3 AND generation_version=$5',[prepared.orgId,prepared.conversationId,prepared.clientId,actual,prepared.version]);
      if(current)await connection.query("UPDATE conversations SET generating_client_id=NULL,generation_started_at=NULL,updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') WHERE org_id=$1 AND id=$2 AND version=$3",[prepared.orgId,prepared.conversationId,prepared.version]);
      return actual;
    });
    emit({type:'meta',version:prepared.version});
    if(prepared.skip){emit({type:'done'});controller.close();return;}
    try {
      for await(const chunk of generateReply({...prepared.input,signal:abort.signal})) {
        if(signal.aborted||abort.signal.aborted||!await active()){abort.abort();await finish('interrupted');emit({type:'cancelled'});return;}
        if(chunk.usage)usage=chunk.usage;
        if(chunk.text) {
          // Recheck the generation before delivery. Never enqueue inside a retryable plan.
          const accepted=await transaction(prepared.orgId, async connection=>{
            const result=await connection.query("SELECT id FROM conversations WHERE org_id=$1 AND id=$2 AND version=$3 AND generating_client_id=$4 AND status='bot_active'",[prepared.orgId,prepared.conversationId,prepared.version,prepared.clientId]);
            if(!result.rows.length)return false;
            if(first)await connection.query("UPDATE conversations SET first_ai_at=COALESCE(first_ai_at,(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')) WHERE org_id=$1 AND id=$2",[prepared.orgId,prepared.conversationId]);
            return true;
          });
          if(!accepted){abort.abort();await finish('interrupted');emit({type:'cancelled'});return;}
          first=false;text+=chunk.text;emit({type:'token',text:chunk.text,version:prepared.version});
        }
      }
      if(!text.trim())throw new Error('Empty provider response');
      const status=await finish('complete');emit({type:status==='complete'?'done':'cancelled'});
    } catch {
      const interrupted=signal.aborted||abort.signal.aborted||!await active().catch(()=>false);
      await finish(interrupted?'interrupted':'failed').catch(()=>{});
      if(interrupted)emit({type:'cancelled'});else emit({type:'error',error:'ตอบกลับไม่สำเร็จ กรุณาลองใหม่ หรือขอคุยกับเจ้าหน้าที่'});
      console.error('[rrs] generation_failed', {conversationId:prepared.conversationId,provider:providerName()});
    } finally {closed=true;try{controller.close();}catch{}}
  },cancel(){/* The next chunk observes the request abort / closed stream. */}});
  return new Response(stream,{headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-store','Connection':'keep-alive','X-Accel-Buffering':'no'}});
}
