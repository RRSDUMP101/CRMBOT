'use client';
import { uiText } from "./interface-text";
import {useCallback,useEffect,useState} from 'react';
import {api,date} from './data';
import {Button,Card,Input,Select} from './ui';

type Item={message_id:string;conversation_id:string;content:string;reason:string;category:string;mode:string;review_state:string;revision:number;lead_name:string;received_ms:number;semantic_status:string;model_summary:string|null;model_quote:string|null;model_name:string|null;model_action:string|null;model_confidence:number|null};
type Queue={items:Item[];policy:{mode:string;repeat_limit:number;window_seconds:number;revision:number};stats:{inspected:number;waiting:number;released:number;oldest_ms:number|null;spam_volume:number;confirmed_false_positive:number;recovered:number}};
type History={recent:{id:string;content:string;created_at:string}[];audit:{action:string;reviewer:string;created_at:string;metadata:{note:string}}[]};
const filters:Record<string,string>={pending:'รอตรวจ',held:'พักต่อ',released:'ปล่อยคืน',suppressed:'ระงับภายใน',all:'ทุกสถานะ'};
const endpoint='/api/admin/spam-review';
export function SpamReview() {
  const [data,setData]=useState<Queue|null>(null),[filter,setFilter]=useState('pending');
  const [cursor,setCursor]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [history,setHistory]=useState<Record<string,History>>({});
  const [notes,setNotes]=useState<Record<string,string>>({}),[mode,setMode]=useState('shadow'),[limit,setLimit]=useState(5),[windowSeconds,setWindowSeconds]=useState(60);
  const load=useCallback(async()=>{
    const q=await api<Queue>(endpoint+'?filter='+filter+cursor);
    setData(q);setMode(q.policy.mode);setLimit(q.policy.repeat_limit);setWindowSeconds(q.policy.window_seconds);
  },[filter,cursor]);
  useEffect(()=>{let active=true;setError('');setData(null);
    void api<Queue>(endpoint+'?filter='+filter+cursor).then(q=>{if(active){setData(q);setMode(q.policy.mode);setLimit(q.policy.repeat_limit);setWindowSeconds(q.policy.window_seconds);}}).catch(e=>{if(active)setError(e.message);});
    return()=>{active=false;};
  },[filter,cursor]);
  const save=async(body:Record<string,unknown>)=>{
    setBusy(true);setError('');
    try{await api(endpoint,body);setHistory({});await load();}catch(e){setError((e as Error).message);}finally{setBusy(false);}
  };
  return <section aria-label="คิวตรวจข้อความ WhatsApp">
    <h3>ตรวจข้อความ WhatsApp</h3>
    {error&&<p role="alert">{error}</p>}
    {data&&<Card><p>รอตรวจ {data.stats.waiting||0} · ปล่อยคืน {data.stats.released||0} · รับเข้าทั้งหมด {data.stats.inspected}
      {data.stats.oldest_ms?' · รอเก่าสุดตั้งแต่ '+date(new Date(data.stats.oldest_ms).toISOString()):''}</p>
      <p>ข้อความซ้ำหรือเข้าข่ายสแปม {data.stats.spam_volume||0} · ตรวจแล้วเป็นลูกค้าจริง {data.stats.confirmed_false_positive||0} · ผู้ส่งที่กลับเข้าคิวขาย {data.stats.recovered||0}</p>
      <details><summary>ตั้งค่าการคัดกรอง</summary>
        <label>โหมด <Select value={mode} onChange={e=>setMode(e.target.value)}><option value="shadow">สังเกตและบันทึก</option><option value="enforce">พักตามเกณฑ์ที่ตั้งไว้</option></Select></label>
        <label>จำนวนข้อความซ้ำ <Input type="number" min={2} max={100} value={limit} onChange={e=>setLimit(Number(e.target.value))}/></label>
        <label>ภายในกี่วินาที <Input type="number" min={10} max={3600} value={windowSeconds} onChange={e=>setWindowSeconds(Number(e.target.value))}/></label>
        <Button disabled={busy} onClick={()=>void save({mode,repeatLimit:limit,windowSeconds,expectedRevision:data.policy.revision})}>บันทึกเกณฑ์</Button>
      </details></Card>}
    <label>{uiText("สถานะ")} <Select value={filter} onChange={e=>{setCursor('');setFilter(e.target.value);}}>{Object.entries(filters).map(([value,label])=><option key={value} value={value}>{label}</option>)}</Select></label>
    {!data&&!error&&<p role="status">กำลังโหลดคิว…</p>}
    {data&&!data.items.length&&<p>ไม่มีข้อความในสถานะนี้</p>}
    {data?.items.map(row=><Card key={row.message_id}><h4>{row.lead_name} · {date(new Date(row.received_ms).toISOString())}</h4>
      <p>{row.reason} · {filters[row.review_state]} · {row.mode==='shadow'?'โหมดสังเกต':'โหมดพักข้อความ'}</p>
      <blockquote style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{row.content}</blockquote>
      {row.model_summary&&<p>ความเห็นจาก {row.model_name} · {row.model_summary} · เสนอ {row.model_action} · ความมั่นใจที่โมเดลประเมิน {Math.round(Number(row.model_confidence)*100)}% · ข้อความอ้างอิง “{row.model_quote}”</p>}
      {row.semantic_status==='unavailable'&&<p>ไม่มีผลจากโมเดล กรุณาตรวจจากข้อความต้นฉบับ</p>}
      <a href={'?conversation='+encodeURIComponent(row.conversation_id)+'#inbox'}>เปิดบทสนทนาใน Inbox</a>
      <details onToggle={async e=>{if(!e.currentTarget.open||history[row.message_id])return;try{const h=await api<History>(endpoint+'?messageId='+encodeURIComponent(row.message_id));setHistory(old=>({...old,[row.message_id]:h}));}catch(err){setError((err as Error).message);}}}>
        <summary>ข้อความก่อนหน้าและประวัติการตรวจ</summary>
        {history[row.message_id]?.recent.map(m=><p key={m.id}>{date(m.created_at)} · {m.content}</p>)}
        {history[row.message_id]?.audit.map((a,i)=><p key={i}>{date(a.created_at)} · {a.reviewer} · {a.action} · {a.metadata.note}</p>)}
      </details>
      {row.review_state!=='released'&&<><label>เหตุผลที่ตรวจ <Input value={notes[row.message_id]||''} maxLength={500} onChange={e=>setNotes(old=>({...old,[row.message_id]:e.target.value}))}/></label>
      {(row.review_state==='suppressed'?[['unsuppress','ยกเลิกการระงับภายใน']]:[['release','ไม่ใช่สแปม / ปล่อยคืน'],['hold','พักต่อ'],['suppress','ระงับผู้ส่งภายใน CRM']]).map(([decision,label])=><Button key={decision} variant="secondary" disabled={busy||!notes[row.message_id]?.trim()} onClick={()=>void save({decision,messageId:row.message_id,expectedRevision:row.revision,note:notes[row.message_id]})}>{label}</Button>)}</>}
    </Card>)}
    {cursor&&<Button variant="secondary" onClick={()=>setCursor('')}>กลับหน้าแรก</Button>}
    {data&&data.items.length===50&&<Button variant="secondary" onClick={()=>{const last=data.items[data.items.length-1];setCursor('&before='+last.received_ms+'&afterId='+encodeURIComponent(last.message_id));}}>หน้าถัดไป</Button>}
  </section>;
}
