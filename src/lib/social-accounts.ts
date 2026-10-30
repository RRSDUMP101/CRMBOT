/**
 * Multi-account channel registry and guided onboarding (SOCIAL_ACCOUNTS_ENABLED, default off).
 *
 * Scope of this module: registry + onboarding only. Inbound routing and outbound dispatch
 * still use the env-based readSocialConfig()/social_channel_controls path unchanged; the
 * registry only READS that path's signed-webhook and controlled-test evidence, so an
 * account can become "ready" only when the exact stored credential has been proven by the
 * existing controlled test flow. A saved token is never ready by itself.
 *
 * Secrets: provider tokens, LINE channel secrets, PKCE verifiers and short-lived user
 * grants are stored only as AES-256-GCM ciphertext (WebCrypto) under a versioned root key
 * from SOCIAL_TOKEN_KEYS / SOCIAL_TOKEN_KEY_CURRENT, with additional authenticated data
 * binding each ciphertext to its organization, provider, subject and purpose. Nothing in
 * this module returns, logs or audits a token, secret, verifier, OAuth code or state.
 */
import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {ApiError,fields,requireAdmin,uuid,type Staff} from './auth';
import {database,transaction,type Executor,type Row} from './db';
import {readSocialConfig,socialConfigFingerprint,type SocialChannelConfig,type SocialProvider} from './social-channels';
import {verifyRegisteredChannel} from './social-channel-admin';

export type AccountProvider='whatsapp'|'line'|'facebook'|'instagram';
export type MetaProvider='whatsapp'|'facebook'|'instagram';
export const SOCIAL_ACCOUNT_STATES=['not_connected','authorizing','awaiting_selection','missing_permission','awaiting_provider_review','webhook_pending','testing','ready','degraded','expired','disconnected','paused'] as const;
export type SocialAccountState=typeof SOCIAL_ACCOUNT_STATES[number];
type Env=Record<string,string|undefined>;
export type SocialAccountOptions={env?:Env;fetch?:typeof fetch};
export type Sealed={ciphertext:string;iv:string;keyVersion:string};

export const SOCIAL_ACCOUNTS_CALLBACK_PATH='/api/admin/social-accounts/oauth/callback';
const STATE_TTL_MS=10*60_000, GRANT_TTL_MS=30*60_000, EXPIRY_ALERT_MS=7*86_400_000;
const PROVIDER_BYTES=128_000;
const utc=(ms:number)=>new Date(ms).toISOString().replace(/(\.\d{3})Z$/,(_,fraction)=>fraction+'000Z');
const sha256=(value:string)=>createHash('sha256').update(value).digest('hex');
const fail=(code:string,status=409)=>new ApiError(status,code);
const envOf=(options:SocialAccountOptions)=>options.env||process.env;
const idOk=(value:unknown):value is string=>typeof value==='string'&&/^\d{5,40}$/.test(value);
const metaProviders=new Set<string>(['whatsapp','facebook','instagram']);

export function socialAccountsEnabled(env:Env=process.env){return env.SOCIAL_ACCOUNTS_ENABLED==='true';}
function guard(staff:Staff,options:SocialAccountOptions){
  const env=envOf(options);
  if(!socialAccountsEnabled(env))throw fail('not_found',404);
  requireAdmin(staff);
  return env;
}

