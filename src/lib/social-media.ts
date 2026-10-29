import { createHash } from 'node:crypto';
import { database, transaction, type Row, type Executor } from './db';
import { ApiError, uuid } from './auth';
import { getPrivateBucket } from './files';
import { readSocialConfig, socialProvider } from './social-channels';
import {signBridgeRequest} from './bridge-protocol';

const maxBytes=25*1024*1024;
function metaLocation(value:string){
  const u=new URL(value);
  if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash||!(['lookaside.fbsbx.com','mmg.whatsapp.net'].includes(u.hostname)||u.hostname.endsWith('.fbcdn.net')))throw new ApiError(502,'Untrusted provider media location');
  return u.toString();
}
async function bytes(response:Response,limit=maxBytes){
  if(!response.ok||response.status>=300)throw new ApiError(502,'Provider media unavailable');
  if(Number(response.headers.get('content-length')||0)>limit)throw new ApiError(413,'Media requires a larger archival limit');
  const reader=response.body?.getReader();if(!reader)throw new ApiError(502,'Empty provider media');
  const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>limit){await reader.cancel();throw new ApiError(413,'Media requires a larger archival limit');}chunks.push(part.value);}}finally{reader.releaseLock();}
  if(!size)throw new ApiError(502,'Empty provider media');return Buffer.concat(chunks,size);
}
async function providerMedia(row:Row,transport:typeof fetch,allowOwnerOnly:boolean){
  const metadata=typeof row.metadata==='string'?JSON.parse(row.metadata):row.metadata||{};
  // An imported attachment keeps its original channel identity. Its immutable
  // source-file reference, rather than the channel label, selects the source.
  const sourceFile=metadata.sourceSystem==='rrs-sale-office'&&typeof metadata.originalRef==='string'&&metadata.originalRef.startsWith('/api/rrs/files?');
  if(row.provider==='legacy'||sourceFile){
    const workspace=metadata.sourceWorkspace,originalRef=metadata.originalRef;
    if(!['live','domestic'].includes(workspace)||typeof originalRef!=='string'||!originalRef.startsWith('/api/rrs/files?'))throw new ApiError(409,'Legacy file requires operator archival');
    const ref=new URL(originalRef,'https://source.invalid'),id=ref.searchParams.get('id');
    if(!id||!/^[\w-]{1,150}$/.test(id)||ref.pathname!=='/api/rrs/files'||ref.hash||ref.searchParams.getAll('id').length!==1||row.provider_ref!==originalRef||ref.searchParams.has('mode')&&ref.searchParams.get('mode')!==workspace)throw new ApiError(409,'Invalid legacy file reference');
    const origin=process.env.CRM_LEGACY_SOURCE_ORIGIN||'',secret=process.env.CRM_BRIDGE_SECRET||'';
    let base:URL;try{base=new URL(origin);}catch{throw new ApiError(503,'Legacy source is not configured');}
    if(base.protocol!=='https:'||base.origin!==origin||base.username||base.password||secret.length<32||process.env.CRM_BRIDGE_ORG_ID!==row.org_id)throw new ApiError(503,'Legacy source is not configured');
    const url=origin+'/api/rrs/chat-migration/files?workspace='+workspace+'&id='+encodeURIComponent(id)+(allowOwnerOnly?'&owner=true':'');
    const response=await transport(url,{headers:await signBridgeRequest(url,{secret,orgId:row.org_id}),redirect:'manual',signal:AbortSignal.timeout(20000)});
    if(response.headers.get('x-rrs-source-owner-only')==='true'&&!allowOwnerOnly)throw new ApiError(403,'Original file requires owner access');
    const content=await bytes(response),expected=response.headers.get('x-file-sha256');
    if(!expected||!/^[a-f0-9]{64}$/.test(expected)||createHash('sha256').update(content).digest('hex')!==expected)throw new ApiError(502,'Legacy file checksum mismatch');
    return {bytes:content,type:response.headers.get('content-type')||'application/octet-stream',ownerOnly:response.headers.get('x-rrs-source-owner-only')==='true'};
  }
  const config=readSocialConfig(socialProvider(row.provider));
  if(config.orgId!==row.org_id||config.accountId!==row.account_id||!config.accessToken)throw new ApiError(503,'Media account is not configured');
  const headers={Authorization:'Bearer '+config.accessToken};
  const get=(url:string,authorization=true)=>transport(url,{headers:authorization?headers:{},redirect:'manual',signal:AbortSignal.timeout(20000)});
  let response:Response;
  if(config.provider==='line'){
    let ref=String(row.provider_ref);if(ref.startsWith('/api/domestic/provider-media?'))ref=new URL(ref,'https://source.invalid').searchParams.get('messageId')||'';
    if(!/^[a-zA-Z0-9_-]{1,200}$/.test(ref))throw new ApiError(409,'Invalid LINE media reference');
    response=await get('https://api-data.line.me/v2/bot/message/'+encodeURIComponent(ref)+'/content');
  }
  else if(config.provider==='whatsapp'){
    if(!/^v\d+\.\d+$/.test(config.apiVersion||''))throw new ApiError(503,'Media API version is not configured');
    const ref=String(row.provider_ref).replace(/^provider:whatsapp:/,'');
    if(!/^[a-zA-Z0-9_-]{1,200}$/.test(ref))throw new ApiError(409,'Invalid WhatsApp media reference');
    const info=await get('https://graph.facebook.com/'+config.apiVersion+'/'+encodeURIComponent(ref));
    let metadata:Record<string,unknown>;try{metadata=JSON.parse((await bytes(info,65536)).toString('utf8'));}catch(error){if(error instanceof ApiError)throw error;throw new ApiError(502,'Invalid provider media metadata');}
    if(typeof metadata.url!=='string')throw new ApiError(502,'Missing provider media location');
    const size=Number(metadata.file_size),expected=metadata.sha256,mime=String(metadata.mime_type||'').toLowerCase();
    if(!Number.isSafeInteger(size)||size<1||size>maxBytes||typeof expected!=='string'||!(/^[a-f0-9]{64}$/i.test(expected)||/^[A-Za-z0-9+/]{43}=$/.test(expected))||!mime)throw new ApiError(415,'Invalid WhatsApp media integrity metadata');
    response=await get(metaLocation(metadata.url));
    const content=await bytes(response,size),type=(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase(),hash=createHash('sha256').update(content);
    const actual=hash.digest();if(content.length!==size||![actual.toString('hex'),actual.toString('base64')].includes(expected)||type!==mime)throw new ApiError(415,'WhatsApp media integrity mismatch');
    return {bytes:content,type:mime,ownerOnly:false};
  }else{
    // Facebook signed CDN URLs need no bearer credential. Never follow redirects or arbitrary URLs.
    let location=row.provider_ref;
    if(!String(location).startsWith('https://')){
      const metadata=typeof row.metadata==='string'?JSON.parse(row.metadata):row.metadata;
      location=metadata?.payload?.url;
    }
    if(typeof location!=='string')throw new ApiError(409,'Media URL needs operator recovery');
    response=await get(metaLocation(location),false);
  }
  const type=(response.headers.get('content-type')||'application/octet-stream').split(';')[0].trim();
  return {bytes:await bytes(response),type:/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(type)?type:'application/octet-stream',ownerOnly:false};
}
async function scoped(orgId:string,id:string,c:Executor=database){
  uuid(id);const row=(await c.query('SELECT a.*,m.source_owner_only FROM social_message_attachments a JOIN messages m ON m.org_id=a.org_id AND m.id=a.message_id JOIN social_message_provenance p ON p.org_id=a.org_id AND p.message_id=a.message_id WHERE a.org_id=$1 AND a.id=$2 AND a.removed_at IS NULL AND p.removed_at IS NULL AND a.storage_state!=\'removed\'',[orgId,id])).rows[0];
  if(!row)throw new ApiError(404,'Attachment unavailable');return row;
}
export type ArchiveBytes={bytes:Uint8Array;type:string;ownerOnly?:boolean};
function permitted(row:Row,allowOwnerOnly:boolean){
  const metadata=typeof row.metadata==='string'?JSON.parse(row.metadata):row.metadata||{};
  if((row.source_owner_only||metadata.sourceOwnerOnly||metadata.sourceScopeUnknown)&&!allowOwnerOnly)throw new ApiError(403,'Original file permissions require an administrator');
  return metadata;
}
/** Call only after original staff/service authorization; never grants download access. */
export async function archiveSocialAttachmentBytes(orgId:string,id:string,file:ArchiveBytes,options:{allowOwnerOnly?:boolean;guard?:()=>Promise<void>}={}){
  const allowOwnerOnly=options.allowOwnerOnly===true;
  const row=await scoped(orgId,id);
  const metadata=permitted(row,allowOwnerOnly),key=`${orgId}/${id}`,hash=createHash('sha256').update(file.bytes).digest('hex');
  if(!file.bytes.length||file.bytes.length>maxBytes||!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(file.type))throw new ApiError(415,'Invalid archive bytes');
  if(file.ownerOnly&&!allowOwnerOnly)throw new ApiError(403,'Original file requires owner access');
    if(metadata.reviewedSale&&(hash!==metadata.sha256||file.bytes.length!==metadata.size||file.type!==metadata.mime))throw new ApiError(409,'Reviewed attachment bytes no longer match the approved source');
    await options.guard?.();
    await transaction(orgId,async c=>{
      const current=await scoped(orgId,id,c);permitted(current,allowOwnerOnly);
      const existing=(await c.query('SELECT * FROM social_media_archive WHERE org_id=$1 AND attachment_id=$2',[orgId,id])).rows[0];
      if(existing){if(existing.sha256!==hash||existing.size_bytes!==file.bytes.length||existing.content_type!==file.type)throw new ApiError(409,'Provider media changed during recovery');return;}
      const used=Number((await c.query('SELECT (SELECT COALESCE(SUM(size_bytes),0) FROM attachments WHERE org_id=$1)+(SELECT COALESCE(SUM(size_bytes),0) FROM social_media_archive WHERE org_id=$1) AS total',[orgId])).rows[0].total);
      const quota=Number(process.env.FILE_STORAGE_LIMIT_BYTES||1073741824);
      if(!Number.isSafeInteger(quota)||used+file.bytes.length>quota)throw new ApiError(409,'Private storage quota exceeded');
      await c.query("INSERT INTO social_media_archive(org_id,attachment_id,object_key,size_bytes,content_type,sha256,status,created_at) VALUES($1,$2,$3,$4,$5,$6,'pending',$7)",[orgId,id,key,file.bytes.length,file.type,hash,new Date().toISOString()]);
    });
    await options.guard?.();permitted(await scoped(orgId,id),allowOwnerOnly);
    const storage=await getPrivateBucket(),existingObject=await storage.get(key);
    if(existingObject){
      const existingBytes=await bytes(new Response(existingObject.body));
      if(createHash('sha256').update(existingBytes).digest('hex')!==hash)throw new ApiError(409,'Private object checksum mismatch');
    }else await storage.put(key,file.bytes,{httpMetadata:{contentType:file.type}});
    await options.guard?.();
    await transaction(orgId,async c=>{
      const current=await scoped(orgId,id,c);permitted(current,allowOwnerOnly);
      await c.query("UPDATE social_media_archive SET status='ready' WHERE org_id=$1 AND attachment_id=$2",[orgId,id]);
      const currentMetadata=typeof current.metadata==='string'?JSON.parse(current.metadata):current.metadata||{};
      await c.query("UPDATE social_message_attachments SET storage_state='archived',object_key=$3,metadata=$4 WHERE org_id=$1 AND id=$2",[orgId,id,key,JSON.stringify({...currentMetadata,...(file.ownerOnly?{sourceOwnerOnly:true}:{})})]);
    });
}
/** Used by the durable inbound queue and authorized downloads; no customer sends. */
export async function archiveSocialAttachment(orgId:string,id:string,transport:typeof fetch=fetch,allowOwnerOnly=false,guard?:()=>Promise<void>){
  const row=await scoped(orgId,id);permitted(row,allowOwnerOnly);await guard?.();
  const archived=(await database.query("SELECT * FROM social_media_archive WHERE org_id=$1 AND attachment_id=$2 AND status='ready'",[orgId,id])).rows[0];
  if(!archived&&permitted(row,allowOwnerOnly).reviewedSale)throw new ApiError(503,'Reviewed original archive is not ready');
  if(!archived)await archiveSocialAttachmentBytes(orgId,id,await providerMedia(row,transport,allowOwnerOnly),{allowOwnerOnly,guard});
  if(archived){const stored=await(await getPrivateBucket()).get(archived.object_key);if(!stored)throw new ApiError(503,'Archived attachment missing; recovery required');await stored.body.cancel();}
  await guard?.();permitted(await scoped(orgId,id),allowOwnerOnly);
}
/** Called only after staff or signed-service authorization. */
export async function downloadSocialAttachment(orgId:string,id:string,transport:typeof fetch=fetch,allowOwnerOnly=false,readBucket:typeof getPrivateBucket=getPrivateBucket){
  await archiveSocialAttachment(orgId,id,transport,allowOwnerOnly);
  const archived=(await database.query("SELECT * FROM social_media_archive WHERE org_id=$1 AND attachment_id=$2 AND status='ready'",[orgId,id])).rows[0];
  if(!archived)throw new ApiError(503,'Archived attachment is not ready');
  const current=await scoped(orgId,id),currentMetadata=typeof current.metadata==='string'?JSON.parse(current.metadata):current.metadata||{};
  if((currentMetadata.sourceOwnerOnly||currentMetadata.sourceScopeUnknown)&&!allowOwnerOnly)throw new ApiError(403,'Original file permissions require an administrator');
  const file=await(await readBucket()).get(archived.object_key);if(!file)throw new ApiError(503,'Archived attachment missing; recovery required');
  try{permitted(await scoped(orgId,id),allowOwnerOnly);}catch(error){await file.body.cancel();throw error;}
  return new Response(file.body,{headers:{'Content-Type':archived.content_type,'Content-Length':String(archived.size_bytes),'Content-Disposition':`attachment; filename="${id}"`,'Cache-Control':'private, no-store, no-transform','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"}});
}
