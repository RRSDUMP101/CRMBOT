"use client";
import {useCallback,useEffect,useState} from 'react';
import {api,date} from './data';
import {Field,Input} from './ui';
type Item={id:string;filename:string;contentType:string;size:number;createdAt:string};
export function LeadFiles({leadId}:{leadId:string}) {
  const [files,setFiles]=useState<Item[]>([]);const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  const load=useCallback(async()=>{const result=await api<{files:Item[]}>(`/api/admin/leads/${leadId}/files`);setFiles(result.files);},[leadId]);
  useEffect(()=>{void load().catch(e=>setError(e.message));},[load]);
  return <section className="form-stack" aria-label="ไฟล์ลูกค้า"><h3>ไฟล์ลูกค้า</h3>
    <Field label="แนบไฟล์" hint="PDF, JPG หรือ PNG ไม่เกิน 10 MB — เฉพาะทีมในองค์กรนี้เปิดได้">
      <Input type="file" accept="application/pdf,image/jpeg,image/png" disabled={busy} onChange={async e=>{
        const file=e.target.files?.[0];e.target.value='';if(!file)return;
        if(file.size>10*1024*1024){setError('ไฟล์ต้องมีขนาดไม่เกิน 10 MB');return;}
        setBusy(true);setError('');
        try{const response=await fetch(`/api/admin/leads/${leadId}/files`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':file.type,'X-File-Name':encodeURIComponent(file.name)},body:file});
          const result=await response.json();if(!response.ok)throw new Error(result.error||'อัปโหลดไม่สำเร็จ');await load();
        }catch(e){setError((e as Error).message);}finally{setBusy(false);}
      }}/>
    </Field>
    {busy&&<p role="status">กำลังอัปโหลด…</p>}{error&&<p role="alert" className="error-text">{error}</p>}
    {files.length?<ul>{files.map(file=><li key={file.id}><a href={`/api/admin/files/${file.id}`} download>{file.filename}</a> <small>{Math.ceil(file.size/1024)} KB · {date(file.createdAt)}</small></li>)}</ul>:<p className="helper-text">ยังไม่มีไฟล์แนบ</p>}
  </section>;
}
