import { randomUUID } from 'node:crypto';
import { database, transaction, camel, demoMode, type Executor, type Row } from './db';
import { ApiError, fields, oneOf, requireAdmin, str, uuid, type Staff } from './auth';

const unreadCount=(staff:Staff)=>staff.role==='Admin'?"MAX(c.customer_message_seq-COALESCE(r.last_read_seq,0),0)":"(SELECT count(*) FROM messages unread_message WHERE unread_message.org_id=c.org_id AND unread_message.conversation_id=c.id AND unread_message.role='user' AND unread_message.source_owner_only=0 AND unread_message.customer_seq>COALESCE(r.last_read_seq,0))";
const visibleMessage=(staff:Staff,alias:string)=>staff.role==='Admin'?'':` AND ${alias}.source_owner_only=0`;
const READ_JOIN='LEFT JOIN conversation_reads r ON r.org_id=c.org_id AND r.conversation_id=c.id AND r.member_id=$2';

async function event(connection:Executor,staff:Staff,action:string,entityId:string,metadata:Row={}) {
  await connection.query('INSERT INTO audit_events(id,org_id,actor_id,action,entity_id,metadata) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),staff.orgId,staff.id,action,entityId,JSON.stringify(metadata)]);
}

export async function inboxSummary(staff:Staff,connection:Executor=database) {
  const UNREAD=unreadCount(staff);
  const result=await connection.query(`SELECT
    count(*) FILTER(WHERE c.status!='resolved') AS "all",
    count(*) FILTER(WHERE c.status!='resolved' AND c.assignee_id=$2) AS mine,
    count(*) FILTER(WHERE c.status!='resolved' AND c.assignee_id IS NULL) AS unassigned,
    count(*) FILTER(WHERE c.status='waiting_human') AS waiting,
    count(*) FILTER(WHERE c.status='resolved') AS closed,
    count(*) FILTER(WHERE c.status!='resolved' AND ${UNREAD}>0) AS unread
    FROM conversations c ${READ_JOIN} WHERE c.org_id=$1`,[staff.orgId,staff.id]);
  return {counts:result.rows[0]};
}

function cursorValue(value:string) {
  if(value.length>400||!/^[A-Za-z0-9_-]+$/.test(value))throw new ApiError(400,'รหัสหน้ารายการไม่ถูกต้อง');
  try {
    const decoded=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));
    if(!decoded||typeof decoded!=='object'||Array.isArray(decoded))throw new Error();
    fields(decoded,['updatedAt','id']);const id=uuid(decoded.id);
    if(typeof decoded.updatedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(decoded.updatedAt)||!Number.isFinite(Date.parse(decoded.updatedAt)))throw new Error();
    // Preserve canonical timestamp precision; converting through Date would skip rows inside one millisecond.
    return {id,updatedAt:decoded.updatedAt};
  } catch {throw new ApiError(400,'รหัสหน้ารายการไม่ถูกต้อง');}
}

