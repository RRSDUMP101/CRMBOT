"use client";
import {useEffect,useState} from 'react';

export default function ErrorPage({error,reset}: {error: Error & {digest?: string}; reset: () => void}) {
  const [time,setTime] = useState('');
  const [copied,setCopied] = useState(false);
  const [manual,setManual] = useState(false);
  useEffect(()=>{setTime(new Date().toISOString());setCopied(false);setManual(false);},[error]);
  const digest = error.digest && /^[A-Za-z0-9_-]{1,80}$/.test(error.digest) ? error.digest : '';
  const reference = digest || time;
  const details = ['RRS CRM Terminal', 'เปิดหน้าทำงานไม่สำเร็จ', 'เวลา UTC ' + time, ...(digest ? ['รหัสจากเซิร์ฟเวอร์ ' + digest] : [])].join('\n');
  async function copy() {
    try {await navigator.clipboard.writeText(details);setCopied(true);}
    catch {setManual(true);}
  }
  return <main className="full-state" style={{maxWidth:660,margin:'10vh auto',padding:24}}>
    <h1>เปิดหน้านี้ไม่สำเร็จ</h1>
    <p>ลองเปิดหน้าเดิมอีกครั้ง หากยังพบปัญหา ส่งรายละเอียดนี้ให้ทีมเทคนิค</p>
    {reference && <p>อ้างอิง <code>{reference}</code></p>}
    <div style={{display:'flex',flexWrap:'wrap',gap:12}}>
      <button type="button" className="button button-primary rrs-btn primary" onClick={reset}>ลองอีกครั้ง</button>
      <button type="button" className="button button-secondary rrs-btn ghost" disabled={!time} onClick={copy}>คัดลอกรายละเอียดปัญหา</button>
    </div>
    {copied && <p role="status">คัดลอกรายละเอียดแล้ว</p>}
    {manual && <label>เลือกและคัดลอกรายละเอียด<textarea readOnly value={details} onFocus={e=>e.target.select()}/></label>}
  </main>;
}
