"use client";
import {useCallback,useEffect,useRef,useState} from 'react';
import type {WhatsAppConsentStatus} from '@/lib/social-consent';
import {api,date} from './data';
import {Badge,Button,Select,Textarea} from './ui';
import {subscribeCRMChanges} from './realtime';

export function WhatsAppConsent({conversationId}:{conversationId:string}){
  const [status,setStatus]=useState<WhatsAppConsentStatus|null>(null),[decision,setDecision]=useState(''),[note,setNote]=useState(''),[confirmed,setConfirmed]=useState(false);
  const [busy,setBusy]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const revision=useRef(0),saving=useRef(false),active=useRef(true);
  const load=useCallback(async()=>{
    setConfirmed(false);if(saving.current)return; // Save always fetches again after its outcome.
    const current=++revision.current;setLoading(true);setError('');
    try{const next=await api<WhatsAppConsentStatus>('/api/admin/whatsapp-consent/'+conversationId);if(active.current&&current===revision.current)setStatus(next);}
    catch(e){if(active.current&&current===revision.current){setStatus(null);setError((e as Error).message);}}
    finally{if(active.current&&current===revision.current)setLoading(false);}
  },[conversationId]);
  useEffect(()=>{active.current=true;void load();const unsubscribe=subscribeCRMChanges(()=>void load());return()=>{active.current=false;revision.current++;unsubscribe();};},[load]);
  async function save(){
    if(!status?.applicable||loading||saving.current||!confirmed)return;
    const current=++revision.current;saving.current=true;setBusy(true);setError('');setNotice('');setConfirmed(false);
    let failed='';
    try{const next=await api<WhatsAppConsentStatus>('/api/admin/whatsapp-consent/'+conversationId,{decision,evidenceNote:note,expectedRevision:status.revision,confirm:true});if(!active.current||current!==revision.current)return;setStatus(next);setDecision('');setNote('');setNotice('บันทึกหลักฐานแล้ว ข้อความที่ค้างรอส่งถูกยกเลิก กรุณาตรวจและตอบใหม่เมื่อพร้อม');}
    catch(e){if(!active.current||current!==revision.current)return;failed=(e as Error).message;setStatus(null);}
    finally{saving.current=false;if(active.current&&current===revision.current){setBusy(false);const refresh=load(),refreshedRevision=revision.current;await refresh;if(failed&&active.current&&refreshedRevision===revision.current)setError(failed);}}
  }
  if(status&&!status.applicable)return null;
  return <section className="profile-section" aria-label="ความยินยอม WhatsApp"><h3>ความยินยอม WhatsApp</h3>
    {error&&<p role="alert" className="error-text">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {!status&&!error&&<p className="helper-text">กำลังตรวจหลักฐาน…</p>}
    {status?.applicable&&<><Badge tone={!loading&&!busy&&status.granted&&!status.optedOut?'green':'neutral'}>{loading||busy?'กำลังตรวจสถานะล่าสุด':status.optedOut?'ลูกค้าปฏิเสธการติดต่อ':status.granted?'มีหลักฐานความยินยอม':'ยังไม่มีหลักฐานความยินยอม'}</Badge>
      {status.recordedAt&&<p className="helper-text">บันทึกหลักฐาน {date(status.recordedAt)}</p>}
      <p className="helper-text">บันทึกจากหลักฐานที่ตรวจสอบแล้ว การทักเข้ามาเพียงอย่างเดียวไม่ถือเป็นหลักฐานยินยอม การบันทึกนี้ไม่ส่งข้อความถึงลูกค้า</p>
      {status.lastReview&&<details><summary>หลักฐานที่ตรวจล่าสุด</summary><p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{status.lastReview.evidenceNote}</p><small>{date(status.lastReview.recordedAt)}</small></details>}
      {status.affectedConversations>1&&<p className="helper-text">ใช้กับบทสนทนา WhatsApp ของลูกค้ารายนี้ทั้ง {status.affectedConversations} บทสนทนา</p>}
      {!!status.inFlight&&<p className="helper-text">มี {status.inFlight} ข้อความที่เริ่มส่งแล้วหรือยังไม่ทราบผล ต้องตรวจใบตอบรับ การถอนความยินยอมไม่ดึงข้อความที่ส่งถึงผู้ให้บริการกลับ</p>}
      <label className="field"><span>ผลการตรวจหลักฐาน</span><Select value={decision} disabled={busy} onChange={e=>{setDecision(e.target.value);setConfirmed(false);}}><option value="">เลือกรายการ</option><option value="granted" disabled={status.optedOut}>ลูกค้ายินยอมให้ติดต่อ</option><option value="revoked">ถอนความยินยอม / หยุดการติดต่อ</option></Select></label>
      <label className="field"><span>ที่มาและรายละเอียดหลักฐาน</span><Textarea value={note} disabled={busy} rows={3} maxLength={1000} placeholder="เช่น ลูกค้ายืนยันผ่านแบบฟอร์มใด วันเวลาใด และหมายเลขอ้างอิง" onChange={e=>{setNote(e.target.value);setConfirmed(false);}}/></label>
      <label className="field"><span><input type="checkbox" checked={confirmed} disabled={busy||loading||!decision||note.trim().length<3} onChange={e=>setConfirmed(e.target.checked)}/> ฉันตรวจหลักฐานแล้ว และยืนยันผลที่เลือก</span></label>
      <Button size="sm" disabled={busy||loading||!decision||!confirmed||note.trim().length<3} onClick={()=>void save()}>{busy?'กำลังบันทึก…':'บันทึกผลตรวจหลักฐาน'}</Button>
    </>}
    <Button variant="ghost" size="sm" disabled={busy} onClick={()=>void load()}>โหลดสถานะล่าสุด</Button>
  </section>;
}
