import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { database, demoMode, type Executor } from './db';

import { ApiError } from './errors';
export { ApiError };
export type Staff = { id: string; orgId: string; name: string; email: string; role: 'Admin'|'Agent' };
export type Visitor = { orgId: string; conversationId: string };
export const STAFF_COOKIE = 'rrs_staff';
export const VISITOR_COOKIE = 'rrs_visitor';
export const WIDGET_COOKIE = 'rrs_widget_visitor';
export const isWidgetRequest = (request:Request) => request.headers.get('x-rrs-widget')==='1';
export const visitorCookieName = (request:Request) => isWidgetRequest(request)?WIDGET_COOKIE:VISITOR_COOKIE;

export function hashToken(token: string) {
  const secret = process.env.SESSION_SECRET || (demoMode() ? 'rrs-demo-cookie-secret-not-for-production' : '');
  if (!secret) throw new Error('SESSION_SECRET is not configured');
  return createHmac('sha256', secret).update(token).digest('hex');
}
export const newToken = () => randomBytes(32).toString('base64url');
export function cookieValue(request: Request, key: string) {
  return request.headers.get('cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith(`${key}=`))?.slice(key.length+1) || '';
}
export function setCookie(name: string, token: string, maxAge: number) {
  if(name===WIDGET_COOKIE)return `${name}=${token}; HttpOnly; SameSite=None; Secure; Partitioned; Path=/; Max-Age=${maxAge}`;
  const secure = (process.env.APP_ORIGIN || '').startsWith('https:');
  return `${name}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
export function assertOrigin(request: Request) {
  const expected = process.env.APP_ORIGIN || (demoMode() ? new URL(request.url).origin : '');
  const origin = request.headers.get('origin');
  if (!expected || origin !== expected) throw new ApiError(403, 'ต้นทางคำขอไม่ถูกต้อง กรุณาเปิดเว็บนี้ใหม่');
}
export async function staffSession(request: Request, required = true): Promise<Staff|null> {
  const token = cookieValue(request, STAFF_COOKIE);
  if (token) {
    const result = await database.query("SELECT m.id,m.org_id,m.name,m.email,m.role FROM staff_sessions s JOIN members m ON m.org_id=s.org_id AND m.id=s.member_id WHERE s.token_hash=$1 AND s.expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') AND m.active=true", [hashToken(token)]);
    if (result.rows[0]) { const row=result.rows[0]; return {id:row.id,orgId:row.org_id,name:row.name,email:row.email,role:row.role}; }
  }
  if (required) throw new ApiError(401, 'กรุณาเข้าสู่ระบบ');
  return null;
}
export async function visitorSession(request: Request, required=true): Promise<Visitor|null> {
  const token = cookieValue(request,visitorCookieName(request));
  if (token) {
    const result=await database.query("SELECT org_id,conversation_id FROM visitors WHERE token_hash=$1 AND expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') AND context=$2", [hashToken(token),isWidgetRequest(request)?'widget':'web']);
    if(result.rows[0]) return {orgId:result.rows[0].org_id,conversationId:result.rows[0].conversation_id};
  }
  if(required) throw new ApiError(401,'กรุณาเริ่มบทสนทนาใหม่');
  return null;
}
export function requireAdmin(staff: Staff) { if(staff.role!=='Admin') throw new ApiError(403,'ต้องใช้สิทธิ์ผู้ดูแลระบบ'); }
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const bits = await derivePassword(password,salt);
  return `pbkdf2:600000:${salt}:${Buffer.from(bits).toString('hex')}`;
}
function derivePassword(password: string, salt: string) {
  // Deployed Workers cap native PBKDF2 at 100,000 rounds, unlike local workerd.
  // Keep the existing 600,000-round hashes compatible without weakening their cost.
  return pbkdf2Async(sha256,new TextEncoder().encode(password),Buffer.from(salt,'hex'),{c:600000,dkLen:32});
}
export async function checkPassword(password: string, stored: string) {
  const parts=/^pbkdf2:600000:([0-9a-f]{32}):([0-9a-f]{64})$/.exec(stored);
  if(!parts)return false;
  const [,salt,hash]=parts;
  const bits=await derivePassword(password,salt);
  return timingSafeEqual(Buffer.from(bits),Buffer.from(hash,'hex'));
}

export async function rateLimit(key: string, maximum: number, seconds: number) {
  const result=await database.query("INSERT INTO rate_buckets(key,hits,reset_at) VALUES($1,1,(strftime('%Y-%m-%dT%H:%M:%f','now','+'||$2||' seconds')||'000Z')) ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN rate_buckets.reset_at<=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') THEN 1 ELSE rate_buckets.hits+1 END,reset_at=CASE WHEN rate_buckets.reset_at<=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') THEN excluded.reset_at ELSE rate_buckets.reset_at END RETURNING hits",[hashToken(key),seconds]);
  if(Number(result.rows[0].hits)>maximum) throw new ApiError(429,'ส่งคำขอถี่เกินไป กรุณารอสักครู่แล้วลองใหม่');
}

export async function readJson(request: Request, maximum=64_000): Promise<Record<string,unknown>> {
  if(!request.headers.get('content-type')?.includes('application/json')) throw new ApiError(415,'ต้องส่งข้อมูลแบบ JSON');
  const reader=request.body?.getReader();
  if(!reader) return {};
  const parts: Uint8Array[]=[]; let length=0;
  while(true){const part=await reader.read(); if(part.done)break; length+=part.value.length; if(length>maximum){await reader.cancel();throw new ApiError(413,'ข้อมูลมีขนาดใหญ่เกินไป');}parts.push(part.value);}
  try { const value=JSON.parse(Buffer.concat(parts).toString('utf8')||'{}'); if(!value||typeof value!=='object'||Array.isArray(value)) throw new Error(); return value; }
  catch { throw new ApiError(400,'ข้อมูล JSON ไม่ถูกต้อง'); }
}
export function fields(value: Record<string,unknown>, allowed: string[]) {
  if(Object.keys(value).some(key=>!allowed.includes(key))) throw new ApiError(400,'มีฟิลด์ข้อมูลที่ไม่รองรับ');
}
export function str(value: unknown, label: string, max=200, required=false): string {
  if(value===undefined || value===null){if(required) throw new ApiError(400,`กรุณาระบุ${label}`);return '';}
  if(typeof value!=='string')throw new ApiError(400,`${label}ต้องเป็นข้อความ`);
  const result=value.trim(); if(result.length>max || (required&&!result))throw new ApiError(400,`${label}ไม่ถูกต้อง`); return result;
}
export function uuid(value: unknown, label='รหัส'): string {
  const result=str(value,label,40,true); if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result))throw new ApiError(400,`${label}ไม่ถูกต้อง`);return result;
}
export function oneOf(value: unknown, allowed: string[], label: string): string {
  if(typeof value!=='string'||!allowed.includes(value))throw new ApiError(400,`${label}ไม่ถูกต้อง`);return value;
}
export function tags(value: unknown): string[] {
  if(!Array.isArray(value)||value.length>20)throw new ApiError(400,'แท็กไม่ถูกต้อง');return [...new Set(value.map(item=>str(item,'แท็ก',40,true)))];
}
export function isoDate(value: unknown, label: string): string {
  const raw=str(value,label,64,true); const parsed=new Date(raw);
  if(!/^\d{4}-\d{2}-\d{2}T/.test(raw)||!Number.isFinite(parsed.getTime()))throw new ApiError(400,`${label}ไม่ถูกต้อง`);return parsed.toISOString().replace(/(\.\d{3})Z$/, (_,fraction)=>fraction+'000Z');
}
export async function assignee(executor: Executor, orgId: string, value: unknown): Promise<string|null> {
  if(value===null||value==='')return null; const id=uuid(value);
  const result=await executor.query('SELECT id FROM members WHERE org_id=$1 AND id=$2 AND active=true',[orgId,id]);
  if(!result.rows.length)throw new ApiError(400,'ไม่พบผู้รับผิดชอบในองค์กร');return id;
}
