import {randomUUID} from 'node:crypto';
import {database,transaction,type Row} from './db';
import {ApiError,type Staff,requireAdmin,uuid} from './auth';
import {resolveSocialConfig,listRuntimeAccounts} from './social-account-runtime';
import type {SocialChannelConfig} from './social-channels';
type Options={config?:SocialChannelConfig;fetch?:typeof fetch};
const at=()=>new Date().toISOString();
function fields(input:Record<string,unknown>,allowed:string[]){if(Object.keys(input).some(k=>!allowed.includes(k)))throw new ApiError(400,'มีฟิลด์ที่ไม่รองรับ');}
export function parseTemplateDraft(input:Record<string,unknown>){
 fields(input,['id','expectedRevision','accountId','name','language','category','body','examples']);
 const name=String(input.name||''),language=String(input.language||''),category=String(input.category||''),body=String(input.body||'').trim();
 if(!/^[a-z][a-z0-9_]{0,511}$/.test(name)||!/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(language)||!['UTILITY','MARKETING'].includes(category)||!body||body.length>1024)throw new ApiError(422,'ตรวจชื่อ ภาษา ประเภท และเนื้อหาเทมเพลต (ไม่เกิน 1,024 ตัวอักษร)');
 const placeholders=[...body.matchAll(/\{\{([^{}]+)\}\}/g)].map(m=>m[1]);
 if(placeholders.some(v=>!/^\d+$/.test(v))||body.replace(/\{\{\d+\}\}/g,'').includes('{{')||body.replace(/\{\{\d+\}\}/g,'').includes('}}'))throw new ApiError(422,'ตัวแปรต้องเป็น {{1}}, {{2}} ตามลำดับ');
 const unique=[...new Set(placeholders.map(Number))].sort((a,b)=>a-b);
 if(unique.some((n,i)=>n!==i+1)||unique.length>20)throw new ApiError(422,'ตัวแปรต้องเรียงต่อเนื่องและไม่เกิน 20 ค่า');
 const examples=input.examples??[];
 if(!Array.isArray(examples)||examples.length!==unique.length||examples.some(v=>typeof v!=='string'||!v.trim()||v.length>200||/[\r\n{}]/.test(v)))throw new ApiError(422,'กรอกตัวอย่างของตัวแปรให้ครบทุกค่า');
 return {name,language,category,body,examples:examples as string[]};
}
async function audit(c:typeof database,staff:Staff,action:string,id:string,metadata:Record<string,unknown>={}){await c.query('INSERT INTO audit_events(id,org_id,actor_id,action,entity_id,metadata) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),staff.orgId,staff.id,'wa_template.'+action,id,JSON.stringify(metadata)]);}
async function config(staff:Staff,accountId:string,options:Options){
 const c=options.config||await resolveSocialConfig(staff.orgId,'whatsapp',accountId);
 if(c.orgId!==staff.orgId||c.accountId!==accountId||c.provider!=='whatsapp')throw new ApiError(403,'บัญชีไม่ตรงกับสิทธิ์');
 if(!c.accessToken||!/^\d{5,40}$/.test(c.wabaId||'')||!/^v\d+\.\d+$/.test(c.apiVersion||''))throw new ApiError(503,'ยังไม่ได้เชื่อมบัญชี WhatsApp ที่จัดการเทมเพลตได้');
 return c;
}
async function provider(c:SocialChannelConfig,method:'GET'|'POST',data:Record<string,unknown>,transport:typeof fetch){
 const url=new URL(`https://graph.facebook.com/${c.apiVersion}/${c.wabaId}/message_templates`);
 if(method==='GET'){url.searchParams.set('name',String(data.name));url.searchParams.set('fields','id,name,status,language,category,components,rejected_reason');url.searchParams.set('limit','100');}
 let r:Response;try{r=await transport(url,{method,headers:{Authorization:'Bearer '+c.accessToken,...method==='POST'?{'Content-Type':'application/json'}:{}},...method==='POST'?{body:JSON.stringify(data)}:{},redirect:'manual',signal:AbortSignal.timeout(10000)});}catch{throw new ApiError(503,'provider_result_unknown');}
 if(!r.ok){await r.body?.cancel();throw new ApiError(r.status>=400&&r.status<500?422:503,r.status>=400&&r.status<500?'provider_rejected_request':'provider_result_unknown');}
 const reader=r.body?.getReader();if(!reader)throw new ApiError(503,'provider_result_unknown');let text='',bytes=0;const decoder=new TextDecoder();
 try{while(true){const item=await reader.read();if(item.done)break;bytes+=item.value.length;if(bytes>512000){await reader.cancel();throw new ApiError(503,'provider_result_unknown');}text+=decoder.decode(item.value,{stream:true});}text+=decoder.decode();}finally{reader.releaseLock();}
 try{return JSON.parse(text) as Row;}catch{throw new ApiError(503,'provider_result_unknown');}
}
export async function listWhatsappTemplates(staff:Staff){requireAdmin(staff);return {accounts:await listRuntimeAccounts(staff.orgId,'whatsapp'),items:(await database.query('SELECT id,account_id,name,language,category,body,examples,revision,status,provider_id,provider_status,provider_reason,updated_at FROM wa_template_drafts WHERE org_id=$1 ORDER BY updated_at DESC LIMIT 200',[staff.orgId])).rows};}
export async function saveWhatsappTemplate(staff:Staff,input:Record<string,unknown>,options:Options={}){
 requireAdmin(staff);const value=parseTemplateDraft(input),accountId=String(input.accountId||'');await config(staff,accountId,options);
 const id=input.id?uuid(input.id):randomUUID(),time=at();
 await transaction(staff.orgId,async c=>{
  if(input.id){const old=(await c.query('SELECT * FROM wa_template_drafts WHERE org_id=$1 AND id=$2',[staff.orgId,id])).rows[0];if(!old||old.account_id!==accountId)throw new ApiError(404,'ไม่พบฉบับร่าง');if(old.status!=='draft'||Number(input.expectedRevision)!==old.revision)throw new ApiError(409,'เทมเพลตเปลี่ยนแล้ว หรือส่งไปตรวจแล้ว กรุณาสร้างชื่อใหม่');await c.query('UPDATE wa_template_drafts SET name=$4,language=$5,category=$6,body=$7,examples=$8,revision=revision+1,updated_at=$9 WHERE org_id=$1 AND id=$2 AND revision=$3',[staff.orgId,id,old.revision,value.name,value.language,value.category,value.body,JSON.stringify(value.examples),time]);}
  else await c.query('INSERT INTO wa_template_drafts(id,org_id,account_id,name,language,category,body,examples,created_by,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[id,staff.orgId,accountId,value.name,value.language,value.category,value.body,JSON.stringify(value.examples),staff.id,time]);
  await audit(c,staff,'saved',id);
 },staff);return {id,...await listWhatsappTemplates(staff)};
}
export async function submitWhatsappTemplate(staff:Staff,id:string,input:Record<string,unknown>,options:Options={}){
 requireAdmin(staff);uuid(id);fields(input,['expectedRevision','confirm']);if(input.confirm!==true)throw new ApiError(422,'ยืนยันการส่งเนื้อหานี้ให้ Meta ตรวจอนุมัติ');
 const row=(await database.query('SELECT * FROM wa_template_drafts WHERE org_id=$1 AND id=$2',[staff.orgId,id])).rows[0];if(!row)throw new ApiError(404,'ไม่พบเทมเพลต');
 if(row.status!=='draft'||row.revision!==Number(input.expectedRevision))throw new ApiError(409,'ส่งไปแล้ว หรือฉบับร่างเปลี่ยน กรุณาตรวจสถานะก่อน');
 const c=await config(staff,row.account_id,options),attempt=randomUUID();
 await transaction(staff.orgId,async tx=>{const current=(await tx.query('SELECT revision,status FROM wa_template_drafts WHERE org_id=$1 AND id=$2',[staff.orgId,id])).rows[0];if(current?.revision!==row.revision||current.status!=='draft')throw new ApiError(409,'มีการส่งหรือแก้ไขพร้อมกัน');await tx.query("UPDATE wa_template_drafts SET status='submitting',attempt_id=$3,revision=revision+1,updated_at=$4 WHERE org_id=$1 AND id=$2",[staff.orgId,id,attempt,at()]);await audit(tx,staff,'submission_started',id,{attempt});},staff);
 let outcome:Row;try{const examples=JSON.parse(row.examples),components=[{type:'BODY',text:row.body,...examples.length?{example:{body_text:[examples]}}:{}}];outcome=await provider(c,'POST',{name:row.name,language:row.language,category:row.category,components},options.fetch||fetch);if(!/^\d{5,40}$/.test(String(outcome.id||'')))throw new ApiError(503,'provider_result_unknown');}
 catch(error){const rejected=error instanceof ApiError&&error.status===422;await database.query('UPDATE wa_template_drafts SET status=$4,provider_reason=$5,updated_at=$6 WHERE org_id=$1 AND id=$2 AND attempt_id=$3',[staff.orgId,id,attempt,rejected?'rejected':'unknown',rejected?'Meta ไม่รับคำขอนี้ กรุณาตรวจบัญชีและเนื้อหา':'ผลการส่งไม่แน่นอน ให้ตรวจสถานะก่อน ห้ามส่งซ้ำ',at()]);throw error;}
 await database.query("UPDATE wa_template_drafts SET status='submitted',provider_id=$4,provider_status=$5,provider_reason=NULL,updated_at=$6 WHERE org_id=$1 AND id=$2 AND attempt_id=$3",[staff.orgId,id,attempt,String(outcome.id),String(outcome.status||'PENDING').slice(0,80),at()]);return listWhatsappTemplates(staff);
}
export async function refreshWhatsappTemplate(staff:Staff,id:string,options:Options={}){
 requireAdmin(staff);uuid(id);const row=(await database.query('SELECT * FROM wa_template_drafts WHERE org_id=$1 AND id=$2',[staff.orgId,id])).rows[0];if(!row)throw new ApiError(404,'ไม่พบเทมเพลต');
 const c=await config(staff,row.account_id,options),body=await provider(c,'GET',{name:row.name},options.fetch||fetch),items=Array.isArray(body.data)?body.data:[];
 const matches=items.filter((t:Row)=>t.name===row.name&&t.language===row.language);if(matches.length!==1)throw new ApiError(409,'ยังไม่พบเทมเพลตตรงชื่อและภาษา ระบบจะไม่ส่งซ้ำให้อัตโนมัติ');const t=matches[0];
 const component=(Array.isArray(t.components)?t.components:[]).find((v:Row)=>v.type==='BODY');if(component?.text!==row.body)throw new ApiError(409,'เนื้อหาบน Meta ต่างจากฉบับนี้ กรุณาสร้างฉบับใหม่');
 if(!/^\d{5,40}$/.test(String(t.id||'')))throw new ApiError(502,'ข้อมูลเทมเพลตไม่ถูกต้อง');
 const states:Record<string,string>={APPROVED:'approved',REJECTED:'rejected',PAUSED:'paused',DISABLED:'disabled',PENDING:'submitted',PENDING_DELETION:'disabled',DELETED:'disabled',IN_APPEAL:'submitted'};
 const status=states[String(t.status)]||'unknown',reason=typeof t.rejected_reason==='string'?t.rejected_reason.replace(/[\u0000-\u001f]/g,' ').slice(0,500):null;
 await transaction(staff.orgId,async tx=>{await tx.query('UPDATE wa_template_drafts SET status=$4,provider_id=$5,provider_status=$6,provider_reason=$7,updated_at=$8 WHERE org_id=$1 AND id=$2 AND revision=$3',[staff.orgId,id,row.revision,status,String(t.id),String(t.status).slice(0,80),reason,at()]);await audit(tx,staff,'status_checked',id,{status});},staff);return listWhatsappTemplates(staff);
}