// ---------------------------------------------------------------- Thai staff messages
// Every machine code maps to one plain-Thai explanation and exactly one next action.
const catalog:Record<string,[string,string]>={
  not_found:['ไม่พบ API ที่ร้องขอ','กลับไปหน้าเชื่อมต่อช่องทาง'],
  https_required:['ต้องเปิดหน้านี้ผ่านการเชื่อมต่อที่ปลอดภัย (HTTPS)','เปิดเว็บไซต์ระบบด้วยลิงก์ https แล้วลองอีกครั้ง'],
  token_storage_unavailable:['ระบบยังไม่พร้อมเก็บกุญแจเชื่อมต่ออย่างปลอดภัย','แจ้งผู้ดูแลเซิร์ฟเวอร์ให้ตั้งค่าการเข้ารหัสกุญแจก่อน'],
  token_key_missing:['ไม่พบกุญแจสำหรับเปิดข้อมูลเชื่อมต่อของบัญชีนี้','แจ้งผู้ดูแลเซิร์ฟเวอร์ หรือเชื่อมต่อบัญชีนี้ใหม่'],
  token_unreadable:['ข้อมูลเชื่อมต่อที่เก็บไว้ใช้งานไม่ได้','เชื่อมต่อบัญชีนี้ใหม่'],
  app_origin_invalid:['ที่อยู่เว็บไซต์ของระบบยังตั้งค่าไม่ถูกต้อง','แจ้งผู้ดูแลเซิร์ฟเวอร์ให้ตรวจที่อยู่เว็บไซต์ของระบบ'],
  meta_not_configured:['ระบบยังไม่ได้ตั้งค่าการเชื่อมต่อกับแอป Meta','แจ้งผู้ดูแลเซิร์ฟเวอร์ให้ตั้งค่าแอป Meta ก่อน'],
  graph_version_invalid:['ยังไม่ได้กำหนดรุ่นการเชื่อมต่อของ Meta ที่ใช้ได้','แจ้งผู้ดูแลเซิร์ฟเวอร์ให้กำหนดรุ่นการเชื่อมต่อของ Meta'],
  redirect_uri_mismatch:['ลิงก์กลับจาก Meta ไม่ตรงกับที่อยู่เว็บไซต์ของระบบ','แจ้งผู้ดูแลเซิร์ฟเวอร์ให้ตั้งลิงก์กลับให้ตรงกับเว็บไซต์ระบบ'],
  oauth_scopes_not_configured:['ยังไม่ได้กำหนดสิทธิ์ที่ต้องขอสำหรับช่องทางนี้','แจ้งผู้ดูแลเซิร์ฟเวอร์ให้กำหนดรายการสิทธิ์ที่ผ่านการตรวจแล้ว'],
  oauth_state_invalid:['ลิงก์ยืนยันไม่ถูกต้องหรือไม่ได้เริ่มจากระบบนี้','เริ่มเชื่อมต่อใหม่จากหน้าเชื่อมต่อช่องทาง'],
  oauth_state_mismatch:['การยืนยันนี้เริ่มจากผู้ใช้หรือการเข้าสู่ระบบอื่น','เข้าสู่ระบบด้วยบัญชีเดิมแล้วเริ่มเชื่อมต่อใหม่'],
  oauth_state_used:['ลิงก์ยืนยันนี้ถูกใช้ไปแล้ว','เริ่มเชื่อมต่อใหม่จากหน้าเชื่อมต่อช่องทาง'],
  oauth_state_expired:['ลิงก์ยืนยันหมดอายุแล้ว (เกิน 10 นาที)','เริ่มเชื่อมต่อใหม่และทำให้เสร็จภายใน 10 นาที'],
  oauth_denied:['ยังไม่ได้กดอนุญาตให้ระบบเชื่อมต่อ','กดเชื่อมต่อใหม่ แล้วกดอนุญาตในหน้าของ Meta'],
  oauth_code_missing:['ไม่ได้รับรหัสยืนยันจาก Meta','เริ่มเชื่อมต่อใหม่อีกครั้ง'],
  login_required:['กรุณาเข้าสู่ระบบก่อนเชื่อมต่อช่องทาง','เข้าสู่ระบบด้วยบัญชีผู้ดูแลแล้วเริ่มเชื่อมต่อใหม่'],
  admin_required:['การเชื่อมต่อช่องทางต้องใช้สิทธิ์ผู้ดูแลระบบ','เข้าสู่ระบบด้วยบัญชีผู้ดูแลระบบแล้วเริ่มเชื่อมต่อใหม่'],
  permission_declined:['ยังไม่ได้อนุญาตสิทธิ์ที่จำเป็นครบทุกข้อ','เชื่อมต่อใหม่และกดอนุญาตทุกรายการที่ระบบขอ'],
  no_assets_granted:['ไม่พบเพจหรือบัญชีที่อนุญาตให้ระบบใช้','เชื่อมต่อใหม่และเลือกเพจหรือบัญชีที่ต้องการในหน้าของ Meta'],
  provider_review_required:['แอปยังรอการอนุมัติสิทธิ์จาก Meta','รอผลการตรวจแอปจาก Meta แล้วเชื่อมต่อใหม่'],
  connection_attempt_not_found:['ไม่พบรายการเชื่อมต่อนี้','เริ่มเชื่อมต่อใหม่'],
  connection_attempt_closed:['รายการเชื่อมต่อนี้ปิดไปแล้ว','เริ่มเชื่อมต่อใหม่หากต้องการเพิ่มบัญชี'],
  connection_attempt_expired:['การอนุญาตหมดเวลาเลือกบัญชีแล้ว (30 นาที)','เริ่มเชื่อมต่อใหม่แล้วเลือกบัญชีทันที'],
  asset_not_authorized:['บัญชีที่เลือกไม่อยู่ในสิทธิ์ที่ได้รับอนุญาต','เชื่อมต่อใหม่และเลือกเพจหรือบัญชีนี้ในหน้าของ Meta'],
  account_not_found:['ไม่พบบัญชีช่องทางนี้','รีเฟรชหน้ารายการบัญชี'],
  account_changed:['บัญชีนี้มีการเปลี่ยนแปลงระหว่างตรวจ','รีเฟรชแล้วลองอีกครั้ง'],
  invalid_state_transition:['ขั้นตอนนี้ยังทำไม่ได้ในสถานะปัจจุบันของบัญชี','ทำขั้นตอนที่ระบบแนะนำให้เสร็จก่อน'],
  invalid_account_action:['ไม่รู้จักคำสั่งนี้','รีเฟรชหน้าแล้วลองอีกครั้ง'],
  explicit_confirmation_required:['ต้องยืนยันก่อนดำเนินการ','ติ๊กช่องยืนยันแล้วกดอีกครั้ง'],
  validation_required:['ต้องตรวจสิทธิ์การเชื่อมต่อให้ผ่านก่อน','กดตรวจสิทธิ์ในขั้นตอนตรวจสิทธิ์'],
  verification_required:['ต้องตรวจบัญชีกับผู้ให้บริการให้ผ่านก่อน','กดตรวจบัญชีในขั้นตอนตรวจบัญชี'],
  waiting_for_signed_webhook:['ยังไม่ได้รับข้อความที่ยืนยันลายเซ็นจากช่องทางนี้หลังเชื่อมต่อ','ส่งข้อความทดสอบจากบัญชีส่วนตัวมาที่ช่องทางนี้ แล้วกดตรวจอีกครั้ง'],
  registry_inbound_pending:['ระบบรับข้อความตอนนี้รองรับเฉพาะบัญชีหลักที่ตั้งค่าไว้ในเซิร์ฟเวอร์','บันทึกบัญชีนี้ไว้ก่อน แล้วรอการเปิดรับข้อความหลายบัญชี'],
  registry_dispatch_pending:['ระบบส่งข้อความตอนนี้ยังใช้กุญแจหลักของเซิร์ฟเวอร์ ไม่ใช่กุญแจของบัญชีนี้','บันทึกบัญชีนี้ไว้ก่อน แล้วรอการย้ายระบบส่งมาใช้ทะเบียนบัญชี'],
  controlled_test_required:['ยังไม่มีผลส่งทดสอบถึงผู้รับทดสอบหลังเชื่อมต่อบัญชีนี้','เปิดเฉพาะผู้รับทดสอบในการ์ดช่องทางด้านบน ส่งตอบ 1 ข้อความ แล้วกดตรวจผลทดสอบ'],
  inbound_unsupported:['ระบบยังไม่รองรับการรับข้อความจาก Instagram','บันทึกบัญชีไว้ก่อน แล้วรอการเพิ่มการรับข้อความ Instagram'],
  activation_not_allowed:['ยังเปิดใช้งานบัญชีนี้ไม่ได้','ทำขั้นตอนทดสอบให้ผ่านก่อน'],
  already_disconnected:['บัญชีนี้ยกเลิกการเชื่อมต่อแล้ว','เชื่อมต่อใหม่หากต้องการใช้อีกครั้ง'],
  line_channel_id_invalid:['Channel ID ต้องเป็นตัวเลข 6–20 หลัก','คัดลอก Channel ID จากแท็บ Basic settings ของ LINE Developers'],
  line_channel_secret_invalid:['Channel secret ต้องเป็นตัวอักษร 0-9 และ a-f จำนวน 32 ตัว','คัดลอก Channel secret จากแท็บ Basic settings อีกครั้ง'],
  line_bot_user_id_invalid:['Your user ID ของบอตต้องขึ้นต้นด้วย U ตามด้วยตัวอักษร 0-9, a-f จำนวน 32 ตัว','คัดลอก Your user ID จากแท็บ Basic settings อีกครั้ง'],
  line_access_token_invalid:['Channel access token มีรูปแบบไม่ถูกต้อง','ออก Channel access token (long-lived) ใหม่ในแท็บ Messaging API แล้ววางอีกครั้ง'],
  display_name_invalid:['ชื่อที่แสดงยาวเกินไปหรือมีอักขระที่ใช้ไม่ได้','ใช้ชื่อสั้น ๆ ไม่เกิน 100 ตัวอักษร'],
  configuration_missing:['การตั้งค่ารับข้อความของเซิร์ฟเวอร์ยังไม่ครบ','แจ้งผู้ดูแลเซิร์ฟเวอร์ให้ตั้งค่ารับข้อความให้ครบ'],
  callback_configuration_invalid:['ลิงก์รับข้อความของระบบตั้งค่าไม่ถูกต้อง','แจ้งผู้ดูแลเซิร์ฟเวอร์ให้ตรวจที่อยู่เว็บไซต์ของระบบ'],
  account_configuration_invalid:['รหัสบัญชีหรือรุ่นการเชื่อมต่อไม่ถูกต้อง','เชื่อมต่อบัญชีนี้ใหม่'],
  whatsapp_account_mode_invalid:['เบอร์ธุรกิจ WhatsApp ของบัญชีนี้ไม่ถูกต้อง','เชื่อมต่อใหม่และเลือกเบอร์ธุรกิจที่ถูกต้อง'],
  provider_account_mismatch:['บัญชีที่ผู้ให้บริการตอบกลับไม่ตรงกับบัญชีที่เลือก','ตรวจว่าใช้กุญแจของบัญชีนี้จริง แล้วเชื่อมต่อใหม่'],
  provider_callback_mismatch:['ลิงก์รับข้อความที่ตั้งไว้ที่ผู้ให้บริการไม่ตรงกับระบบ','คัดลอกลิงก์รับข้อความจากขั้นตอนตั้งค่ารับข้อความไปวางอีกครั้ง'],
  provider_token_app_mismatch:['กุญแจนี้ไม่ได้ออกให้แอปของระบบ','เชื่อมต่อใหม่ผ่านปุ่มเชื่อมต่อของระบบ'],
  provider_permission_missing:['บัญชียังขาดสิทธิ์ที่จำเป็น','เชื่อมต่อใหม่และกดอนุญาตทุกรายการ'],
  provider_token_expired:['สิทธิ์เชื่อมต่อหมดอายุแล้ว','เชื่อมต่อบัญชีนี้ใหม่'],
  provider_token_invalid:['ผู้ให้บริการแจ้งว่ากุญแจนี้ใช้ไม่ได้แล้ว','เชื่อมต่อบัญชีนี้ใหม่'],
  provider_business_sender_mismatch:['เบอร์ธุรกิจไม่ตรงกับเบอร์ที่เลือกไว้','เชื่อมต่อใหม่และเลือกเบอร์ที่ถูกต้อง'],
  provider_phone_not_connected:['เบอร์ WhatsApp นี้ยังไม่พร้อมใช้งานที่ Meta','ตรวจสถานะเบอร์ใน WhatsApp Manager แล้วตรวจอีกครั้ง'],
  provider_subscription_incomplete:['ตรวจการสมัครรับข้อความที่ Meta ไม่ครบ','ลองตรวจอีกครั้งในอีกสักครู่'],
  provider_waba_subscription_mismatch:['บัญชี WhatsApp ยังไม่ได้เปิดรับข้อความกับแอปของระบบ','เปิดรับข้อความให้แอปของระบบใน WhatsApp Manager แล้วตรวจอีกครั้ง'],
  provider_redirect_rejected:['ผู้ให้บริการตอบกลับแบบเปลี่ยนเส้นทาง ระบบจึงหยุดเพื่อความปลอดภัย','ลองอีกครั้งในอีกสักครู่'],
  provider_authentication_failed:['ผู้ให้บริการไม่ยอมรับกุญแจเชื่อมต่อนี้','ออกกุญแจใหม่แล้วเชื่อมต่อใหม่'],
  provider_permission_denied:['ผู้ให้บริการไม่อนุญาตให้ระบบเข้าถึงบัญชีนี้','ตรวจสิทธิ์ของแอปที่ผู้ให้บริการ แล้วเชื่อมต่อใหม่'],
  provider_request_rejected:['ผู้ให้บริการปฏิเสธคำขอ (รหัสยืนยันอาจหมดอายุหรือถูกใช้แล้ว)','เริ่มเชื่อมต่อใหม่อีกครั้ง'],
  provider_response_invalid:['ข้อมูลที่ผู้ให้บริการตอบกลับไม่ถูกต้อง','ลองอีกครั้งในอีกสักครู่'],
  provider_check_failed:['ตรวจกับผู้ให้บริการไม่สำเร็จ','ลองอีกครั้งในอีกสักครู่'],
  provider_unreachable:['ติดต่อผู้ให้บริการไม่ได้','ตรวจการเชื่อมต่ออินเทอร์เน็ตแล้วลองอีกครั้ง'],
};
const stateProblems:Partial<Record<SocialAccountState,string>>={missing_permission:'permission_declined',awaiting_provider_review:'provider_review_required',expired:'provider_token_expired'};
/** Staff-facing explanation for a machine code. Unknown codes never leak raw provider text. */
export function describeSocialAccountError(code:string):{message:string;next:string}{
  const entry=catalog[code];
  if(entry)return {message:entry[0],next:entry[1]};
  // Existing Thai ApiError messages (auth, rate limit, JSON) are already staff-readable.
  if(/[฀-๿]/.test(code))return {message:code,next:'ลองอีกครั้ง หรือรีเฟรชหน้า'};
  return {message:'ดำเนินการไม่สำเร็จ',next:'ลองอีกครั้ง หรือรีเฟรชหน้า'};
}

