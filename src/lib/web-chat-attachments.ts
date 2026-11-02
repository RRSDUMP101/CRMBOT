import {createHash,randomUUID} from 'node:crypto';
import {ApiError,cookieValue,hashToken,isWidgetRequest,STAFF_COOKIE,staffSession,str,uuid,visitorCookieName,visitorSession,type Staff} from './auth';
import {database,transaction,type Executor,type Row} from './db';
import {getPrivateBucket,type PrivateBucket} from './files';
import {mediaContainer} from './reviewed-sale-media';
import {widgetForOrg} from './helpdesk';
import {routeWaitingConversation} from './operators';

const MAX=5*1024*1024,formats=['application/pdf','image/jpeg','image/png'];
const now=()=>new Date().toISOString().replace(/(\.\d{3})Z$/,(_,fraction)=>fraction+'000Z');
const later=(ms:number)=>new Date(Date.now()+ms).toISOString().replace(/(\.\d{3})Z$/,(_,fraction)=>fraction+'000Z');
const sha=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
export const webAttachmentsEnabled=()=>process.env.WEB_CHAT_ATTACHMENTS_ENABLED==='true';
type Base={orgId:string;conversationId:string;sessionHash:string};
export type WebAttachmentActor=Base&({kind:'visitor';context:'widget'|'web'}|{kind:'staff';staff:Staff});
const actorKey=(a:WebAttachmentActor)=>a.kind==='staff'?'staff:'+a.staff.id:'visitor:'+a.sessionHash;
export async function webAttachmentActor(request:Request,conversationId?:string):Promise<WebAttachmentActor>{
 if(conversationId){const staff=(await staffSession(request))!;return {kind:'staff',staff,orgId:staff.orgId,conversationId:uuid(conversationId),sessionHash:hashToken(cookieValue(request,STAFF_COOKIE))};}
 const visitor=(await visitorSession(request))!;return {...visitor,kind:'visitor',context:isWidgetRequest(request)?'widget':'web',sessionHash:hashToken(cookieValue(request,visitorCookieName(request)))};
}
async function authorize(c:Executor,actor:WebAttachmentActor,write=false,version?:number,customerSeq?:number){
 if(actor.kind==='visitor'){
  if(!(await c.query('SELECT 1 FROM visitors WHERE token_hash=$1 AND org_id=$2 AND conversation_id=$3 AND context=$4 AND expires_at>$5',[actor.sessionHash,actor.orgId,actor.conversationId,actor.context,now()])).rows.length)throw new ApiError(401,'กรุณาเริ่มบทสนทนาใหม่');
  if(actor.context==='widget'){const config=await widgetForOrg(actor.orgId,c);if(!config.enabled)throw new ApiError(403,'วิดเจ็ตแชตปิดอยู่');if(write&&config.prechatRequired&&!(await c.query('SELECT 1 FROM conversations c JOIN leads l ON l.org_id=c.org_id AND l.id=c.lead_id WHERE c.org_id=$1 AND c.id=$2 AND l.contact_consent_at IS NOT NULL',[actor.orgId,actor.conversationId])).rows.length)throw new ApiError(422,'กรุณาฝากข้อมูลติดต่อและยินยอมก่อนแนบไฟล์');}
 }else if(!(await c.query('SELECT 1 FROM staff_sessions s JOIN members m ON m.org_id=s.org_id AND m.id=s.member_id WHERE s.token_hash=$1 AND s.org_id=$2 AND s.member_id=$3 AND s.expires_at>$4 AND m.active=1 AND m.role=$5',[actor.sessionHash,actor.orgId,actor.staff.id,now(),actor.staff.role])).rows.length)throw new ApiError(401,'กรุณาเข้าสู่ระบบใหม่');
 const chat=(await c.query('SELECT * FROM conversations WHERE org_id=$1 AND id=$2',[actor.orgId,actor.conversationId])).rows[0];if(!chat)throw new ApiError(404,'ไม่พบบทสนทนา');
 if(!(await c.query('SELECT 1 FROM visitors WHERE org_id=$1 AND conversation_id=$2 LIMIT 1',[actor.orgId,actor.conversationId])).rows.length||(await c.query('SELECT 1 FROM social_identities WHERE org_id=$1 AND conversation_id=$2 UNION ALL SELECT 1 FROM external_threads WHERE org_id=$1 AND conversation_id=$2 LIMIT 1',[actor.orgId,actor.conversationId])).rows.length)throw new ApiError(422,'ไฟล์นี้รองรับเฉพาะแชตเว็บไซต์');
 if(write&&!webAttachmentsEnabled())throw new ApiError(503,'การแนบไฟล์แชตยังปิดอยู่');
 if(write&&actor.kind==='staff'&&(chat.status!=='human_active'||chat.assignee_id!==actor.staff.id||Number(chat.version)!==version||customerSeq!==undefined&&Number(chat.customer_message_seq)!==customerSeq))throw new ApiError(409,'บทสนทนาเปลี่ยนแล้ว กรุณารับช่วงและตรวจข้อความล่าสุดก่อนส่งไฟล์');
 return chat;
}
const publicFile=(row:Row)=>({id:String(row.id),name:String(row.filename),mime:String(row.content_type),size:Number(row.size_bytes),state:row.state==='ready'?'ready':'expired',expiresAt:row.state==='ready'?null:row.expires_at,messageId:row.message_id});
export async function webAttachmentCapabilities(actor:WebAttachmentActor){
 try{await authorize(database,actor);return {enabled:webAttachmentsEnabled(),supported:true,maxBytes:MAX,accept:formats};}catch(error){if(error instanceof ApiError&&error.status===422)return {enabled:webAttachmentsEnabled(),supported:false,maxBytes:MAX,accept:formats};throw error;}
}
async function bounded(body:ReadableStream<Uint8Array>|null,limit:number){
 const reader=body?.getReader();if(!reader)throw new ApiError(400,'ไม่มีไฟล์');let size=0;const chunks:Uint8Array[]=[];
 try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>limit){await reader.cancel();throw new ApiError(413,'ไฟล์ต้องไม่เกิน 5 MB');}chunks.push(part.value);}}finally{reader.releaseLock();}return Buffer.concat(chunks,size);
}
/** Published files remain private evidence. Only expired unpublished reservations are removed. */
export async function sweepWebAttachments(orgId:string,storage?:PrivateBucket){
 const bucket=storage||await getPrivateBucket();if(!bucket.delete)return {removed:0};
 const rows=await transaction(orgId,async c=>{const found=(await c.query("SELECT id,object_key FROM web_chat_attachments WHERE org_id=$1 AND state IN ('pending','deleting') AND message_id IS NULL AND expires_at<=$2 ORDER BY expires_at,id LIMIT 10",[orgId,now()])).rows;for(const r of found)await c.query("UPDATE web_chat_attachments SET state='deleting' WHERE org_id=$1 AND id=$2 AND message_id IS NULL",[orgId,r.id]);return found;});
 let removed=0;for(const row of rows){if(row.object_key!==orgId+'/' +row.id)continue;try{await bucket.delete(row.object_key);await transaction(orgId,c=>c.query("UPDATE web_chat_attachments SET state='expired' WHERE org_id=$1 AND id=$2 AND state='deleting'",[orgId,row.id]));removed++;}catch{console.warn('Web attachment cleanup deferred');}}return {removed};
}
async function finishWebRouting(orgId:string,id:string){
 const row=(await database.query("SELECT conversation_id,message_id FROM web_chat_attachments WHERE org_id=$1 AND id=$2 AND state='ready' AND routing_pending=1",[orgId,id])).rows[0];if(!row)return false;
 const eventId='web:'+row.message_id,ingress=(await database.query('SELECT status FROM flow_ingress WHERE org_id=$1 AND event_id=$2',[orgId,eventId])).rows[0];
 if(ingress&&ingress.status!=='processed'){
  await (await import('./flows')).drainFlowIngress(orgId,{},eventId);
  if((await database.query('SELECT status FROM flow_ingress WHERE org_id=$1 AND event_id=$2',[orgId,eventId])).rows[0]?.status!=='processed')return false;
 }
 await routeWaitingConversation(orgId,row.conversation_id);
 await transaction(orgId,c=>c.query("UPDATE web_chat_attachments SET routing_pending=0 WHERE org_id=$1 AND id=$2 AND state='ready'",[orgId,id]));return true;
}
/** Cron also recovers the post-commit Flow→basic-routing handoff after a lost response. */
export async function maintainWebAttachments(orgId:string,storage:PrivateBucket){
 const cleanup=await sweepWebAttachments(orgId,storage),rows=(await database.query("SELECT id FROM web_chat_attachments WHERE org_id=$1 AND state='ready' AND routing_pending=1 ORDER BY created_at,id LIMIT 10",[orgId])).rows;let routed=0;
 for(const row of rows)try{if(await finishWebRouting(orgId,row.id))routed++;}catch{console.warn('Web attachment routing deferred');}
 return {status:'ok' as const,...cleanup,routed};
}
export async function uploadWebAttachment(actor:WebAttachmentActor,request:Request,options:{storage?:PrivateBucket}={}){
 const clientId=uuid(request.headers.get('x-client-id'),'รหัสคำขอ'),raw=request.headers.get('x-conversation-version')||'',version=/^[1-9]\d{0,9}$/.test(raw)?Number(raw):undefined;
 // A retry of an already committed upload remains readable after a benign chat state change.
 await authorize(database,actor);if(!webAttachmentsEnabled())throw new ApiError(503,'การแนบไฟล์แชตยังปิดอยู่');
 const mime=request.headers.get('content-type')||'';if(!formats.includes(mime))throw new ApiError(415,'รองรับ PDF, JPEG และ PNG เท่านั้น');
 let name:string;try{name=decodeURIComponent(request.headers.get('x-file-name')||'');}catch{throw new ApiError(400,'ชื่อไฟล์ไม่ถูกต้อง');}name=str(name,'ชื่อไฟล์',180,true);if(/[\x00-\x1f\x7f/\\]/.test(name))throw new ApiError(400,'ชื่อไฟล์ไม่ถูกต้อง');
 if(Number(request.headers.get('content-length')||0)>MAX)throw new ApiError(413,'ไฟล์ต้องไม่เกิน 5 MB');const bytes=await bounded(request.body,MAX);if(!bytes.length)throw new ApiError(400,'ไฟล์ว่าง');mediaContainer(bytes,mime);const digest=sha(bytes),key=actorKey(actor);
 const bucket=options.storage||await getPrivateBucket();await sweepWebAttachments(actor.orgId,bucket);
 const reservation=await transaction(actor.orgId,async c=>{
  await authorize(c,actor);
  const old=(await c.query('SELECT * FROM web_chat_attachments WHERE org_id=$1 AND conversation_id=$2 AND actor_key=$3 AND client_id=$4',[actor.orgId,actor.conversationId,key,clientId])).rows[0];
  if(old){if(old.filename!==name||old.content_type!==mime||Number(old.size_bytes)!==bytes.length||old.sha256!==digest)throw new ApiError(409,'รหัสคำขอนี้ใช้กับไฟล์อื่นแล้ว');if(old.state==='ready')return old;if(old.state!=='pending'||old.expires_at<=now())throw new ApiError(409,'การอัปโหลดหมดอายุ กรุณาเลือกไฟล์ใหม่');await authorize(c,actor,true,Number(old.conversation_version),Number(old.customer_seq));return old;}
  const chat=await authorize(c,actor,true,version),used=Number((await c.query("SELECT COALESCE(sum(size_bytes),0) AS n FROM web_chat_attachments WHERE org_id=$1 AND state<>'expired'",[actor.orgId])).rows[0].n),conversationUsed=Number((await c.query("SELECT COALESCE(sum(size_bytes),0) AS n FROM web_chat_attachments WHERE org_id=$1 AND conversation_id=$2 AND state<>'expired'",[actor.orgId,actor.conversationId])).rows[0].n);
  const quota=Number(process.env.WEB_CHAT_FILE_STORAGE_LIMIT_BYTES||100*1024*1024);if(used+bytes.length>(Number.isSafeInteger(quota)&&quota>0?quota:100*1024*1024)||conversationUsed+bytes.length>20*1024*1024)throw new ApiError(409,'พื้นที่ไฟล์แชตถึงขีดจำกัด');
  const id=randomUUID(),row={id,org_id:actor.orgId,conversation_id:actor.conversationId,actor_kind:actor.kind,actor_key:key,client_id:clientId,uploaded_by:actor.kind==='staff'?actor.staff.id:null,conversation_version:Number(chat.version),customer_seq:Number(chat.customer_message_seq),filename:name,content_type:mime,size_bytes:bytes.length,sha256:digest,object_key:actor.orgId+'/' +id,state:'pending',message_id:null,created_at:now(),expires_at:later(15*60_000)};
  await c.query('INSERT INTO web_chat_attachments(id,org_id,conversation_id,actor_kind,actor_key,client_id,uploaded_by,conversation_version,customer_seq,filename,content_type,size_bytes,sha256,object_key,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',[id,actor.orgId,actor.conversationId,actor.kind,key,clientId,row.uploaded_by,row.conversation_version,row.customer_seq,name,mime,bytes.length,digest,row.object_key,row.created_at,row.expires_at]);return row;
 },actor.kind==='staff'?actor.staff:undefined);
 if(reservation.state==='ready'){if(actor.kind==='visitor')await finishWebRouting(actor.orgId,reservation.id).catch(()=>undefined);return {file:publicFile(reservation),duplicate:true};}
 try{
  try{await bucket.put(reservation.object_key,bytes,{httpMetadata:{contentType:mime}});}catch(error){const existing=await bucket.get(reservation.object_key).catch(()=>null);if(!existing||sha(await bounded(existing.body,MAX))!==digest)throw error;}
  const result=await transaction(actor.orgId,async c=>{
   await authorize(c,actor);const row=(await c.query('SELECT * FROM web_chat_attachments WHERE org_id=$1 AND id=$2',[actor.orgId,reservation.id])).rows[0];
   if(row?.state==='ready')return {file:publicFile(row),duplicate:true};
   if(!row||row.state!=='pending'||row.expires_at<=now())throw new ApiError(409,'การอัปโหลดหมดอายุ');
   const chat=await authorize(c,actor,true,Number(row.conversation_version),Number(row.customer_seq)),messageId=randomUUID(),time=now(),content='[ไฟล์แนบ: '+name+']',customerSeq=Number(chat.customer_message_seq)+1;
   if(actor.kind==='visitor'){
    // Files go to staff review. Never pretend their contents have been read by AI.
    await c.query("UPDATE messages SET status='interrupted' WHERE org_id=$1 AND conversation_id=$2 AND status='generating'",[actor.orgId,actor.conversationId]);
    await c.query("UPDATE conversations SET status=CASE WHEN status='human_active' THEN status ELSE 'waiting_human' END,version=version+1,customer_message_seq=$3,generating_client_id=NULL,generation_started_at=NULL,first_customer_at=COALESCE(first_customer_at,$4),handoff_at=COALESCE(handoff_at,$4),updated_at=$4 WHERE org_id=$1 AND id=$2",[actor.orgId,actor.conversationId,customerSeq,time]);
    await c.query("INSERT INTO messages(id,org_id,conversation_id,role,content,client_id,status,customer_seq) VALUES($1,$2,$3,'user',$4,$5,'complete',$6)",[messageId,actor.orgId,actor.conversationId,content,'file:'+clientId,customerSeq]);
    // Durable reply evidence cancels waits and permits published non-send workflows.
    // The filename/bytes are not customer text: keyword matching receives no text.
    await (await import('./flows')).enqueueFlowIngress(c,{orgId:actor.orgId,provider:'web',accountId:'',eventId:'web:'+messageId,kind:'message',conversationId:actor.conversationId,leadId:chat.lead_id,messageId,text:'',fresh:customerSeq===1,optOut:false});
   }else{
    await c.query("INSERT INTO messages(id,org_id,conversation_id,role,content,author_member_id,author_type) VALUES($1,$2,$3,'agent',$4,$5,'human')",[messageId,actor.orgId,actor.conversationId,content,actor.staff.id]);
    await c.query('UPDATE conversations SET first_agent_at=COALESCE(first_agent_at,$3),updated_at=$3 WHERE org_id=$1 AND id=$2',[actor.orgId,actor.conversationId,time]);
   }
   const expires=row.expires_at;await c.query("UPDATE web_chat_attachments SET state='ready',message_id=$3,expires_at=$4,routing_pending=$5 WHERE org_id=$1 AND id=$2",[actor.orgId,row.id,messageId,expires,actor.kind==='visitor'?1:0]);
   await c.query('INSERT INTO audit_events(id,org_id,actor_id,action,entity_id,metadata) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),actor.orgId,actor.kind==='staff'?actor.staff.id:'visitor','web_chat.file_sent',actor.conversationId,JSON.stringify({attachmentId:row.id,messageId,sha256:digest,size:bytes.length})]);
   return {file:publicFile({...row,state:'ready',message_id:messageId,expires_at:expires}),duplicate:false};
  },actor.kind==='staff'?actor.staff:undefined);
  if(actor.kind==='visitor')await finishWebRouting(actor.orgId,reservation.id).catch(()=>undefined);return result;
 }catch(error){
  // Never delete a possibly committed ready object after an ambiguous D1 response.
  const state=(await database.query('SELECT state FROM web_chat_attachments WHERE org_id=$1 AND id=$2',[actor.orgId,reservation.id]).catch(()=>({rows:[{state:'unknown'}]}))).rows[0]?.state;
  if(state==='expired'||state==='deleting'){
   // A slow put can recreate bytes after the sweeper finished. Persist retry intent
   // before deletion so a storage failure cannot strand an orphan in expired state.
   await transaction(actor.orgId,c=>c.query("UPDATE web_chat_attachments SET state='deleting' WHERE org_id=$1 AND id=$2 AND state IN ('expired','deleting') AND message_id IS NULL",[actor.orgId,reservation.id]));
   if(bucket.delete)try{await bucket.delete(reservation.object_key);await transaction(actor.orgId,c=>c.query("UPDATE web_chat_attachments SET state='expired' WHERE org_id=$1 AND id=$2 AND state='deleting'",[actor.orgId,reservation.id]));}catch{/* minute cleanup retries the tombstone */}
  }
  throw error;
 }
}
export async function webAttachmentMetadata(orgId:string,conversationId:string){
 return (await database.query("SELECT a.* FROM web_chat_attachments a JOIN messages m ON m.org_id=a.org_id AND m.id=a.message_id WHERE a.org_id=$1 AND a.conversation_id=$2 AND a.message_id IS NOT NULL AND m.role IN ('user','agent') AND m.source_owner_only=0 ORDER BY a.created_at,a.id",[orgId,conversationId])).rows.map(publicFile);
}
export async function downloadWebAttachment(actor:WebAttachmentActor,id:string,options:{storage?:PrivateBucket}={}){
 await authorize(database,actor);const row=(await database.query("SELECT a.* FROM web_chat_attachments a JOIN messages m ON m.org_id=a.org_id AND m.id=a.message_id WHERE a.org_id=$1 AND a.conversation_id=$2 AND a.id=$3 AND a.state='ready' AND m.conversation_id=a.conversation_id AND m.role IN ('user','agent') AND m.source_owner_only=0",[actor.orgId,actor.conversationId,uuid(id)])).rows[0];if(!row)throw new ApiError(404,'ไม่พบไฟล์หรือไฟล์หมดอายุ');
 const object=await(options.storage||await getPrivateBucket()).get(row.object_key);if(!object)throw new ApiError(404,'ไม่พบไฟล์');const bytes=await bounded(object.body,Number(row.size_bytes));if(bytes.length!==row.size_bytes||sha(bytes)!==row.sha256)throw new ApiError(409,'ไฟล์ไม่ตรงกับข้อมูลที่บันทึก');mediaContainer(bytes,row.content_type);
 await authorize(database,actor);const fresh=(await database.query("SELECT 1 FROM web_chat_attachments a JOIN messages m ON m.org_id=a.org_id AND m.id=a.message_id WHERE a.org_id=$1 AND a.id=$2 AND a.state='ready' AND m.source_owner_only=0 AND m.role IN ('user','agent') AND m.conversation_id=a.conversation_id",[actor.orgId,row.id])).rows.length;if(!fresh)throw new ApiError(404,'ไฟล์หมดอายุ');
 return new Response(new Uint8Array(bytes),{headers:{'Content-Type':row.content_type,'Content-Length':String(bytes.length),'Content-Disposition':`attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(row.filename).replace(/'/g,'%27')}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",'Referrer-Policy':'no-referrer'}});
}
