"use client";
/**
 * "เชื่อมต่อช่องทาง" — guided multi-account connection wizard (Admin only, server flag gated).
 * All progress comes from the server, so the wizard resumes after a refresh or the Meta redirect.
 * Staff see plain Thai with exactly one next action; never tokens, raw JSON or server setting names.
 */
import {useCallback,useEffect,useRef,useState} from 'react';
import {date} from './data';
import {Badge,Button,Card,Field,Input} from './ui';

type Provider='whatsapp'|'line'|'facebook'|'instagram';
type MetaProvider=Exclude<Provider,'line'>;
type Problem={code?:string;message:string;next:string}|null;
type Account={id:string;provider:Provider;displayName:string;maskedIdentity:string;state:string;readiness:{auth:string;inbound:string;outbound:string};expiresAt:string|null;lastVerifiedAt:string|null;verificationFresh:boolean;connectedAt:string|null;updatedAt:string;step:number;callbackUrl:string;problem:Problem;revision:number};
type Attempt={id:string;provider:MetaProvider;status:string;createdAt:string;expiresAt:string|null;step:number;assets:{key:string;name:string;maskedIdentity:string;alreadyConnected:boolean}[];problem:Problem};
type Overview={enabled:boolean;prerequisites:{tokenStorage:boolean;appOrigin:boolean;meta:Record<MetaProvider,boolean>;line:boolean};callbackUrls:Record<Provider,string>;accounts:Account[];attempts:Attempt[];expiring:{id:string;provider:Provider;displayName:string;maskedIdentity:string;expiresAt:string;daysLeft:number;expired:boolean}[]};
type Selection={kind:'new';provider:Provider|null}|{kind:'account';id:string}|{kind:'attempt';id:string};

