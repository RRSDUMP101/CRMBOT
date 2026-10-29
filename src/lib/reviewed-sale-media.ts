import {createHash,randomUUID} from 'node:crypto';
import {ApiError} from './errors';
import {database,transaction,type Executor,type Row} from './db';
import {signBridgeRequest} from './bridge-protocol';
import {readSocialConfig,type SocialChannelConfig} from './social-channels';
import {archiveSocialAttachmentBytes} from './social-media';

export type ReviewedPrivateFile={kind:'private-file';fileId:string;sourceRecordKind:'media'|'quote';sourceRecordId:string;sha256:string;size:number;mime:string;name:string;ownerOnly?:true};
export type ReviewedSalePart={kind:'text';text:string}|ReviewedPrivateFile;
type Guard=(c:Executor,command:Row,config:SocialChannelConfig,epoch?:number)=>Promise<Row>;
type Options={config?:SocialChannelConfig;fetch?:typeof fetch;guard:Guard};
const now=()=>new Date().toISOString().replace(/(\.\d{3})Z$/,(_,f)=>f+'000Z');
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const accepted=new Set(['submitted','sent','delivered','read']);
const ranks:Record<string,number>={submitted:1,sent:2,failed:2,delivered:3,read:4};
// Meta primary guide + its linked fbsamples validator specify decimal MB limits.
// https://whatsappbusiness.com/blog/media-messages-via-app/
// https://github.com/fbsamples/whatsapp-api-examples/blob/main/media-messages-js/boilerplate/helper/validations.js
// The source uploader caps every file at20MiB. Unknown MIME types never fall back to document.
const formats:Record<string,{type:'image'|'video'|'audio'|'document';limit:number}>={
 'image/jpeg':{type:'image',limit:5_000_000},'image/png':{type:'image',limit:5_000_000},
 'video/mp4':{type:'video',limit:16_000_000},'audio/mpeg':{type:'audio',limit:16_000_000},'audio/mp4':{type:'audio',limit:16_000_000},
 'application/pdf':{type:'document',limit:20*1024*1024},'text/plain':{type:'document',limit:20*1024*1024},
 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':{type:'document',limit:20*1024*1024},
 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':{type:'document',limit:20*1024*1024},
};
function object(value:unknown):Row{if(!value||typeof value!=='object'||Array.isArray(value))throw new ApiError(400,'Invalid reviewed part');return value as Row;}
export function parseReviewedParts(raw:unknown,parent:{text:string;template:unknown}):ReviewedSalePart[]{
 if(raw===undefined)return [{kind:'text',text:parent.text}];
 if(!Array.isArray(raw)||!raw.length||raw.length>21)throw new ApiError(400,'Reviewed message requires1–21parts');
 const seenFiles=new Set<string>();
 const parts=raw.map(value=>{const p=object(value);
  if(p.kind==='text'){if(Object.keys(p).some(k=>!['kind','text'].includes(k))||typeof p.text!=='string'||!p.text.trim()||p.text.length>4096)throw new ApiError(400,'Invalid reviewed text part');return p as ReviewedSalePart;}
  if(p.kind!=='private-file'||Object.keys(p).some(k=>!['kind','fileId','sourceRecordKind','sourceRecordId','sha256','size','mime','name','ownerOnly'].includes(k))||p.ownerOnly!==undefined&&p.ownerOnly!==true||!['media','quote'].includes(p.sourceRecordKind)||! /^[A-Za-z0-9-]{1,150}$/.test(p.fileId)||! /^[A-Za-z0-9-]{1,150}$/.test(p.sourceRecordId)||! /^[a-f0-9]{64}$/.test(p.sha256)||typeof p.name!=='string'||!p.name||p.name.length>180||/[\x00-\x1f\x7f\\/]/.test(p.name))throw new ApiError(400,'Invalid reviewed private file');
  const format=formats[p.mime];if(!format||!Number.isSafeInteger(p.size)||p.size<1||p.size>format.limit)throw new ApiError(400,'Unsupported media format or size');
  if(seenFiles.has(p.fileId))throw new ApiError(400,'Duplicate reviewed private file');seenFiles.add(p.fileId);return p as ReviewedPrivateFile;
 });
 if(parts[0].kind!=='text'||parts[0].text!==parent.text)throw new ApiError(400,'First part must be the exact reviewed text');
 if(parent.template!==null&&parts.length!==1)throw new ApiError(400,'Template attachments require a separately approved mapping');
 return parts;
}
export async function stageReviewedSaleParts(c:Executor,orgId:string,outbound:{id:string;accountId:string;remoteId:string},parts:ReviewedSalePart[]){
 if(parts.length===1&&parts[0].kind==='text')return;
 for(const [index,part] of parts.entries()){const payload=JSON.stringify(part);await c.query("INSERT INTO crm_reviewed_sale_parts(org_id,outbound_command_id,part_index,provider,account_id,remote_id,payload_json,payload_hash,created_at,updated_at) VALUES($1,$2,$3,'whatsapp',$4,$5,$6,$7,$8,$8)",[orgId,outbound.id,index,outbound.accountId,outbound.remoteId,payload,sha(payload),now()]);}
}
function mediaContainer(bytes:Uint8Array,mime:string){
 const text=(from:number,to:number)=>new TextDecoder('latin1').decode(bytes.subarray(from,to));
 if(mime==='application/pdf'){if(text(0,5)!=='%PDF-')throw new ApiError(415,'Invalid PDF bytes');return;}
 if(mime==='image/png'){if(Buffer.from(bytes.subarray(0,8)).toString('hex')!=='89504e470d0a1a0a'||text(12,16)!=='IHDR'||bytes[24]!==8||![2,6].includes(bytes[25]))throw new ApiError(415,'PNG requires8-bit RGB/RGBA');return;}
 if(mime==='image/jpeg'){
  if(bytes[0]!==255||bytes[1]!==216)throw new ApiError(415,'Invalid JPEG bytes');
  for(let at=2;at+8<bytes.length;){if(bytes[at++]!==255)break;while(bytes[at]===255)at++;const marker=bytes[at++];if(marker===217||marker===218)break;const size=(bytes[at]<<8)|bytes[at+1];if(size<2||at+size>bytes.length)break;if([192,193,194].includes(marker)){if(bytes[at+2]!==8||bytes[at+7]!==3)throw new ApiError(415,'JPEG requires8-bit three-component color');return;}at+=size;}
  throw new ApiError(415,'JPEG color format could not be verified');
 }
 if(mime==='text/plain'){let value:string;try{value=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new ApiError(415,'Text must be UTF-8');}if(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value))throw new ApiError(415,'Invalid text bytes');return;}
 if(mime.startsWith('application/vnd.openxmlformats')){if(text(0,4)!=='PK\x03\x04')throw new ApiError(415,'Invalid Office container');return;}
 if(mime==='audio/mpeg'){if(text(0,3)!=='ID3'&&!(bytes[0]===255&&(bytes[1]&224)===224))throw new ApiError(415,'Invalid MPEG audio bytes');return;}
 if(mime==='video/mp4'||mime==='audio/mp4'){
  if(text(4,8)!=='ftyp')throw new ApiError(415,'Invalid MP4 container');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),codecs:string[]=[];let boxes=0;
  const walk=(start:number,end:number,depth:number)=>{if(depth>9)throw new ApiError(415,'MP4 box depth');for(let at=start;at+8<=end;){if(++boxes>5000)throw new ApiError(415,'MP4 box limit');const size=view.getUint32(at),kind=text(at+4,at+8);if(size<8||at+size>end)throw new ApiError(415,'Unsupported MP4 box');if(['moov','trak','mdia','minf','stbl'].includes(kind))walk(at+8,at+size,depth+1);if(kind==='stsd'){if(size<16)throw new ApiError(415,'Invalid MP4 sample table');const count=view.getUint32(at+12);let p=at+16;for(let i=0;i<count;i++){if(p+8>at+size)throw new ApiError(415,'Invalid MP4 codec');const length=view.getUint32(p);if(length<8||p+length>at+size)throw new ApiError(415,'Invalid MP4 codec');codecs.push(text(p+4,p+8));p+=length;}}at+=size;}};
  walk(0,bytes.length,0);const videos=codecs.filter(c=>c==='avc1').length,audios=codecs.filter(c=>c==='mp4a').length;
  if(codecs.some(c=>!['avc1','mp4a'].includes(c))||audios>1||(mime==='video/mp4'?videos!==1:videos!==0||audios!==1))throw new ApiError(415,'MP4 requires H.264 video and at most one AAC audio track');return;
 }
 throw new ApiError(415,'Unsupported private media bytes');
}
async function boundedBytes(response:Response,maximum:number){const reader=response.body?.getReader();if(!reader)throw new ApiError(503,'Private file body missing');const chunks:Uint8Array[]=[];let length=0;try{while(true){const r=await reader.read();if(r.done)break;length+=r.value.length;if(length>maximum){await reader.cancel();throw new ApiError(413,'Private file exceeds approved size');}chunks.push(r.value);}}finally{reader.releaseLock();}const bytes=new Uint8Array(length);let pos=0;for(const chunk of chunks){bytes.set(chunk,pos);pos+=chunk.length;}return bytes;}
export async function fetchReviewedPrivateBytes(row:Row,index:number,file:ReviewedPrivateFile,transport:typeof fetch,signal:AbortSignal){
 const {reviewedSaleConfig}=await import('./reviewed-sale-messages'),config=reviewedSaleConfig();if(config.orgId!==row.org_id)throw new ApiError(403,'Private file organization mismatch');
 const body=JSON.stringify({commandId:row.command_id,payloadHash:row.payload_hash,partIndex:index,fileId:file.fileId,sha256:file.sha256,nonce:randomUUID()}),url=config.origin+'/api/rrs/crm/reviewed-messages/file';
 const response=await transport(url,{method:'POST',body,headers:await signBridgeRequest(url,{...config,method:'POST',body}),redirect:'manual',cache:'no-store',signal});
 if(!response.ok){await response.body?.cancel();throw new ApiError(409,'Private file authorization is no longer valid');}
 if(response.headers.get('content-type')?.split(';')[0].toLowerCase()!==file.mime||response.headers.get('x-file-sha256')!==file.sha256||(response.headers.get('x-rrs-source-owner-only')==='true')!==!!file.ownerOnly||response.headers.has('content-length')&&Number(response.headers.get('content-length'))!==file.size){await response.body?.cancel();throw new ApiError(409,'Private file metadata changed');}
 const bytes=await boundedBytes(response,file.size);if(bytes.length!==file.size||sha(bytes)!==file.sha256)throw new ApiError(409,'Private file bytes changed');mediaContainer(bytes,file.mime);return bytes;
}
async function providerJson(response:Response){const bytes=await boundedBytes(response,65536);try{return JSON.parse(new TextDecoder().decode(bytes)) as Row;}catch{throw new ApiError(503,'Provider response is ambiguous');}}
function configMatches(config:SocialChannelConfig,command:Row){if(config.provider!=='whatsapp'||config.orgId!==command.org_id||config.accountId!==command.account_id||config.owner!=='crm'||!config.liveEnabled||!config.inboundEnabled||!config.accessToken||!/^v\d+\.\d+$/.test(config.apiVersion||'')||!/^\d{5,40}$/.test(config.accountId))throw new ApiError(503,'Reviewed media channel is disabled or changed');}

