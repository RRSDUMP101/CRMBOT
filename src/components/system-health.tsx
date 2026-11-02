'use client';
import {DataView} from './data-view';
import {useCallback,useEffect,useState} from 'react';
import {ArrowRight, RefreshCw} from 'lucide-react';
import {api,date,number} from './data';
import {Card,Button,Badge} from './ui';
import {FeatureHeading, FeatureTabs} from './specialist-workspace';
type Health={checkedAt:number;flags:Record<string,boolean>;crmToSale:{headSequence:number;consumers:{consumer_id:string;acknowledged_sequence:number;pendingEvents:number;updated_at:string}[]};saleToCrm:{last_sequence:number;acknowledged_sequence:number;last_success_at:string;last_error:string}|null;runners:{worker:string;status:string;last_run_at:number;last_success_at:number|null;ageMs:number;runs:number;details:{durationMs:number;httpStatus?:number}}[];outboundAttention:{provider:string;account_id:string;status:string;count:number}[];webhookQueue:{status:string;count:number}[]};
const labels:Record<string,string>={'sale-push':'CRM → Sale','sale-context':'Sale → CRM',flows:'ระบบอัตโนมัติ',broadcast:'บรอดแคสต์',webhooks:'เว็บฮุก',connectors:'อีเมลและร้านค้า'};
const statuses:Record<string,string>={ok:'ทำงานสำเร็จ',sent:'ส่งคำขอแล้ว',empty:'ไม่มีงานค้าง',unchanged:'ไม่มีข้อมูลเปลี่ยน',accepted:'รับคำขอแล้ว',error:'ต้องตรวจสอบ',failed:'ไม่สำเร็จ',unknown:'ยังไม่ทราบผล',pending:'รอประมวลผล',sending:'กำลังส่ง',dead:'ต้องตรวจสอบ',delivered:'ปลายทางตอบรับแล้ว'};
const healthyStatuses=['ok','sent','empty','unchanged','accepted'];
export function SystemHealthPanel(){
 const [data,setData]=useState<Health|null>(null),[error,setError]=useState(''),[view,setView]=useState('sync');
 const load=useCallback(async()=>{try{setData(await api('/api/admin/system-health'));setError('');}catch(e){setError((e as Error).message);}},[]);
 useEffect(()=>{void load();const timer=setInterval(()=>void load(),15000);return()=>clearInterval(timer);},[load]);
 const pending=data?.crmToSale.consumers.reduce((total,item)=>total+item.pendingEvents,0);
 const attention=data?.outboundAttention.reduce((total,item)=>total+item.count,0);
 const stale=data?.runners.filter(item=>item.ageMs>180000||!healthyStatuses.includes(item.status)).length;
 return <section className="rrs-specialist">
  <FeatureHeading eyebrow="SYSTEM OPERATIONS" title="สถานะซิงก์และงานอัตโนมัติ" description="ตรวจความคืบหน้าสองระบบ คิวงาน และรายการที่ต้องดำเนินการจากหลักฐานบนเซิร์ฟเวอร์" actions={<Button variant="secondary" onClick={()=>void load()}><RefreshCw size={16}/>รีเฟรช</Button>}/>
  {error&&<p role="alert" className="alert alert-error">{error}</p>}
  {!data&&!error&&<p role="status" className="rrs-empty-inline">กำลังตรวจสถานะระบบ…</p>}
  {data&&<>
   <div className="rrs-health-metrics">
    <div className="rrs-health-metric"><small>ค้างส่งไป Sale</small><strong>{data.crmToSale.consumers.length?number(pending||0):'—'}</strong><small>รวมตามผู้รับข้อมูลที่ลงทะเบียน</small></div>
    <div className="rrs-health-metric"><small>ข้อความต้องตรวจสอบ</small><strong>{number(attention||0)}</strong><small>ส่งค้าง ไม่ทราบผล หรือผิดพลาด</small></div>
    <div className="rrs-health-metric"><small>ตัวประมวลผลต้องตรวจ</small><strong>{data.runners.length?number(stale||0):'—'}</strong><small>ผิดพลาดหรือไม่มีบันทึกเกิน 3 นาที</small></div>
    <div className="rrs-health-metric"><small>ข้อมูล Sale ที่บันทึกแล้ว</small><strong>{data.saleToCrm?number(data.saleToCrm.last_sequence):'—'}</strong><small>ลำดับเหตุการณ์ล่าสุด</small></div>
   </div>
   <FeatureTabs label="สถานะระบบ" value={view} onChange={setView} items={[{id:'sync',label:'ซิงก์สองระบบ'},{id:'runners',label:'งานเบื้องหลัง',count:data.runners.length},{id:'attention',label:'รายการต้องตรวจ',count:attention}]}/>
   <div hidden={view!=='sync'} className="rrs-panel-grid">
    <Card><h3>ส่งข้อมูลจาก CRM</h3><div className="rrs-sync-path">CRM <ArrowRight size={19}/> คิวงาน <ArrowRight size={19}/> Sale Office</div><p>เหตุการณ์ล่าสุด <strong>{number(data.crmToSale.headSequence)}</strong></p>{data.crmToSale.consumers.length?data.crmToSale.consumers.map(c=><div className="rrs-runner-row" key={c.consumer_id}><h4>{c.consumer_id}<Badge tone={c.pendingEvents?'amber':'green'}>{c.pendingEvents?`ค้าง ${number(c.pendingEvents)}`:'ยืนยันครบแล้ว'}</Badge></h4><p>ปลายทางยืนยันถึงลำดับ {number(c.acknowledged_sequence)}</p><small>อัปเดต {date(c.updated_at)}</small></div>):<p className="rrs-empty-inline">ยังไม่มีหลักฐานยืนยันจาก Sale</p>}</Card>
    <Card><h3>รับข้อมูลอ้างอิงจาก Sale Office</h3><div className="rrs-sync-path">Sale Office <ArrowRight size={19}/> CRM</div>{data.saleToCrm?<><p>บันทึกถึงลำดับ <strong>{number(data.saleToCrm.last_sequence)}</strong></p><p>ส่งคำยืนยันถึงลำดับ <strong>{number(data.saleToCrm.acknowledged_sequence)}</strong></p><p>สำเร็จล่าสุด {date(data.saleToCrm.last_success_at)}</p>{data.saleToCrm.last_error&&<p role="alert" className="alert alert-error">ต้องตรวจสอบ: {data.saleToCrm.last_error}</p>}</>:<p className="rrs-empty-inline">ยังไม่มีข้อมูลยืนยันการซิงก์</p>}<p className="helper-text">ข้อมูลการขายเป็นข้อมูลอ้างอิง การแก้ไขยังทำใน Sale Office</p></Card>
   </div>
   <div hidden={view!=='runners'} className="rrs-workspace-section"><Card><h3>ตัวประมวลผลบนเซิร์ฟเวอร์</h3>{!data.runners.length&&<p className="rrs-empty-inline">ยังไม่มีบันทึกการทำงาน</p>}{data.runners.map(r=><div className="rrs-runner-row" key={r.worker}><h4>{labels[r.worker]||r.worker}<Badge tone={r.ageMs<=180000&&healthyStatuses.includes(r.status)?'green':'amber'}>{statuses[r.status]||r.status}</Badge></h4><p>ทำงานล่าสุด {date(new Date(r.last_run_at).toISOString())} · {number(r.runs)} ครั้ง · ใช้เวลา {number(r.details.durationMs)} มิลลิวินาที</p>{r.ageMs>180000&&<p>ไม่มีบันทึกใหม่เกิน 3 นาที กรุณาตรวจตารางเวลาและการเชื่อมต่อ</p>}</div>)}</Card></div>
   <div hidden={view!=='attention'} className="rrs-panel-grid"><Card><h3>ข้อความที่ต้องตรวจสอบ</h3>{data.outboundAttention.length?<div className="table-wrap"><DataView><table><thead><tr><th>ช่องทาง</th><th>บัญชี</th><th>สถานะ</th><th>จำนวน</th></tr></thead><tbody>{data.outboundAttention.map((r,i)=><tr key={i}><td>{r.provider}</td><td>{r.account_id}</td><td><Badge tone="amber">{statuses[r.status]||r.status}</Badge></td><td>{number(r.count)}</td></tr>)}</tbody></table></DataView></div>:<p className="rrs-empty-inline">ไม่มีข้อความส่งค้าง ไม่ทราบผล หรือผิดพลาด</p>}<p className="helper-text">ข้อความที่ไม่ทราบผลจะไม่ถูกส่งซ้ำอัตโนมัติ</p></Card><Card><h3>คิวแจ้งเหตุการณ์</h3>{data.webhookQueue.length?data.webhookQueue.map(item=><p key={item.status}><Badge tone={item.status==='dead'?'amber':'neutral'}>{statuses[item.status]||item.status}</Badge> {number(item.count)} รายการ</p>):<p className="rrs-empty-inline">ยังไม่มีรายการในคิว</p>}</Card></div>
   <p className="helper-text">ตรวจล่าสุด {date(new Date(data.checkedAt).toISOString())} · อัปเดตทุก 15 วินาที · การรับคำขอซิงก์และการบันทึกข้อมูลปลายทางเป็นคนละขั้นตอน</p>
  </>}
 </section>;
}
