"use client";
import {useEffect,useRef,useState} from 'react';
import {api,date} from './data';
import {Button} from './ui';
type Attachment={id:string;filename:string;contentType:string;sizeBytes:number;conversationVersion:number;expiresAt:string};
type Capabilities={enabled:boolean;provider:string;supported:boolean;accept:string|string[];maxBytes:number;limits?:Record<string,number>;items:Attachment[]};
export function HumanAttachments({conversationId,version,disabled,onSent}:{conversationId:string;version:number;disabled:boolean;onSent:()=>Promise<void>}){
 const base=`/api/admin/conversations/${conversationId}/attachments`,[caps,setCaps]=useState<Capabilities|null>(null),[item,setItem]=useState<Attachment|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState('');
 const client=useRef(''),input=useRef<HTMLInputElement>(null);
 useEffect(()=>{let live=true;api<Capabilities>(base).then(value=>{if(live)setCaps(value);},e=>{if(live)setError((e as Error).message);});return()=>{live=false;};},[base]);
 async function upload(file:File){
  if(!caps||busy)return;if(file.size>(caps.limits?.[file.type]||caps.maxBytes)){setError('ไฟล์มีขนาดเกินที่ช่องทางนี้รองรับ');return;}
  setBusy(true);setError('');setResult('');setItem(null);
  try{const response=await fetch(base,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':file.type||'application/octet-stream','X-File-Name':encodeURIComponent(file.name),'X-Conversation-Version':String(version)},body:file});const data=await response.json();if(!response.ok)throw new Error(data.error||'อัปโหลดไฟล์ไม่สำเร็จ');client.current=crypto.randomUUID();setItem(data);}
  catch(e){setError((e as Error).message);}finally{setBusy(false);if(input.current)input.current.value='';}
 }
 async function send(){
  if(!item||busy)return;setBusy(true);setError('');
  try{const response=await api<{status:string}>(base+'/send',{attachmentId:item.id,clientId:client.current,expectedVersion:item.conversationVersion});setResult(response.status==='unknown'?'ยังยืนยันผลการส่งไม่ได้ กรุณาตรวจสถานะข้อความก่อนดำเนินการต่อ':'บันทึกคำสั่งส่งไฟล์แล้ว ตรวจสถานะใต้ข้อความ');setItem(null);await onSent();}catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 const changed=!!item&&item.conversationVersion!==version;
 if(caps&&!caps.enabled)return null;
 return <div aria-label="ไฟล์แนบ" className="composer-attachments">
  {caps?.supported?<label>{caps.provider === "whatsapp" ? "แนบไฟล์ PDF หรือรูปภาพ" : "แนบรูปภาพ JPEG หรือ PNG (ไม่เกิน 1 MB)"} <input ref={input} type="file" accept={Array.isArray(caps.accept)?caps.accept.join(','):caps.accept} disabled={disabled||busy} onChange={e=>{const file=e.target.files?.[0];if(file)void upload(file);}} /></label>:caps&&<small>ช่องทางนี้ยังไม่รองรับการส่งไฟล์แนบ</small>}
  {busy&&<p role="status">กำลังดำเนินการ…</p>}
  {item&&<div><a href={base+'/'+item.id} target="_blank" rel="noreferrer">ดูไฟล์ {item.filename}</a> <small>{Math.ceil(item.sizeBytes/1024)} KB · ใช้ได้ถึง {date(item.expiresAt)}</small>{changed&&<p role="alert">บทสนทนาเปลี่ยนแล้ว กรุณาตรวจข้อความล่าสุดและแนบไฟล์อีกครั้ง</p>}<div className="button-row"><Button type="button" size="sm" disabled={disabled||busy||changed} onClick={()=>void send()}>ยืนยันส่งไฟล์นี้</Button><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={()=>setItem(null)}>ยกเลิก</Button></div></div>}
  {error&&<p role="alert" className="error-text">{error}</p>}{result&&<p role="status">{result}</p>}
 </div>;
}
