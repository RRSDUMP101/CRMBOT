import {createHash} from 'node:crypto';
import {ApiError,fields,rateLimit,str,uuid} from './auth';
import {bridgeMember} from './bridge-commands';
import {approveHumanAttachment,assertPhotoCase,listHumanAttachments,uploadHumanAttachment} from './human-attachments';
import {database} from './db';

const LIMIT=1_000_000;
const photoTypes=['image/jpeg','image/png'];
function photoId(orgId:string,memberId:string,clientId:string,sourceId?:string){
  const bytes=createHash('sha256').update(JSON.stringify(['sale-photo',orgId,memberId,clientId,sourceId||''])).digest().subarray(0,16);
  bytes[6]=(bytes[6]&15)|128;
  bytes[8]=(bytes[8]&63)|128;
  return bytes.toString('hex').replace(/^(\w{8})(\w{4})(\w{4})(\w{4})(\w{12})$/,'$1-$2-$3-$4-$5');
}
export async function staffPhoto(input:Record<string,unknown>){
  const action=input.action;
  const common=['action','actorId','conversationId','clarificationSourceMessageId'];
  if(action==='capabilities')fields(input,common);
  else if(action==='prepare')fields(input,[...common,'expectedVersion','clientId','mime','name','base64']);
  else if(action==='send')fields(input,[...common,'expectedVersion','clientId','attachmentId']);
  else throw new ApiError(400,'Invalid photo operation');
  const source=input.clarificationSourceMessageId===undefined?undefined:uuid(input.clarificationSourceMessageId);
  const staff=await bridgeMember(uuid(input.actorId),!!source);
  const conversationId=uuid(input.conversationId);
  if(action==='capabilities'){
    const caps=await listHumanAttachments(staff,conversationId);
    if(source)await assertPhotoCase(database,staff.orgId,staff.id,conversationId,source);
    return {supported:caps.enabled&&caps.supported,provider:caps.provider,accept:caps.enabled&&caps.supported?photoTypes:[],maxBytes:LIMIT};
  }
  await rateLimit('sale-photo:'+staff.orgId+':'+staff.id,30,60);
  const clientId=uuid(input.clientId),attachmentId=photoId(staff.orgId,staff.id,clientId,source);
  if(typeof input.expectedVersion!=='number'||!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<0)throw new ApiError(400,'Invalid conversation version');
  if(action==='send'){
    if(uuid(input.attachmentId)!==attachmentId)throw new ApiError(409,'เลือกไฟล์ในร่างเดิมก่อนยืนยันส่ง');
    return approveHumanAttachment(staff,conversationId,{attachmentId,clientId,expectedVersion:input.expectedVersion},{caseSource:source});
  }
  const mime=String(input.mime),name=str(input.name,'ชื่อไฟล์',180,true);
  if(!photoTypes.includes(mime))throw new ApiError(415,'รองรับรูป JPEG และ PNG');
  const data=input.base64;
  if(typeof data!=='string'||!data.length||data.length>4*Math.ceil(LIMIT/3))throw new ApiError(413,'รองรับไฟล์ไม่เกิน 1 MB');
  const bytes=Buffer.from(data,'base64');
  if(bytes.length>LIMIT||bytes.toString('base64')!==data)throw new ApiError(400,'ข้อมูลรูปภาพไม่ถูกต้อง');
  const request=new Request('https://rrs.invalid/staff-photo',{method:'POST',headers:{'Content-Type':mime,'X-File-Name':encodeURIComponent(name),'X-Conversation-Version':String(input.expectedVersion)},body:bytes});
  const uploaded=await uploadHumanAttachment(staff,conversationId,request,{draftId:attachmentId,caseSource:source});
  return {id:uploaded.id,attachmentId:uploaded.id,expectedVersion:uploaded.conversationVersion,filename:uploaded.filename,expiresAt:uploaded.expiresAt};
}
