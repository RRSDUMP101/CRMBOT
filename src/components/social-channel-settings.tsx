"use client";
import {useCallback,useEffect,useRef,useState} from 'react';
import {api,date} from './data';
import {Badge,Button,Card} from './ui';

type Provider='whatsapp'|'line'|'facebook';
type Status={provider:Provider;accountId:string;configured:boolean;missing:string[];expectedWebhookUrl:string;owner:string;inboundEnabled:boolean;environmentLiveEnabled:boolean;sendMode:'disabled'|'test'|'live';emergencyStop:boolean;verified:boolean;verifiedAt:string|null;verificationExpiresAt:string|null;webhookVerified:boolean;lastWebhookAt:string|null;testRecipient:string|null;testPassed:boolean;errorCode:string|null;testAccount:boolean};
const labels:Record<Provider,string>={whatsapp:'WhatsApp',line:'LINE OA',facebook:'Facebook'};
export function SocialChannelSettings({isAdmin}:{isAdmin:boolean}){
  if(!isAdmin)return <p className="helper-text">ผู้ดูแลระบบตรวจสอบและจัดการการเชื่อมต่อ WhatsApp, LINE OA และ Facebook ได้</p>;
  return <section aria-label="ช่องทางข้อความลูกค้า"><h2>ช่องทางข้อความลูกค้า</h2><p className="helper-text">ตรวจบัญชีและการรับข้อความก่อนเปิดให้ทีมตอบ การตรวจบัญชีไม่ส่งข้อความถึงลูกค้า</p><div className="knowledge-grid">{(['whatsapp','line','facebook'] as Provider[]).map(provider=><Channel key={provider} provider={provider}/>)}</div></section>;
}
function Channel({provider}:{provider:Provider}){
  const [status,setStatus]=useState<Status|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[review,setReview]=useState(false);
  const revision=useRef(0);
  const load=useCallback(async()=>{const current=++revision.current;setError('');setReview(false);try{const next=await api<Status>('/api/admin/social-channels/'+provider);if(current===revision.current)setStatus(next);}catch(e){if(current===revision.current)setError((e as Error).message);}},[provider]);
  useEffect(()=>{void load();return()=>{revision.current++;};},[load]);
  async function act(action:'verify'|'disable'|'enable-test'|'enable'){
    const current=++revision.current;setBusy(true);setError('');setNotice('');setReview(false);
    try{const next=await api<Status>('/api/admin/social-channels/'+provider,{action,...(action.startsWith('enable')?{confirm:true}:{})});if(current!==revision.current)return;setStatus(next);setNotice(action==='verify'?'ตรวจบัญชีแล้ว การส่งยังปิดอยู่':action==='disable'?'หยุดการส่งแล้ว':action==='enable-test'?'เปิดเฉพาะผู้รับทดสอบแล้ว':'เปิดการตอบลูกค้าแล้ว');}
    catch(e){if(current!==revision.current)return;setError((e as Error).message);setStatus(null);try{const next=await api<Status>('/api/admin/social-channels/'+provider);if(current===revision.current)setStatus(next);}catch{/* Keep an unknown state until a fresh server response succeeds. */}}
    finally{if(current===revision.current)setBusy(false);}
  }
  const ready=!!status&&status.configured&&status.verified&&status.webhookVerified&&status.owner==='crm'&&status.inboundEnabled&&status.environmentLiveEnabled;
  return <Card className="settings-card"><div className="card-heading"><h3>{labels[provider]}</h3><Badge tone={ready&&status?.sendMode==='live'&&!status.emergencyStop?'green':'neutral'}>{!status?'ยังไม่ยืนยันสถานะ':status.emergencyStop||status.sendMode==='disabled'?'การส่งปิดอยู่':!ready?'รอตรวจสอบก่อนส่ง':status.sendMode==='test'?'เฉพาะผู้รับทดสอบ':'เปิดการตอบลูกค้า'}</Badge></div>
    {error&&<p role="alert" className="error-text">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {status&&<><dl><dt>บัญชีช่องทาง</dt><dd>{status.accountId||'ยังไม่ได้ตั้งค่า'}</dd><dt>ตรวจบัญชี</dt><dd>{status.verified?'ผ่าน · '+date(status.verifiedAt):'ยังไม่ผ่าน หรือหมดอายุ'}</dd><dt>รับข้อความจากช่องทาง</dt><dd>{status.webhookVerified?'ยืนยันแล้ว · '+date(status.lastWebhookAt):'รอข้อความทดสอบจากช่องทาง'}</dd><dt>ผลการตอบทดสอบ</dt><dd>{status.testPassed?'ผ่าน':'ยังไม่ผ่าน'}</dd><dt>ผู้รับทดสอบ</dt><dd>{status.testRecipient||'ยังไม่ได้กำหนด'}</dd></dl>
    {!status.environmentLiveEnabled&&<p className="helper-text">การส่งยังถูกปิดไว้ในการตั้งค่าระบบ</p>}
    {status.testAccount&&<p className="helper-text">บัญชี Meta สำหรับทดสอบ · ส่งได้เฉพาะผู้รับทดสอบที่กำหนด</p>}
    <details><summary>รายละเอียดสำหรับเชื่อมช่องทาง</summary><p>ลิงก์รับข้อความ</p><code style={{overflowWrap:'anywhere'}}>{status.expectedWebhookUrl}</code>{status.missing.length>0&&<p>ยังขาดการตั้งค่า: {status.missing.join(', ')}</p>}{status.errorCode&&<p>รหัสตรวจสอบ: {status.errorCode}</p>}<p className="helper-text">ตั้งค่ากุญแจเชื่อมต่อผ่านระบบจัดเก็บความลับของเซิร์ฟเวอร์</p></details>
    <div className="button-row"><Button variant="secondary" disabled={busy||!status.configured} onClick={()=>void act('verify')}>ตรวจบัญชี</Button><Button variant="destructive" disabled={busy} onClick={()=>void act('disable')}>หยุดการส่ง</Button></div>
    <label className="field"><span><input type="checkbox" checked={review} disabled={busy||!ready} onChange={e=>setReview(e.target.checked)}/> ฉันตรวจบัญชีและผู้รับทดสอบแล้ว และยืนยันว่าระบบเดิมหยุดส่งแล้ว</span></label>
    <div className="button-row"><Button variant="secondary" disabled={busy||!ready||!review||!status.testRecipient} onClick={()=>void act('enable-test')}>เปิดเฉพาะผู้รับทดสอบ</Button><Button disabled={busy||!ready||!review||!status.testPassed||status.testAccount} onClick={()=>void act('enable')}>เปิดการตอบลูกค้า</Button></div></>}
    <Button variant="ghost" size="sm" disabled={busy} onClick={()=>void load()}>ตรวจสถานะล่าสุด</Button>
  </Card>;
}
