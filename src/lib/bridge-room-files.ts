import {createHash} from 'node:crypto';
import {ApiError,fields,rateLimit,uuid} from './auth';
import {database} from './db';
import {mappedBridgeMember} from './bridge-commands';
import {verifyBridgeRequest,type BridgeCredentials} from './bridge-protocol';
import {approveHumanAttachment,downloadHumanAttachment,listHumanAttachments,uploadHumanAttachment} from './human-attachments';

const maxFile=10*1024*1024;
async function room(input:Record<string,unknown>){
  const id=uuid(input.conversationId),actor=await mappedBridgeMember(uuid(input.actorId));
  if(input.workspace!=='domestic'&&input.workspace!=='live')throw new ApiError(400,'Invalid workspace');
  const row=(await database.query('SELECT l.market FROM conversations c JOIN leads l ON l.org_id=c.org_id AND l.id=c.lead_id WHERE c.id=$1 AND c.org_id=$2',[id,actor.orgId])).rows[0];
  if(!row||row.market==='domestic'&&input.workspace!=='domestic'||row.market==='export'&&input.workspace!=='live')throw new ApiError(404,'ไม่พบบทสนทนาในพื้นที่งานนี้');
  await rateLimit('sale-room-files:'+actor.orgId+':'+actor.id,60,60);
  return {id,actor};
}
export async function roomFileAction(input:Record<string,unknown>){
  const {id,actor}=await room(input);
  if(input.action==='list'){
    fields(input,['conversationId','actorId','workspace','action']);
    return Response.json({...await listHumanAttachments(actor,id),actorId:actor.id},{headers:{'Cache-Control':'no-store'}});
  }
  if(input.action==='preview'){
    fields(input,['conversationId','actorId','workspace','action','attachmentId']);
    return downloadHumanAttachment(actor,id,uuid(input.attachmentId));
  }
  if(input.action==='send'){
    fields(input,['conversationId','actorId','workspace','action','attachmentId','clientId','expectedVersion']);
    const result=await approveHumanAttachment(actor,id,{attachmentId:input.attachmentId,clientId:input.clientId,expectedVersion:input.expectedVersion});
    return Response.json(result,{headers:{'Cache-Control':'no-store'}});
  }
  throw new ApiError(400,'Unknown room file action');
}
/** The ordinary bridge HMAC signs the complete manifest including the exact file digest.
 * Authenticate it before buffering binary data. Browser headers never choose actor, MIME or version. */
export async function signedRoomUpload(request:Request,credentials:BridgeCredentials) {
  const encoded=request.headers.get('x-rrs-file-manifest')||'';
  if(!encoded||encoded.length>8000)throw new ApiError(400,'Invalid upload manifest');
  let manifest:string;try{manifest=decodeURIComponent(encoded);}catch{throw new ApiError(400,'Invalid upload manifest');}
  const headers=new Headers(request.headers);headers.delete('content-length');headers.delete('x-rrs-file-manifest');
  await verifyBridgeRequest(new Request(request.url,{method:'POST',headers,body:manifest}),credentials,4096);
  let data:Record<string,unknown>;try{data=JSON.parse(manifest);}catch{throw new ApiError(400,'Invalid upload manifest');}
  if(!data||typeof data!=='object'||Array.isArray(data))throw new ApiError(400,'Invalid upload manifest');
  fields(data,['actorId','conversationId','workspace','name','mime','version','size','digest']);
  if(typeof data.name!=='string'||data.name.length>180||typeof data.mime!=='string'||!['image/png','image/jpeg','application/pdf'].includes(data.mime)
    ||!Number.isSafeInteger(data.version)||Number(data.version)<0||!Number.isSafeInteger(data.size)||Number(data.size)<=0||Number(data.size)>maxFile
    ||typeof data.digest!=='string'||!/^[0-9a-f]{64}$/.test(data.digest))throw new ApiError(400,'Invalid upload manifest');
  const {id,actor}=await room(data),size=Number(data.size);
  const body=request.body?.getReader();if(!body)throw new ApiError(400,'ไม่มีไฟล์');
  const bytes=new Uint8Array(size);let offset=0;
  try{while(true){const part=await body.read();if(part.done)break;if(part.value.byteLength>size-offset){await body.cancel();throw new ApiError(413,'ไฟล์เกินขนาดที่ระบุ');}bytes.set(part.value,offset);offset+=part.value.byteLength;}}
  finally{body.releaseLock();}
  if(offset!==size||createHash('sha256').update(bytes).digest('hex')!==data.digest)throw new ApiError(400,'ไฟล์ไม่ตรงกับรายการที่ยืนยัน');
  const result=await uploadHumanAttachment(actor,id,new Request('https://crm.invalid/internal/room-upload',{method:'POST',body:bytes,
    headers:{'content-type':data.mime,'x-file-name':encodeURIComponent(data.name),'x-conversation-version':String(data.version)}}));
  return Response.json(result,{headers:{'Cache-Control':'no-store'}});
}
