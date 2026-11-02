import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {ApiError,fields,requireAdmin,str,uuid,type Staff} from './auth';
import {database,transaction,type Executor,type Row} from './db';
import {getPrivateBucket,type PrivateBucket} from './files';
import {mediaContainer} from './reviewed-sale-media';
import {outboundGuard,socialConfigFingerprint,type SocialChannelConfig} from './social-channels';
import {resolveSocialConfig} from './social-account-runtime';
import {privateMediaRequest,type PrivateMediaOptions} from './private-media-transport';

const now=()=>new Date().toISOString(),hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const images:Record<string,number>={'image/jpeg':1_000_000,'image/png':1_000_000};
const formats=(provider:string):Record<string,number>=>provider==='whatsapp'?{'image/jpeg':5_000_000,'image/png':5_000_000,'application/pdf':10*1024*1024}:provider==='line'?images:{};
const enabled=()=>process.env.CRM_BROADCAST_MEDIA_ENABLED==='true';
function requireEnabled(){if(!enabled())throw new ApiError(503,'การแนบไฟล์บรอดแคสต์ยังไม่เปิดใช้งาน');}
const snapshot=(r:Row)=>({id:r.id as string,sha256:r.sha256 as string,name:r.filename as string,mime:r.content_type as string,size:Number(r.size_bytes)});
async function campaignFor(c:Executor,staff:Staff,id:string,version?:number){
  requireAdmin(staff);const campaign=(await c.query('SELECT * FROM broadcast_campaigns WHERE org_id=$1 AND id=$2',[staff.orgId,uuid(id)])).rows[0];if(!campaign)throw new ApiError(404,'ไม่พบแคมเปญ');
  if(version!==undefined&&(campaign.status!=='draft'||Number(campaign.version)!==version))throw new ApiError(409,'แคมเปญเปลี่ยนหรือไม่ใช่ฉบับร่าง');return campaign;
}
function validAsset(asset:Row|undefined,campaign:Row){
  if(!asset||asset.status!=='ready'||asset.org_id!==campaign.org_id||asset.campaign_id!==campaign.id||asset.provider!==campaign.provider||asset.account_id!==campaign.account_id||campaign.message_kind!=='text'||!formats(asset.provider)[asset.content_type]||asset.size_bytes>formats(asset.provider)[asset.content_type])throw new ApiError(409,'ไฟล์แนบไม่ตรงกับแคมเปญ');
}
export async function broadcastAssetSnapshot(c:Executor,orgId:string,campaign:Row){
  if(!campaign.media_asset_id)return null;if(campaign.org_id!==orgId)throw new ApiError(404,'ไม่พบแคมเปญ');
  const asset=(await c.query('SELECT * FROM broadcast_assets WHERE org_id=$1 AND id=$2',[orgId,campaign.media_asset_id])).rows[0];validAsset(asset,campaign);return snapshot(asset);
}
export const broadcastAsset=broadcastAssetSnapshot;
async function readBytes(body:ReadableStream<Uint8Array>|null,limit:number){
  const reader=body?.getReader();if(!reader)throw new ApiError(400,'ไม่มีไฟล์');const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>limit){await reader.cancel();throw new ApiError(413,'ไฟล์เกินขนาด');}chunks.push(next.value);}}finally{reader.releaseLock();}return Buffer.concat(chunks,size);
}
async function fileBytes(row:Row){
  const object=await(await getPrivateBucket()).get(row.object_key);if(!object)throw new ApiError(404,'ไม่พบไฟล์');
  const bytes=await readBytes(object.body,row.size_bytes);if(bytes.length!==row.size_bytes||hash(bytes)!==row.sha256)throw new ApiError(409,'ไฟล์เปลี่ยนแปลง');mediaContainer(bytes,row.content_type);return bytes;
}
/** Only abandoned/unselected assets without any approved command are removed. */
export async function sweepBroadcastAssets(orgId:string,storage?:PrivateBucket){
  const bucket=storage||await getPrivateBucket();if(!bucket.delete)return {removed:0};
  const rows=await transaction(orgId,async c=>{const found=(await c.query("SELECT a.id,a.object_key FROM broadcast_assets a WHERE a.org_id=$1 AND a.expires_at<=$2 AND NOT EXISTS(SELECT 1 FROM broadcast_campaigns p WHERE p.org_id=a.org_id AND p.media_asset_id=a.id) AND NOT EXISTS(SELECT 1 FROM broadcast_command_assets b WHERE b.org_id=a.org_id AND b.asset_id=a.id) ORDER BY a.expires_at,a.id LIMIT 10",[orgId,now()])).rows;for(const row of found)await c.query("UPDATE broadcast_assets SET status='deleting' WHERE org_id=$1 AND id=$2",[orgId,row.id]);return found;});
  let removed=0;for(const row of rows){if(row.object_key!==orgId+'/'+row.id)continue;try{await bucket.delete(row.object_key);await transaction(orgId,c=>c.query("DELETE FROM broadcast_assets WHERE org_id=$1 AND id=$2 AND status='deleting' AND NOT EXISTS(SELECT 1 FROM broadcast_campaigns p WHERE p.org_id=$1 AND p.media_asset_id=$2) AND NOT EXISTS(SELECT 1 FROM broadcast_command_assets b WHERE b.org_id=$1 AND b.asset_id=$2)",[orgId,row.id]));removed++;}catch{console.error('[rrs] broadcast_asset_cleanup_deferred');}}return {removed};
}
export async function uploadBroadcastAsset(staff:Staff,id:string,request:Request,options:{storage?:PrivateBucket}={}){
  requireAdmin(staff);requireEnabled();const raw=request.headers.get('x-campaign-version')||'';if(!/^\d{1,10}$/.test(raw))throw new ApiError(400,'รุ่นแคมเปญไม่ถูกต้อง');const version=Number(raw),initial=await campaignFor(database,staff,id,version);
  if(initial.message_kind!=='text')throw new ApiError(422,'ไฟล์แนบรองรับแคมเปญข้อความเท่านั้น');
  const type=request.headers.get('content-type')||'',limit=formats(initial.provider)[type];if(!limit)throw new ApiError(415,'ชนิดไฟล์ไม่รองรับ');
  let filename:string;try{filename=decodeURIComponent(request.headers.get('x-file-name')||'');}catch{throw new ApiError(400,'ชื่อไฟล์ไม่ถูกต้อง');}filename=str(filename,'ชื่อไฟล์',180,true);if(/[\x00-\x1f\x7f/\\]/.test(filename))throw new ApiError(400,'ชื่อไฟล์ไม่ถูกต้อง');
  if(Number(request.headers.get('content-length')||0)>limit)throw new ApiError(413,'ไฟล์เกินขนาด');const bytes=await readBytes(request.body,limit);if(!bytes.length)throw new ApiError(400,'ไฟล์ว่าง');mediaContainer(bytes,type);
  await sweepBroadcastAssets(staff.orgId,options.storage);const asset=randomUUID(),key=staff.orgId+'/'+asset,sha=hash(bytes),at=now(),expires=new Date(Date.now()+3600_000).toISOString();
  await transaction(staff.orgId,async c=>{const campaign=await campaignFor(c,staff,id,version);if(campaign.provider!==initial.provider||campaign.account_id!==initial.account_id||campaign.message_kind!=='text')throw new ApiError(409,'แคมเปญเปลี่ยน');
    const used=Number((await c.query('SELECT COALESCE(sum(size_bytes),0) AS n FROM broadcast_assets WHERE org_id=$1',[staff.orgId])).rows[0].n),configured=Number(process.env.BROADCAST_MEDIA_STORAGE_LIMIT_BYTES||100*1024*1024),quota=Number.isSafeInteger(configured)&&configured>0?configured:100*1024*1024;if(used+bytes.length>quota)throw new ApiError(409,'พื้นที่ไฟล์บรอดแคสต์ถึงขีดจำกัด');
    await c.query('INSERT INTO broadcast_assets(id,org_id,campaign_id,provider,account_id,uploaded_by,filename,content_type,size_bytes,sha256,object_key,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',[asset,staff.orgId,id,campaign.provider,campaign.account_id,staff.id,filename,type,bytes.length,sha,key,expires,at]);
  },staff);
  const bucket=options.storage||await getPrivateBucket();await bucket.put(key,bytes,{httpMetadata:{contentType:type}});
  try{const result=await transaction(staff.orgId,async c=>{const row=(await c.query('SELECT * FROM broadcast_assets WHERE org_id=$1 AND id=$2',[staff.orgId,asset])).rows[0];if(!row||row.status==='deleting')return null;requireEnabled();const campaign=await campaignFor(c,staff,id,version);if(row.status!=='pending'||row.expires_at<=now()||campaign.provider!==row.provider||campaign.account_id!==row.account_id||campaign.message_kind!=='text')throw new ApiError(409,'การอัปโหลดหมดอายุหรือแคมเปญเปลี่ยน');
    await c.query("UPDATE broadcast_assets SET status='ready' WHERE org_id=$1 AND id=$2",[staff.orgId,asset]);await c.query('UPDATE broadcast_campaigns SET media_asset_id=$3,version=version+1,updated_at=$4 WHERE org_id=$1 AND id=$2',[staff.orgId,id,asset,now()]);
    await c.query("INSERT INTO audit_events(id,org_id,actor_id,action,entity_id,metadata) VALUES($1,$2,$3,'broadcast.asset_changed',$4,$5)",[randomUUID(),staff.orgId,staff.id,id,JSON.stringify({assetId:asset,sha256:sha,version:version+1})]);return {asset:snapshot(row),version:version+1};},staff);
    // A conclusively removed/deleting reservation can never become selected.
    // Clean up a late put only in this branch, never after a batch exception.
    if(!result){await bucket.delete?.(key);throw new ApiError(409,'การอัปโหลดหมดอายุ กรุณาเลือกไฟล์อีกครั้ง');}return result;
  }catch(error){
    // A lost batch response cannot prove the final CAS failed. It may already
    // have selected these bytes. Retain the reservation; bounded cleanup alone
    // may remove assets proven unselected and without any approved command.
    throw error;
  }
}
export async function removeBroadcastAsset(staff:Staff,id:string,body:Record<string,unknown>){
  requireAdmin(staff);requireEnabled();fields(body,['expectedVersion']);if(!Number.isSafeInteger(body.expectedVersion)||Number(body.expectedVersion)<1)throw new ApiError(400,'รุ่นแคมเปญไม่ถูกต้อง');
  return transaction(staff.orgId,async c=>{const campaign=await campaignFor(c,staff,id,Number(body.expectedVersion));await c.query('UPDATE broadcast_campaigns SET media_asset_id=NULL,version=version+1,updated_at=$3 WHERE org_id=$1 AND id=$2',[staff.orgId,id,now()]);await c.query("INSERT INTO audit_events(id,org_id,actor_id,action,entity_id,metadata) VALUES($1,$2,$3,'broadcast.asset_removed',$4,$5)",[randomUUID(),staff.orgId,staff.id,id,JSON.stringify({assetId:campaign.media_asset_id,version:Number(campaign.version)+1})]);return {asset:null,version:Number(campaign.version)+1};},staff);
}
const response=(bytes:Buffer,row:Row,inline=false)=>new Response(new Uint8Array(bytes),{headers:{'Content-Type':row.content_type,'Content-Length':String(bytes.length),'Content-Disposition':inline?'inline':`attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(row.filename).replace(/'/g,'%27')}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",'Referrer-Policy':'no-referrer'}});
export async function downloadBroadcastAsset(staff:Staff,id:string,assetId:string){
  await campaignFor(database,staff,id);const row=(await database.query("SELECT * FROM broadcast_assets WHERE org_id=$1 AND campaign_id=$2 AND id=$3 AND status='ready'",[staff.orgId,id,uuid(assetId)])).rows[0];if(!row)throw new ApiError(404,'ไม่พบไฟล์');return response(await fileBytes(row),row);
}
/** Called in the same transaction as the canonical message/outbound command. */
export async function bindBroadcastAsset(c:Executor,input:{orgId:string;campaign:Row;commandId:string;command:Row;body:string;approvedBy:string}){
  const {orgId,campaign,commandId,body,approvedBy}=input;if(!campaign.media_asset_id)return;requireEnabled();await broadcastAssetSnapshot(c,orgId,campaign);
  if(campaign.provider==='whatsapp'&&[...body].length>1024||campaign.provider==='line'&&body.length>2000)throw new ApiError(422,'ข้อความประกอบไฟล์ยาวเกินขนาดช่องทาง');
  // D1 transaction planning cannot read a command staged earlier in this batch.
  // The trusted caller passes the exact canonical INSERT snapshot; the FK and
  // the normal dispatch guard verify the committed command before any I/O.
  const asset=(await c.query('SELECT * FROM broadcast_assets WHERE org_id=$1 AND id=$2',[orgId,campaign.media_asset_id])).rows[0],command=input.command;
  if(command.id!==commandId||command.org_id!==orgId||command.provider!==asset.provider||command.account_id!==asset.account_id||command.body!==body||command.approved_by!==approvedBy)throw new ApiError(409,'คำสั่งส่งไฟล์ไม่ตรงกับการอนุมัติ');const attachment=randomUUID();
  await c.query('INSERT INTO broadcast_command_assets(org_id,command_id,asset_id,campaign_id,campaign_version,message_id,provider,account_id,approved_by,body,sha256,object_key,filename,content_type,size_bytes,attachment_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)',[orgId,commandId,asset.id,campaign.id,campaign.version,command.message_id,asset.provider,asset.account_id,approvedBy,body,asset.sha256,asset.object_key,asset.filename,asset.content_type,asset.size_bytes,attachment,now()]);
  await c.query("INSERT INTO social_message_attachments(id,org_id,message_id,provider,account_id,media_type,provider_ref,metadata,storage_state,object_key) VALUES($1,$2,$3,$4,$5,$6,'',$7,'archived',$8)",[attachment,orgId,command.message_id,asset.provider,asset.account_id,asset.content_type==='application/pdf'?'document':'image',JSON.stringify({name:asset.filename,mime:asset.content_type,size:asset.size_bytes,sha256:asset.sha256,broadcastAsset:true}),asset.object_key]);
  await c.query("INSERT INTO social_media_archive(org_id,attachment_id,object_key,size_bytes,content_type,sha256,status,created_at) VALUES($1,$2,$3,$4,$5,$6,'ready',$7)",[orgId,attachment,asset.object_key,asset.size_bytes,asset.content_type,asset.sha256,now()]);
}
export async function guardBroadcastAsset(c:Executor,command:Row){
  const row=(await c.query('SELECT * FROM broadcast_command_assets WHERE org_id=$1 AND command_id=$2',[command.org_id,command.id])).rows[0];
  const link=(await c.query('SELECT campaign_id FROM broadcast_recipients WHERE org_id=$1 AND outbound_command_id=$2 UNION ALL SELECT campaign_id FROM broadcast_test_sends WHERE org_id=$1 AND outbound_command_id=$2',[command.org_id,command.id])).rows;
  if(!row){if(link.length&&(await c.query('SELECT media_asset_id FROM broadcast_campaigns WHERE org_id=$1 AND id=$2',[command.org_id,link[0].campaign_id])).rows[0]?.media_asset_id)throw new ApiError(409,'Missing broadcast media approval');return;}
  requireEnabled();if(link.length!==1||link[0].campaign_id!==row.campaign_id)throw new ApiError(409,'Broadcast media linkage changed');
  const campaign=(await c.query('SELECT * FROM broadcast_campaigns WHERE org_id=$1 AND id=$2',[command.org_id,row.campaign_id])).rows[0],asset=(await c.query('SELECT * FROM broadcast_assets WHERE org_id=$1 AND id=$2',[command.org_id,row.asset_id])).rows[0];if(!campaign)throw new ApiError(409,'Broadcast campaign missing');validAsset(asset,campaign);
  if(campaign.media_asset_id!==row.asset_id||row.message_id!==command.message_id||row.provider!==command.provider||row.account_id!==command.account_id||row.approved_by!==command.approved_by||row.body!==command.body||['sha256','object_key','filename','content_type','size_bytes'].some(key=>row[key]!==asset[key]))throw new ApiError(409,'Broadcast media approval changed');
}
export async function prepareBroadcastMediaRequest(config:SocialChannelConfig,command:Row,options:PrivateMediaOptions){
  const row=(await database.query('SELECT * FROM broadcast_command_assets WHERE org_id=$1 AND command_id=$2',[command.org_id,command.id])).rows[0];if(!row)return null;
  await options.assertCurrent();await guardBroadcastAsset(database,command);const bytes=await fileBytes(row);
  return privateMediaRequest(config,command,{bytes,mime:row.content_type,name:row.filename,text:row.body,uploaded:async id=>{await transaction(command.org_id,async c=>{await guardBroadcastAsset(c,command);await c.query('UPDATE broadcast_command_assets SET provider_media_id=$3 WHERE org_id=$1 AND command_id=$2',[command.org_id,command.id,id]);await c.query('UPDATE social_message_attachments SET provider_ref=$3 WHERE org_id=$1 AND id=$2',[command.org_id,row.attachment_id,id]);});},grant:async()=>{
    let origin:URL;try{origin=new URL(process.env.APP_ORIGIN||'');}catch{throw new ApiError(503,'Public media origin missing');}if(origin.protocol!=='https:'||origin.origin!==process.env.APP_ORIGIN||origin.username||origin.password)throw new ApiError(503,'Public media origin must be HTTPS');const token=randomBytes(32).toString('base64url');
    await transaction(command.org_id,async c=>{await guardBroadcastAsset(c,command);const state=(await c.query('SELECT status,attempt_id FROM social_outbound_commands WHERE org_id=$1 AND id=$2',[command.org_id,command.id])).rows[0];if(state?.status!=='sending'||state.attempt_id!==command.attempt_id)throw new ApiError(409,'Media attempt changed');await c.query('UPDATE broadcast_command_assets SET grant_hash=$3,grant_expires_at=$4,grant_attempt=$5,grant_fingerprint=$6,grant_epoch=$7,grant_reads=0 WHERE org_id=$1 AND command_id=$2',[command.org_id,command.id,hash(token),new Date(Date.now()+300_000).toISOString(),command.attempt_id,socialConfigFingerprint(config),command.control_epoch]);});return origin.origin+'/api/channels/media/'+token;
  }},options);
}
export async function hasBroadcastMediaGrant(token:string){return /^[A-Za-z0-9_-]{43}$/.test(token)&&(await database.query('SELECT 1 FROM broadcast_command_assets WHERE grant_hash=$1',[hash(token)])).rows.length>0;}
export async function downloadBroadcastMediaGrant(token:string,options:{readConfig?:(row:Row,c:Executor)=>Promise<SocialChannelConfig>}={}){
  requireEnabled();if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw new ApiError(404,'Media unavailable');const grantHash=hash(token),found=(await database.query('SELECT org_id FROM broadcast_command_assets WHERE grant_hash=$1',[grantHash])).rows[0];if(!found)throw new ApiError(404,'Media unavailable');
  const check=async(c:Executor,count:boolean)=>{const row=(await c.query('SELECT * FROM broadcast_command_assets WHERE org_id=$1 AND grant_hash=$2',[found.org_id,grantHash])).rows[0];if(!row||!row.grant_expires_at||row.grant_expires_at<=now()||row.grant_reads>(count?15:16)||!images[row.content_type]||row.size_bytes>images[row.content_type])throw new ApiError(404,'Media unavailable');
    const command=(await c.query('SELECT * FROM social_outbound_commands WHERE org_id=$1 AND id=$2',[row.org_id,row.command_id])).rows[0];if(!command||!['sending','submitted','sent','delivered','read','unknown'].includes(command.status)||command.attempt_id!==row.grant_attempt)throw new ApiError(404,'Media unavailable');
    const config=options.readConfig?await options.readConfig(row,c):await resolveSocialConfig(row.org_id,row.provider,row.account_id,{connection:c});if(!config.liveEnabled||!config.inboundEnabled||config.owner!=='crm'||socialConfigFingerprint(config)!==row.grant_fingerprint)throw new ApiError(404,'Media unavailable');await outboundGuard(c,command,config,row.grant_epoch,{mediaFetch:true});if(count)await c.query('UPDATE broadcast_command_assets SET grant_reads=grant_reads+1 WHERE org_id=$1 AND command_id=$2',[row.org_id,row.command_id]);return row;};
  const row=await transaction(found.org_id,c=>check(c,true)),bytes=await fileBytes(row);await check(database,false);return response(bytes,row,true);
}
