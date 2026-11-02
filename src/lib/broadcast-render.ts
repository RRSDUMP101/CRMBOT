import {ApiError,hashToken} from './auth';
import type {Row} from './db';

/** Plain text, single-pass substitution. Customer values are never evaluated as templates. */
const variables=new Set(['name','first_name','market','stage']);
export function validateBroadcastVariables(text:string){
  const stripped=text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g,(_,key:string)=>{
    if(!variables.has(key))throw new ApiError(400,'ตัวแปรข้อความไม่รองรับ: '+key);
    return '';
  });
  if(stripped.includes('{{')||stripped.includes('}}'))throw new ApiError(400,'รูปแบบตัวแปรข้อความไม่ถูกต้อง');
}
export function personalizeBroadcast(text:string,recipient:Row){
  validateBroadcastVariables(text);
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g,(_,key:string)=>{
    const name=String(recipient.name||'').replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/\s+/g,' ').trim();
    const value=key==='name'?name:key==='first_name'?name.split(' ')[0]:String(recipient[key]||'').trim();
    if(!value||value.length>200)throw new ApiError(409,'personalization_missing');
    return value;
  });
}
export function broadcastContentHash(campaign:Row,source:string,asset:unknown){
  return hashToken(JSON.stringify([1,campaign.id,campaign.provider,campaign.account_id,campaign.message_kind,campaign.message_text,campaign.template_name,campaign.template_language,campaign.template_params,source,asset]));
}
export function broadcastRenderHash(identity:string,body:string,params:string[],contentHash:string){return hashToken(JSON.stringify([1,identity,body,params,contentHash]));}
export function renderBroadcast(campaign:Row,recipient:Row,source:string,contentHash:string){
  const body=personalizeBroadcast(source,recipient),params=campaign.message_kind==='template'?(JSON.parse(String(campaign.template_params||'[]')) as string[]).map(value=>personalizeBroadcast(value,recipient)):[];
  const limit=campaign.media_asset_id&&campaign.provider==='whatsapp'?1024:campaign.provider==='whatsapp'?4096:2000;
  if(!body.trim()||body.length>limit||params.some(value=>!value.trim()||value.length>1024||/[\n\r\t]/.test(value)||/ {5,}/.test(value)))throw new ApiError(409,'personalization_invalid');
  return {body,params,hash:broadcastRenderHash(String(recipient.identity_id??recipient.id),body,params,contentHash),contentHash,source};
}
