import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {ApiError,fields,str,uuid,type Staff} from './auth';
import {database,transaction,type Executor,type Row} from './db';
import {getPrivateBucket,type PrivateBucket} from './files';
import {mediaContainer} from './reviewed-sale-media';
import {enqueueSocialReply,dispatchSocialReply,outboundGuard,socialConfigFingerprint,type DispatchOptions,type SocialChannelConfig} from './social-channels';
import {resolveSocialConfig} from './social-account-runtime';
import {privateMediaRequest,type PrivateMediaOptions} from './private-media-transport';

const now=()=>new Date().toISOString(),hash=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');
const formats:Record<string,number>={'application/pdf':10*1024*1024,'image/jpeg':5_000_000,'image/png':5_000_000};
const imageFormats:Record<string,number>={'image/jpeg':1_000_000,'image/png':1_000_000};
const supported=(provider:string)=>['whatsapp','line','facebook','instagram'].includes(provider);
const supportedFormats=(provider:string)=>provider==='whatsapp'?formats:supported(provider)?imageFormats:{};
function enabled(){return process.env.CRM_HUMAN_ATTACHMENTS_ENABLED==='true';}
function requireEnabled(){if(!enabled())throw new ApiError(503,'การแนบไฟล์เพื่อส่งยังไม่เปิดใช้งาน');}
async function chat(c:Executor,staff:Staff,id:string,version?:number):Promise<Row>{
  const row=(await c.query('SELECT * FROM conversations WHERE org_id=$1 AND id=$2',[staff.orgId,uuid(id)])).rows[0];
  if(!row)throw new ApiError(404,'ไม่พบบทสนทนา');
  if(row.status!=='human_active'||row.assignee_id!==staff.id)throw new ApiError(409,'กรุณารับช่วงบทสนทนาก่อนแนบไฟล์');
  if(version!==undefined&&row.version!==version)throw new ApiError(409,'บทสนทนาเปลี่ยน กรุณาเปิดตัวอย่างไฟล์อีกครั้ง');
  const identity=(await c.query('SELECT * FROM social_identities WHERE org_id=$1 AND conversation_id=$2',[staff.orgId,id])).rows[0];
  if(!supported(identity?.provider))throw new ApiError(422,'ช่องทางนี้ยังไม่รองรับการส่งไฟล์ส่วนตัว');
  if(identity.opt_out)throw new ApiError(409,'ลูกค้ายกเลิกการติดต่อแล้ว');
  return {...row,provider:identity.provider,account_id:identity.account_id};
}
const item=(r:Row)=>({id:r.id,filename:r.filename,contentType:r.content_type,sizeBytes:r.size_bytes,sha256:r.sha256,conversationVersion:r.conversation_version,customerSeq:r.customer_seq,expiresAt:r.expires_at});
export async function listHumanAttachments(staff:Staff,id:string){
  uuid(id);if(!(await database.query('SELECT 1 FROM conversations WHERE org_id=$1 AND id=$2',[staff.orgId,id])).rows.length)throw new ApiError(404,'ไม่พบบทสนทนา');
  const identity=(await database.query('SELECT provider FROM social_identities WHERE org_id=$1 AND conversation_id=$2',[staff.orgId,id])).rows[0];
  const rows=(await database.query("SELECT * FROM human_attachments WHERE org_id=$1 AND conversation_id=$2 AND uploaded_by=$3 AND status='ready' AND expires_at>$4 ORDER BY created_at DESC LIMIT 20",[staff.orgId,id,staff.id,now()])).rows;
  const allowed=supportedFormats(identity?.provider);return {enabled:enabled(),provider:identity?.provider||'web',supported:supported(identity?.provider),accept:Object.keys(allowed),maxBytes:Math.max(0,...Object.values(allowed)),limits:allowed,items:rows.map(item)};
}
async function bytesFrom(response:Response,limit:number){
  const reader=response.body?.getReader();if(!reader)throw new ApiError(400,'ไม่มีไฟล์');const parts:Uint8Array[]=[];let size=0;
  try{while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>limit){await reader.cancel();throw new ApiError(413,'ไฟล์เกินขนาดที่รองรับ');}parts.push(chunk.value);}}finally{reader.releaseLock();}
  return Buffer.concat(parts,size);
}
/** Only abandoned, unapproved uploads are removable. Claim before deleting R2;
 * failed deletion retains the quota reservation and is retried by the next sweep. */
