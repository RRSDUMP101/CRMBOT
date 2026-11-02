import { randomUUID } from 'node:crypto';
import { ApiError, str, uuid, type Staff } from './auth';
import { database, transaction } from './db';
import { getPrivateBucket } from './files';
import { canReadOperatorItem, validateOperatorScope } from './operators';

/** Dedicated library uploads: customer attachments are never silently republished. */
export async function uploadOperatorAsset(staff: Staff, request: Request) {
  const type = request.headers.get('content-type') || '';
  if (!['application/pdf', 'image/jpeg', 'image/png'].includes(type)) throw new ApiError(415, 'รองรับไฟล์ PDF, JPG และ PNG');
  let name: string;
  try { name = decodeURIComponent(request.headers.get('x-file-name') || ''); } catch { throw new ApiError(400, 'ชื่อไฟล์ไม่ถูกต้อง'); }
  const filename = str(name, 'ชื่อไฟล์', 180, true);
  if (/[\x00-\x1f\x7f/\\]/.test(filename)) throw new ApiError(400, 'ชื่อไฟล์ไม่ถูกต้อง');
  const max = 10 * 1024 * 1024;
  if (Number(request.headers.get('content-length') || 0) > max) throw new ApiError(413, 'ไฟล์ต้องไม่เกิน 10 MB');
  const reader = request.body?.getReader(); if (!reader) throw new ApiError(400, 'ไม่มีไฟล์');
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > max) { await reader.cancel(); throw new ApiError(413, 'ไฟล์ต้องไม่เกิน 10 MB'); } chunks.push(chunk.value); }
  if (!size) throw new ApiError(400, 'ไฟล์ว่าง');
  const bytes = Buffer.concat(chunks, size);
  const valid = type === 'application/pdf' ? bytes.subarray(0, 5).toString() === '%PDF-' : type === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!valid) throw new ApiError(400, 'ชนิดไฟล์ไม่ตรงกับเนื้อหา');
  const id = randomUUID(), key = `${staff.orgId}/${id}`;
  await transaction(staff.orgId, async c => {
    const scope = await validateOperatorScope(c, staff, request.headers.get('x-visibility') || 'personal', request.headers.get('x-team-id'));
    const configured = Number(process.env.OPERATOR_STORAGE_LIMIT_BYTES || 100 * 1024 * 1024);
    const quota = Number.isSafeInteger(configured) && configured > 0 ? configured : 100 * 1024 * 1024;
    const used = Number((await c.query('SELECT COALESCE(sum(size_bytes),0) AS bytes FROM operator_assets WHERE org_id=$1', [staff.orgId])).rows[0].bytes);
    if (used + size > quota) throw new ApiError(409, 'พื้นที่คลังสื่อถึงขีดจำกัด');
    await c.query("INSERT INTO operator_assets(id,org_id,owner_id,filename,content_type,size_bytes,object_key,visibility,team_id,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')", [id, staff.orgId, staff.id, filename, type, size, key, scope.visibility, scope.teamId]);
  }, staff);
  await (await getPrivateBucket()).put(key, bytes, { httpMetadata: { contentType: type } });
  await transaction(staff.orgId, async c => {
    await c.query("UPDATE operator_assets SET status='ready' WHERE org_id=$1 AND id=$2", [staff.orgId, id]);
    await c.query("INSERT INTO audit_events(id,org_id,actor_id,action,entity_id) VALUES($1,$2,$3,'operator.asset.upload',$4)", [randomUUID(), staff.orgId, staff.id, id]);
  }, staff);
  return { id, filename, contentType: type, sizeBytes: size };
}
export async function downloadOperatorAsset(staff: Staff, id: string) {
  const row = (await database.query("SELECT * FROM operator_assets WHERE org_id=$1 AND id=$2 AND status='ready'", [staff.orgId, uuid(id)])).rows[0];
  if (!row || !(await canReadOperatorItem(database, staff, row))) throw new ApiError(404, 'ไม่พบสื่อ');
  const object = await (await getPrivateBucket()).get(row.object_key);
  if (!object) throw new ApiError(404, 'ไม่พบสื่อ');
  return new Response(object.body, { headers: { 'Content-Type': row.content_type, 'Content-Length': String(row.size_bytes), 'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(row.filename).replace(/'/g, '%27')}`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" } });
}