// ---------------------------------------------------------------- Authenticated encryption
type KeyRing={current:string;keys:Map<string,Uint8Array<ArrayBuffer>>};
const copyBytes=(source:Uint8Array)=>{const target=new Uint8Array(source.length);target.set(source);return target;};
/** Loads the versioned root keys. Every key must decode to exactly 32 random-looking bytes. */
export function socialTokenKeyRing(env:Env=process.env):KeyRing{
  const unavailable=()=>fail('token_storage_unavailable',503);
  const current=env.SOCIAL_TOKEN_KEY_CURRENT||'';let parsed:unknown;
  try{parsed=JSON.parse(env.SOCIAL_TOKEN_KEYS||'');}catch{throw unavailable();}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw unavailable();
  const entries=Object.entries(parsed as Record<string,unknown>),keys=new Map<string,Uint8Array<ArrayBuffer>>();
  if(!entries.length||entries.length>20)throw unavailable();
  for(const [version,value] of entries){
    if(!/^[A-Za-z0-9_.-]{1,32}$/.test(version)||typeof value!=='string'||!/^[A-Za-z0-9+/_-]{43}=?$/.test(value))throw unavailable();
    const bytes=copyBytes(Buffer.from(value.replace(/-/g,'+').replace(/_/g,'/'),'base64'));
    if(bytes.length!==32||bytes.every(byte=>byte===bytes[0]))throw unavailable();
    keys.set(version,bytes);
  }
  if(!keys.has(current))throw unavailable();
  return {current,keys};
}
const additionalData=(purpose:string,subject:string[],version:string)=>copyBytes(new TextEncoder().encode(['rrs-social-secret-v1',purpose,...subject,version].join('\n')));
async function aesKey(bytes:Uint8Array<ArrayBuffer>){return crypto.subtle.importKey('raw',bytes,{name:'AES-GCM'},false,['encrypt','decrypt']);}
/** Encrypts with the current key. `subject` (org/provider/account…) is authenticated, not stored. */
export async function sealSocialSecret(plaintext:string,purpose:string,subject:string[],env:Env=process.env,ring=socialTokenKeyRing(env)):Promise<Sealed>{
  const iv=copyBytes(randomBytes(12));
  const data=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:additionalData(purpose,subject,ring.current),tagLength:128},await aesKey(ring.keys.get(ring.current)!),copyBytes(new TextEncoder().encode(plaintext)));
  return {ciphertext:Buffer.from(data).toString('base64'),iv:Buffer.from(iv).toString('base64'),keyVersion:ring.current};
}
/** Decrypts by the stored key version. Wrong key, tampering or a different subject all fail closed. */
export async function openSocialSecret(sealed:Sealed,purpose:string,subject:string[],env:Env=process.env,ring=socialTokenKeyRing(env)):Promise<string>{
  const key=ring.keys.get(sealed.keyVersion);if(!key)throw fail('token_key_missing',503);
  const iv=copyBytes(Buffer.from(sealed.iv||'','base64')),data=copyBytes(Buffer.from(sealed.ciphertext||'','base64'));
  if(iv.length!==12||data.length<17)throw fail('token_unreadable',503);
  try{
    const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:additionalData(purpose,subject,sealed.keyVersion),tagLength:128},await aesKey(key),data);
    return new TextDecoder('utf-8',{fatal:true}).decode(plain);
  }catch{throw fail('token_unreadable',503);}
}
/** One-way, server-only fingerprint used to bind evidence to an exact credential. */
export const socialTokenFingerprint=(token:string)=>sha256('rrs-social-token-fp-v1\0'+token);
const secretEqual=(left:string,right:string)=>!!left&&!!right&&timingSafeEqual(createHash('sha256').update(left).digest(),createHash('sha256').update(right).digest());
const tokenSubject=(row:Row)=>[row.org_id,row.provider,row.account_id];
const sealedToken=(row:Row):Sealed=>({ciphertext:row.token_ciphertext,iv:row.token_iv,keyVersion:row.key_version});
const sealedSecret=(row:Row):Sealed=>({ciphertext:row.secret_ciphertext,iv:row.secret_iv,keyVersion:row.key_version});

// ---------------------------------------------------------------- State machine
const transitions:Record<SocialAccountState,readonly SocialAccountState[]>={
  not_connected:['authorizing','webhook_pending'],
  authorizing:['awaiting_selection','missing_permission','awaiting_provider_review','not_connected'],
  awaiting_selection:['webhook_pending','missing_permission','awaiting_provider_review','not_connected'],
  missing_permission:['authorizing','webhook_pending','testing','awaiting_provider_review','missing_permission','degraded','expired','paused','disconnected'],
  awaiting_provider_review:['authorizing','webhook_pending','testing','missing_permission','awaiting_provider_review','degraded','expired','paused','disconnected'],
  webhook_pending:['webhook_pending','testing','missing_permission','awaiting_provider_review','degraded','expired','paused','disconnected'],
  testing:['testing','ready','webhook_pending','missing_permission','awaiting_provider_review','degraded','expired','paused','disconnected'],
  ready:['ready','testing','webhook_pending','degraded','expired','missing_permission','awaiting_provider_review','paused','disconnected'],
  degraded:['degraded','webhook_pending','testing','missing_permission','awaiting_provider_review','expired','paused','disconnected'],
  expired:['expired','authorizing','webhook_pending','paused','disconnected'],
  paused:['webhook_pending','testing','disconnected'],
  disconnected:['authorizing','webhook_pending'],
};
export function canTransition(from:SocialAccountState,to:SocialAccountState){return transitions[from]?.includes(to)??false;}
function assertTransition(from:SocialAccountState,to:SocialAccountState){if(!canTransition(from,to))throw fail('invalid_state_transition');}

// ---------------------------------------------------------------- Configuration
function appOrigin(env:Env){
  const raw=env.APP_ORIGIN||'';let url:URL;try{url=new URL(raw);}catch{return '';}
  return url.protocol==='https:'&&url.origin===raw&&!url.username&&!url.password?url.origin:'';
}
export function socialAccountCallbackUrl(provider:AccountProvider,env:Env=process.env){
  const origin=appOrigin(env);return origin&&provider!=='instagram'?origin+'/api/channels/'+provider:'';
}
function metaApp(env:Env){
  const appId=env.META_APP_ID||'',appSecret=env.META_APP_SECRET||'',version=env.META_GRAPH_VERSION||'';
  if(!idOk(appId)||!appSecret)throw fail('meta_not_configured',503);
  // Validated, never hardcoded: operators pin the reviewed Graph API version.
  if(!/^v\d{1,3}\.\d{1,2}$/.test(version))throw fail('graph_version_invalid',503);
  return {appId,appSecret,version};
}
/** Requested scopes come only from META_OAUTH_SCOPES: a list for all Meta channels or a JSON map per channel. */
function oauthScopes(provider:MetaProvider,env:Env){
  const raw=(env.META_OAUTH_SCOPES||'').trim();if(!raw)return [];
  let value:unknown=raw;
  if(raw.startsWith('{')){try{value=(JSON.parse(raw) as Record<string,unknown>)?.[provider];}catch{return [];}}
  const items=Array.isArray(value)?value:typeof value==='string'?value.split(/[\s,]+/):[];
  const scopes=[...new Set(items.filter(item=>item!=='').map(String))];
  return scopes.length<=30&&scopes.every(scope=>/^[a-z][a-z0-9_]{1,63}$/.test(scope))?scopes:[];
}
type MetaConfig={appId:string;appSecret:string;version:string;redirectUri:string;scopes:string[];configId:string};
export function metaOAuthConfig(provider:MetaProvider,env:Env=process.env):MetaConfig{
  const app=metaApp(env),origin=appOrigin(env);
  if(!origin)throw fail('app_origin_invalid',503);
  // The redirect must be exactly this deployment's callback; nothing else is ever sent to Meta.
  const redirectUri=env.META_OAUTH_REDIRECT_URI||'';
  if(redirectUri!==origin+SOCIAL_ACCOUNTS_CALLBACK_PATH)throw fail('redirect_uri_mismatch',503);
  const scopes=oauthScopes(provider,env);if(!scopes.length)throw fail('oauth_scopes_not_configured',503);
  const configId=provider==='whatsapp'?env.META_WHATSAPP_CONFIG_ID||'':'';
  if(configId&&!idOk(configId))throw fail('meta_not_configured',503);
  return {...app,redirectUri,scopes,configId};
}
function metaProvider(value:unknown):MetaProvider{if(typeof value!=='string'||!metaProviders.has(value))throw fail('invalid_account_action',400);return value as MetaProvider;}

// ---------------------------------------------------------------- Provider transport
type Call={method?:'GET'|'POST'|'DELETE';bearer?:string;form?:Record<string,string>;allowEmpty?:boolean};
const providerHosts=new Set(['graph.facebook.com','api.line.me']);
/** Fixed hosts only, redirect:'manual', non-2xx is failure, bounded body, no provider text surfaces. */
async function providerCall(url:string,call:Call,transport:typeof fetch):Promise<Record<string,any>>{
  const target=new URL(url);
  if(target.protocol!=='https:'||!providerHosts.has(target.hostname))throw fail('provider_check_failed',502);
  const headers:Record<string,string>={Accept:'application/json'};
  if(call.bearer)headers.Authorization='Bearer '+call.bearer;
  let body:string|undefined;
  if(call.form){headers['Content-Type']='application/x-www-form-urlencoded';body=new URLSearchParams(call.form).toString();}
  let response:Response;
  try{response=await transport(target.toString(),{method:call.method||'GET',headers,body,redirect:'manual',signal:AbortSignal.timeout(15000)});}
  catch{throw fail('provider_unreachable',502);}
  if(response.status<200||response.status>=300){
    await response.body?.cancel().catch(()=>{});
    const status=response.status;
    throw fail(status>=300&&status<400?'provider_redirect_rejected':status===401?'provider_authentication_failed':status===403?'provider_permission_denied':status===400?'provider_request_rejected':'provider_check_failed',502);
  }
  if(Number(response.headers.get('content-length')||0)>PROVIDER_BYTES){await response.body?.cancel().catch(()=>{});throw fail('provider_response_invalid',502);}
  let text='';const reader=response.body?.getReader();
  if(reader){
    const decoder=new TextDecoder();let size=0;
    try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>PROVIDER_BYTES){await reader.cancel();throw fail('provider_response_invalid',502);}text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}
    finally{reader.releaseLock();}
  }
  if(!text.trim()&&call.allowEmpty)return {};
  try{const value=JSON.parse(text);if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value as Record<string,any>;}
  catch{throw fail('provider_response_invalid',502);}
}
const graphUrl=(version:string,path:string,query:Record<string,string>={})=>{
  const url=new URL(`https://graph.facebook.com/${version}/${path}`);
  for(const [key,value] of Object.entries(query))url.searchParams.set(key,value);
  return url.toString();
};
async function graphList(version:string,path:string,query:Record<string,string>,bearer:string,transport:typeof fetch,maxPages=5){
  const items:any[]=[];let after='';
  for(let page=0;page<maxPages;page++){
    const body=await providerCall(graphUrl(version,path,{...query,limit:'100',...after?{after}:{}}),{bearer},transport);
    if(!Array.isArray(body.data))throw fail('provider_response_invalid',502);
    items.push(...body.data);if(items.length>500)throw fail('provider_response_invalid',502);
    if(!body.paging?.next)break;
    const next=body.paging?.cursors?.after;if(typeof next!=='string'||!next||next.length>2000)throw fail('provider_response_invalid',502);
    after=next;
  }
  return items;
}
function providerToken(value:unknown){
  if(typeof value!=='string'||value.length<20||value.length>4096||!/^[A-Za-z0-9._|+/=-]+$/.test(value))throw fail('provider_response_invalid',502);
  return value;
}
async function debugToken(app:{appId:string;appSecret:string;version:string},token:string,transport:typeof fetch){
  const body=await providerCall(graphUrl(app.version,'debug_token',{input_token:token}),{bearer:app.appId+'|'+app.appSecret},transport);
  if(!body.data||typeof body.data!=='object'||Array.isArray(body.data))throw fail('provider_response_invalid',502);
  return body.data as Record<string,any>;
}
function tokenExpiry(data:Record<string,any>):number|null{
  let expires:number|null=null;
  for(const field of ['expires_at','data_access_expires_at']){
    const seconds=Number(data[field]);
    if(data[field]===undefined||seconds===0||!Number.isFinite(seconds)||seconds<0)continue;
    expires=expires===null?seconds*1000:Math.min(expires,seconds*1000);
  }
  return expires;
}
const grantedScopes=(data:Record<string,any>)=>Array.isArray(data.scopes)?data.scopes.filter((scope:unknown):scope is string=>typeof scope==='string'&&/^[a-z][a-z0-9_]{1,63}$/.test(scope)).slice(0,60):[];
function wabaTargets(data:Record<string,any>){
  const ids=new Set<string>();
  for(const item of Array.isArray(data.granular_scopes)?data.granular_scopes:[])
    if(item&&['whatsapp_business_management','whatsapp_business_messaging'].includes(item.scope)&&Array.isArray(item.target_ids))
      for(const target of item.target_ids)if(idOk(String(target)))ids.add(String(target));
  return [...ids].slice(0,10);
}