export async function inbox(staff:Staff,url:URL) {
  const UNREAD=unreadCount(staff);
  for(const key of url.searchParams.keys())if(!['q','view','status','assignee','tag','cursor','limit','unread'].includes(key))throw new ApiError(400,'ตัวกรองไม่ถูกต้อง');
  const query=str(url.searchParams.get('q'),'คำค้น',200);
  const view=oneOf(url.searchParams.get('view')||'all',['all','mine','unassigned','waiting','closed','unread'],'กล่องข้อความ');
  const rawLimit=url.searchParams.get('limit')||'30';
  if(!/^\d{1,3}$/.test(rawLimit)||Number(rawLimit)<1||Number(rawLimit)>100)throw new ApiError(400,'จำนวนรายการต้องอยู่ระหว่าง 1 ถึง 100');
  const limit=Number(rawLimit);const params:unknown[]=[staff.orgId,staff.id];const where=['c.org_id=$1'];
  const bind=(value:unknown)=>{params.push(value);return `$${params.length}`;};
  where.push(view==='closed'?"c.status='resolved'":"c.status!='resolved'");
  if(view==='mine')where.push('c.assignee_id=$2');
  if(view==='unassigned')where.push('c.assignee_id IS NULL');
  if(view==='waiting')where.push("c.status='waiting_human'");
  if(view==='unread')where.push(`${UNREAD}>0`);
  const unread=url.searchParams.get('unread');
  if(unread!==null&&unread!==''){oneOf(unread,['true','false'],'ตัวกรองยังไม่อ่าน');where.push(`${UNREAD}${unread==='true'?'>0':'=0'}`);}
  const status=url.searchParams.get('status');if(status)where.push(`c.status=${bind(oneOf(status,['bot_active','human_active','waiting_human','resolved'],'สถานะ'))}`);
  const owner=url.searchParams.get('assignee');if(owner)where.push(`c.assignee_id=${bind(uuid(owner,'ผู้รับผิดชอบ'))}`);
  const tag=str(url.searchParams.get('tag'),'แท็ก',40);if(tag)where.push(`EXISTS(SELECT 1 FROM json_each(l.tags) t WHERE lower(t.value)=lower(${bind(tag)}))`);
  if(query) {
    // D1 limits LIKE patterns to 50 bytes, too short for normal Thai names.
    // INSTR keeps search literal (including % and _) without truncation.
    const term=bind(query);
    where.push(`(instr(lower(l.name),lower(${term}))>0 OR instr(lower(l.phone),lower(${term}))>0 OR instr(lower(l.email),lower(${term}))>0 OR EXISTS(SELECT 1 FROM messages search_message WHERE search_message.org_id=c.org_id AND search_message.conversation_id=c.id AND search_message.role IN ('user','assistant','agent')${visibleMessage(staff,'search_message')} AND instr(lower(search_message.content),lower(${term}))>0))`);
  }
  const totalParams=[...params];const totalWhere=where.join(' AND ');
  const cursor=url.searchParams.get('cursor');
  if(cursor){const parsed=cursorValue(cursor);where.push(`(c.updated_at,c.id)<(${bind(parsed.updatedAt)},${bind(parsed.id)})`);}
  const pageLimit=bind(limit+1);
  return transaction(staff.orgId, async connection=>{
    const total=await connection.query(`SELECT count(*) AS total FROM conversations c JOIN leads l ON l.org_id=c.org_id AND l.id=c.lead_id ${READ_JOIN} WHERE ${totalWhere}`,totalParams);
    const result=await connection.query(`SELECT c.id,c.lead_id,c.status,c.version,c.assignee_id,c.created_at,c.updated_at,l.name AS lead_name,l.tags,
      c.updated_at AS cursor_updated_at,
      ${UNREAD} AS unread_count,
      (SELECT m.id FROM messages m WHERE m.org_id=c.org_id AND m.conversation_id=c.id AND m.role='user'${visibleMessage(staff,'m')} ORDER BY m.customer_seq DESC LIMIT 1) AS last_customer_message_id,
      (SELECT m.content FROM messages m WHERE m.org_id=c.org_id AND m.conversation_id=c.id AND m.role IN ('user','assistant','agent')${visibleMessage(staff,'m')} ORDER BY m.created_at DESC,m.id DESC LIMIT 1) AS last_message
      FROM conversations c JOIN leads l ON l.org_id=c.org_id AND l.id=c.lead_id ${READ_JOIN} WHERE ${where.join(' AND ')} ORDER BY c.updated_at DESC,c.id DESC LIMIT ${pageLimit}`,params);
    const pageRows=result.rows.slice(0,limit);const last=pageRows.at(-1);
    const items=pageRows.map(row=>{const item=camel(row);delete item.cursorUpdatedAt;return item;});
    const nextCursor=result.rows.length>limit&&last?Buffer.from(JSON.stringify({updatedAt:last.cursor_updated_at,id:last.id})).toString('base64url'):null;
    return {items,nextCursor,total:total.rows[0].total,...await inboxSummary(staff,connection)};
  }, staff);
}

export async function markConversationRead(staff:Staff,id:string,body:Record<string,unknown>) {
  uuid(id);fields(body,['throughMessageId']);const messageId=uuid(body.throughMessageId);
  await transaction(staff.orgId, async connection=>{
    const message=(await connection.query(`SELECT m.customer_seq FROM messages m WHERE m.org_id=$1 AND m.conversation_id=$2 AND m.id=$3 AND m.role='user'${visibleMessage(staff,'m')}`,[staff.orgId,id,messageId])).rows[0];
    if(!message||!message.customer_seq)throw new ApiError(404,'ไม่พบข้อความลูกค้าในบทสนทนานี้');
    await connection.query("INSERT INTO conversation_reads(org_id,conversation_id,member_id,last_read_seq) VALUES($1,$2,$3,$4)\n      ON CONFLICT(org_id,conversation_id,member_id) DO UPDATE SET last_read_seq=MAX(conversation_reads.last_read_seq,excluded.last_read_seq),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')",[staff.orgId,id,staff.id,message.customer_seq]);
  }, staff);
  return {ok:true};
}

