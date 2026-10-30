"use client";
import {useCallback,useEffect,useRef,useState} from 'react';
import {AlertTriangle,Megaphone,Plus,RefreshCw} from 'lucide-react';
import {api,date,isoLocal,stageNames} from './data';
import {Badge,Button,Card,Empty,Field,Input,Select,Textarea} from './ui';

type Provider='whatsapp'|'line';
type ChannelGate={configured:boolean;accountId:string;environmentLive:boolean;verified:boolean;emergencyStop:boolean;sendMode:string;live:boolean;testReady:boolean;testRecipient:string|null};
type Gates={enabled:boolean;dailyLimit:number;maxRecipients:number;batchLimit:number;channels:Record<Provider,ChannelGate>};
type Segment={tags?:string[];markets?:string[];stages?:string[];firstContactFrom?:string;firstContactTo?:string;lastContactFrom?:string;lastContactTo?:string;importId?:string};
type Summary={id:string;name:string;provider:Provider;status:string;messageKind:string;scheduledAt:string|null;launchedAt:string|null;launchedCount:number|null;completedAt:string|null;version:number;updatedAt:string;recipients:Record<string,number>};
type Campaign={id:string;name:string;provider:Provider;accountId:string;status:string;messageKind:'text'|'template';messageText:string;template:{name:string;language:string;params:string[]}|null;templateBody:string|null;segment:Segment;scheduledAt:string|null;launchedAt:string|null;launchedCount:number|null;completedAt:string|null;cancelledAt:string|null;version:number;updatedAt:string};
type Detail={campaign:Campaign;stats:{recipients:Record<string,number>;skipReasons:Record<string,number>;delivery:Record<string,number>};gates:Gates;canManage:boolean;testSends:{campaignVersion:number;recipient:string;createdAt:string;status:string;errorCode:string}[];imports:{importId:string;createdAt:string;total:number;valid:number;matched:number;eligible:number}[];testPassedForVersion:boolean};
type Preview={campaignId:string;version:number;matched:number;eligible:number;excluded:Record<string,number>;maxRecipients:number;overLimit:boolean;computedAt:string;samples:{recipient:string;market:string;stage:string}[];excludedSamples:{recipient:string;market:string;stage:string;reason:string}[]};
type ImportResult={importId:string;totalRows:number;valid:number;invalid:number;duplicates:number;invalidReasons:Record<string,number>;matched:number;matchedEligible:number;unmatched:number;excluded:Record<string,number>;recipientsCreated:number;samples:{row:number;recipient:string;status:string;error:string;match:string;reason:string}[]};

const providerNames:Record<Provider,string>={whatsapp:'WhatsApp',line:'LINE OA'};
const statusNames:Record<string,string>={draft:'ฉบับร่าง',scheduled:'ตั้งเวลาไว้',sending:'กำลังส่ง',paused:'หยุดชั่วคราว',completed:'ส่งครบแล้ว',cancelled:'ยกเลิกแล้ว'};
const statusTone:Record<string,string>={draft:'neutral',scheduled:'blue',sending:'green',paused:'amber',completed:'purple',cancelled:'neutral'};
const reasonNames:Record<string,string>={no_consent:'ไม่มีหลักฐานความยินยอม WhatsApp',not_followed:'ไม่มีหลักฐานว่าเป็นเพื่อน LINE',opted_out:'ลูกค้าปฏิเสธการติดต่อหรือบล็อก',suppressed:'อยู่ในรายชื่อระงับการส่ง',outside_24h_window:'เกิน 24 ชม. หลังข้อความล่าสุดของลูกค้า (ส่งได้เฉพาะเทมเพลตที่อนุมัติ)',invalid_recipient:'รูปแบบผู้รับไม่ถูกต้อง',identity_link_changed:'ข้อมูลตัวตนลูกค้าเปลี่ยน ต้องตรวจสอบ',replied:'ลูกค้าตอบกลับหลังเริ่มส่ง',cancelled_before_send:'ยกเลิกก่อนส่ง',guard_rejected:'ไม่ผ่านการตรวจก่อนส่ง',campaign_cancelled:'ยกเลิกแคมเปญ'};
const recipientNames:Record<string,string>={pending:'รอส่ง',queued:'อยู่ในคิว',submitted:'ส่งถึงผู้ให้บริการแล้ว',failed:'ส่งไม่สำเร็จ',unknown:'ไม่ทราบผล (ไม่ส่งซ้ำอัตโนมัติ)',skipped:'ข้าม'};
const importErrors:Record<string,string>={missing_value:'ไม่มีค่า',invalid_phone:'เบอร์ไม่ถูกต้อง',phone_requires_country_code:'ต้องมีรหัสประเทศ เช่น +66',invalid_line_id:'LINE user ID ไม่ถูกต้อง',duplicate:'ซ้ำในไฟล์'};
const markets:Record<string,string>={export:'ส่งออก',domestic:'ในประเทศ',unknown:'ไม่ระบุ'};
const label=(names:Record<string,string>,key:string)=>names[key]||key;
const counts=(values:Record<string,number>,names:Record<string,string>)=>Object.entries(values).filter(([,n])=>n>0).map(([key,n])=><li key={key}>{label(names,key)}: <strong>{n}</strong></li>);
const newId=()=>globalThis.crypto.randomUUID();