// ---------------------------------------------------------------- Identity masking
const cleanName=(value:unknown)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f<>]/g,'').trim().slice(0,100):'';
export function maskIdentity(provider:AccountProvider,value:string){
  const tail=(text:string,count=4)=>text.slice(-count);
  if(provider==='whatsapp'){const digits=value.replace(/\D/g,'');return digits.length>=8?`+${digits.slice(0,2)} ••• ${tail(digits)}`:'•••';}
  if(provider==='line')return value.length>5?`${value[0]}•••${tail(value)}`:'•••';
  if(provider==='instagram'){const name=value.replace(/^@/,'');return name.length>3?`@${name.slice(0,2)}•••`:'@•••';}
  return value.length>4?`•••${tail(value)}`:'•••';
}
type Asset={key:string;id:string;name:string;masked:string;parent:string;identity:string};
const assetKey=(attemptId:string,provider:string,id:string)=>sha256(attemptId+'\0'+provider+'\0'+id).slice(0,24);
function parseJsonArray(value:unknown):any[]{if(Array.isArray(value))return value;try{const parsed=JSON.parse(String(value||'[]'));return Array.isArray(parsed)?parsed:[];}catch{return [];}}
function parseJsonObject(value:unknown):Record<string,any>{try{const parsed=JSON.parse(String(value||'{}'));return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{};}catch{return {};}}

async function listAssets(provider:MetaProvider,app:{version:string},token:string,debug:Record<string,any>,attemptId:string,transport:typeof fetch):Promise<Asset[]>{
  const make=(id:string,name:string,parent:string,identity:string,maskSource:string):Asset=>({key:assetKey(attemptId,provider,id),id,name,masked:maskIdentity(provider,maskSource),parent,identity});
  if(provider==='facebook'){
    const pages=await graphList(app.version,'me/accounts',{fields:'id,name'},token,transport);
    return pages.filter(page=>idOk(String(page?.id))).map(page=>make(String(page.id),cleanName(page.name)||'Facebook Page','','',String(page.id))).slice(0,100);
  }
  if(provider==='instagram'){
    const pages=await graphList(app.version,'me/accounts',{fields:'id,name,instagram_business_account{id,username}'},token,transport);
    return pages.filter(page=>idOk(String(page?.id))&&idOk(String(page?.instagram_business_account?.id))).map(page=>{
      const ig=page.instagram_business_account,username=cleanName(ig.username);
      return make(String(ig.id),username?'@'+username:cleanName(page.name)||'Instagram',String(page.id),'',username||String(ig.id));
    }).slice(0,100);
  }
  const assets:Asset[]=[];
  for(const waba of wabaTargets(debug)){
    const numbers=await graphList(app.version,waba+'/phone_numbers',{fields:'id,display_phone_number,verified_name'},token,transport,2);
    for(const number of numbers){
      const digits=String(number?.display_phone_number||'').replace(/\D/g,'');
      if(idOk(String(number?.id))&&/^[1-9]\d{7,14}$/.test(digits))assets.push(make(String(number.id),cleanName(number.verified_name)||'WhatsApp',waba,digits,digits));
    }
  }
  return assets.slice(0,100);
}

/** Re-asks the provider with the authorized grant; the chosen asset must still belong to it. */
async function confirmAsset(provider:MetaProvider,app:ReturnType<typeof metaApp>,grant:string,asset:Asset,transport:typeof fetch){
  const denied=()=>fail('asset_not_authorized',403);
  if(provider==='facebook'||provider==='instagram'){
    const pages=await graphList(app.version,'me/accounts',{fields:provider==='facebook'?'id,name,access_token':'id,name,access_token,instagram_business_account{id,username}'},grant,transport);
    const page=provider==='facebook'?pages.find(item=>String(item?.id)===asset.id):pages.find(item=>String(item?.id)===asset.parent&&String(item?.instagram_business_account?.id)===asset.id);
    if(!page)throw denied();
    return {token:providerToken(page.access_token),scopes:[] as string[],expires:null as number|null};
  }
  const data=await debugToken(app,grant,transport);
  if(data.is_valid!==true||String(data.app_id)!==app.appId)throw fail('provider_token_app_mismatch');
  if(!wabaTargets(data).includes(asset.parent))throw denied();
  const numbers=await graphList(app.version,asset.parent+'/phone_numbers',{fields:'id,display_phone_number,verified_name'},grant,transport,2);
  const number=numbers.find(item=>String(item?.id)===asset.id);
  if(!number||String(number.display_phone_number||'').replace(/\D/g,'')!==asset.identity)throw denied();
  return {token:grant,scopes:grantedScopes(data),expires:tokenExpiry(data)};
}

