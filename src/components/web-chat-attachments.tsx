"use client";
import {useEffect,useRef,useState} from 'react';
import {api} from './data';
import {Button} from './ui';
export type WebChatFile={id:string;name:string;mime:string;size:number;state:string;downloadUrl?:string};
export function WebChatFiles({files,staff=false}:{files?:WebChatFile[];staff?:boolean}){
 const [error,setError]=useState('');
 async function download(file:WebChatFile){
  setError('');try{const path=staff?file.downloadUrl:'/api/chat/attachments/'+file.id;if(!path||!path.startsWith('/api/'))throw new Error('ไม่พบไฟล์');const response=await fetch(path,{credentials:'same-origin',cache:'no-store'});if(!response.ok){const result=await response.json();throw new Error(result.error||'ดาวน์โหลดไม่ได้');}const url=URL.createObjectURL(await response.blob()),link=document.createElement('a');link.href=url;link.download=file.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){setError((e as Error).message);}
 }
 return <>{files?.map(file=><div key={file.id}><button type="button" className="text-link" onClick={()=>void download(file)} disabled={file.state!=='ready'}>{file.name} · {Math.ceil(file.size/1024)} KB · {file.state==='ready'?'ดาวน์โหลด':'ไฟล์ไม่พร้อมใช้งาน'}</button></div>)}{error&&<small role="alert">{error}</small>}</>;
}
export function WebChatAttachments({conversationId,version,disabled,onSent}:{conversationId?:string;version:number;disabled:boolean;onSent:()=>Promise<void>}){
 const base=conversationId?`/api/admin/conversations/${conversationId}/web-attachments`:'/api/chat/attachments';
 const [caps,setCaps]=useState<{enabled:boolean;supported:boolean;maxBytes:number;accept:string[]}|null>(null),[file,setFile]=useState<File|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[selectedVersion,setSelectedVersion]=useState(version),client=useRef('');
 useEffect(()=>{let live=true;api<typeof caps>(base).then(value=>{if(live)setCaps(value);},()=>{});return()=>{live=false;};},[base]);
 async function send(){
  if(!file||!caps||busy)return;setBusy(true);setError('');
  try{const response=await fetch(base,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':file.type,'X-File-Name':encodeURIComponent(file.name),'X-Client-Id':client.current,'X-Conversation-Version':String(selectedVersion)},body:file});const result=await response.json();if(!response.ok)throw new Error(result.error||'ส่งไฟล์ไม่ได้');setFile(null);await onSent();}catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 if(!caps?.enabled||!caps.supported)return null;
 const stale=!!conversationId&&!!file&&selectedVersion!==version;
 return <div className="composer-attachments" aria-label="แนบไฟล์แชตเว็บไซต์"><label>แนบ PDF, JPEG หรือ PNG ไม่เกิน 5 MB <input type="file" accept={caps.accept.join(',')} disabled={disabled||busy} onChange={e=>{const chosen=e.target.files?.[0];e.target.value='';setError('');if(!chosen)return;if(chosen.size>caps.maxBytes||!caps.accept.includes(chosen.type)){setError('รองรับ PDF, JPEG และ PNG ไม่เกิน 5 MB');return;}setFile(chosen);setSelectedVersion(version);client.current=crypto.randomUUID();}}/></label>
  {file&&<div><span>{file.name} · {Math.ceil(file.size/1024)} KB</span>{stale&&<p role="alert">บทสนทนาเปลี่ยนแล้ว โปรดตรวจข้อความล่าสุดและเลือกไฟล์อีกครั้ง</p>}<div className="button-row"><Button type="button" size="sm" disabled={disabled||busy||stale} onClick={()=>void send()}>{busy?'กำลังส่ง…':'ยืนยันส่งไฟล์'}</Button><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={()=>setFile(null)}>ยกเลิก</Button></div></div>}
  {!conversationId&&<small>ไฟล์เก็บเป็นส่วนตัว ทีมงานจะตรวจเนื้อหาให้ โปรดไม่ส่งรหัสผ่านหรือข้อมูลอ่อนไหว</small>}{error&&<p role="alert" className="error-text">{error} {file?'กดส่งอีกครั้งด้วยไฟล์เดิมได้ ระบบไม่สร้างข้อความซ้ำ':''}</p>}
 </div>;
}