class WizardError extends Error{constructor(message:string,readonly next:string,readonly status:number){super(message);}}
async function call<T>(path:string,body?:unknown):Promise<T>{
  const response=await fetch(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',headers:body===undefined?undefined:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  let data:Record<string,unknown>={};try{data=await response.json();}catch{/* non-JSON failure */}
  if(!response.ok)throw new WizardError(typeof data.error==='string'?data.error:'ดำเนินการไม่สำเร็จ',typeof data.next==='string'?data.next:'ลองอีกครั้ง หรือรีเฟรชหน้า',response.status);
  return data as T;
}
const toProblem=(error:unknown):Problem=>error instanceof WizardError?{message:error.message,next:error.next}:{message:'ติดต่อระบบไม่ได้',next:'ตรวจการเชื่อมต่ออินเทอร์เน็ตแล้วลองอีกครั้ง'};

const STEPS=['เลือกช่องทาง','สิ่งที่ต้องเตรียม','เชื่อมต่อบัญชี','เลือกเพจหรือบัญชี','ตรวจสิทธิ์','ตั้งค่ารับข้อความ','ยืนยันการรับข้อความ','ตรวจบัญชีกับผู้ให้บริการ','ทดสอบแบบควบคุม','สรุปและเปิดใช้งาน'];
const PROVIDERS:Record<Provider,string>={facebook:'Facebook Page',instagram:'Instagram',whatsapp:'WhatsApp',line:'LINE OA'};
const STATES:Record<string,[string,string]>={not_connected:['ยังไม่เชื่อมต่อ','neutral'],authorizing:['รอการอนุญาต','blue'],awaiting_selection:['รอเลือกบัญชี','blue'],missing_permission:['สิทธิ์ไม่ครบ','amber'],awaiting_provider_review:['รอ Meta อนุมัติ','amber'],webhook_pending:['รอตั้งค่ารับข้อความ','blue'],testing:['รอผลทดสอบ','blue'],ready:['พร้อมใช้งาน','green'],degraded:['ต้องตรวจใหม่','amber'],expired:['หมดอายุ','amber'],disconnected:['ยกเลิกการเชื่อมต่อแล้ว','neutral'],paused:['หยุดชั่วคราว','neutral'],failed:['เชื่อมต่อไม่สำเร็จ','amber'],completed:['เสร็จแล้ว','green']};
const AUTH:Record<string,string>={ready:'ผ่าน',pending:'รอตรวจ',failed:'ไม่ผ่าน',expired:'หมดอายุ'};
const INBOUND:Record<string,string>={ready:'ยืนยันแล้ว',pending:'รอยืนยัน',failed:'ไม่ผ่าน',unsupported:'ยังไม่รองรับ'};
const OUTBOUND:Record<string,string>={ready:'เปิดใช้งานแล้ว',test_passed:'ทดสอบผ่าน',pending:'รอทดสอบ',blocked:'ปิดอยู่',unsupported:'ยังไม่รองรับ'};
const PREPARE:Record<Provider,string[]>={
  facebook:['เป็นผู้ดูแลเพจ Facebook ที่ต้องการเชื่อมต่อ','เข้าสู่ระบบ Facebook ด้วยบัญชีที่ดูแลเพจนั้นได้','ระหว่างอนุญาต ให้เลือกเพจที่ต้องการและกดอนุญาตทุกรายการที่ระบบขอ'],
  instagram:['บัญชี Instagram เป็นบัญชีธุรกิจหรือครีเอเตอร์ และเชื่อมกับเพจ Facebook แล้ว','เปิด “อนุญาตให้เข้าถึงข้อความ” ในการตั้งค่าข้อความของ Instagram','ระบบบันทึกบัญชีได้ แต่ยังไม่รองรับการรับข้อความ Instagram'],
  whatsapp:['มีบัญชี WhatsApp Business ใน Meta Business และเป็นผู้ดูแลธุรกิจ','เบอร์ธุรกิจผ่านการยืนยันและใช้งานกับ Cloud API แล้ว','ระหว่างอนุญาต ให้เลือกบัญชี WhatsApp และเบอร์ที่ต้องการ'],
  line:['มี LINE Official Account ที่เปิดใช้ Messaging API แล้ว','เข้า LINE Developers Console ของช่องทางนี้ได้','เตรียม Channel ID, Channel secret และ Your user ID จากแท็บ Basic settings และออก Channel access token (long-lived) ในแท็บ Messaging API'],
};
const RETURN_REASONS:Record<string,[string,string]>={
  oauth_state_invalid:['ลิงก์ยืนยันไม่ถูกต้องหรือไม่ได้เริ่มจากระบบนี้','เริ่มเชื่อมต่อใหม่จากหน้านี้'],
  oauth_state_mismatch:['การยืนยันนี้เริ่มจากผู้ใช้หรือการเข้าสู่ระบบอื่น','เข้าสู่ระบบด้วยบัญชีเดิมแล้วเริ่มเชื่อมต่อใหม่'],
  oauth_state_used:['ลิงก์ยืนยันนี้ถูกใช้ไปแล้ว','เริ่มเชื่อมต่อใหม่จากหน้านี้'],
  oauth_state_expired:['ลิงก์ยืนยันหมดอายุแล้ว (เกิน 10 นาที)','เริ่มเชื่อมต่อใหม่และทำให้เสร็จภายใน 10 นาที'],
  login_required:['ต้องเข้าสู่ระบบก่อนเชื่อมต่อช่องทาง','เข้าสู่ระบบด้วยบัญชีผู้ดูแลแล้วเริ่มเชื่อมต่อใหม่'],
  admin_required:['การเชื่อมต่อช่องทางต้องใช้สิทธิ์ผู้ดูแลระบบ','เข้าสู่ระบบด้วยบัญชีผู้ดูแลระบบแล้วเริ่มเชื่อมต่อใหม่'],
};

export function SocialAccountsWizard(){
  const [overview,setOverview]=useState<Overview|null>(null),[absent,setAbsent]=useState(false);
  const [selection,setSelection]=useState<Selection|null>(null),[step,setStep]=useState(1);
  const [busy,setBusy]=useState(false),[problem,setProblem]=useState<Problem>(null),[notice,setNotice]=useState('');
  const sectionRef=useRef<HTMLElement>(null),revision=useRef(0);

  const load=useCallback(async()=>{
    const current=++revision.current;
    try{const next=await call<Overview>('/api/admin/social-accounts');if(current===revision.current){setOverview(next);setAbsent(false);}return next;}
    catch(error){if(current!==revision.current)return null;if(error instanceof WizardError&&error.status===404)setAbsent(true);else setProblem(toProblem(error));return null;}
  },[]);

  // Resume after the Meta redirect: the server already holds the attempt's state.
  useEffect(()=>{void(async()=>{
    const params=new URLSearchParams(window.location.search),returned=params.get('connection'),reason=params.get('reason')||'';
    const next=await load();
    if(window.location.hash==='#social-accounts')sectionRef.current?.scrollIntoView({block:'start'});
    if(!returned)return;
    window.history.replaceState(null,'',window.location.pathname+window.location.hash);
    if(RETURN_REASONS[reason]){setProblem({message:RETURN_REASONS[reason][0],next:RETURN_REASONS[reason][1]});setSelection({kind:'new',provider:null});setStep(1);return;}
    const attempt=next?.attempts[0];
    if(attempt){setSelection({kind:'attempt',id:attempt.id});setStep(attempt.step);}
  })();return()=>{revision.current++;};},[load]);

  if(absent)return null;
  const account=selection?.kind==='account'?overview?.accounts.find(item=>item.id===selection.id)??null:null;
  const attempt=selection?.kind==='attempt'?overview?.attempts.find(item=>item.id===selection.id)??null:null;
  const provider:Provider|null=selection?.kind==='new'?selection.provider:account?.provider??attempt?.provider??null;

  async function run<T>(work:()=>Promise<T>,done?:(value:T,fresh:Overview|null)=>void,message=''){
    setBusy(true);setProblem(null);setNotice('');
    try{const value=await work();const fresh=await load();setNotice(message);done?.(value,fresh);}
    catch(error){setProblem(toProblem(error));await load();}
    finally{setBusy(false);}
  }
  function openAccount(item:Account){setSelection({kind:'account',id:item.id});setStep(item.step);setProblem(null);setNotice('');}
  function openAttempt(item:Attempt){setSelection({kind:'attempt',id:item.id});setStep(item.step);setProblem(null);setNotice('');}
  async function accountAction(id:string,action:string,extra:Record<string,unknown>={},message=''){
    await run(()=>call<Account>('/api/admin/social-accounts/'+id,{action,...extra}),value=>{if(value.step>step)setStep(value.step);if(value.problem){setNotice('');setProblem({message:value.problem.message,next:value.problem.next});}},message);
  }
  async function startMeta(target:MetaProvider){
    setBusy(true);setProblem(null);
    try{const started=await call<{authorizeUrl:string}>('/api/admin/social-accounts/oauth/start',{provider:target});window.location.assign(started.authorizeUrl);}
    catch(error){setProblem(toProblem(error));setBusy(false);}
  }

  const expiring=overview?.expiring??[];
  return <section ref={sectionRef} id="social-accounts" aria-label="เชื่อมต่อช่องทาง" className="social-wizard">
    <div className="card-heading"><h2>เชื่อมต่อช่องทาง</h2><Button size="sm" disabled={busy} onClick={()=>{setSelection({kind:'new',provider:null});setStep(1);setProblem(null);setNotice('');}}>เพิ่มช่องทาง</Button></div>
    <p className="helper-text">เชื่อมเพจ บัญชี และเบอร์ธุรกิจทีละขั้น ระบบตรวจทุกขั้นก่อน และไม่ส่งข้อความถึงลูกค้าระหว่างเชื่อมต่อ</p>
    {expiring.map(item=><div key={item.id} className="alert alert-warning" role="status"><span><strong>{PROVIDERS[item.provider]} · {item.displayName} ({item.maskedIdentity})</strong> {item.expired?'สิทธิ์เชื่อมต่อหมดอายุแล้ว':`สิทธิ์เชื่อมต่อจะหมดอายุใน ${item.daysLeft} วัน`} — เชื่อมต่อบัญชีนี้ใหม่</span></div>)}
    {problem&&!selection&&<ProblemBox problem={problem}/>}
    {overview&&<div className="social-account-list">
      {overview.accounts.length===0&&overview.attempts.length===0&&<p className="helper-text">ยังไม่มีช่องทางในทะเบียน กด “เพิ่มช่องทาง” เพื่อเริ่ม</p>}
      {overview.attempts.filter(item=>item.status==='awaiting_selection').map(item=><Card key={item.id} className="social-account-row"><div><strong>{PROVIDERS[item.provider]}</strong><small>อนุญาตแล้ว รอเลือกบัญชี</small></div><StateBadge state={item.status}/><Button size="sm" variant="secondary" onClick={()=>openAttempt(item)}>ทำต่อ</Button></Card>)}
      {overview.accounts.map(item=><Card key={item.id} className="social-account-row"><div><strong>{PROVIDERS[item.provider]} · {item.displayName}</strong><small>{item.maskedIdentity} · ตรวจสิทธิ์ {AUTH[item.readiness.auth]} · รับข้อความ {INBOUND[item.readiness.inbound]} · ส่งข้อความ {OUTBOUND[item.readiness.outbound]}</small></div><StateBadge state={item.state}/><Button size="sm" variant="secondary" onClick={()=>openAccount(item)}>{item.state==='ready'?'ดูรายละเอียด':`ทำต่อ · ขั้นที่ ${item.step}`}</Button></Card>)}
    </div>}
    {selection&&<Card className="settings-card social-wizard-panel">
      <ol className="social-wizard-steps" aria-label="ขั้นตอนการเชื่อมต่อ">{STEPS.map((label,index)=><li key={label} aria-current={index+1===step?'step':undefined} className={index+1<step?'done':index+1===step?'current':''}><span>{index+1}</span>{label}</li>)}</ol>
      <div className="social-wizard-body">
        <h3>ขั้นที่ {step}: {STEPS[step-1]}{provider?` · ${PROVIDERS[provider]}`:''}</h3>
        {problem&&<ProblemBox problem={problem}/>}{notice&&<p role="status" className="helper-text">{notice}</p>}
        {step===1&&<ChooseProvider onChoose={next=>{setSelection({kind:'new',provider:next});setStep(2);setProblem(null);}}/>}
        {step===2&&provider&&overview&&<Prerequisites provider={provider} overview={overview} onNext={()=>setStep(3)}/>}
        {step===3&&provider&&overview&&<Connect provider={provider} overview={overview} attempt={attempt} busy={busy} onMeta={startMeta} onLine={input=>run(()=>call<Account>('/api/admin/social-accounts/line',input),value=>{setSelection({kind:'account',id:value.id});setStep(value.step);},'บันทึกข้อมูลเชื่อมต่อแล้ว (เข้ารหัสไว้) ต่อไปตรวจสิทธิ์')}/>}
        {step===4&&attempt&&<SelectAsset attempt={attempt} busy={busy} onSelect={key=>run(()=>call<Account>('/api/admin/social-accounts/select',{attemptId:attempt.id,assetKey:key}),value=>{setSelection({kind:'account',id:value.id});setStep(value.step);},'บันทึกบัญชีแล้ว ต่อไปตรวจสิทธิ์')}/>}
        {step===4&&!attempt&&<p className="helper-text">ไม่พบรายการรอเลือกบัญชี กรุณาเริ่มเชื่อมต่อใหม่</p>}
        {step>=5&&account&&<AccountStep account={account} step={step} busy={busy} setStep={setStep} act={(action,extra,message)=>accountAction(account.id,action,extra,message)}/>}
        {step>=5&&!account&&<p className="helper-text">ยังไม่มีบัญชีสำหรับขั้นนี้ กลับไปเชื่อมต่อบัญชีก่อน</p>}
        <div className="button-row social-wizard-nav">
          <Button variant="ghost" size="sm" disabled={busy||step<=1||(step>=5&&!!account&&step<=5)} onClick={()=>setStep(step-1)}>ย้อนกลับ</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={()=>{setSelection(null);setProblem(null);setNotice('');void load();}}>ปิดหน้าต่างขั้นตอน</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={()=>void run(async()=>null,(_,fresh)=>{const current=fresh?.accounts.find(item=>item.id===account?.id);if(current)setStep(current.step);})}>ตรวจสถานะล่าสุด</Button>
        </div>
        {account&&account.state!=='disconnected'&&<Disconnect account={account} busy={busy} onConfirm={()=>accountAction(account.id,'disconnect',{confirm:true},'ยกเลิกการเชื่อมต่อแล้ว ประวัติข้อความยังอยู่ครบ')}/>}
      </div>
    </Card>}
  </section>;
}

function ProblemBox({problem}:{problem:NonNullable<Problem>}){
  return <div className="alert alert-error" role="alert"><span><strong>{problem.message}</strong><br/>สิ่งที่ต้องทำต่อ: {problem.next}</span></div>;
}
function StateBadge({state}:{state:string}){const [label,tone]=STATES[state]??['ไม่ทราบสถานะ','neutral'];return <Badge tone={tone}>{label}</Badge>;}

function ChooseProvider({onChoose}:{onChoose:(provider:Provider)=>void}){
  return <div className="social-provider-grid">{(Object.keys(PROVIDERS) as Provider[]).map(item=><Button key={item} variant="secondary" onClick={()=>onChoose(item)}>{PROVIDERS[item]}</Button>)}</div>;
}
function Prerequisites({provider,overview,onNext}:{provider:Provider;overview:Overview;onNext:()=>void}){
  const blocker:Problem=!overview.prerequisites.tokenStorage?{message:'ระบบยังไม่พร้อมเก็บกุญแจเชื่อมต่ออย่างปลอดภัย',next:'แจ้งผู้ดูแลเซิร์ฟเวอร์ให้ตั้งค่าการเข้ารหัสกุญแจก่อน'}
    :provider==='line'?(overview.prerequisites.line?null:{message:'ที่อยู่เว็บไซต์ของระบบยังตั้งค่าไม่ถูกต้อง',next:'แจ้งผู้ดูแลเซิร์ฟเวอร์ให้ตรวจที่อยู่เว็บไซต์ของระบบ'})
    :overview.prerequisites.meta[provider]?null:{message:`ระบบยังไม่ได้ตั้งค่าการเชื่อมต่อ ${PROVIDERS[provider]} กับแอป Meta`,next:'แจ้งผู้ดูแลเซิร์ฟเวอร์ให้ตั้งค่าแอป Meta ก่อน'};
  return <><ul className="social-checklist">{PREPARE[provider].map(item=><li key={item}>{item}</li>)}</ul>
    {blocker?<ProblemBox problem={blocker}/>:<Button onClick={onNext}>เตรียมพร้อมแล้ว ไปขั้นถัดไป</Button>}</>;
}
function Connect({provider,overview,attempt,busy,onMeta,onLine}:{provider:Provider;overview:Overview;attempt:Attempt|null;busy:boolean;onMeta:(provider:MetaProvider)=>void;onLine:(input:Record<string,string>)=>void}){
  const [form,setForm]=useState({channelId:'',channelSecret:'',accessToken:'',botUserId:'',displayName:''});
  if(provider!=='line')return <>
    {attempt?.problem&&<ProblemBox problem={attempt.problem}/>}
    <p className="helper-text">ระบบจะพาไปหน้าของ Meta เพื่อเข้าสู่ระบบและอนุญาต จากนั้นกลับมาที่หน้านี้อัตโนมัติ ลิงก์อนุญาตใช้ได้ 10 นาทีและใช้ได้ครั้งเดียว</p>
    <Button disabled={busy||!overview.prerequisites.meta[provider]||!overview.prerequisites.tokenStorage} onClick={()=>onMeta(provider)}>{busy?'กำลังเปิดหน้าอนุญาต…':`เข้าสู่ระบบ Facebook เพื่ออนุญาต ${PROVIDERS[provider]}`}</Button>
  </>;
  const formats:Record<keyof typeof form,[RegExp,string]>={channelId:[/^\d{6,20}$/,'ตัวเลข 6–20 หลัก'],channelSecret:[/^[a-f0-9]{32}$/,'ตัวอักษร 0-9 และ a-f จำนวน 32 ตัว'],accessToken:[/^[A-Za-z0-9+/=._-]{20,1024}$/,'คัดลอกทั้งหมดโดยไม่มีช่องว่าง'],botUserId:[/^U[a-f0-9]{32}$/,'ขึ้นต้นด้วย U ตามด้วย 0-9, a-f จำนวน 32 ตัว'],displayName:[/^[^<>]{0,100}$/,'ไม่เกิน 100 ตัวอักษร']};
  const invalid=(Object.keys(formats) as (keyof typeof form)[]).filter(key=>(key!=='displayName'||form[key])&&!formats[key][0].test(form[key].trim()));
  const field=(key:keyof typeof form,label:string,secret=false)=><Field label={label} hint={form[key]&&invalid.includes(key)?'รูปแบบไม่ถูกต้อง: '+formats[key][1]:formats[key][1]}><Input value={form[key]} type={secret?'password':'text'} autoComplete="off" spellCheck={false} onChange={event=>setForm({...form,[key]:event.target.value})}/></Field>;
  return <form className="form-stack" onSubmit={event=>{event.preventDefault();if(invalid.length)return;const input=Object.fromEntries(Object.entries(form).map(([key,value])=>[key,value.trim()]).filter(([key,value])=>key!=='displayName'||value));setForm({...form,channelSecret:'',accessToken:''});onLine(input);}}>
    <p className="helper-text">LINE ไม่มีการอนุญาตผ่านหน้าเข้าสู่ระบบ ให้คัดลอกค่าจาก LINE Developers Console มาวางทีละช่อง ระบบเข้ารหัสก่อนบันทึกและจะไม่แสดงค่าลับอีก</p>
    {field('channelId','Channel ID (แท็บ Basic settings)')}{field('channelSecret','Channel secret (แท็บ Basic settings)',true)}
    {field('botUserId','Your user ID ของบอต (แท็บ Basic settings)')}{field('accessToken','Channel access token (long-lived) (แท็บ Messaging API)',true)}
    {field('displayName','ชื่อที่แสดงในระบบ (ไม่บังคับ)')}
    <p className="helper-text">ลิงก์รับข้อความที่ต้องวางใน LINE (ขั้นตั้งค่ารับข้อความ): <code style={{overflowWrap:'anywhere'}}>{overview.callbackUrls.line||'ยังไม่พร้อม'}</code></p>
    <Button type="submit" disabled={busy||invalid.length>0}>บันทึกและไปตรวจสิทธิ์</Button>
  </form>;
}
function SelectAsset({attempt,busy,onSelect}:{attempt:Attempt;busy:boolean;onSelect:(key:string)=>void}){
  const [chosen,setChosen]=useState('');
  if(!attempt.assets.length)return <p className="helper-text">ไม่พบบัญชีให้เลือก กรุณาเริ่มเชื่อมต่อใหม่</p>;
  return <><p className="helper-text">เลือก 1 รายการจากสิทธิ์ที่เพิ่งอนุญาต ระบบจะตรวจกับ Meta อีกครั้งก่อนบันทึก (เลือกได้ภายใน 30 นาที)</p>
    <div className="social-asset-list" role="radiogroup" aria-label="บัญชีที่อนุญาต">{attempt.assets.map(asset=><label key={asset.key} className="toggle-field"><span><strong>{asset.name}</strong><small>{asset.maskedIdentity}{asset.alreadyConnected?' · อยู่ในทะเบียนแล้ว (จะเปลี่ยนเป็นกุญแจใหม่)':''}</small></span><input type="radio" name="social-asset" checked={chosen===asset.key} onChange={()=>setChosen(asset.key)}/></label>)}</div>
    <Button disabled={busy||!chosen} onClick={()=>onSelect(chosen)}>ใช้บัญชีนี้</Button></>;
}
function CopyLink({url}:{url:string}){
  const [copied,setCopied]=useState(false);
  return <div className="social-callback"><code>{url}</code><Button size="sm" variant="secondary" onClick={()=>{void navigator.clipboard?.writeText(url).then(()=>setCopied(true),()=>setCopied(false));}}>{copied?'คัดลอกแล้ว':'คัดลอกลิงก์'}</Button></div>;
}
function AccountStep({account,step,busy,setStep,act}:{account:Account;step:number;busy:boolean;setStep:(step:number)=>void;act:(action:string,extra?:Record<string,unknown>,message?:string)=>Promise<void>}){
  const [confirmed,setConfirmed]=useState(false);
  const summary=<dl className="social-summary"><dt>บัญชี</dt><dd>{account.displayName} · {account.maskedIdentity}</dd><dt>สถานะ</dt><dd><StateBadge state={account.state}/></dd><dt>ตรวจสิทธิ์</dt><dd>{AUTH[account.readiness.auth]}{account.expiresAt?` · หมดอายุ ${date(account.expiresAt)}`:''}</dd><dt>รับข้อความ</dt><dd>{INBOUND[account.readiness.inbound]}</dd><dt>ตรวจบัญชีล่าสุด</dt><dd>{account.verificationFresh?'ผ่าน · '+date(account.lastVerifiedAt):'ยังไม่ผ่าน หรือหมดอายุ'}</dd><dt>ส่งข้อความ</dt><dd>{OUTBOUND[account.readiness.outbound]}</dd></dl>;
  if(['disconnected','expired','missing_permission','awaiting_provider_review'].includes(account.state)&&step<10)return <>{summary}<p className="helper-text">บัญชีนี้ต้องเชื่อมต่อใหม่ ประวัติข้อความและลูกค้าเดิมยังอยู่ครบ</p><Button variant="secondary" disabled={busy} onClick={()=>setStep(3)}>เชื่อมต่อใหม่</Button></>;
  if(account.state==='paused')return <>{summary}<p className="helper-text">บัญชีนี้หยุดชั่วคราวในทะเบียน การส่งจริงยังควบคุมด้วยปุ่มในการ์ดช่องทางด้านบน</p><Button disabled={busy} onClick={()=>void act('resume',{},'ใช้งานต่อแล้ว กรุณาตรวจการรับข้อความและผลทดสอบอีกครั้ง')}>ใช้งานต่อ</Button></>;
  if(step===5)return <><p className="helper-text">ตรวจว่ากุญแจที่บันทึกไว้ยังใช้ได้ ออกให้แอปของระบบ ตรงกับบัญชีที่เลือก และมีสิทธิ์ครบ ขั้นนี้ไม่ส่งข้อความถึงลูกค้า</p>{summary}<Button disabled={busy} onClick={()=>void act('validate',{},'ตรวจสิทธิ์เสร็จแล้ว')}>ตรวจสิทธิ์</Button></>;
  if(step===6)return <>{account.provider==='instagram'?<p className="helper-text">ระบบยังไม่รองรับการรับข้อความจาก Instagram บัญชีนี้ถูกบันทึกไว้แล้ว และจะเปิดรับข้อความได้เมื่อระบบรองรับ</p>:<>
    <p className="helper-text">{account.provider==='line'?'ใน LINE Developers Console เปิดแท็บ Messaging API วางลิงก์ด้านล่างในช่อง Webhook URL กด Update แล้วเปิด Use webhook':'ลิงก์รับข้อความของแอป Meta ต้องเป็นลิงก์ด้านล่าง และเลือกรับหัวข้อ messages (ผู้ดูแลแอปตั้งค่าที่ Meta for Developers)'}</p>
    <CopyLink url={account.callbackUrl}/><Button disabled={busy} onClick={()=>setStep(7)}>ตั้งค่าแล้ว ไปขั้นถัดไป</Button></>}</>;
  if(step===7)return <><p className="helper-text">ส่งข้อความสั้น ๆ 1 ข้อความจากบัญชีส่วนตัวมายังช่องทางนี้ แล้วกดตรวจ ระบบยอมรับเฉพาะข้อความที่ลายเซ็นถูกต้องและได้รับหลังเชื่อมต่อบัญชีนี้</p>{summary}<Button disabled={busy} onClick={()=>void act('check-webhook',{},'ตรวจการรับข้อความแล้ว')}>ตรวจการรับข้อความ</Button></>;
  if(step===8)return <><p className="helper-text">ตรวจบัญชี ลิงก์รับข้อความ และสิทธิ์กับผู้ให้บริการโดยตรง ขั้นนี้ไม่ส่งข้อความถึงลูกค้า</p>{summary}<Button disabled={busy||account.readiness.auth!=='ready'} onClick={()=>void act('verify',{},'ตรวจบัญชีแล้ว')}>ตรวจบัญชี</Button></>;
  if(step===9)return <><p className="helper-text">ใช้การ์ดช่องทางด้านบน: กด “เปิดเฉพาะผู้รับทดสอบ” แล้วตอบผู้รับทดสอบ 1 ข้อความจากกล่องข้อความ ระบบส่งได้เฉพาะผู้รับทดสอบ จากนั้นกลับมากดตรวจผลทดสอบ</p>{summary}<Button disabled={busy} onClick={()=>void act('check-test',{},'ตรวจผลทดสอบแล้ว')}>ตรวจผลทดสอบ</Button></>;
  return <>{summary}
    {account.state==='ready'?<p className="helper-text">บัญชีนี้ผ่านทุกขั้นแล้ว การเปิดหรือหยุดส่งจริงยังควบคุมด้วยปุ่มในการ์ดช่องทางด้านบน</p>
      :<><label className="field"><span><input type="checkbox" checked={confirmed} disabled={busy||account.readiness.outbound!=='test_passed'} onChange={event=>setConfirmed(event.target.checked)}/> ฉันตรวจผลทดสอบกับผู้รับทดสอบแล้ว และยืนยันเปิดใช้งานบัญชีนี้</span></label>
        <Button disabled={busy||!confirmed||account.state!=='testing'||account.readiness.outbound!=='test_passed'} onClick={()=>void act('activate',{confirm:true},'เปิดใช้งานบัญชีนี้แล้ว')}>เปิดใช้งานบัญชีนี้</Button></>}
    {['webhook_pending','testing','ready','degraded'].includes(account.state)&&<Button variant="ghost" size="sm" disabled={busy} onClick={()=>void act('pause',{},'หยุดบัญชีนี้ชั่วคราวแล้ว')}>หยุดชั่วคราว</Button>}
  </>;
}
function Disconnect({account,busy,onConfirm}:{account:Account;busy:boolean;onConfirm:()=>void}){
  const [confirmed,setConfirmed]=useState(false);
  return <details className="social-disconnect"><summary>ยกเลิกการเชื่อมต่อบัญชีนี้</summary>
    <p className="helper-text">ประวัติข้อความ ลูกค้า และบันทึกการทำงานทั้งหมดยังอยู่ ระบบลบกุญแจเชื่อมต่อของบัญชีนี้ และยกเลิกการรับข้อความเฉพาะบัญชีนี้เมื่อผู้ให้บริการรองรับ บัญชีที่ใช้ร่วมกับการเชื่อมต่อหลักจะไม่ถูกยกเลิกที่ผู้ให้บริการ</p>
    <label className="field"><span><input type="checkbox" checked={confirmed} disabled={busy} onChange={event=>setConfirmed(event.target.checked)}/> ยืนยันยกเลิกการเชื่อมต่อ {account.displayName}</span></label>
    <Button variant="destructive" size="sm" disabled={busy||!confirmed} onClick={onConfirm}>ยกเลิกการเชื่อมต่อ</Button>
  </details>;
}
