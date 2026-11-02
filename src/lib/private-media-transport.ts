import {ApiError} from './auth';
import type {Row} from './db';
import type {SocialChannelConfig} from './social-channels';

export type PrivateMediaOptions={fetch:typeof fetch;signal:AbortSignal;assertCurrent:()=>Promise<void>};
export type PrivateMediaSource={bytes:Uint8Array;mime:string;name:string;text?:string;grant:()=>Promise<string>;uploaded:(id:string)=>Promise<void>};
/** Bytes are verified by each approval owner before this common provider transport.
 * The caller retains the single existing outbound attempt and all final guards. */
export async function privateMediaRequest(config:SocialChannelConfig,command:Row,source:PrivateMediaSource,options:PrivateMediaOptions){
  await options.assertCurrent();
  const headers:Record<string,string>={Authorization:'Bearer '+config.accessToken,'Content-Type':'application/json'};
  if(config.provider!=='whatsapp'){
    if(!['line','facebook','instagram'].includes(config.provider)||!['image/jpeg','image/png'].includes(source.mime))throw new ApiError(422,'Unsupported private media transport');
    const url=await source.grant();await options.assertCurrent();
    if(config.provider==='line'){
      headers['X-Line-Retry-Key']=command.id;
      return {url:'https://api.line.me/v2/bot/message/push',init:{method:'POST',headers,body:JSON.stringify({to:command.remote_id,messages:[...(source.text?[{type:'text',text:source.text}]:[]),{type:'image',originalContentUrl:url,previewImageUrl:url}]}),redirect:'manual',signal:options.signal} as RequestInit};
    }
    if(source.text)throw new ApiError(422,'Image captions are unsupported for this transport');
    return {url:`https://graph.facebook.com/${config.apiVersion}/${config.provider==='instagram'?'me':config.accountId}/messages`,init:{method:'POST',headers,body:JSON.stringify({recipient:{id:command.remote_id},...(config.provider==='facebook'?{messaging_type:'RESPONSE'}:{}),message:{attachment:{type:'image',payload:{url,...config.provider==='facebook'?{is_reusable:false}:{}}}}}),redirect:'manual',signal:options.signal} as RequestInit};
  }
  if(source.text&&[...source.text].length>1024)throw new ApiError(422,'WhatsApp media caption exceeds 1024 characters');
  const form=new FormData();form.append('messaging_product','whatsapp');form.append('type',source.mime);form.append('file',new Blob([new Uint8Array(source.bytes)],{type:source.mime}),source.name);
  const upload=await options.fetch(`https://graph.facebook.com/${config.apiVersion}/${config.accountId}/media`,{method:'POST',headers:{Authorization:headers.Authorization},body:form,redirect:'manual',signal:options.signal});
  if(!upload.ok){await upload.body?.cancel();throw new ApiError(502,'Provider media upload was not accepted');}
  const reader=upload.body?.getReader();if(!reader)throw new ApiError(502,'Provider media ID is missing');const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>65536){await reader.cancel();throw new ApiError(502,'Provider media response is too large');}chunks.push(part.value);}}finally{reader.releaseLock();}
  const data=JSON.parse(Buffer.concat(chunks,size).toString());if(typeof data.id!=='string'||!/^\d{1,200}$/.test(data.id))throw new ApiError(502,'Provider media ID is missing');
  await options.assertCurrent();await source.uploaded(data.id);await options.assertCurrent();
  const type=source.mime==='application/pdf'?'document':'image';
  return {url:`https://graph.facebook.com/${config.apiVersion}/${config.accountId}/messages`,init:{method:'POST',headers,body:JSON.stringify({messaging_product:'whatsapp',recipient_type:'individual',to:command.remote_id,type,[type]:{id:data.id,...type==='document'?{filename:source.name}:{},...source.text?{caption:source.text}:{}},biz_opaque_callback_data:command.attempt_id}),redirect:'manual',signal:options.signal} as RequestInit};
}