export async function replyTemplates(staff:Staff) {
  const result=await database.query('SELECT id,title,shortcut,content,category,version,updated_at FROM reply_templates WHERE org_id=$1 ORDER BY category,title,id',[staff.orgId]);
  return {templates:result.rows.map(camel)};
}

function version(value:unknown) {if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1)throw new ApiError(400,'กรุณาระบุรุ่นข้อความที่กำลังแก้ไข');return value;}
export async function templateAction(staff:Staff,body:Record<string,unknown>) {
  requireAdmin(staff);fields(body,['action','id','values']);
  const action=oneOf(body.action,['saveReplyTemplate','deleteReplyTemplate'],'คำสั่ง');
  if(!body.values||typeof body.values!=='object'||Array.isArray(body.values))throw new ApiError(400,'ค่าข้อมูลไม่ถูกต้อง');
  const values=body.values as Record<string,unknown>;
  fields(values,action==='deleteReplyTemplate'?['version']:['title','shortcut','content','category','version']);
  await transaction(staff.orgId, async connection=>{
    // The organization revision serializes uniqueness checks and the template limit.
    await connection.query("SELECT id FROM organizations WHERE id=$1",[staff.orgId]);
    const id=body.id?uuid(body.id):randomUUID();
    if(action==='deleteReplyTemplate'&&!body.id)throw new ApiError(400,'กรุณาระบุข้อความที่ต้องการลบ');
    let existing:Row|undefined;
    if(body.id) {
      existing=(await connection.query("SELECT * FROM reply_templates WHERE org_id=$1 AND id=$2",[staff.orgId,id])).rows[0];
      if(!existing)throw new ApiError(404,'ไม่พบข้อความตอบสำเร็จรูป');
      if(existing.version!==version(values.version))throw new ApiError(409,'ข้อความนี้ถูกแก้ไขแล้ว กรุณาโหลดรายการใหม่');
    }
    if(action==='deleteReplyTemplate')await connection.query('DELETE FROM reply_templates WHERE org_id=$1 AND id=$2',[staff.orgId,id]);
    else {
      const title=str(values.title,'ชื่อข้อความ',120,true);const content=str(values.content,'เนื้อหา',4000,true);const category=str(values.category,'หมวดหมู่',80)||'ทั่วไป';
      const rawShortcut=str(values.shortcut,'คำย่อ',41,true).replace(/^\//,'').toLowerCase();
      if(!/^[a-z0-9_-]{1,40}$/.test(rawShortcut))throw new ApiError(400,'คำย่อใช้ตัวอักษรอังกฤษ ตัวเลข - หรือ _ ไม่เกิน 40 ตัว');
      const shortcut=`/${rawShortcut}`;
      if((await connection.query('SELECT id FROM reply_templates WHERE org_id=$1 AND shortcut=$2 AND id!=$3',[staff.orgId,shortcut,id])).rows.length)throw new ApiError(409,'คำย่อนี้มีอยู่แล้วในองค์กร');
      if(existing)await connection.query("UPDATE reply_templates SET title=$3,shortcut=$4,content=$5,category=$6,version=version+1,updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') WHERE org_id=$1 AND id=$2",[staff.orgId,id,title,shortcut,content,category]);
      else {
        const count=(await connection.query("SELECT count(*) AS total FROM reply_templates WHERE org_id=$1",[staff.orgId])).rows[0].total;
        if(count>=200)throw new ApiError(400,'รองรับข้อความตอบสำเร็จรูปสูงสุด 200 รายการต่อองค์กร');
        await connection.query('INSERT INTO reply_templates(id,org_id,title,shortcut,content,category) VALUES($1,$2,$3,$4,$5,$6)',[id,staff.orgId,title,shortcut,content,category]);
      }
    }
    await event(connection,staff,action,id,{previousVersion:existing?.version??null,nextVersion:action==='deleteReplyTemplate'?null:(existing?.version??0)+1});
  }, staff);
  return {ok:true};
}

export type WidgetConfig={enabled:boolean;title:string;greeting:string;accentColor:string;position:'left'|'right';allowedOrigins:string[]};
const DEFAULT_WIDGET:WidgetConfig={enabled:true,title:'คุยกับ RRS',greeting:'สวัสดีค่ะ ฉันเป็นผู้ช่วย AI ของ RRS สนใจสอบถามเรื่องไหนคะ',accentColor:'#0f766e',position:'right',allowedOrigins:[]};
function validateWidgetConfig(raw:unknown):WidgetConfig {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new ApiError(400,'ตั้งค่าวิดเจ็ตไม่ถูกต้อง');
  const input=raw as Record<string,unknown>;fields(input,['enabled','title','greeting','accentColor','position','allowedOrigins']);
  if(typeof input.enabled!=='boolean')throw new ApiError(400,'สถานะวิดเจ็ตไม่ถูกต้อง');
  const title=str(input.title,'ชื่อหน้าต่างแชต',80,true);const greeting=str(input.greeting,'ข้อความต้อนรับ',400,true);
  const accentColor=str(input.accentColor,'สี',7,true);if(!/^#[0-9a-f]{6}$/i.test(accentColor))throw new ApiError(400,'สีต้องอยู่ในรูปแบบ #RRGGBB');
  const position=oneOf(input.position,['left','right'],'ตำแหน่ง') as 'left'|'right';
  if(!Array.isArray(input.allowedOrigins)||input.allowedOrigins.length>10)throw new ApiError(400,'ระบุเว็บไซต์ที่อนุญาตได้สูงสุด 10 แห่ง');
  const allowedOrigins=[...new Set(input.allowedOrigins.map(value=>{
    const origin=str(value,'เว็บไซต์',300,true);let parsed:URL;
    try {parsed=new URL(origin);}catch {throw new ApiError(400,'เว็บไซต์ที่อนุญาตไม่ถูกต้อง');}
    const local=['localhost','127.0.0.1','[::1]'].includes(parsed.hostname);
    const permitLocal=local&&(demoMode()||process.env.NODE_ENV!=='production');
    if(parsed.username||parsed.password||parsed.search||parsed.hash||parsed.pathname!=='/'||origin.includes('*')||/[\r\n]/.test(origin)||(parsed.protocol!=='https:'&&!(parsed.protocol==='http:'&&permitLocal)))throw new ApiError(400,'ใช้ต้นทาง HTTPS เช่น https://example.com โดยไม่ใส่ path หรือ wildcard');
    return parsed.origin;
  }))];
  return {enabled:input.enabled,title,greeting,accentColor:accentColor.toLowerCase(),position,allowedOrigins};
}
async function widgetForOrg(orgId:string,connection:Executor=database):Promise<WidgetConfig> {
  const row=(await connection.query('SELECT widget_config FROM organizations WHERE id=$1',[orgId])).rows[0];
  if(!row)throw new ApiError(404,'ไม่พบองค์กร');
  return validateWidgetConfig({...DEFAULT_WIDGET,...row.widget_config});
}
export async function getWidgetEmbedConfig():Promise<WidgetConfig> {
  const row=(await database.query('SELECT id FROM organizations WHERE slug=$1',[process.env.PUBLIC_ORG_SLUG||'rrs'])).rows[0];
  if(!row)throw new ApiError(503,'ยังไม่ได้ตั้งค่าธุรกิจสำหรับเว็บแชต');
  return widgetForOrg(row.id);
}
export async function getPublicWidgetConfig(origin?:string) {
  const config=await getWidgetEmbedConfig();
  if(origin&&origin!==(process.env.APP_ORIGIN||'http://localhost:3000')&&!config.allowedOrigins.includes(origin))throw new ApiError(403,'เว็บไซต์นี้ไม่ได้รับอนุญาตให้ใช้วิดเจ็ต');
  const {allowedOrigins:_,...safe}=config;return safe;
}
export async function adminWidgetConfig(staff:Staff) {requireAdmin(staff);return {config:await widgetForOrg(staff.orgId)};}
export async function saveWidgetConfig(staff:Staff,body:Record<string,unknown>) {
  requireAdmin(staff);fields(body,['config']);const config=validateWidgetConfig(body.config);
  await transaction(staff.orgId, async connection=>{
    await connection.query('UPDATE organizations SET widget_config=$2 WHERE id=$1',[staff.orgId,JSON.stringify(config)]);
    if(!config.enabled)await connection.query("UPDATE conversations AS c SET version=version+1,generating_client_id=NULL,generation_started_at=NULL WHERE c.org_id=$1 AND EXISTS(SELECT 1 FROM visitors v WHERE v.org_id=c.org_id AND v.conversation_id=c.id AND v.context='widget')",[staff.orgId]);
    await event(connection,staff,'widget.updated',staff.orgId,{enabled:config.enabled,allowedOriginCount:config.allowedOrigins.length});
  }, staff);
  return {config};
}