/** Admin-only workflow with explicit gates. Agents get a read-only list. Nothing here sends without a server-side check. */
export function BroadcastPanel({isAdmin}:{isAdmin:boolean}){
  const [list,setList]=useState<{campaigns:Summary[];gates:Gates;canManage:boolean}|null>(null),[selected,setSelected]=useState<string|null>(null);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[name,setName]=useState(''),[provider,setProvider]=useState<Provider>('whatsapp');
  const load=useCallback(async()=>{setError('');try{setList(await api('/api/admin/broadcasts'));}catch(e){setError((e as Error).message);}},[]);
  useEffect(()=>{void load();},[load]);
  async function create(){
    setBusy(true);setError('');
    try{const created=await api<Detail>('/api/admin/broadcasts',{name,provider,messageText:''});setName('');await load();setSelected(created.campaign.id);}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <div className="form-stack" style={{padding:0}}>
    {error&&<div className="alert alert-error" role="alert">{error}</div>}
    {list&&<GateWarnings gates={list.gates}/>}
    {isAdmin&&<Card><div className="card-heading"><div><h2>สร้างแคมเปญบรอดแคสต์</h2><p>ส่งได้เฉพาะลูกค้าที่มีหลักฐานยินยอม (WhatsApp) หรือเป็นเพื่อนอยู่ (LINE) ไม่สร้างรายชื่อหรือความยินยอมใหม่</p></div><Megaphone size={20}/></div>
      <div className="form-grid" style={{padding:'0 24px 20px'}}><Field label="ชื่อแคมเปญ"><Input value={name} maxLength={120} onChange={e=>setName(e.target.value)} placeholder="เช่น แจ้งสินค้าใหม่ ตุลาคม"/></Field>
        <Field label="ช่องทาง"><Select value={provider} onChange={e=>setProvider(e.target.value as Provider)}><option value="whatsapp">WhatsApp</option><option value="line">LINE OA</option></Select></Field>
        <div className="button-row"><Button disabled={busy||!name.trim()} onClick={()=>void create()}><Plus size={15}/>สร้างฉบับร่าง</Button></div></div></Card>}
    {!isAdmin&&<p className="helper-text">ผู้ดูแลระบบเป็นผู้สร้างและอนุมัติการส่งบรอดแคสต์ คุณดูรายการและสถานะได้อย่างเดียว</p>}
    <Card><div className="card-heading"><div><h2>แคมเปญ</h2><p>ล่าสุด 100 รายการ</p></div><Button variant="ghost" size="sm" onClick={()=>void load()}><RefreshCw size={14}/>รีเฟรช</Button></div>
      {!list?<p className="helper-text" style={{padding:'0 24px'}}>กำลังโหลด…</p>:!list.campaigns.length?<Empty title="ยังไม่มีแคมเปญ"/>:
      <div className="table-wrap"><table><thead><tr><th>แคมเปญ</th><th>ช่องทาง</th><th>สถานะ</th><th>ผู้รับ</th><th>อัปเดต</th><th/></tr></thead><tbody>{list.campaigns.map(c=><tr key={c.id}>
        <td><strong>{c.name}</strong><small>{c.messageKind==='template'?'เทมเพลต':'ข้อความ'}{c.scheduledAt?' · ตั้งเวลา '+date(c.scheduledAt):''}</small></td><td>{providerNames[c.provider]}</td>
        <td><Badge tone={statusTone[c.status]}>{label(statusNames,c.status)}</Badge></td>
        <td>{c.launchedCount??'—'}{c.recipients.submitted?` · ส่งแล้ว ${c.recipients.submitted}`:''}</td><td>{date(c.updatedAt)}</td>
        <td><Button variant="ghost" size="sm" onClick={()=>setSelected(selected===c.id?null:c.id)}>{selected===c.id?'ปิด':'เปิด'}</Button></td></tr>)}</tbody></table></div>}
    </Card>
    {selected&&<CampaignDetail key={selected} id={selected} isAdmin={isAdmin} onChanged={load}/>}
  </div>;
}

function GateWarnings({gates}:{gates:Gates}){
  const warnings:string[]=[];
  if(!gates.enabled)warnings.push('บรอดแคสต์ปิดอยู่ (BROADCAST_ENABLED ไม่ได้เปิด) — สร้างร่าง ดูตัวอย่างกลุ่มผู้รับ และนำเข้ารายชื่อแบบทดลองได้ แต่ทดสอบส่งหรือส่งจริงไม่ได้');
  for(const provider of ['whatsapp','line'] as Provider[]){
    const g=gates.channels[provider];
    if(!g?.configured)warnings.push(`${providerNames[provider]}: ยังไม่ได้ตั้งค่าบัญชีช่องทางสำหรับองค์กรนี้`);
    else if(g.emergencyStop)warnings.push(`${providerNames[provider]}: หยุดการส่งอยู่ (หยุดฉุกเฉินหรือยังไม่เปิด) — ส่งไม่ได้`);
    else if(!g.environmentLive||!g.verified)warnings.push(`${providerNames[provider]}: ช่องทางยังไม่เปิดส่งจริงหรือยังไม่ผ่านการตรวจบัญชี`);
    else if(!g.live)warnings.push(`${providerNames[provider]}: อยู่ในโหมดทดสอบ — ทดสอบส่งถึง ${g.testRecipient||'ผู้รับทดสอบ'} ได้เท่านั้น ส่งถึงลูกค้าไม่ได้`);
  }
  return <div className="alert" role="status" style={{flexDirection:'column',alignItems:'flex-start',background:warnings.length?'#fff6e4':'#eaf6ef',border:'1px solid #f0e2c2'}}>
    {warnings.length?<><strong><AlertTriangle size={14}/> การส่งบรอดแคสต์ยังถูกจำกัด</strong><ul style={{margin:0,paddingLeft:18}}>{warnings.map(w=><li key={w}>{w}</li>)}</ul></>:<strong>พร้อมส่งตามเงื่อนไข · โควตา {gates.dailyLimit} ข้อความต่อวัน · สูงสุด {gates.maxRecipients} รายต่อแคมเปญ</strong>}
    <small>ทุกข้อความผ่านการตรวจเดียวกับการตอบลูกค้า: ความยินยอม การปฏิเสธการติดต่อ หยุดฉุกเฉิน และไม่ส่งซ้ำเมื่อไม่ทราบผล ระบบไม่มีตัวตั้งเวลาอัตโนมัติ ผู้ดูแลต้องกด “ส่งชุดถัดไป”</small>
  </div>;
}

function CampaignDetail({id,isAdmin,onChanged}:{id:string;isAdmin:boolean;onChanged:()=>Promise<void>}){
  const [detail,setDetail]=useState<Detail|null>(null),[preview,setPreview]=useState<Preview|null>(null),[imported,setImported]=useState<ImportResult|null>(null);
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
  const [form,setForm]=useState({name:'',kind:'text' as 'text'|'template',text:'',templateName:'',templateLanguage:'th',templateParams:'',tags:'',markets:[] as string[],stages:[] as string[],firstFrom:'',firstTo:'',lastFrom:'',lastTo:'',importId:''});
  const [csv,setCsv]=useState<{name:string;text:string}|null>(null),[column,setColumn]=useState('phone'),[confirmLaunch,setConfirmLaunch]=useState(false),[scheduleAt,setScheduleAt]=useState(''),[confirmControl,setConfirmControl]=useState(false);
  const revision=useRef(0);
  const apply=useCallback((next:Detail)=>{
    setDetail(next);const c=next.campaign,s=c.segment||{};
    setForm({name:c.name,kind:c.messageKind,text:c.messageText,templateName:c.template?.name||'',templateLanguage:c.template?.language||'th',templateParams:(c.template?.params||[]).join('\n'),tags:(s.tags||[]).join(', '),markets:s.markets||[],stages:s.stages||[],firstFrom:s.firstContactFrom||'',firstTo:s.firstContactTo||'',lastFrom:s.lastContactFrom||'',lastTo:s.lastContactTo||'',importId:s.importId||''});
    setConfirmLaunch(false);setConfirmControl(false);
  },[]);
  const load=useCallback(async()=>{const current=++revision.current;try{const next=await api<Detail>('/api/admin/broadcasts/'+id);if(current===revision.current)apply(next);}catch(e){if(current===revision.current)setError((e as Error).message);}},[id,apply]);
  useEffect(()=>{void load();return()=>{revision.current++;};},[load]);
  async function act<T>(task:()=>Promise<T>,done?:(value:T)=>string|void){
    setBusy(true);setError('');setNotice('');
    try{const value=await task();const message=done?.(value);if(message)setNotice(message);}
    catch(e){setError((e as Error).message);}
    finally{setBusy(false);await load();await onChanged();}
  }
  if(!detail)return <Card><p className="helper-text" style={{padding:'0 24px'}}>{error||'กำลังโหลดแคมเปญ…'}</p></Card>;
  const c=detail.campaign,gate=detail.gates.channels[c.provider],draft=c.status==='draft',manage=isAdmin&&detail.canManage;
  const previewCurrent=preview&&preview.version===c.version?preview:null;
  const segment=():Segment=>({...(form.tags.trim()?{tags:form.tags.split(',').map(t=>t.trim()).filter(Boolean)}:{}),...(form.markets.length?{markets:form.markets}:{}),...(form.stages.length?{stages:form.stages}:{}),
    ...(form.firstFrom?{firstContactFrom:form.firstFrom}:{}),...(form.firstTo?{firstContactTo:form.firstTo}:{}),...(form.lastFrom?{lastContactFrom:form.lastFrom}:{}),...(form.lastTo?{lastContactTo:form.lastTo}:{}),...(form.importId?{importId:form.importId}:{})});
  const save=(extra:Partial<typeof form>={})=>act(async()=>{
    const f={...form,...extra},template=c.provider==='whatsapp'&&f.kind==='template'?{name:f.templateName.trim(),language:f.templateLanguage.trim(),params:f.templateParams.split('\n').map(p=>p.trim()).filter(Boolean)}:null;
    setPreview(null);
    return api<Detail>('/api/admin/broadcasts/'+id,{expectedVersion:c.version,name:f.name,messageKind:c.provider==='line'?'text':f.kind,messageText:f.text,...(template?{template}:{}),segment:{...segment(),...(extra.importId!==undefined?{importId:extra.importId||undefined}:{})}});
  },()=>'บันทึกฉบับร่างแล้ว กรุณาดูตัวอย่างและทดสอบส่งใหม่');
  const toggle=(key:'markets'|'stages',value:string)=>setForm(f=>({...f,[key]:f[key].includes(value)?f[key].filter(v=>v!==value):[...f[key],value]}));
  return <Card className="settings-card" style={{maxWidth:'none'}}>
    <div className="card-heading"><div><h2>{c.name}</h2><p>{providerNames[c.provider]} · บัญชี {c.accountId} · ฉบับที่ {c.version}</p></div><Badge tone={statusTone[c.status]}>{label(statusNames,c.status)}</Badge></div>
    <div className="form-stack">
      {error&&<p role="alert" className="error-text">{error}</p>}{notice&&<p role="status">{notice}</p>}
      {c.status!=='draft'&&<section aria-label="สถานะการส่ง"><h3>สถานะการส่ง</h3>
        <p className="helper-text">ยืนยันส่ง {c.launchedCount??0} ราย{c.launchedAt?' · '+date(c.launchedAt):''}{c.scheduledAt?' · กำหนดส่ง '+date(c.scheduledAt):''}{c.completedAt?' · ส่งครบ '+date(c.completedAt):''}</p>
        <ul>{counts(detail.stats.recipients,recipientNames)}</ul>
        {Object.keys(detail.stats.skipReasons).length>0&&<><strong>เหตุผลที่ข้าม</strong><ul>{counts(detail.stats.skipReasons,reasonNames)}</ul></>}
        {Object.keys(detail.stats.delivery).length>0&&<p className="helper-text">สถานะจากผู้ให้บริการ: {Object.entries(detail.stats.delivery).map(([k,n])=>`${k} ${n}`).join(' · ')} — ยืนยันการส่งถึงได้จากใบตอบรับของผู้ให้บริการเท่านั้น</p>}
      </section>}
      {manage&&draft&&<section aria-label="แก้ไขฉบับร่าง"><h3>ข้อความ</h3>
        <Field label="ชื่อแคมเปญ"><Input value={form.name} maxLength={120} disabled={busy} onChange={e=>setForm({...form,name:e.target.value})}/></Field>
        {c.provider==='whatsapp'&&<Field label="รูปแบบ" hint="นอกช่วง 24 ชม. หลังข้อความล่าสุดของลูกค้า WhatsApp อนุญาตเฉพาะเทมเพลตที่อนุมัติแล้ว"><Select value={form.kind} disabled={busy} onChange={e=>setForm({...form,kind:e.target.value as 'text'|'template'})}><option value="text">ข้อความ (เฉพาะลูกค้าที่ทักมาภายใน 24 ชม.)</option><option value="template">เทมเพลตที่อนุมัติแล้ว</option></Select></Field>}
        {form.kind==='template'&&c.provider==='whatsapp'?<div className="form-grid"><Field label="ชื่อเทมเพลต"><Input value={form.templateName} disabled={busy} onChange={e=>setForm({...form,templateName:e.target.value})} placeholder="เช่น promo_october"/></Field><Field label="ภาษา"><Input value={form.templateLanguage} disabled={busy} onChange={e=>setForm({...form,templateLanguage:e.target.value})} placeholder="th หรือ en_US"/></Field>
          <Field label="ค่าตัวแปร (บรรทัดละ 1 ค่า ตามลำดับ {{1}}, {{2}})"><Textarea rows={3} value={form.templateParams} disabled={busy} onChange={e=>setForm({...form,templateParams:e.target.value})}/></Field></div>
          :<Field label={`ข้อความ (ไม่เกิน ${c.provider==='whatsapp'?4096:2000} ตัวอักษร)`}><Textarea rows={4} value={form.text} maxLength={c.provider==='whatsapp'?4096:2000} disabled={busy} onChange={e=>setForm({...form,text:e.target.value})}/></Field>}
        <h3>กลุ่มเป้าหมาย</h3>
        <Field label="แท็กลูกค้า (คั่นด้วยจุลภาค ตรงกับแท็กใดก็ได้)"><Input value={form.tags} disabled={busy} onChange={e=>setForm({...form,tags:e.target.value})}/></Field>
        <div className="form-grid"><fieldset><legend>ตลาด</legend>{Object.entries(markets).map(([k,v])=><label key={k} style={{marginRight:12}}><input type="checkbox" checked={form.markets.includes(k)} disabled={busy} onChange={()=>toggle('markets',k)}/> {v}</label>)}</fieldset>
          <fieldset><legend>สถานะลูกค้า</legend>{Object.entries(stageNames).map(([k,v])=><label key={k} style={{marginRight:12}}><input type="checkbox" checked={form.stages.includes(k)} disabled={busy} onChange={()=>toggle('stages',k)}/> {v}</label>)}</fieldset></div>
        <div className="form-grid"><Field label="ติดต่อครั้งแรก ตั้งแต่"><Input type="date" value={form.firstFrom} disabled={busy} onChange={e=>setForm({...form,firstFrom:e.target.value})}/></Field><Field label="ถึง"><Input type="date" value={form.firstTo} disabled={busy} onChange={e=>setForm({...form,firstTo:e.target.value})}/></Field>
          <Field label="ลูกค้าทักล่าสุด ตั้งแต่"><Input type="date" value={form.lastFrom} disabled={busy} onChange={e=>setForm({...form,lastFrom:e.target.value})}/></Field><Field label="ถึง"><Input type="date" value={form.lastTo} disabled={busy} onChange={e=>setForm({...form,lastTo:e.target.value})}/></Field></div>
        {form.importId&&<p className="helper-text">จำกัดเฉพาะรายชื่อที่นำเข้า (ตรงกับลูกค้าที่มีอยู่แล้วเท่านั้น) <Button variant="ghost" size="sm" disabled={busy} onClick={()=>void save({importId:''})}>เลิกใช้รายชื่อนำเข้า</Button></p>}
        <div className="button-row"><Button disabled={busy} onClick={()=>void save()}>บันทึกฉบับร่าง</Button></div>
      </section>}
      {manage&&<section aria-label="ตัวอย่างกลุ่มผู้รับ"><h3>ตัวอย่างกลุ่มผู้รับ (ไม่ส่งข้อความ)</h3>
        <Button variant="secondary" disabled={busy} onClick={()=>void act(()=>api<Preview>(`/api/admin/broadcasts/${id}/preview`,{}),value=>{setPreview(value);})}>ดูตัวอย่างกลุ่มผู้รับ</Button>
        {previewCurrent&&<div><p>ตรงกลุ่มเป้าหมาย <strong>{previewCurrent.matched}</strong> ราย · ส่งได้ <strong>{previewCurrent.eligible}</strong> ราย · ตรวจเมื่อ {date(previewCurrent.computedAt)}</p>
          {previewCurrent.overLimit&&<p className="error-text">เกินขีดจำกัด {previewCurrent.maxRecipients} รายต่อแคมเปญ กรุณาจำกัดกลุ่มเป้าหมาย</p>}
          {Object.keys(previewCurrent.excluded).length>0&&<><strong>ไม่รวมในการส่ง</strong><ul>{counts(previewCurrent.excluded,reasonNames)}</ul></>}
          {previewCurrent.samples.length>0&&<p className="helper-text">ตัวอย่างผู้รับ (ปิดบังหมายเลข): {previewCurrent.samples.map(s=>`${s.recipient} (${label(markets,s.market)}, ${label(stageNames,s.stage)})`).join(' · ')}</p>}
          {previewCurrent.excludedSamples.length>0&&<p className="helper-text">ตัวอย่างที่ไม่รวม: {previewCurrent.excludedSamples.map(s=>`${s.recipient} — ${label(reasonNames,s.reason)}`).join(' · ')}</p>}
        </div>}
      </section>}
      {manage&&draft&&<section aria-label="นำเข้า CSV แบบทดลอง"><h3>นำเข้ารายชื่อ CSV (ทดลองเท่านั้น)</h3>
        <p className="helper-text">ไฟล์ใช้จำกัดกลุ่มเป้าหมายให้เหลือเฉพาะลูกค้าที่มีอยู่แล้วและผ่านเงื่อนไขเท่านั้น ไม่สร้างผู้รับ ไม่สร้างลูกค้าใหม่ และไม่ถือเป็นหลักฐานความยินยอม ระบบเก็บเฉพาะค่าที่ปิดบังแล้ว</p>
        <div className="form-grid"><Field label="ไฟล์ CSV (UTF-8, คั่นด้วยจุลภาค)"><Input type="file" accept=".csv,text/csv" disabled={busy} onChange={async e=>{const file=e.target.files?.[0];setImported(null);setCsv(file?{name:file.name,text:await file.text()}:null);}}/></Field>
          <Field label="คอลัมน์ผู้รับ (ชื่อหัวตาราง)" hint={c.provider==='whatsapp'?'เบอร์พร้อมรหัสประเทศ เช่น +66812345678':'LINE user ID (U + 32 ตัวอักษร)'}><Input value={column} disabled={busy} onChange={e=>setColumn(e.target.value)}/></Field></div>
        <Button variant="secondary" disabled={busy||!csv} onClick={()=>void act(()=>api<ImportResult>(`/api/admin/broadcasts/${id}/import`,{csv:csv!.text,column}),value=>{setImported(value);})}>ตรวจไฟล์แบบทดลอง</Button>
        {imported&&<div><p>ทั้งหมด {imported.totalRows} แถว · ถูกต้อง {imported.valid} · ไม่ถูกต้อง {imported.invalid} · ซ้ำ {imported.duplicates} · ตรงกับลูกค้าที่มีอยู่ {imported.matched} (ส่งได้ {imported.matchedEligible}) · ไม่พบในระบบ {imported.unmatched} · สร้างผู้รับ {imported.recipientsCreated}</p>
          {Object.keys(imported.invalidReasons).length>0&&<ul>{counts(imported.invalidReasons,importErrors)}</ul>}
          {Object.keys(imported.excluded).length>0&&<><strong>ตรงกับลูกค้าแต่ไม่ผ่านเงื่อนไข</strong><ul>{counts(imported.excluded,reasonNames)}</ul></>}
          <details><summary>ตัวอย่าง 20 แถวแรก</summary><ul>{imported.samples.map(s=><li key={s.row}>แถว {s.row}: {s.recipient||'—'} · {s.error?label(importErrors,s.error):s.match==='eligible'?'ส่งได้':s.match==='excluded'?label(reasonNames,s.reason):'ไม่พบในระบบ'}</li>)}</ul></details>
          <Button size="sm" disabled={busy} onClick={()=>void save({importId:imported.importId})}>ใช้รายชื่อนี้จำกัดกลุ่มเป้าหมาย</Button></div>}
      </section>}
      {manage&&!['completed','cancelled'].includes(c.status)&&<section aria-label="ทดสอบส่ง"><h3>ทดสอบส่ง</h3>
        <p className="helper-text">ส่งถึงผู้รับทดสอบที่ตั้งค่าในระบบเท่านั้น ({gate?.testRecipient||'ยังไม่ได้กำหนด WHATSAPP_TEST_RECIPIENT / LINE_TEST_RECIPIENT'}) ผ่านการตรวจเดียวกับการส่งจริง</p>
        <Button variant="secondary" disabled={busy||!detail.gates.enabled||!gate?.testReady} onClick={()=>void act(()=>api<{status:string;recipient:string;passed:boolean;error?:string}>(`/api/admin/broadcasts/${id}/test-send`,{requestId:newId()}),value=>value.passed?`ทดสอบส่งถึง ${value.recipient} แล้ว (สถานะ ${value.status})`:`ทดสอบส่งไม่สำเร็จ: ${value.error||value.status}`)}>ทดสอบส่ง</Button>
        {detail.testSends.length>0&&<ul>{detail.testSends.map(t=><li key={t.createdAt+t.recipient}>ฉบับที่ {t.campaignVersion} · {t.recipient} · {t.status}{t.errorCode?' ('+t.errorCode+')':''} · {date(t.createdAt)}</li>)}</ul>}
        {draft&&<p className="helper-text">{detail.testPassedForVersion?'ฉบับนี้ทดสอบส่งสำเร็จแล้ว':'ต้องทดสอบส่งฉบับนี้ให้สำเร็จก่อนยืนยันส่ง'}</p>}
      </section>}
      {manage&&draft&&<section aria-label="ยืนยันส่ง"><h3>ยืนยันส่ง</h3>
        {!previewCurrent?<p className="helper-text">ดูตัวอย่างกลุ่มผู้รับของฉบับนี้ก่อน ระบบจะใช้จำนวนนี้ตรวจซ้ำตอนยืนยัน</p>:<>
          <Field label="ตั้งเวลาส่ง (ไม่บังคับ, เวลาไทย)" hint="ระบบไม่ส่งอัตโนมัติ เมื่อถึงเวลาต้องกด “ส่งชุดถัดไป”"><Input type="datetime-local" value={scheduleAt} disabled={busy} onChange={e=>setScheduleAt(e.target.value)}/></Field>
          <label className="field"><span><input type="checkbox" checked={confirmLaunch} disabled={busy||!previewCurrent.eligible} onChange={e=>setConfirmLaunch(e.target.checked)}/> ฉันตรวจข้อความ ผลทดสอบส่ง และกลุ่มผู้รับแล้ว ยืนยันส่งถึง {previewCurrent.eligible} ราย</span></label>
          <Button disabled={busy||!confirmLaunch||!previewCurrent.eligible||!detail.gates.enabled||!gate?.live||!detail.testPassedForVersion||previewCurrent.overLimit} onClick={()=>void act(()=>api<Detail>(`/api/admin/broadcasts/${id}/launch`,{confirm:true,expectedVersion:c.version,expectedRecipients:previewCurrent.eligible,...(scheduleAt?{scheduledAt:isoLocal(scheduleAt)}:{})}),()=>scheduleAt?'ตั้งเวลาแล้ว':'ยืนยันส่งแล้ว กด “ส่งชุดถัดไป” เพื่อเริ่มส่ง')}>ยืนยันส่งถึง {previewCurrent.eligible} ราย</Button>
          {(!detail.gates.enabled||!gate?.live)&&<p className="helper-text">ยังยืนยันส่งไม่ได้: บรอดแคสต์หรือช่องทางยังไม่เปิดส่งจริง</p>}</>}
      </section>}
      {manage&&['sending','scheduled','paused'].includes(c.status)&&<section aria-label="ควบคุมการส่ง"><h3>ควบคุมการส่ง</h3>
        <div className="button-row">
          {c.status!=='paused'&&<Button disabled={busy||!detail.gates.enabled||!gate?.live} onClick={()=>void act(()=>api<{batch:{enqueued:number;dispatched:number;outcome:Record<string,number>}}>(`/api/admin/broadcasts/${id}/run`,{limit:detail.gates.batchLimit}),value=>`ส่งชุดนี้ ${value.batch.dispatched} ราย: ${Object.entries(value.batch.outcome).map(([k,n])=>`${k} ${n}`).join(', ')||'ไม่มีรายการ'}`)}>ส่งชุดถัดไป (สูงสุด {detail.gates.batchLimit} ราย)</Button>}
          {c.status!=='paused'&&<Button variant="secondary" disabled={busy} onClick={()=>void act(()=>api<Detail>(`/api/admin/broadcasts/${id}/pause`,{expectedVersion:c.version}),()=>'หยุดชั่วคราวแล้ว รายการที่ยังไม่เริ่มส่งถูกถอนออกจากคิว')}>หยุดชั่วคราว</Button>}
        </div>
        <label className="field"><span><input type="checkbox" checked={confirmControl} disabled={busy} onChange={e=>setConfirmControl(e.target.checked)}/> ฉันยืนยันคำสั่งด้านล่าง</span></label>
        <div className="button-row">
          {c.status==='paused'&&<Button disabled={busy||!confirmControl||!detail.gates.enabled||!gate?.live} onClick={()=>void act(()=>api<Detail>(`/api/admin/broadcasts/${id}/resume`,{expectedVersion:c.version,confirm:true}),()=>'ส่งต่อแล้ว')}>ส่งต่อ</Button>}
          <Button variant="destructive" disabled={busy||!confirmControl} onClick={()=>void act(()=>api<Detail>(`/api/admin/broadcasts/${id}/cancel`,{expectedVersion:c.version,confirm:true}),()=>'ยกเลิกแคมเปญแล้ว')}>ยกเลิกแคมเปญ</Button>
        </div>
        <p className="helper-text">ข้อความที่เริ่มส่งแล้วหรือไม่ทราบผลอาจถึงผู้ให้บริการแล้ว ระบบไม่ดึงกลับและไม่ส่งซ้ำอัตโนมัติ</p>
      </section>}
      {manage&&draft&&<div className="button-row"><label className="field"><span><input type="checkbox" checked={confirmControl} disabled={busy} onChange={e=>setConfirmControl(e.target.checked)}/> ยืนยันยกเลิกฉบับร่าง</span></label><Button variant="destructive" size="sm" disabled={busy||!confirmControl} onClick={()=>void act(()=>api<Detail>(`/api/admin/broadcasts/${id}/cancel`,{expectedVersion:c.version,confirm:true}),()=>'ยกเลิกฉบับร่างแล้ว')}>ยกเลิกฉบับร่าง</Button></div>}
      {!manage&&<p className="helper-text">ข้อความ: {c.messageKind==='template'?`เทมเพลต ${c.template?.name||''}`:c.messageText||'—'}</p>}
    </div>
  </Card>;
}
