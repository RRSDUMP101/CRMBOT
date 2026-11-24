"use client";
import { FeatureHeading } from "./specialist-workspace";

import { useCallback, useEffect, useState } from "react";
import { Bookmark, Copy, Pencil, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { api, date } from "./data";
import { Badge, Button, Card, Empty, Field, Input, Textarea } from "./ui";
import { Modal } from "./workspace-panels";
import type { PanelProps } from "./workspace";
import type { ReplyTemplate } from "./inbox-data";

export function ReplyTemplatesPanel({ data, reload, notify }: PanelProps) {
  const [items, setItems] = useState<ReplyTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<ReplyTemplate | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try { setItems((await api<{ templates: ReplyTemplate[] }>("/api/admin/reply-templates")).templates); setError(""); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const filtered = items.filter(item => `${item.title} ${item.content} ${item.shortcut} ${item.category}`.toLowerCase().includes(search.toLowerCase()));
  const admin = data.user.role === "Admin";
  return <div className="rrs-specialist"><FeatureHeading eyebrow="TEAM LIBRARY" title={admin?"ตั้งค่าการขาย":"ข้อความสำเร็จรูป"} description="ข้อความที่ทีมเลือกใช้ตอบลูกค้า"/>
    {admin && <DisplayNameEditor data={data} reload={reload} notify={notify}/>}
    <div className="section-toolbar">
      <div className="search-input"><Search size={17} /><Input placeholder="ค้นหาชื่อ ข้อความ หรือคำลัด…" value={search} onChange={e => setSearch(e.target.value)} /></div>
      <div className="button-row"><Button variant="secondary" size="sm" onClick={load} disabled={loading}><RefreshCw size={15} />รีเฟรช</Button>{admin && <Button onClick={() => setEditing("new")}><Plus size={16} />สร้างข้อความ</Button>}</div>
    </div>
    <div className="template-guidance"><Bookmark size={18} /><div><strong>ข้อความที่ทีมใช้บ่อย พร้อมหยิบไปตอบ</strong><p>เลือกใช้จากกล่องข้อความ ตรวจและแก้ไขก่อนกดส่งทุกครั้ง ระบบจะไม่ส่งแทนคุณ</p></div><Badge>{items.length} ข้อความ</Badge></div>
    {error && <div className="alert alert-error" role="alert">{error}<Button size="sm" variant="ghost" onClick={load}>ลองอีกครั้ง</Button></div>}
    {loading && !items.length ? <div className="skeleton-grid"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div> : <div className="template-grid">{filtered.map(item => <Card className="template-card" key={item.id}>
      <div className="template-card-top"><span className="template-symbol"><Bookmark size={20} /></span><Badge>{item.category || "ทั่วไป"}</Badge></div>
      <h2>{item.title}</h2><code className="template-shortcut">{item.shortcut}</code><p className="template-content">{item.content}</p>
      <footer><small>แก้ไข {date(item.updatedAt)}</small><div className="button-row"><Button variant="ghost" size="icon" aria-label={`คัดลอก ${item.title}`} onClick={async () => { try { await navigator.clipboard.writeText(item.content); notify("คัดลอกข้อความแล้ว"); } catch { setError("คัดลอกไม่ได้ กรุณาเลือกข้อความและคัดลอกด้วยตนเอง"); } }}><Copy size={16} /></Button>{admin && <><Button variant="ghost" size="icon" aria-label={`แก้ไข ${item.title}`} onClick={() => setEditing(item)}><Pencil size={16} /></Button><Button variant="ghost" size="icon" aria-label={`ลบ ${item.title}`} disabled={busy} onClick={async () => { if (!window.confirm(`ลบข้อความ “${item.title}” ออกจากรายการของทีม?`)) return; setBusy(true); try { await api("/api/admin/action", { action: "deleteReplyTemplate", id: item.id, values: { version: item.version } }); await load(); notify("ลบข้อความสำเร็จรูปแล้ว"); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}><Trash2 size={16} /></Button></>}</div></footer>
    </Card>)}</div>}
    {!loading && !filtered.length && <Card><Empty title={search ? "ไม่พบข้อความที่ค้นหา" : "ยังไม่มีข้อความสำเร็จรูป"} detail={admin ? "สร้างข้อความที่ใช้บ่อย เพื่อให้ทีมเลือกเติมในร่างคำตอบ" : "ผู้ดูแลระบบสามารถเพิ่มข้อความสำหรับทีมได้"} /></Card>}
    {editing && <Modal title={editing === "new" ? "สร้างข้อความสำเร็จรูป" : "แก้ไขข้อความสำเร็จรูป"} close={() => setEditing(null)}><TemplateEditor item={editing === "new" ? null : editing} close={() => setEditing(null)} onSaved={async () => { setEditing(null); await load(); notify("บันทึกข้อความสำเร็จรูปแล้ว"); }} /></Modal>}
  </div>;
}

function DisplayNameEditor({data,reload,notify}:PanelProps) {
  const [base,setBase]=useState(data.settings.botName),[name,setName]=useState(base),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  const [previous,setPrevious]=useState<string|null>(null);
  const loadPrevious=useCallback(async()=>{
    try {setPrevious((await api<{previous:string|null}>("/api/admin/sales-settings/previous")).previous);}
    catch(e){setError((e as Error).message);}
  },[]);
  useEffect(()=>{void loadPrevious();},[loadPrevious]);
  const reset=()=>{setBase(data.settings.botName);setName(data.settings.botName);setError("");void loadPrevious();};
  return <Card><form className="form-stack" onSubmit={async e=>{
    e.preventDefault();setBusy(true);setError("");
    try {await api("/api/admin/action",{action:"updateSettings",values:{botName:name.trim(),expectedBotName:base}});setBase(name.trim());setName(name.trim());await Promise.all([reload(),loadPrevious()]);notify("บันทึกชื่อที่แสดงแล้ว");}
    catch(e){setError((e as Error).message);await reload();}
    finally{setBusy(false);}
  }}>
    <Field label="ชื่อผู้ช่วยที่แสดงแก่ลูกค้า"><Input required maxLength={80} value={name} onChange={e=>setName(e.target.value)}/></Field>
    <div aria-label="ตัวอย่างชื่อที่แสดง"><small>ตัวอย่างหัวห้องแชท</small><p><strong>{name.trim() || "—"}</strong></p></div>
    {previous!==null && <Button type="button" variant="ghost" onClick={()=>setName(previous)}>ใช้ชื่อก่อนหน้า · {previous}</Button>}
    {error&&<p role="alert">{error}</p>}
    <div className="form-actions"><Button type="button" variant="secondary" onClick={reset}>โหลดค่าปัจจุบัน</Button><Button type="submit" disabled={busy||!name.trim()||name.trim()===base}>บันทึกชื่อที่แสดง</Button></div>
  </form></Card>;
}

function TemplateEditor({ item, close, onSaved }: { item: ReplyTemplate | null; close: () => void; onSaved: () => Promise<void> }) {
  const [values, setValues] = useState({ title: item?.title || "", shortcut: item?.shortcut || "", content: item?.content || "", category: item?.category || "ทั่วไป" });
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [previous,setPrevious]=useState<typeof values|null>(null);
  useEffect(()=>{
    if(!item)return;let active=true;
    api<{previous:typeof values|null}>("/api/admin/sales-settings/previous?templateId="+encodeURIComponent(item.id))
      .then(result=>{if(active)setPrevious(result.previous);},e=>{if(active)setError((e as Error).message);});
    return ()=>{active=false;};
  },[item]);
  const put = (key: keyof typeof values, value: string) => setValues(previous => ({ ...previous, [key]: value }));
  return <form className="form-stack" onSubmit={async e => { e.preventDefault(); setBusy(true); setError(""); try { await api("/api/admin/action", { action: "saveReplyTemplate", ...(item ? { id: item.id } : {}), values: { ...values, ...(item ? { version: item.version } : {}) } }); await onSaved(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } }}>
    <Field label="ชื่อข้อความ"><Input autoFocus required maxLength={120} value={values.title} onChange={e => put("title", e.target.value)} placeholder="เช่น ขอข้อมูลรถสำหรับประเมินราคา" /></Field>
    <div className="form-grid"><Field label="คำลัด" hint="ใช้เพื่อค้นหาได้รวดเร็ว เช่น /vehicle"><Input required maxLength={40} value={values.shortcut} onChange={e => put("shortcut", e.target.value)} placeholder="/vehicle" /></Field><Field label="หมวดหมู่"><Input required maxLength={80} value={values.category} onChange={e => put("category", e.target.value)} /></Field></div>
    <Field label="ข้อความ" hint="ใช้ข้อมูลที่ทีมตรวจสอบแล้ว ไม่ใส่ข้อมูลลูกค้าหรือราคาที่ยังไม่ได้ยืนยัน"><Textarea required rows={7} maxLength={4000} value={values.content} onChange={e => put("content", e.target.value)} /></Field>
    <section aria-label="ตัวอย่างข้อความที่จะเติมในแชท"><small>ตัวอย่างข้อความที่จะเติมในแชท</small><p style={{whiteSpace:"pre-wrap"}}>{values.content || "—"}</p></section>
    {previous && <Button type="button" variant="ghost" onClick={()=>setValues(previous)}>โหลดข้อความรุ่นก่อนมาแก้ไข</Button>}
    {error && <div className="alert alert-error" role="alert">{error}</div>}
    <div className="form-actions"><Button variant="secondary" type="button" onClick={close}>ยกเลิก</Button><Button type="submit" disabled={busy}>{busy ? "กำลังบันทึก…" : "บันทึกข้อความ"}</Button></div>
  </form>;
}