export async function sweepExpiredHumanAttachments(orgId:string,limit=10,storage?:PrivateBucket){
  const bucket=storage||await getPrivateBucket();if(!bucket.delete)return {removed:0};
  if(!Number.isSafeInteger(limit)||limit<1||limit>20)throw new ApiError(400,'Invalid cleanup limit');
  const rows=await transaction(orgId,async c=>{
    const found=(await c.query("SELECT id,object_key FROM human_attachments WHERE org_id=$1 AND status IN ('pending','ready','deleting') AND expires_at<=$2 AND client_id IS NULL AND message_id IS NULL AND outbound_command_id IS NULL ORDER BY expires_at,id LIMIT $3",[orgId,now(),limit])).rows;
    for(const row of found)await c.query("UPDATE human_attachments SET status='deleting' WHERE org_id=$1 AND id=$2",[orgId,row.id]);return found;
  });
  let removed=0;for(const row of rows){
    if(row.object_key!==orgId+'/'+row.id)continue;
    try{await bucket.delete(row.object_key);await transaction(orgId,async c=>{await c.query("DELETE FROM human_attachments WHERE org_id=$1 AND id=$2 AND status='deleting' AND client_id IS NULL AND message_id IS NULL AND outbound_command_id IS NULL",[orgId,row.id]);});removed++;}catch{console.error('[rrs] human_attachment_cleanup_deferred');}
  }
  return {removed};
}
export async function uploadHumanAttachment(staff:Staff,id:string,request:Request,options:{storage?:PrivateBucket}={}){
  requireEnabled();const rawVersion=request.headers.get('x-conversation-version')||'';if(!/^\d{1,10}$/.test(rawVersion))throw new ApiError(400,'ไม่พบรุ่นบทสนทนา');const version=Number(rawVersion);
  const current=await chat(database,staff,id,version);const type=request.headers.get('content-type')||'',limit=supportedFormats(current.provider)[type];if(!limit)throw new ApiError(415,'ชนิดไฟล์นี้ไม่รองรับในช่องทางที่เลือก');
  await sweepExpiredHumanAttachments(staff.orgId,10,options.storage);
  let name:string;try{name=decodeURIComponent(request.headers.get('x-file-name')||'');}catch{throw new ApiError(400,'ชื่อไฟล์ไม่ถูกต้อง');}
  name=str(name,'ชื่อไฟล์',180,true);if(/[\x00-\x1f\x7f/\\]/.test(name))throw new ApiError(400,'ชื่อไฟล์ไม่ถูกต้อง');
  if(Number(request.headers.get('content-length')||0)>limit)throw new ApiError(413,'ไฟล์เกินขนาดที่รองรับ');
  const bytes=await bytesFrom(new Response(request.body),limit);if(!bytes.length)throw new ApiError(400,'ไฟล์ว่าง');mediaContainer(bytes,type);
  const asset=randomUUID(),key=staff.orgId+'/'+asset,sha=hash(bytes),expires=new Date(Date.now()+15*60_000).toISOString();
  const row=await transaction(staff.orgId,async c=>{
    const conversation=await chat(c,staff,id,version),used=Number((await c.query('SELECT COALESCE(sum(size_bytes),0) AS n FROM human_attachments WHERE org_id=$1',[staff.orgId])).rows[0].n);
    if(conversation.provider!==current.provider||conversation.account_id!==current.account_id)throw new ApiError(409,'บัญชีช่องทางเปลี่ยน กรุณาเลือกไฟล์อีกครั้ง');
    const configured=Number(process.env.HUMAN_ATTACHMENT_STORAGE_LIMIT_BYTES||100*1024*1024),quota=Number.isSafeInteger(configured)&&configured>0?configured:100*1024*1024;
    if(used+bytes.length>quota)throw new ApiError(409,'พื้นที่ไฟล์แนบถึงขีดจำกัด');
    await c.query("INSERT INTO human_attachments(id,org_id,conversation_id,uploaded_by,provider,account_id,conversation_version,customer_seq,filename,content_type,size_bytes,sha256,object_key,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",[asset,staff.orgId,id,staff.id,conversation.provider,conversation.account_id,version,conversation.customer_message_seq,name,type,bytes.length,sha,key,expires,now()]);
    return {id:asset,filename:name,content_type:type,size_bytes:bytes.length,sha256:sha,conversation_version:version,customer_seq:conversation.customer_message_seq,expires_at:expires};
  },staff);
  const storage=options.storage||await getPrivateBucket();await storage.put(key,bytes,{httpMetadata:{contentType:type}});
  const ready=await transaction(staff.orgId,async c=>{const pending=(await c.query('SELECT status FROM human_attachments WHERE org_id=$1 AND id=$2',[staff.orgId,asset])).rows[0];if(pending?.status!=='pending')return false;await chat(c,staff,id,version);await c.query("UPDATE human_attachments SET status='ready' WHERE org_id=$1 AND id=$2 AND status='pending'",[staff.orgId,asset]);return true;},staff);
  if(!ready){await storage.delete?.(key);throw new ApiError(409,'การอัปโหลดหมดอายุ กรุณาเลือกไฟล์อีกครั้ง');}
  return item(row);
}
async function fileBytes(row:Row){
  const object=await(await getPrivateBucket()).get(row.object_key);if(!object)throw new ApiError(404,'ไม่พบไฟล์แนบ');
  const bytes=await bytesFrom(new Response(object.body),row.size_bytes);if(bytes.length!==row.size_bytes||hash(bytes)!==row.sha256)throw new ApiError(409,'ไฟล์แนบเปลี่ยนแปลง');mediaContainer(bytes,row.content_type);return bytes;
}
export async function downloadHumanAttachment(staff:Staff,id:string,attachmentId:string){
  const row=(await database.query("SELECT * FROM human_attachments WHERE org_id=$1 AND conversation_id=$2 AND uploaded_by=$3 AND id=$4 AND status IN ('ready','approved')",[staff.orgId,uuid(id),staff.id,uuid(attachmentId)])).rows[0];
  if(!row||row.expires_at<now()&&row.status!=='approved')throw new ApiError(404,'ไม่พบไฟล์แนบ');
  const bytes=await fileBytes(row);return new Response(bytes,{headers:{'Content-Type':row.content_type,'Content-Length':String(bytes.length),'Content-Disposition':`attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(row.filename).replace(/'/g,'%27')}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"}});
}
export async function approveHumanAttachment(staff:Staff,id:string,body:Record<string,unknown>,options:DispatchOptions&{dispatch?:boolean}={}){
  requireEnabled();fields(body,['attachmentId','clientId','expectedVersion']);const asset=uuid(body.attachmentId),client=uuid(body.clientId);if(!Number.isSafeInteger(body.expectedVersion)||Number(body.expectedVersion)<0)throw new ApiError(400,'รุ่นบทสนทนาไม่ถูกต้อง');
  const result=await transaction(staff.orgId,async c=>{
    const previous=(await c.query('SELECT * FROM human_attachments WHERE org_id=$1 AND client_id=$2',[staff.orgId,client])).rows[0];
    if(previous){if(previous.id!==asset||previous.conversation_id!==id||previous.uploaded_by!==staff.id||previous.conversation_version!==body.expectedVersion)throw new ApiError(409,'คำสั่งส่งนี้ถูกใช้กับข้อมูลอื่นแล้ว');return {attachmentId:asset,messageId:previous.message_id,commandId:previous.outbound_command_id};}
    const conversation=await chat(c,staff,id,Number(body.expectedVersion));
    const file=(await c.query("SELECT * FROM human_attachments WHERE org_id=$1 AND conversation_id=$2 AND uploaded_by=$3 AND id=$4 AND status='ready'",[staff.orgId,id,staff.id,asset])).rows[0];
    if(!file)throw new ApiError(404,'ไม่พบไฟล์ที่คุณอัปโหลด');
    if(file.expires_at<now()||file.conversation_version!==conversation.version||file.customer_seq!==conversation.customer_message_seq||file.provider!==conversation.provider||file.account_id!==conversation.account_id)throw new ApiError(409,'ตัวอย่างไฟล์หมดอายุหรือบทสนทนาเปลี่ยน');
    const messageId=randomUUID(),text='[ไฟล์แนบ: '+file.filename+']';
    await c.query("INSERT INTO messages(id,org_id,conversation_id,role,content,author_member_id,author_type) VALUES($1,$2,$3,'agent',$4,$5,'human')",[messageId,staff.orgId,id,text,staff.id]);
    const command=await enqueueSocialReply(c,staff.orgId,id,messageId,text);if(!command.commandId)throw new ApiError(422,'ช่องทางนี้ยังไม่รองรับไฟล์แนบ');
    await c.query("UPDATE human_attachments SET status='approved',client_id=$3,message_id=$4,outbound_command_id=$5 WHERE org_id=$1 AND id=$2",[staff.orgId,asset,client,messageId,command.commandId]);
    await c.query("INSERT INTO social_message_attachments(id,org_id,message_id,provider,account_id,media_type,provider_ref,metadata,storage_state,object_key) VALUES($1,$2,$3,$4,$5,$6,'',$7,'archived',$8)",[asset,staff.orgId,messageId,file.provider,file.account_id,file.content_type==='application/pdf'?'document':'image',JSON.stringify({name:file.filename,mime:file.content_type,size:file.size_bytes,sha256:file.sha256,humanAttachment:true}),file.object_key]);
    await c.query("INSERT INTO social_media_archive(org_id,attachment_id,object_key,size_bytes,content_type,sha256,status,created_at) VALUES($1,$2,$3,$4,$5,$6,'ready',$7)",[staff.orgId,asset,file.object_key,file.size_bytes,file.content_type,file.sha256,now()]);
    await c.query('UPDATE conversations SET updated_at=$3,first_agent_at=COALESCE(first_agent_at,$3) WHERE org_id=$1 AND id=$2',[staff.orgId,id,now()]);
    await c.query("INSERT INTO audit_events(id,org_id,actor_id,action,entity_id,metadata) VALUES($1,$2,$3,'conversation.attachment_approved',$4,$5)",[randomUUID(),staff.orgId,staff.id,id,JSON.stringify({attachmentId:asset,messageId,commandId:command.commandId,sha256:file.sha256})]);
    return {attachmentId:asset,messageId,commandId:command.commandId};
  },staff);
  if(options.dispatch!==false)await dispatchSocialReply(staff.orgId,result.commandId,options).catch(()=>{console.error('[rrs] human_attachment_dispatch_deferred');});
  const row=(await database.query('SELECT status FROM social_outbound_commands WHERE org_id=$1 AND id=$2',[staff.orgId,result.commandId])).rows[0];return {...result,status:row?.status||'unknown'};
}
export async function guardHumanAttachment(c:Executor,command:Row){
  const row=(await c.query('SELECT * FROM human_attachments WHERE org_id=$1 AND outbound_command_id=$2',[command.org_id,command.id])).rows[0];if(!row)return;
  requireEnabled();const conversation=(await c.query('SELECT customer_message_seq FROM conversations WHERE org_id=$1 AND id=$2',[command.org_id,command.conversation_id])).rows[0];
  if(row.status!=='approved'||row.uploaded_by!==command.approved_by||row.conversation_id!==command.conversation_id||row.conversation_version!==command.conversation_version||row.customer_seq!==conversation?.customer_message_seq||row.message_id!==command.message_id||row.provider!==command.provider||row.account_id!==command.account_id||command.body!=='[ไฟล์แนบ: '+row.filename+']')throw new ApiError(409,'การอนุมัติไฟล์แนบเปลี่ยน');
}
/** Runs inside the single normal dispatcher attempt. No separate media send queue. */
export async function prepareHumanAttachmentRequest(config:SocialChannelConfig,command:Row,options:PrivateMediaOptions){
  const row=(await database.query('SELECT * FROM human_attachments WHERE org_id=$1 AND outbound_command_id=$2',[command.org_id,command.id])).rows[0];if(!row)return null;
  await options.assertCurrent();const limit=supportedFormats(config.provider)[row.content_type];if(!limit||row.size_bytes>limit)throw new ApiError(422,'Unsupported private attachment transport');const bytes=await fileBytes(row);await options.assertCurrent();
  return privateMediaRequest(config,command,{bytes,mime:row.content_type,name:row.filename,uploaded:async id=>{
    await transaction(command.org_id,async c=>{await guardHumanAttachment(c,command);await c.query('UPDATE human_attachments SET provider_media_id=$3 WHERE org_id=$1 AND id=$2',[command.org_id,row.id,id]);await c.query('UPDATE social_message_attachments SET provider_ref=$3 WHERE org_id=$1 AND id=$2',[command.org_id,row.id,id]);});
  },grant:async()=>{
    let origin:URL;try{origin=new URL(process.env.APP_ORIGIN||'');}catch{throw new ApiError(503,'Public media origin is missing');}
    if(origin.protocol!=='https:'||origin.origin!==process.env.APP_ORIGIN||origin.username||origin.password)throw new ApiError(503,'Public media origin must be HTTPS');
    const token=randomBytes(32).toString('base64url');
    await transaction(command.org_id,async c=>{await guardHumanAttachment(c,command);const state=(await c.query('SELECT status,attempt_id FROM social_outbound_commands WHERE org_id=$1 AND id=$2',[command.org_id,command.id])).rows[0];if(state?.status!=='sending'||state.attempt_id!==command.attempt_id)throw new ApiError(409,'Attachment attempt changed');await c.query('UPDATE human_attachments SET grant_hash=$3,grant_expires_at=$4,grant_attempt=$5,grant_fingerprint=$6,grant_epoch=$7,grant_reads=0 WHERE org_id=$1 AND id=$2',[command.org_id,row.id,hash(token),new Date(Date.now()+300_000).toISOString(),command.attempt_id,socialConfigFingerprint(config),command.control_epoch]);});
    return origin.origin+'/api/channels/media/'+token;
  }},options);
}

/** Bearer capability is never listed or returned by staff APIs. No arbitrary URL fetching. */
export async function downloadHumanAttachmentGrant(token:string,options:{readConfig?:(row:Row,c:Executor)=>Promise<SocialChannelConfig>}={}){
  requireEnabled();if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw new ApiError(404,'Media unavailable');
  const grantHash=hash(token),found=(await database.query('SELECT org_id FROM human_attachments WHERE grant_hash=$1',[grantHash])).rows[0];if(!found)throw new ApiError(404,'Media unavailable');
  const check=async(c:Executor,count:boolean)=>{
    const row=(await c.query("SELECT * FROM human_attachments WHERE org_id=$1 AND grant_hash=$2 AND status='approved'",[found.org_id,grantHash])).rows[0];
    if(!row||!row.grant_expires_at||row.grant_expires_at<=now()||row.grant_reads>(count?15:16)||!imageFormats[row.content_type]||row.size_bytes>imageFormats[row.content_type])throw new ApiError(404,'Media unavailable');
    const command=(await c.query('SELECT * FROM social_outbound_commands WHERE org_id=$1 AND id=$2',[row.org_id,row.outbound_command_id])).rows[0];
    // A timeout cannot prove that the provider rejected this attempt. Permit
    // its already-issued fetch only until the original expiry; never resend.
    if(!command||!['sending','submitted','sent','delivered','read','unknown'].includes(command.status)||command.attempt_id!==row.grant_attempt)throw new ApiError(404,'Media unavailable');
    const config=options.readConfig?await options.readConfig(row,c):await resolveSocialConfig(row.org_id,row.provider,row.account_id,{connection:c});
    if(!config.liveEnabled||!config.inboundEnabled||config.owner!=='crm'||socialConfigFingerprint(config)!==row.grant_fingerprint)throw new ApiError(404,'Media unavailable');
    await outboundGuard(c,command,config,row.grant_epoch);
    if(count)await c.query('UPDATE human_attachments SET grant_reads=grant_reads+1 WHERE org_id=$1 AND id=$2',[row.org_id,row.id]);
    return row;
  };
  const row=await transaction(found.org_id,c=>check(c,true)),bytes=await fileBytes(row);await check(database,false);
  return new Response(bytes,{headers:{'Content-Type':row.content_type,'Content-Length':String(bytes.length),'Content-Disposition':'inline','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",'Referrer-Policy':'no-referrer'}});
}
