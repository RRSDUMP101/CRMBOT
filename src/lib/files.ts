import { randomUUID } from 'node:crypto';
import { camel, database, demoMode, transaction } from './db';
import { ApiError, str, uuid, type Staff } from './auth';

export type PrivateBucket = {
  put(key:string,value:Uint8Array,options?:unknown):Promise<unknown>;
  get(key:string):Promise<{body:ReadableStream<Uint8Array>}|null>;
};
async function bucket():Promise<PrivateBucket> {
  if(process.env.RRS_WORKERS==='true') {
    const {getCloudflareContext}=await import('@opennextjs/cloudflare');
    const binding=(getCloudflareContext().env as unknown as {BUCKET?:PrivateBucket}).BUCKET;
    if(!binding)throw new ApiError(503,'ยังไม่ได้เชื่อมพื้นที่เก็บไฟล์');
    return binding;
  }
  if(!demoMode())throw new Error('Production requires a private R2 binding');
  return (await import('./local-files')).localBucket();
}
export const getPrivateBucket = bucket;
async function scopedLead(staff:Staff,id:string) {
  uuid(id);
  if(!(await database.query('SELECT id FROM leads WHERE org_id=$1 AND id=$2',[staff.orgId,id])).rows.length)throw new ApiError(404,'ไม่พบลูกค้า');
}
export async function listFiles(staff:Staff,leadId:string) {
  await scopedLead(staff,leadId);
  const result=await database.query("SELECT id,filename,content_type,size_bytes AS size,created_at FROM attachments WHERE org_id=$1 AND lead_id=$2 AND status='ready' ORDER BY created_at DESC,id DESC LIMIT 200",[staff.orgId,leadId]);
  return {files:result.rows.map(camel)};
}
export async function uploadFile(staff:Staff,leadId:string,request:Request) {
  await scopedLead(staff,leadId);
  const type=request.headers.get('content-type')||'';
  if(!['application/pdf','image/jpeg','image/png'].includes(type))throw new ApiError(415,'รองรับไฟล์ PDF, JPG และ PNG');
  let filename:string;
  try{filename=decodeURIComponent(request.headers.get('x-file-name')||'');}catch{throw new ApiError(400,'ชื่อไฟล์ไม่ถูกต้อง');}
  filename=str(filename,'ชื่อไฟล์',180,true);
  if(/[\x00-\x1f\x7f/\\]/.test(filename))throw new ApiError(400,'ชื่อไฟล์ไม่ถูกต้อง');
  const max=10*1024*1024;
  if(Number(request.headers.get('content-length')||0)>max)throw new ApiError(413,'ไฟล์ต้องมีขนาดไม่เกิน 10 MB');
  const reader=request.body?.getReader();if(!reader)throw new ApiError(400,'ไม่มีไฟล์');
  const chunks:Uint8Array[]=[];let size=0;
  while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>max){await reader.cancel();throw new ApiError(413,'ไฟล์ต้องมีขนาดไม่เกิน 10 MB');}chunks.push(next.value);}
  if(!size)throw new ApiError(400,'ไฟล์ว่าง');
  const bytes=Buffer.concat(chunks,size);
  const valid=type==='application/pdf'?bytes.subarray(0,5).toString()==='%PDF-':type==='image/png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
  if(!valid)throw new ApiError(400,'ชนิดไฟล์ไม่ตรงกับเนื้อหา');
  const id=randomUUID();const key=`${staff.orgId}/${id}`;
  const configured=Number(process.env.FILE_STORAGE_LIMIT_BYTES||1073741824);
  const quota=Number.isSafeInteger(configured)&&configured>0?configured:1073741824;
  // Reserve quota atomically BEFORE R2 writes. Pending rows consume quota but
  // cannot be downloaded. Failed/ambiguous transfers remain for owner recovery.
  await transaction(staff.orgId,async connection=>{
    if(!(await connection.query('SELECT id FROM leads WHERE org_id=$1 AND id=$2',[staff.orgId,leadId])).rows.length)throw new ApiError(404,'ไม่พบลูกค้า');
    const used=Number((await connection.query('SELECT (SELECT COALESCE(sum(size_bytes),0) FROM attachments WHERE org_id=$1)+(SELECT COALESCE(sum(size_bytes),0) FROM social_media_archive WHERE org_id=$1) AS bytes',[staff.orgId])).rows[0].bytes);
    if(used+size>quota)throw new ApiError(409,'พื้นที่ไฟล์ถึงขีดจำกัด กรุณาติดต่อผู้ดูแล');
    await connection.query('INSERT INTO attachments(id,org_id,lead_id,uploaded_by,object_key,filename,content_type,size_bytes) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,staff.orgId,leadId,staff.id,key,filename,type,size]);
  },staff);
  await (await bucket()).put(key,bytes,{httpMetadata:{contentType:type}});
  await transaction(staff.orgId,async connection=>{
    await connection.query("UPDATE attachments SET status='ready' WHERE org_id=$1 AND id=$2",[staff.orgId,id]);
    await connection.query('INSERT INTO audit_events(id,org_id,actor_id,action,entity_id) VALUES($1,$2,$3,$4,$5)',[randomUUID(),staff.orgId,staff.id,'file.uploaded',id]);
  },staff);
  return {id,filename,contentType:type,size};
}
export async function downloadFile(staff:Staff,id:string) {
  uuid(id);
  const row=(await database.query("SELECT object_key,filename,content_type,size_bytes AS size FROM attachments WHERE org_id=$1 AND id=$2 AND status='ready'",[staff.orgId,id])).rows[0];
  if(!row)throw new ApiError(404,'ไม่พบไฟล์');
  const object=await (await bucket()).get(row.object_key);if(!object)throw new ApiError(404,'ไม่พบไฟล์');
  return new Response(object.body,{headers:{
    'Content-Type':row.content_type,'Content-Length':String(row.size),
    'Content-Disposition':`attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(row.filename).replace(/'/g,'%27')}`,
    'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",
  }});
}
