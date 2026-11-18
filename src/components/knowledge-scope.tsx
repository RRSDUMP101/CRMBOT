'use client';
import {useState} from 'react';
import {Field,Input,Button,Select} from './ui';
import {api} from './data';
export const scopeFields={product:'ประเภทสินค้า',model:'รุ่นสินค้า',vehicle:'รุ่นรถ',year:'ปี',cab:'ห้องโดยสาร',market:'ตลาด',useCase:'การใช้งาน',country:'ประเทศ',conversationId:'ใช้เฉพาะบทสนทนา ID'};
export function KnowledgeScopeFields({value,onChange}:{value:Record<string,string>;onChange:(next:Record<string,string>)=>void}){
 return <details><summary>ขอบเขตสินค้าและลูกค้า</summary>{Object.entries(scopeFields).map(([key,label])=><Field key={key} label={label}><Input value={value[key]||''} onChange={e=>onChange({...value,[key]:e.target.value})}/></Field>)}</details>;
}
type Fact={fact_key:string;value:string|null;unit:string|null;revision:number;source_message_id:string;state:string};
export function CustomerFactReview(){
 const [id,setId]=useState(''),[message,setMessage]=useState(''),[key,setKey]=useState('vehicle'),[value,setValue]=useState(''),[unit,setUnit]=useState(''),[items,setItems]=useState<Fact[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 async function run(action:()=>Promise<{facts:Fact[]}>){setBusy(true);setError('');try{setItems((await action()).facts);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 const update=(state:'confirmed'|'unknown')=>run(()=>api('/api/admin/ai/case-fact',{conversationId:id,messageId:message,key,value,unit,state,expectedRevision:items.find(f=>f.fact_key===key)?.revision||0}));
 return <details><summary>ตรวจข้อมูลที่ลูกค้าแจ้ง</summary><fieldset disabled={busy}>
 <Field label="ID บทสนทนา"><Input value={id} onChange={e=>{setId(e.target.value);setItems([]);setMessage('');}}/></Field>
 <Button onClick={()=>void run(()=>api('/api/admin/ai/case-facts?id='+encodeURIComponent(id)))}>โหลดข้อมูลลูกค้ารายนี้</Button>
 <ul>{items.map(f=><li key={f.fact_key}>{f.fact_key} · {f.value??'ยังไม่ทราบ'} {f.unit} · {f.state} · v{f.revision} · {f.source_message_id}</li>)}</ul>
 <Field label="ข้อมูล"><Select value={key} onChange={e=>setKey(e.target.value)}>{Object.entries({...scopeFields,quantity:'จำนวน',email:'อีเมล',destination:'ปลายทาง',needBy:'วันที่ต้องการ'}).filter(([k])=>k!=='conversationId').map(([k,label])=><option key={k} value={k}>{label}</option>)}</Select></Field>
 <Field label="ID ข้อความหลักฐาน"><Input value={message} onChange={e=>setMessage(e.target.value)}/></Field>
 <Field label="ค่าที่ตรวจแล้ว"><Input value={value} onChange={e=>setValue(e.target.value)}/></Field>
 <Field label="หน่วย (ถ้ามี)"><Input value={unit} onChange={e=>setUnit(e.target.value)}/></Field>
 <Button disabled={!id||!message||!value} onClick={()=>void update('confirmed')}>ยืนยันข้อมูลสำหรับเคสนี้</Button>
 <Button variant="ghost" disabled={!id||!message} onClick={()=>void update('unknown')}>บันทึกว่ายังไม่ทราบ</Button></fieldset>
 {error&&<p role="alert">{error}</p>}</details>;
}