// ---------------------------------------------------------------- Persistence helpers
async function audit(c:Executor,staff:Staff,action:string,entityId:string,detail:Record<string,unknown>={}){
  await c.query('INSERT INTO audit_events(id,org_id,actor_id,action,entity_id,metadata) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),staff.orgId,staff.id,'social_account.'+action,entityId,JSON.stringify(detail)]);
}
const sessionBinding=(sessionKey:string)=>{if(!sessionKey)throw fail('login_required',401);return sha256('rrs-oauth-session-v1\0'+sessionKey);};
async function accountRow(c:Executor,orgId:string,id:string){return (await c.query('SELECT * FROM social_accounts WHERE org_id=$1 AND id=$2',[orgId,id])).rows[0];}

type Connect={provider:AccountProvider;accountId:string;parentRef:string;displayName:string;masked:string;identity:string;token:Sealed;secret?:Sealed;fingerprint:string;scopes:string[];expires:number|null;grantId:string|null;from:SocialAccountState};
/** Stores (or replaces) a credential. A new or replaced credential always restarts at webhook_pending. */
async function storeConnection(c:Executor,staff:Staff,data:Connect){
  const existing=(await c.query('SELECT id,state,revision FROM social_accounts WHERE org_id=$1 AND provider=$2 AND account_id=$3',[staff.orgId,data.provider,data.accountId])).rows[0];
  assertTransition(existing?existing.state:data.from,'webhook_pending');
  const time=utc(Date.now()),inbound=data.provider==='instagram'?'unsupported':'pending',outbound=data.provider==='instagram'?'unsupported':'pending';
  const values=[data.parentRef,data.displayName,data.masked,data.identity,inbound,outbound,data.token.ciphertext,data.token.iv,data.secret?.ciphertext??null,data.secret?.iv??null,data.token.keyVersion,data.fingerprint,JSON.stringify(data.scopes),data.expires===null?null:utc(data.expires),time,staff.id,data.grantId];
  if(existing){
    await c.query(`UPDATE social_accounts SET parent_ref=$4,display_name=$5,masked_identity=$6,display_identity=$7,state='webhook_pending',auth_readiness='pending',inbound_readiness=$8,outbound_readiness=$9,
      token_ciphertext=$10,token_iv=$11,secret_ciphertext=$12,secret_iv=$13,key_version=$14,token_fingerprint=$15,scopes=$16,expires_at=$17,connected_at=$18,connected_by=$19,grant_id=$20,
      last_verified_at=NULL,verification_expires_at=NULL,verification_evidence='{}',last_error_code=NULL,revision=revision+1,updated_at=$18 WHERE org_id=$1 AND id=$2 AND revision=$3`,[staff.orgId,existing.id,existing.revision,...values]);
    return existing.id as string;
  }
  const id=randomUUID();
  await c.query(`INSERT INTO social_accounts(id,org_id,provider,account_id,parent_ref,display_name,masked_identity,display_identity,state,auth_readiness,inbound_readiness,outbound_readiness,
    token_ciphertext,token_iv,secret_ciphertext,secret_iv,key_version,token_fingerprint,scopes,expires_at,connected_at,connected_by,grant_id,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'webhook_pending','pending',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$19,$19)`,[id,staff.orgId,data.provider,data.accountId,...values]);
  return id;
}

// ---------------------------------------------------------------- Views (never include credentials)
export type SocialAccountView={id:string;provider:AccountProvider;displayName:string;maskedIdentity:string;state:SocialAccountState;
  readiness:{auth:string;inbound:string;outbound:string};expiresAt:string|null;lastVerifiedAt:string|null;verificationFresh:boolean;connectedAt:string|null;updatedAt:string;
  step:number;callbackUrl:string;problem:{code:string;message:string;next:string}|null;revision:number};
function wizardStep(row:Row,fresh:boolean){
  if(['disconnected','expired','missing_permission','awaiting_provider_review'].includes(row.state))return 3;
  if(row.state==='ready'||row.state==='paused')return 10;
  if(row.auth_readiness!=='ready')return 5;
  if(row.inbound_readiness!=='ready')return 6;
  if(!fresh)return 8;
  if(row.outbound_readiness!=='test_passed'&&row.outbound_readiness!=='ready')return 9;
  return 10;
}
function accountView(row:Row,env:Env):SocialAccountView{
  const fresh=!!row.verification_expires_at&&Date.parse(row.verification_expires_at)>Date.now();
  const code=row.last_error_code||stateProblems[row.state as SocialAccountState]||(row.provider==='instagram'&&row.state==='webhook_pending'&&row.auth_readiness==='ready'?'inbound_unsupported':'');
  return {id:row.id,provider:row.provider,displayName:row.display_name,maskedIdentity:row.masked_identity,state:row.state,
    readiness:{auth:row.auth_readiness,inbound:row.inbound_readiness,outbound:row.outbound_readiness},expiresAt:row.expires_at||null,lastVerifiedAt:row.last_verified_at||null,verificationFresh:fresh,
    connectedAt:row.connected_at||null,updatedAt:row.updated_at,step:wizardStep(row,fresh),callbackUrl:socialAccountCallbackUrl(row.provider,env),
    problem:code?{code,...describeSocialAccountError(code)}:null,revision:Number(row.revision)};
}
function attemptView(row:Row,connected:Set<string>){
  const assets=row.status==='awaiting_selection'?parseJsonArray(row.assets).map((asset:Asset)=>({key:asset.key,name:asset.name,maskedIdentity:asset.masked,alreadyConnected:connected.has(row.provider+'\0'+asset.id)})):[];
  const code=row.error_code||(row.status==='missing_permission'?'permission_declined':row.status==='awaiting_provider_review'?'provider_review_required':'');
  return {id:row.id,provider:row.provider,status:row.status,createdAt:row.created_at,expiresAt:row.status==='authorizing'?row.expires_at:row.grant_expires_at,
    step:row.status==='awaiting_selection'?4:3,assets,problem:code?{code,...describeSocialAccountError(code)}:null};
}

// ---------------------------------------------------------------- Expiry
/** Alert data: connected accounts whose credential expires within 7 days (or already has). */
export async function socialAccountsExpiringSoon(orgId:string,at=Date.now(),c:Executor=database){
  const rows=(await c.query("SELECT id,provider,display_name,masked_identity,expires_at FROM social_accounts WHERE org_id=$1 AND expires_at IS NOT NULL AND expires_at<=$2 AND state<>'disconnected' ORDER BY expires_at LIMIT 100",[orgId,utc(at+EXPIRY_ALERT_MS)])).rows;
  return rows.map(row=>{const ms=Date.parse(row.expires_at)-at;return {id:row.id,provider:row.provider as AccountProvider,displayName:row.display_name,maskedIdentity:row.masked_identity,expiresAt:row.expires_at,daysLeft:Math.max(0,Math.ceil(ms/86_400_000)),expired:ms<=0};});
}
async function settleExpiry(staff:Staff){
  const time=utc(Date.now());
  const lapsedAccounts=(await database.query("SELECT 1 FROM social_accounts WHERE org_id=$1 AND expires_at IS NOT NULL AND expires_at<=$2 AND state NOT IN ('disconnected','expired','paused') LIMIT 1",[staff.orgId,time])).rows.length;
  const lapsedAttempts=(await database.query("SELECT 1 FROM oauth_states WHERE org_id=$1 AND ((consumed_at IS NULL AND expires_at<=$2 AND verifier_ciphertext IS NOT NULL) OR (grant_ciphertext IS NOT NULL AND grant_expires_at<=$2)) LIMIT 1",[staff.orgId,time])).rows.length;
  if(!lapsedAccounts&&!lapsedAttempts)return;
  await transaction(staff.orgId,async c=>{
    // An expired credential can never remain ready; the readiness CHECK is satisfied by leaving 'ready'.
    await c.query("UPDATE social_accounts SET state='expired',auth_readiness='expired',outbound_readiness=CASE WHEN outbound_readiness='unsupported' THEN 'unsupported' ELSE 'blocked' END,revision=revision+1,updated_at=$2 WHERE org_id=$1 AND expires_at IS NOT NULL AND expires_at<=$2 AND state NOT IN ('disconnected','expired','paused')",[staff.orgId,time]);
    await c.query("UPDATE oauth_states SET verifier_ciphertext=NULL,verifier_iv=NULL,status='failed',error_code='oauth_state_expired',updated_at=$2 WHERE org_id=$1 AND consumed_at IS NULL AND expires_at<=$2 AND verifier_ciphertext IS NOT NULL",[staff.orgId,time]);
    await c.query("UPDATE oauth_states SET grant_ciphertext=NULL,grant_iv=NULL,status=CASE WHEN status='awaiting_selection' THEN 'failed' ELSE status END,error_code=CASE WHEN status='awaiting_selection' THEN 'connection_attempt_expired' ELSE error_code END,updated_at=$2 WHERE org_id=$1 AND grant_ciphertext IS NOT NULL AND grant_expires_at<=$2",[staff.orgId,time]);
  },staff);
}

// ---------------------------------------------------------------- Overview
export async function socialAccountsOverview(staff:Staff,sessionKey:string,options:SocialAccountOptions={}){
  const env=guard(staff,options);
  await settleExpiry(staff);
  const binding=sessionBinding(sessionKey);
  const accounts=(await database.query('SELECT * FROM social_accounts WHERE org_id=$1 ORDER BY created_at,id LIMIT 200',[staff.orgId])).rows;
  const attempts=(await database.query("SELECT * FROM oauth_states WHERE org_id=$1 AND member_id=$2 AND session_binding=$3 AND created_at>=$4 AND status<>'completed' ORDER BY created_at DESC LIMIT 5",[staff.orgId,staff.id,binding,utc(Date.now()-3_600_000)])).rows;
  const connected=new Set(accounts.filter(row=>row.state!=='disconnected').map(row=>row.provider+'\0'+row.account_id));
  let tokenStorage=true;try{socialTokenKeyRing(env);}catch{tokenStorage=false;}
  const meta=Object.fromEntries((['whatsapp','facebook','instagram'] as const).map(provider=>{try{metaOAuthConfig(provider,env);return [provider,true];}catch{return [provider,false];}}));
  return {enabled:true,
    prerequisites:{tokenStorage,appOrigin:!!appOrigin(env),meta,line:tokenStorage&&!!appOrigin(env)},
    callbackUrls:Object.fromEntries((['whatsapp','line','facebook','instagram'] as const).map(provider=>[provider,socialAccountCallbackUrl(provider,env)])),
    accounts:accounts.map(row=>accountView(row,env)),
    attempts:attempts.map(row=>attemptView(row,connected)),
    expiring:await socialAccountsExpiringSoon(staff.orgId)};
}
export async function socialAccountDetail(staff:Staff,accountId:string,options:SocialAccountOptions={}){
  const env=guard(staff,options);await settleExpiry(staff);
  const row=await accountRow(database,staff.orgId,uuid(accountId));if(!row)throw fail('account_not_found',404);
  return accountView(row,env);
}

// ---------------------------------------------------------------- Meta OAuth
export async function startSocialOAuth(staff:Staff,sessionKey:string,input:Record<string,unknown>,options:SocialAccountOptions={}){
  const env=guard(staff,options);fields(input,['provider']);
  const provider=metaProvider(input.provider),meta=metaOAuthConfig(provider,env),ring=socialTokenKeyRing(env),binding=sessionBinding(sessionKey);
  const state=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url');
  const challenge=createHash('sha256').update(verifier).digest('base64url');
  const id=randomUUID(),time=Date.now(),expiresAt=utc(time+STATE_TTL_MS);
  const sealed=await sealSocialSecret(verifier,'oauth-pkce',[staff.orgId,provider,id],env,ring);
  await transaction(staff.orgId,async c=>{
    await c.query("INSERT INTO oauth_states(id,state_hash,org_id,member_id,session_binding,provider,status,key_version,verifier_ciphertext,verifier_iv,expires_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'authorizing',$7,$8,$9,$10,$11,$11)",
      [id,sha256(state),staff.orgId,staff.id,binding,provider,sealed.keyVersion,sealed.ciphertext,sealed.iv,expiresAt,utc(time)]);
    await audit(c,staff,'oauth_started',id,{provider});
  },staff);
  const url=new URL(`https://www.facebook.com/${meta.version}/dialog/oauth`);
  for(const [key,value] of Object.entries({client_id:meta.appId,redirect_uri:meta.redirectUri,state,response_type:'code',scope:meta.scopes.join(','),code_challenge:challenge,code_challenge_method:'S256'}))url.searchParams.set(key,value);
  if(meta.configId){url.searchParams.set('config_id',meta.configId);url.searchParams.set('override_default_response_type','true');}
  return {attemptId:id,provider,authorizeUrl:url.toString(),expiresAt};
}

/**
 * OAuth redirect target. State must exist, belong to this staff session and organization,
 * be unconsumed and unexpired; it is consumed before any provider call. The code is
 * exchanged server-side and the permitted assets are stored for selection.
 */
export async function completeSocialOAuth(staff:Staff,sessionKey:string,query:URLSearchParams,options:SocialAccountOptions={}){
  const env=guard(staff,options),state=query.get('state')||'';
  if(!/^[A-Za-z0-9_-]{43}$/.test(state))throw fail('oauth_state_invalid',400);
  const row=(await database.query('SELECT * FROM oauth_states WHERE state_hash=$1',[sha256(state)])).rows[0];
  if(!row)throw fail('oauth_state_invalid',400);
  if(row.org_id!==staff.orgId||row.member_id!==staff.id||!secretEqual(row.session_binding,sessionBinding(sessionKey)))throw fail('oauth_state_mismatch',403);
  if(row.consumed_at)throw fail('oauth_state_used',409);
  if(!(Date.parse(row.expires_at)>Date.now())||!row.verifier_ciphertext)throw fail('oauth_state_expired',410);
  const sealedVerifier:Sealed={ciphertext:row.verifier_ciphertext,iv:row.verifier_iv,keyVersion:row.key_version};
  // Single use: the compare-and-swap commit lets exactly one concurrent callback proceed.
  await transaction(staff.orgId,async c=>{
    const fresh=(await c.query('SELECT consumed_at FROM oauth_states WHERE org_id=$1 AND id=$2',[staff.orgId,row.id])).rows[0];
    if(!fresh||fresh.consumed_at)throw fail('oauth_state_used',409);
    await c.query('UPDATE oauth_states SET consumed_at=$3,verifier_ciphertext=NULL,verifier_iv=NULL,updated_at=$3 WHERE org_id=$1 AND id=$2 AND consumed_at IS NULL',[staff.orgId,row.id,utc(Date.now())]);
  },staff);
  const provider=row.provider as MetaProvider,transport=options.fetch||fetch;
  const finish=async(status:string,code:string,scopes:string[]=[])=>{
    await transaction(staff.orgId,async c=>{
      await c.query('UPDATE oauth_states SET status=$3,error_code=$4,granted_scopes=$5,updated_at=$6 WHERE org_id=$1 AND id=$2',[staff.orgId,row.id,status,code,JSON.stringify(scopes),utc(Date.now())]);
      await audit(c,staff,'oauth_failed',row.id,{provider,errorCode:code});
    },staff);
    return {attemptId:row.id,status,errorCode:code};
  };
  if(query.get('error'))return finish('failed','oauth_denied');
  const code=query.get('code')||'';
  if(!code||code.length>4096||!/^[A-Za-z0-9._#~-]+$/.test(code))return finish('failed','oauth_code_missing');
  try{
    const meta=metaOAuthConfig(provider,env),ring=socialTokenKeyRing(env);
    const verifier=await openSocialSecret(sealedVerifier,'oauth-pkce',[row.org_id,provider,row.id],env,ring);
    const exchanged=await providerCall(graphUrl(meta.version,'oauth/access_token',{client_id:meta.appId,redirect_uri:meta.redirectUri,client_secret:meta.appSecret,code,code_verifier:verifier}),{},transport);
    let grant=providerToken(exchanged.access_token);
    // Best effort: a long-lived user grant yields durable Page tokens. Failure keeps the
    // short-lived grant, whose real expiry is then shown by the validation step.
    try{grant=providerToken((await providerCall(graphUrl(meta.version,'oauth/access_token',{grant_type:'fb_exchange_token',client_id:meta.appId,client_secret:meta.appSecret,fb_exchange_token:grant}),{},transport)).access_token);}catch{/* keep short-lived grant */}
    const debug=await debugToken(meta,grant,transport);
    if(debug.is_valid!==true||String(debug.app_id)!==meta.appId)return finish('failed','provider_token_app_mismatch');
    const scopes=grantedScopes(debug);
    if(meta.scopes.some(scope=>!scopes.includes(scope)))return finish('missing_permission','permission_declined',scopes);
    const assets=await listAssets(provider,meta,grant,debug,row.id,transport);
    if(!assets.length)return finish('missing_permission','no_assets_granted');
    const sealed=await sealSocialSecret(grant,'oauth-grant',[row.org_id,provider,row.id],env,ring);
    const expires=tokenExpiry(debug),grantExpires=Math.min(Date.now()+GRANT_TTL_MS,expires??Infinity);
    await transaction(staff.orgId,async c=>{
      await c.query("UPDATE oauth_states SET status='awaiting_selection',key_version=$3,grant_ciphertext=$4,grant_iv=$5,granted_scopes=$6,assets=$7,grant_expires_at=$8,error_code=NULL,updated_at=$9 WHERE org_id=$1 AND id=$2",
        [staff.orgId,row.id,sealed.keyVersion,sealed.ciphertext,sealed.iv,JSON.stringify(scopes),JSON.stringify(assets),utc(grantExpires),utc(Date.now())]);
      await audit(c,staff,'oauth_completed',row.id,{provider,assets:assets.length});
    },staff);
    return {attemptId:row.id,status:'awaiting_selection',errorCode:null};
  }catch(error){
    const failure=error instanceof ApiError?error.message:'provider_check_failed';
    return finish(failure==='provider_permission_denied'?'awaiting_provider_review':'failed',failure==='provider_permission_denied'?'provider_review_required':failure);
  }
}

export async function selectSocialAsset(staff:Staff,sessionKey:string,input:Record<string,unknown>,options:SocialAccountOptions={}){
  const env=guard(staff,options);fields(input,['attemptId','assetKey']);
  const attemptId=uuid(input.attemptId),key=typeof input.assetKey==='string'&&/^[a-f0-9]{24}$/.test(input.assetKey)?input.assetKey:'';
  if(!key)throw fail('asset_not_authorized',403);
  const row=(await database.query('SELECT * FROM oauth_states WHERE org_id=$1 AND id=$2',[staff.orgId,attemptId])).rows[0];
  if(!row)throw fail('connection_attempt_not_found',404);
  if(row.member_id!==staff.id||!secretEqual(row.session_binding,sessionBinding(sessionKey)))throw fail('oauth_state_mismatch',403);
  if(row.status!=='awaiting_selection'||!row.grant_ciphertext)throw fail('connection_attempt_closed');
  if(!(Date.parse(row.grant_expires_at)>Date.now()))throw fail('connection_attempt_expired',410);
  const asset=parseJsonArray(row.assets).find((item:Asset)=>item?.key===key) as Asset|undefined;
  if(!asset||!idOk(asset.id))throw fail('asset_not_authorized',403);
  const provider=row.provider as MetaProvider,app=metaApp(env),ring=socialTokenKeyRing(env);
  const grant=await openSocialSecret({ciphertext:row.grant_ciphertext,iv:row.grant_iv,keyVersion:row.key_version},'oauth-grant',[row.org_id,provider,row.id],env,ring);
  const proof=await confirmAsset(provider,app,grant,asset,options.fetch||fetch);
  const token=await sealSocialSecret(proof.token,'account-token',[staff.orgId,provider,asset.id],env,ring);
  const scopes=proof.scopes.length?proof.scopes:parseJsonArray(row.granted_scopes).filter(item=>typeof item==='string');
  const id=await transaction(staff.orgId,async c=>{
    const current=(await c.query('SELECT status,grant_ciphertext FROM oauth_states WHERE org_id=$1 AND id=$2',[staff.orgId,row.id])).rows[0];
    if(current?.status!=='awaiting_selection'||current.grant_ciphertext!==row.grant_ciphertext)throw fail('connection_attempt_closed');
    const accountId=await storeConnection(c,staff,{provider,accountId:asset.id,parentRef:asset.parent,displayName:asset.name,masked:asset.masked,identity:asset.identity,token,fingerprint:socialTokenFingerprint(proof.token),scopes,expires:proof.expires,grantId:row.id,from:'awaiting_selection'});
    // The grant is wiped as soon as one asset is stored; adding another asset re-authorizes.
    await c.query("UPDATE oauth_states SET status='completed',grant_ciphertext=NULL,grant_iv=NULL,updated_at=$3 WHERE org_id=$1 AND id=$2",[staff.orgId,row.id,utc(Date.now())]);
    await audit(c,staff,'connected',accountId,{provider,account:asset.masked,via:'oauth'});
    return accountId;
  },staff);
  return accountView(await accountRow(database,staff.orgId,id),env);
}

// ---------------------------------------------------------------- LINE (manual, guided)
export async function saveLineAccount(staff:Staff,input:Record<string,unknown>,options:SocialAccountOptions={}){
  const env=guard(staff,options);fields(input,['channelId','channelSecret','accessToken','botUserId','displayName']);
  const text=(value:unknown)=>typeof value==='string'?value.trim():'';
  const channelId=text(input.channelId),secret=text(input.channelSecret),token=text(input.accessToken),botUserId=text(input.botUserId);
  if(!/^\d{6,20}$/.test(channelId))throw fail('line_channel_id_invalid',400);
  if(!/^[a-f0-9]{32}$/.test(secret))throw fail('line_channel_secret_invalid',400);
  if(!/^U[a-f0-9]{32}$/.test(botUserId))throw fail('line_bot_user_id_invalid',400);
  if(!/^[A-Za-z0-9+/=._-]{20,1024}$/.test(token))throw fail('line_access_token_invalid',400);
  if(input.displayName!==undefined&&(typeof input.displayName!=='string'||input.displayName.length>100||/[\u0000-\u001f\u007f<>]/.test(input.displayName)))throw fail('display_name_invalid',400);
  if(!appOrigin(env))throw fail('app_origin_invalid',503);
  const ring=socialTokenKeyRing(env),subject=[staff.orgId,'line',botUserId];
  const sealedToken=await sealSocialSecret(token,'account-token',subject,env,ring),sealedSecret=await sealSocialSecret(secret,'account-secret',subject,env,ring);
  const id=await transaction(staff.orgId,async c=>{
    const accountId=await storeConnection(c,staff,{provider:'line',accountId:botUserId,parentRef:channelId,displayName:cleanName(input.displayName)||'LINE Official Account',masked:maskIdentity('line',botUserId),identity:'',token:sealedToken,secret:sealedSecret,fingerprint:socialTokenFingerprint(token),scopes:[],expires:null,grantId:null,from:'not_connected'});
    await audit(c,staff,'connected',accountId,{provider:'line',account:maskIdentity('line',botUserId),via:'manual'});
    return accountId;
  },staff);
  return accountView(await accountRow(database,staff.orgId,id),env);
}

// ---------------------------------------------------------------- Evidence from the existing runtime path
/**
 * Reads (never writes) the env-based path's signed-webhook and controlled-test evidence.
 * Inbound requires a signed webhook for this exact account after it was connected; outbound
 * additionally requires that the existing sender uses this exact stored credential.
 */
async function runtimeEvidence(row:Row,env:Env,secret:string){
  if(row.provider==='instagram')return {supported:false,envMatches:false,inbound:false,credentialMatches:false,test:false};
  const config=readSocialConfig(row.provider as SocialProvider,env);
  const envMatches=config.orgId===row.org_id&&config.accountId===row.account_id&&(row.provider!=='whatsapp'||config.wabaId===row.parent_ref)&&(row.provider!=='line'||secretEqual(config.secret,secret));
  const control=(await database.query('SELECT webhook_fingerprint,webhook_verified_at,test_passed_at,test_fingerprint FROM social_channel_controls WHERE org_id=$1 AND provider=$2 AND account_id=$3',[row.org_id,row.provider,row.account_id])).rows[0];
  const fingerprint=socialConfigFingerprint(config),since=Date.parse(row.connected_at||'');
  const inbound=envMatches&&!!control?.webhook_verified_at&&control.webhook_fingerprint===fingerprint&&Date.parse(control.webhook_verified_at)>=since;
  const credentialMatches=envMatches&&!!config.accessToken&&socialTokenFingerprint(config.accessToken)===row.token_fingerprint;
  const test=inbound&&credentialMatches&&!!control?.test_passed_at&&control.test_fingerprint===fingerprint&&Date.parse(control.test_passed_at)>=since;
  return {supported:true,envMatches,inbound,credentialMatches,test};
}
function registryConfig(row:Row,token:string,secret:string,env:Env):SocialChannelConfig{
  const base={provider:row.provider as SocialProvider,orgId:row.org_id,accountId:row.account_id,accessToken:token,webhookUrl:socialAccountCallbackUrl(row.provider,env),owner:'crm',inboundEnabled:true,liveEnabled:false};
  if(row.provider==='line')return {...base,secret};
  if(row.provider==='facebook')return {...base,secret:env.META_APP_SECRET||'',appId:env.META_APP_ID||'',verifyToken:env.META_VERIFY_TOKEN,apiVersion:env.META_GRAPH_VERSION};
  return {...base,wabaId:row.parent_ref,appId:env.META_APP_ID||'',secret:env.META_APP_SECRET||'',verifyToken:env.WHATSAPP_VERIFY_TOKEN||env.META_VERIFY_TOKEN,apiVersion:env.META_GRAPH_VERSION,whatsappAccountMode:'business'};
}
async function credentials(row:Row,env:Env){
  if(!row.token_ciphertext)throw fail('token_unreadable',503);
  const ring=socialTokenKeyRing(env);
  const token=await openSocialSecret(sealedToken(row),'account-token',tokenSubject(row),env,ring);
  const secret=row.secret_ciphertext?await openSocialSecret(sealedSecret(row),'account-secret',tokenSubject(row),env,ring):'';
  return {token,secret};
}

type Patch={state?:SocialAccountState;auth_readiness?:string;inbound_readiness?:string;outbound_readiness?:string;scopes?:string;expires_at?:string|null;last_verified_at?:string|null;verification_expires_at?:string|null;verification_evidence?:string;last_error_code?:string|null};
const patchColumns=['state','auth_readiness','inbound_readiness','outbound_readiness','scopes','expires_at','last_verified_at','verification_expires_at','verification_evidence','last_error_code'] as const;
/** Commits a patch only if the row is unchanged since the provider check began (revision CAS). */
async function commitPatch(staff:Staff,row:Row,patch:Patch,action:string,detail:Record<string,unknown>={}){
  await transaction(staff.orgId,async c=>{
    const current=await accountRow(c,staff.orgId,row.id);
    if(!current||current.revision!==row.revision||current.token_fingerprint!==row.token_fingerprint)throw fail('account_changed');
    const next:Patch={...patch};delete next.state;
    // 'ready' only while every readiness gate holds; leaving 'ready' also withdraws outbound readiness.
    let state=(patch.state??current.state) as SocialAccountState;
    const auth=next.auth_readiness??current.auth_readiness,inbound=next.inbound_readiness??current.inbound_readiness,outbound=next.outbound_readiness??current.outbound_readiness;
    if(state==='ready'&&!(auth==='ready'&&inbound==='ready'&&outbound==='ready'))state=auth==='ready'&&inbound==='ready'?'testing':'webhook_pending';
    if(state!=='ready'&&outbound==='ready')next.outbound_readiness='pending';
    if(state!==current.state){assertTransition(current.state,state);next.state=state;}
    const keys=patchColumns.filter(key=>key in next),time=utc(Date.now());
    await c.query(`UPDATE social_accounts SET ${keys.map((key,index)=>`${key}=$${index+4}`).join(',')}${keys.length?',':''}revision=revision+1,updated_at=$3 WHERE org_id=$1 AND id=$2`,[staff.orgId,row.id,time,...keys.map(key=>next[key])]);
    await audit(c,staff,action,row.id,{provider:row.provider,account:row.masked_identity,...detail});
  },staff);
}
/** Recomputes the furthest state proven by current evidence. Never yields 'ready'. */
function provenState(row:Row,patch:Patch):SocialAccountState{
  const auth=patch.auth_readiness??row.auth_readiness,inbound=patch.inbound_readiness??row.inbound_readiness;
  const fresh=Date.parse((patch.verification_expires_at!==undefined?patch.verification_expires_at:row.verification_expires_at)||'')>Date.now();
  return auth==='ready'&&inbound==='ready'&&fresh?'testing':'webhook_pending';
}
const readyKeep=(row:Row,next:SocialAccountState):SocialAccountState=>row.state==='ready'&&next==='testing'?'ready':next;

const progress=new Set(['webhook_pending','testing','ready']);
const actions=['validate','check-webhook','verify','check-test','activate','pause','resume','disconnect'] as const;
export async function socialAccountAction(staff:Staff,accountId:string,input:Record<string,unknown>,options:SocialAccountOptions={}){
  const env=guard(staff,options);fields(input,['action','confirm']);
  if(typeof input.action!=='string'||!(actions as readonly string[]).includes(input.action))throw fail('invalid_account_action',400);
  const action=input.action as typeof actions[number],transport=options.fetch||fetch;
  await settleExpiry(staff);
  const row=await accountRow(database,staff.orgId,uuid(accountId));if(!row)throw fail('account_not_found',404);
  const view=async()=>accountView(await accountRow(database,staff.orgId,row.id),env);
  const unsupported=row.provider==='instagram'?'unsupported':'pending';

  if(action==='disconnect')return disconnect(staff,row,input,env,transport);
  if(action==='pause'){
    if(!canTransition(row.state,'paused'))throw fail('invalid_state_transition');
    await commitPatch(staff,row,{state:'paused',outbound_readiness:row.provider==='instagram'?'unsupported':'blocked'},'paused');return view();
  }
  if(action==='resume'){
    // Resuming never restores 'ready': inbound and controlled-test evidence are re-checked.
    if(row.state!=='paused')throw fail('invalid_state_transition');
    const patch:Patch={inbound_readiness:unsupported,outbound_readiness:unsupported,last_error_code:null};
    await commitPatch(staff,row,{...patch,state:provenState(row,patch)},'resumed');return view();
  }
  if(['disconnected','paused','expired'].includes(row.state))throw fail('invalid_state_transition');

  if(action==='validate'){
    const {token}=await credentials(row,env);let patch:Patch;
    try{patch=await validateCredential(row,token,env,transport);}
    catch(error){
      // Definitive provider answers are recorded; configuration and transient failures change nothing.
      if(!(error instanceof ApiError))throw error;
      if(error.message==='provider_permission_denied')patch={state:'awaiting_provider_review',auth_readiness:'failed',last_error_code:'provider_review_required'};
      else if(['provider_authentication_failed','provider_account_mismatch'].includes(error.message))patch={state:'degraded',auth_readiness:'failed',last_error_code:error.message};
      else throw error;
    }
    if(!patch.state)patch.state=readyKeep(row,provenState(row,patch));
    await commitPatch(staff,row,patch,patch.auth_readiness==='ready'?'validated':'validation_failed',{errorCode:patch.last_error_code??null});return view();
  }
  if(action==='check-webhook'){
    const {secret}=await credentials(row,env),evidence=await runtimeEvidence(row,env,secret);
    if(!evidence.supported){await commitPatch(staff,row,{inbound_readiness:'unsupported',last_error_code:'inbound_unsupported'},'webhook_checked',{inbound:false});return view();}
    const patch:Patch={inbound_readiness:evidence.inbound?'ready':'pending',last_error_code:evidence.inbound?null:evidence.envMatches?'waiting_for_signed_webhook':'registry_inbound_pending'};
    if(!evidence.inbound)patch.outbound_readiness='pending';
    if(progress.has(row.state))patch.state=evidence.inbound?readyKeep(row,provenState(row,patch)):'webhook_pending';
    await commitPatch(staff,row,patch,'webhook_checked',{inbound:evidence.inbound});return view();
  }
  if(action==='verify'){
    if(row.auth_readiness!=='ready')throw fail('validation_required');
    const {token,secret}=await credentials(row,env);let patch:Patch;
    try{
      const proof=row.provider==='instagram'?await verifyInstagram(row,token,env,transport):await verifyRegisteredChannel(registryConfig(row,token,secret,env),transport,row.provider==='whatsapp'?row.display_identity:undefined);
      patch={last_verified_at:utc(Date.now()),verification_expires_at:utc(proof.expires),verification_evidence:JSON.stringify(proof.detail),last_error_code:null};
      if(progress.has(row.state)||row.state==='degraded')patch.state=readyKeep(row,provenState(row,patch));
    }catch(error){
      if(!(error instanceof ApiError))throw error;
      patch={last_verified_at:null,verification_expires_at:null,verification_evidence:'{}',last_error_code:error.message};
      if(error.message==='provider_token_expired')Object.assign(patch,{state:'expired',auth_readiness:'expired'});
      else if(row.state==='testing'||row.state==='ready')patch.state='degraded';
    }
    await commitPatch(staff,row,patch,patch.last_error_code?'verification_failed':'verified',{errorCode:patch.last_error_code??null});return view();
  }
  if(action==='check-test'){
    const {secret}=await credentials(row,env),evidence=await runtimeEvidence(row,env,secret);
    if(!evidence.supported)throw fail('inbound_unsupported');
    const patch:Patch=evidence.test?{outbound_readiness:row.state==='ready'?'ready':'test_passed',last_error_code:null}
      :{outbound_readiness:'pending',last_error_code:!evidence.credentialMatches?'registry_dispatch_pending':'controlled_test_required'};
    await commitPatch(staff,row,patch,'test_checked',{testPassed:evidence.test});return view();
  }
  // activate: the only path to 'ready', and only on fresh evidence from the existing controlled test flow.
  if(input.confirm!==true)throw fail('explicit_confirmation_required',422);
  if(row.state!=='testing')throw fail('activation_not_allowed');
  if(row.auth_readiness!=='ready')throw fail('validation_required');
  if(!(Date.parse(row.verification_expires_at||'')>Date.now()))throw fail('verification_required');
  const {secret}=await credentials(row,env),evidence=await runtimeEvidence(row,env,secret);
  if(!evidence.inbound)throw fail('waiting_for_signed_webhook');
  if(!evidence.credentialMatches)throw fail('registry_dispatch_pending');
  if(!evidence.test)throw fail('controlled_test_required');
  await commitPatch(staff,row,{state:'ready',inbound_readiness:'ready',outbound_readiness:'ready',last_error_code:null},'activated');
  return view();
}

async function validateCredential(row:Row,token:string,env:Env,transport:typeof fetch):Promise<Patch>{
  if(row.provider==='line'){
    const info=await providerCall('https://api.line.me/v2/bot/info',{bearer:token},transport);
    if(info.userId!==row.account_id)throw fail('provider_account_mismatch');
    return {auth_readiness:'ready',last_error_code:null};
  }
  const app=metaApp(env),required=oauthScopes(row.provider as MetaProvider,env);
  if(!required.length)throw fail('oauth_scopes_not_configured',503);
  const data=await debugToken(app,token,transport),expires=tokenExpiry(data),scopes=grantedScopes(data);
  if(data.is_valid!==true){
    const lapsed=expires!==null&&expires<=Date.now();
    return {state:lapsed?'expired':'degraded',auth_readiness:lapsed?'expired':'failed',last_error_code:lapsed?'provider_token_expired':'provider_token_invalid'};
  }
  if(String(data.app_id)!==app.appId)return {state:'degraded',auth_readiness:'failed',last_error_code:'provider_token_app_mismatch'};
  // Page tokens report their Page; it must be exactly the selected (or linked) Page.
  const page=row.provider==='facebook'?row.account_id:row.provider==='instagram'?row.parent_ref:'';
  if(page&&data.profile_id!==undefined&&String(data.profile_id)!==page)return {state:'degraded',auth_readiness:'failed',last_error_code:'provider_account_mismatch'};
  if(row.provider==='whatsapp'&&!wabaTargets(data).includes(row.parent_ref))return {state:'missing_permission',auth_readiness:'failed',scopes:JSON.stringify(scopes),last_error_code:'asset_not_authorized'};
  if(required.some(scope=>!scopes.includes(scope)))return {state:'missing_permission',auth_readiness:'failed',scopes:JSON.stringify(scopes),last_error_code:'permission_declined'};
  return {auth_readiness:'ready',scopes:JSON.stringify(scopes),expires_at:expires===null?null:utc(expires),last_error_code:null};
}
async function verifyInstagram(row:Row,token:string,env:Env,transport:typeof fetch){
  const app=metaApp(env);
  const account=await providerCall(graphUrl(app.version,row.account_id,{fields:'id,username'}),{bearer:token},transport);
  if(String(account.id)!==row.account_id)throw fail('provider_account_mismatch');
  const page=await providerCall(graphUrl(app.version,row.parent_ref,{fields:'id,instagram_business_account'}),{bearer:token},transport);
  if(String(page.id)!==row.parent_ref||String(page.instagram_business_account?.id)!==row.account_id)throw fail('provider_account_mismatch');
  return {expires:Date.now()+86_400_000,detail:{accountMatched:true,linkedPageMatched:true,inbound:'unsupported'}};
}

/**
 * Revokes/unsubscribes only this account where the provider API supports it, never an
 * identity shared with the existing env-based connection or another registered number.
 * Local credentials are wiped; identities, conversations, messages, events and audit stay.
 */
async function disconnect(staff:Staff,row:Row,input:Record<string,unknown>,env:Env,transport:typeof fetch){
  if(input.confirm!==true)throw fail('explicit_confirmation_required',422);
  if(row.state==='disconnected')throw fail('already_disconnected');
  let result='not_supported';
  try{
    const {token}=await credentials(row,env);
    if(row.provider==='facebook'){
      if(env.META_PAGE_ID===row.account_id)result='skipped_shared_with_existing_connection';
      else{await providerCall(graphUrl(metaApp(env).version,row.account_id+'/subscribed_apps'),{method:'DELETE',bearer:token},transport);result='unsubscribed';}
    }else if(row.provider==='whatsapp'){
      const shared=env.WHATSAPP_WABA_ID===row.parent_ref||(await database.query("SELECT 1 FROM social_accounts WHERE org_id=$1 AND provider='whatsapp' AND parent_ref=$2 AND id<>$3 AND state<>'disconnected' LIMIT 1",[staff.orgId,row.parent_ref,row.id])).rows.length>0;
      if(shared)result='skipped_shared_with_existing_connection';
      else{await providerCall(graphUrl(metaApp(env).version,row.parent_ref+'/subscribed_apps'),{method:'DELETE',bearer:token},transport);result='unsubscribed';}
    }else if(row.provider==='line'){
      if(secretEqual(env.LINE_CHANNEL_ACCESS_TOKEN||'',token))result='skipped_shared_with_existing_connection';
      else{await providerCall('https://api.line.me/v2/oauth/revoke',{method:'POST',form:{access_token:token},allowEmpty:true},transport);result='revoked';}
    }
  }catch(error){result='provider_failed:'+(error instanceof ApiError?error.message:'provider_check_failed');}
  await transaction(staff.orgId,async c=>{
    const current=await accountRow(c,staff.orgId,row.id);
    if(!current||current.state==='disconnected')throw fail('already_disconnected');
    assertTransition(current.state,'disconnected');
    await c.query(`UPDATE social_accounts SET state='disconnected',auth_readiness='pending',inbound_readiness=CASE WHEN provider='instagram' THEN 'unsupported' ELSE 'pending' END,outbound_readiness=CASE WHEN provider='instagram' THEN 'unsupported' ELSE 'blocked' END,
      token_ciphertext=NULL,token_iv=NULL,secret_ciphertext=NULL,secret_iv=NULL,token_fingerprint=NULL,last_verified_at=NULL,verification_expires_at=NULL,verification_evidence='{}',last_error_code=NULL,revision=revision+1,updated_at=$3 WHERE org_id=$1 AND id=$2`,[staff.orgId,row.id,utc(Date.now())]);
    await audit(c,staff,'disconnected',row.id,{provider:row.provider,account:row.masked_identity,providerResult:result});
  },staff);
  return {...accountView(await accountRow(database,staff.orgId,row.id),env),providerResult:result};
}

// ---------------------------------------------------------------- Key rotation
/** Re-encrypts this organization's stored credentials under SOCIAL_TOKEN_KEY_CURRENT (bounded batch). */
export async function rotateSocialTokenKeys(staff:Staff,options:SocialAccountOptions={}){
  const env=guard(staff,options),ring=socialTokenKeyRing(env);let rotated=0;
  const accounts=(await database.query("SELECT * FROM social_accounts WHERE org_id=$1 AND key_version IS NOT NULL AND key_version<>$2 AND (token_ciphertext IS NOT NULL OR secret_ciphertext IS NOT NULL) ORDER BY id LIMIT 50",[staff.orgId,ring.current])).rows;
  for(const row of accounts){
    const subject=tokenSubject(row);
    const token=row.token_ciphertext?await sealSocialSecret(await openSocialSecret(sealedToken(row),'account-token',subject,env,ring),'account-token',subject,env,ring):null;
    const secret=row.secret_ciphertext?await sealSocialSecret(await openSocialSecret(sealedSecret(row),'account-secret',subject,env,ring),'account-secret',subject,env,ring):null;
    if(await transaction(staff.orgId,async c=>{
      const current=await accountRow(c,staff.orgId,row.id);
      if(!current||current.token_ciphertext!==row.token_ciphertext||current.secret_ciphertext!==row.secret_ciphertext)return false;
      await c.query('UPDATE social_accounts SET token_ciphertext=$3,token_iv=$4,secret_ciphertext=$5,secret_iv=$6,key_version=$7,revision=revision+1,updated_at=$8 WHERE org_id=$1 AND id=$2',[staff.orgId,row.id,token?.ciphertext??null,token?.iv??null,secret?.ciphertext??null,secret?.iv??null,ring.current,utc(Date.now())]);
      return true;
    },staff))rotated++;
  }
  const attempts=(await database.query("SELECT * FROM oauth_states WHERE org_id=$1 AND key_version<>$2 AND (verifier_ciphertext IS NOT NULL OR grant_ciphertext IS NOT NULL) ORDER BY id LIMIT 50",[staff.orgId,ring.current])).rows;
  for(const row of attempts){
    const subject=[row.org_id,row.provider,row.id];
    const verifier=row.verifier_ciphertext?await sealSocialSecret(await openSocialSecret({ciphertext:row.verifier_ciphertext,iv:row.verifier_iv,keyVersion:row.key_version},'oauth-pkce',subject,env,ring),'oauth-pkce',subject,env,ring):null;
    const grant=row.grant_ciphertext?await sealSocialSecret(await openSocialSecret({ciphertext:row.grant_ciphertext,iv:row.grant_iv,keyVersion:row.key_version},'oauth-grant',subject,env,ring),'oauth-grant',subject,env,ring):null;
    if(await transaction(staff.orgId,async c=>{
      const current=(await c.query('SELECT verifier_ciphertext,grant_ciphertext FROM oauth_states WHERE org_id=$1 AND id=$2',[staff.orgId,row.id])).rows[0];
      if(!current||current.verifier_ciphertext!==row.verifier_ciphertext||current.grant_ciphertext!==row.grant_ciphertext)return false;
      await c.query('UPDATE oauth_states SET verifier_ciphertext=$3,verifier_iv=$4,grant_ciphertext=$5,grant_iv=$6,key_version=$7,updated_at=$8 WHERE org_id=$1 AND id=$2',[staff.orgId,row.id,verifier?.ciphertext??null,verifier?.iv??null,grant?.ciphertext??null,grant?.iv??null,ring.current,utc(Date.now())]);
      return true;
    },staff))rotated++;
  }
  const remaining=Number((await database.query("SELECT count(*) AS n FROM social_accounts WHERE org_id=$1 AND key_version IS NOT NULL AND key_version<>$2 AND (token_ciphertext IS NOT NULL OR secret_ciphertext IS NOT NULL)",[staff.orgId,ring.current])).rows[0].n);
  if(rotated)await transaction(staff.orgId,async c=>{await audit(c,staff,'keys_rotated',staff.orgId,{rotated,keyVersion:ring.current});},staff);
  return {rotated,remaining,keyVersion:ring.current};
}