async function partRows(c:Executor,orgId:string,commandId:string){return (await c.query('SELECT * FROM crm_reviewed_sale_parts WHERE org_id=$1 AND outbound_command_id=$2 ORDER BY part_index',[orgId,commandId])).rows;}
/** The caller supplies its in-memory overrides: mutation planners do not read their staged writes. */
async function summarize(c:Executor,command:Row,parts:Row[],error=''){
 const anyAccepted=parts.some(p=>accepted.has(p.status)),unknown=parts.some(p=>p.status==='unknown'),failed=parts.some(p=>p.status==='failed'),cancelled=parts.some(p=>p.status==='cancelled'),pending=parts.some(p=>['queued','preparing','sending'].includes(p.status));
 const status=unknown?'unknown':(failed||cancelled)&&anyAccepted?'unknown':failed?'failed':cancelled?'cancelled':pending?'sending':parts.reduce((worst,p)=>ranks[p.status]<ranks[worst]?p.status:worst,'read');
 const partial=anyAccepted&&(unknown||failed||cancelled),code=partial?'partial_delivery':error||parts.find(p=>p.error_code)?.error_code||'';
 const current=(await c.query('SELECT metadata,removed_at FROM social_message_provenance WHERE org_id=$1 AND message_id=$2',[command.org_id,command.message_id])).rows[0];
 // This summary follows the visible parent text. Private filenames and hashes stay on permission-filtered attachments.
 const summaries=parts.map(p=>{const part=JSON.parse(p.payload_json) as ReviewedSalePart;return {index:p.part_index,kind:part.kind,status:p.status,providerMessageId:p.provider_message_id||null,errorCode:p.error_code||''};});
 for(const part of parts){
  const attachment=(await c.query('SELECT id,metadata FROM social_message_attachments WHERE org_id=$1 AND id=$2',[command.org_id,part.attempt_id||''])).rows[0];if(!attachment)continue;
  const removed=['failed','cancelled'].includes(part.status)||!!current?.removed_at;await c.query("UPDATE social_message_attachments SET metadata=$3,removed_at=CASE WHEN $4=1 THEN COALESCE(removed_at,$5) ELSE NULL END,storage_state=CASE WHEN $4=1 THEN 'removed' WHEN object_key IS NOT NULL THEN 'archived' ELSE 'provider_reference' END WHERE org_id=$1 AND id=$2",[command.org_id,attachment.id,JSON.stringify({...attachment.metadata,deliveryStatus:part.status}),removed?1:0,now()]);
 }
 const firstId=parts.find(p=>p.provider_message_id)?.provider_message_id||null;
 await c.query('UPDATE social_outbound_commands SET status=$3,error_code=$4,provider_message_id=COALESCE(provider_message_id,$5),updated_at=$6 WHERE org_id=$1 AND id=$2',[command.org_id,command.id,status,code,firstId,now()]);
 await c.query('UPDATE social_message_provenance SET delivery_status=$3,provider_message_id=COALESCE(provider_message_id,$4),metadata=$5 WHERE org_id=$1 AND message_id=$2',[command.org_id,command.message_id,status,firstId,JSON.stringify({...current?.metadata,multipart:{partial,parts:summaries}})]);
 return status;
}
async function finishPart(orgId:string,commandId:string,index:number,attempt:string,state:string,error:string,providerId?:string){
 return transaction(orgId,async c=>{
  const command=(await c.query('SELECT * FROM social_outbound_commands WHERE org_id=$1 AND id=$2',[orgId,commandId])).rows[0],parts=await partRows(c,orgId,commandId),part=parts[index];
  if(!command||!part||part.attempt_id!==attempt)throw new ApiError(409,'Reviewed part attempt changed');
  if(!['preparing','sending'].includes(part.status))return command.status as string;
  let status=state;
  if(providerId){
   const collision=(await c.query('SELECT outbound_command_id,part_index FROM crm_reviewed_sale_parts WHERE org_id=$1 AND provider=$2 AND account_id=$3 AND provider_message_id=$4',[orgId,part.provider,part.account_id,providerId])).rows[0];
   const nativeCollision=(await c.query('SELECT message_id,remote_id FROM social_message_provenance WHERE org_id=$1 AND provider=$2 AND account_id=$3 AND provider_message_id=$4',[orgId,part.provider,part.account_id,providerId])).rows[0];
   if(collision&&(collision.outbound_command_id!==commandId||collision.part_index!==index)||nativeCollision&&nativeCollision.message_id!==command.message_id){status='unknown';error='provider_message_id_conflict';providerId=undefined;}
   else{const receipt=(await c.query('SELECT * FROM social_delivery_receipts WHERE org_id=$1 AND provider=$2 AND account_id=$3 AND provider_message_id=$4',[orgId,part.provider,part.account_id,providerId])).rows[0];if(receipt&&receipt.remote_id===part.remote_id&&(ranks[receipt.status]||0)>=(ranks[status]||0))status=receipt.status;}
  }
  Object.assign(part,{status,error_code:error,provider_message_id:providerId||null,updated_at:now()});
  await c.query('UPDATE crm_reviewed_sale_parts SET status=$4,error_code=$5,provider_message_id=$6,updated_at=$7 WHERE org_id=$1 AND outbound_command_id=$2 AND part_index=$3',[orgId,commandId,index,status,error,providerId||null,part.updated_at]);
  if(!accepted.has(status))for(const rest of parts.filter(p=>p.status==='queued')){Object.assign(rest,{status:'cancelled',error_code:'earlier_part_stopped'});await c.query("UPDATE crm_reviewed_sale_parts SET status='cancelled',error_code='earlier_part_stopped',updated_at=$4 WHERE org_id=$1 AND outbound_command_id=$2 AND part_index=$3",[orgId,commandId,rest.part_index,now()]);}
  return summarize(c,command,parts,error);
 });
}
/** Link exact-account receipts to their own part; a receipt for part0 cannot mark the whole group read. */
export async function applyReviewedSaleReceipt(c:Executor,config:SocialChannelConfig,event:{mid?:string;remote:string;status?:string;at:string;metadata?:Record<string,unknown>}){
 if(!event.mid||!event.status)return false;
 let part=(await c.query('SELECT * FROM crm_reviewed_sale_parts WHERE org_id=$1 AND provider=$2 AND account_id=$3 AND provider_message_id=$4',[config.orgId,config.provider,config.accountId,event.mid])).rows[0];
 // A signed provider receipt may arrive before the HTTP response, including after a timeout.
 if(!part&&typeof event.metadata?.attemptId==='string'&&/^[a-f0-9-]{36}$/.test(event.metadata.attemptId)){
  const candidate=(await c.query("SELECT * FROM crm_reviewed_sale_parts WHERE org_id=$1 AND provider=$2 AND account_id=$3 AND attempt_id=$4 AND status IN ('sending','unknown') AND provider_message_id IS NULL",[config.orgId,config.provider,config.accountId,event.metadata.attemptId])).rows[0];
  if(candidate&&candidate.remote_id===event.remote){const collision=(await c.query('SELECT message_id FROM social_message_provenance WHERE org_id=$1 AND provider=$2 AND account_id=$3 AND provider_message_id=$4',[config.orgId,config.provider,config.accountId,event.mid])).rows[0];if(!collision)part=candidate;}
 }
 if(!part)return false;if(part.remote_id!==event.remote)return true;
 const command=(await c.query('SELECT * FROM social_outbound_commands WHERE org_id=$1 AND id=$2',[config.orgId,part.outbound_command_id])).rows[0];
 if(!command)return true;const parts=await partRows(c,config.orgId,command.id),current=parts[part.part_index];
 if((ranks[event.status]||0)<(ranks[current.status]||0)||current.status==='cancelled')return true;
 current.status=event.status;current.error_code=event.status==='failed'?'provider_delivery_failed':'';current.provider_message_id=event.mid;
 await c.query('UPDATE crm_reviewed_sale_parts SET status=$4,error_code=$5,updated_at=$6,provider_message_id=$7 WHERE org_id=$1 AND outbound_command_id=$2 AND part_index=$3',[config.orgId,command.id,part.part_index,current.status,current.error_code,now(),event.mid]);
 await summarize(c,command,parts);return true;
}
async function proof(orgId:string,commandId:string,transport:typeof fetch){await (await import('./reviewed-sale-messages')).validateReviewedSaleDispatch(orgId,commandId,transport);}
/** Returns null for the ordinary single-text/template path. Every accepted/ambiguous part is final. */
export async function dispatchReviewedSaleMultipart(orgId:string,commandId:string,options:Options):Promise<{commandId:string;status:string}|null>{
 if(!(await database.query('SELECT 1 FROM crm_reviewed_sale_parts WHERE org_id=$1 AND outbound_command_id=$2 LIMIT 1',[orgId,commandId])).rows.length)return null;
 const transport=options.fetch||fetch;
 const claim=await transaction<Row & {claimed:boolean}>(orgId,async c=>{
  const command=(await c.query('SELECT * FROM social_outbound_commands WHERE org_id=$1 AND id=$2',[orgId,commandId])).rows[0];if(!command)throw new ApiError(404,'Reviewed command missing');
  const parts=await partRows(c,orgId,commandId);
  if(command.status==='sending'&&command.lease_expires_at&&command.lease_expires_at<now()){
   for(const part of parts)if(['preparing','sending','queued'].includes(part.status)){const status=part.status==='queued'?'cancelled':'unknown';Object.assign(part,{status,error_code:'part_lease_expired'});await c.query('UPDATE crm_reviewed_sale_parts SET status=$4,error_code=$5,updated_at=$6 WHERE org_id=$1 AND outbound_command_id=$2 AND part_index=$3',[orgId,commandId,part.part_index,status,'part_lease_expired',now()]);}
   return {...command,status:await summarize(c,command,parts,'part_lease_expired'),claimed:false};
  }
  if(command.status!=='queued')return {...command,claimed:false};
  const config=options.config||readSocialConfig('whatsapp');configMatches(config,command);const control=await options.guard(c,command,config),attempt=randomUUID(),lease=new Date(Date.now()+90_000).toISOString().replace(/(\.\d{3})Z$/,(_,f)=>f+'000Z');
  await c.query("UPDATE social_outbound_commands SET status='sending',attempt_id=$3,control_epoch=$4,lease_expires_at=$5,updated_at=$6 WHERE org_id=$1 AND id=$2",[orgId,commandId,attempt,control.epoch,lease,now()]);
  await c.query("UPDATE social_message_provenance SET delivery_status='sending',provider_timestamp=$3 WHERE org_id=$1 AND message_id=$2",[orgId,command.message_id,now()]);
  return {...command,status:'sending',attempt_id:attempt,control_epoch:control.epoch,claimed:true};
 });
 if(!claim.claimed)return {commandId,status:claim.status};
 const source=(await database.query('SELECT * FROM crm_reviewed_sale_commands WHERE org_id=$1 AND outbound_command_id=$2',[orgId,commandId])).rows[0];
 if(!source)throw new ApiError(409,'Reviewed source manifest missing');
 const payload=JSON.parse(source.payload_json),parts=parseReviewedParts(payload.parts,payload),stored=await partRows(database,orgId,commandId);
 if(parts.length!==stored.length||parts.some((part,i)=>sha(JSON.stringify(part))!==stored[i].payload_hash||sha(stored[i].payload_json)!==stored[i].payload_hash))throw new ApiError(409,'Reviewed part manifest changed');
 let final='sending';
 for(const [index,part] of parts.entries()){
  const attempt=randomUUID(),config=options.config||readSocialConfig('whatsapp'),abort=new AbortController();let busy=false,effect=false,providerRejected=false;
  await transaction(orgId,async c=>{const current=(await partRows(c,orgId,commandId))[index];if(current.status!=='queued')throw new ApiError(409,'Reviewed part was already attempted');const lease=new Date(Date.now()+90_000).toISOString().replace(/(\.\d{3})Z$/,(_,f)=>f+'000Z');await c.query("UPDATE crm_reviewed_sale_parts SET status='preparing',attempt_id=$4,lease_expires_at=$5,updated_at=$6 WHERE org_id=$1 AND outbound_command_id=$2 AND part_index=$3",[orgId,commandId,index,attempt,lease,now()]);await c.query('UPDATE social_outbound_commands SET lease_expires_at=$3 WHERE org_id=$1 AND id=$2',[orgId,commandId,lease]);});
  const assertCurrent=async()=>{const current=options.config||readSocialConfig('whatsapp');configMatches(current,claim);await proof(orgId,commandId,transport);await options.guard(database,claim,current,claim.control_epoch);if(abort.signal.aborted)throw new ApiError(409,'Reviewed send interrupted');};
  const timer=setTimeout(()=>abort.abort(),70_000),monitor=setInterval(async()=>{if(busy)return;busy=true;try{await assertCurrent();}catch{abort.abort();}finally{busy=false;}},1000);
  try{
   await assertCurrent();let body:Row={type:'text',text:{preview_url:false,body:part.kind==='text'?part.text:''}};
   if(part.kind==='private-file'){
    const bytes=await fetchReviewedPrivateBytes(source,index,part,transport,abort.signal);await assertCurrent();
    const form=new FormData();form.append('messaging_product','whatsapp');form.append('type',part.mime);form.append('file',new Blob([bytes],{type:part.mime}),part.name);
    effect=true;const uploaded=await transport('https://graph.facebook.com/'+config.apiVersion+'/'+config.accountId+'/media',{method:'POST',headers:{Authorization:'Bearer '+config.accessToken},body:form,redirect:'manual',signal:abort.signal});
    if(!uploaded.ok){providerRejected=uploaded.status>=400&&uploaded.status<500;await uploaded.body?.cancel();throw new ApiError(providerRejected?400:503,'provider_media_upload_rejected');}
    const data=await providerJson(uploaded);if(typeof data.id!=='string'||!/^\d{1,200}$/.test(data.id))throw new ApiError(503,'provider_media_id_missing');
    // The upload receipt is known, but no customer media message has been attempted yet.
    effect=false;
    await transaction(orgId,async c=>{
     const current=(await partRows(c,orgId,commandId))[index];if(current.attempt_id!==attempt||current.status!=='preparing')throw new ApiError(409,'Reviewed part claim changed');
     await c.query('UPDATE crm_reviewed_sale_parts SET provider_media_id=$4,updated_at=$5 WHERE org_id=$1 AND outbound_command_id=$2 AND part_index=$3',[orgId,commandId,index,data.id,now()]);
     await c.query("INSERT INTO social_message_attachments(id,org_id,message_id,provider,account_id,media_type,provider_ref,metadata) VALUES($1,$2,$3,'whatsapp',$4,$5,$6,$7)",[attempt,orgId,claim.message_id,config.accountId,formats[part.mime].type,data.id,JSON.stringify({name:part.name,mime:part.mime,size:part.size,sha256:part.sha256,deliveryStatus:'preparing',sourceOwnerOnly:!!part.ownerOnly,reviewedSale:{outboundCommandId:commandId,partIndex:index}})]);
    });
    // Preserve the exact reviewed source copy before sending its provider media ID. A CDN may later expire or transcode it.
    await archiveSocialAttachmentBytes(orgId,attempt,{bytes,type:part.mime,ownerOnly:!!part.ownerOnly},{allowOwnerOnly:!!part.ownerOnly,guard:assertCurrent});
    const type=formats[part.mime].type;body={type,[type]:{id:data.id,...type==='document'?{filename:part.name}:{}}};effect=false;
   }
   await assertCurrent();await transaction(orgId,async c=>{await options.guard(c,claim,config,claim.control_epoch);await c.query("UPDATE crm_reviewed_sale_parts SET status='sending',updated_at=$4 WHERE org_id=$1 AND outbound_command_id=$2 AND part_index=$3 AND attempt_id=$5 AND status='preparing'",[orgId,commandId,index,now(),attempt]);});
   effect=true;const response=await transport('https://graph.facebook.com/'+config.apiVersion+'/'+config.accountId+'/messages',{method:'POST',headers:{Authorization:'Bearer '+config.accessToken,'Content-Type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',recipient_type:'individual',to:claim.remote_id,...body,biz_opaque_callback_data:attempt}),redirect:'manual',signal:abort.signal});
   if(!response.ok){providerRejected=response.status>=400&&response.status<500;await response.body?.cancel();throw new ApiError(providerRejected?400:503,'provider_send_rejected');}
   const data=await providerJson(response),id=data.messages?.[0]?.id;if(typeof id!=='string'||!id||id.length>500)throw new ApiError(503,'provider_message_id_missing');
   final=await finishPart(orgId,commandId,index,attempt,'submitted','',id);
  }catch(error){const known=error instanceof ApiError&&error.status>=400&&error.status<500;const state=effect?(providerRejected?'failed':'unknown'):'cancelled';final=await finishPart(orgId,commandId,index,attempt,state,effect&&!providerRejected?'provider_outcome_unknown':known?'review_or_provider_rejected':'review_unavailable');}
  finally{clearTimeout(timer);clearInterval(monitor);}
  if(['unknown','failed','cancelled'].includes(final))break;
 }
 return {commandId,status:final};
}
