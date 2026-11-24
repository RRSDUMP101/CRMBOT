"use client";
import { uiText } from "./interface-text";
import { FeatureHeading } from "./specialist-workspace";

import { useCallback, useEffect, useState } from "react";
import { Bookmark, Copy, Pencil, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { api, date } from "./data";
import { Badge, Button, Card, Empty, Field, Input, Select, Textarea } from "./ui";
import { Modal } from "./workspace-panels";
import type { PanelProps } from "./workspace";
import type { ReplyTemplate } from "./inbox-data";

export function ReplyTemplatesPanel({ data, notify }: PanelProps) {
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
  return <div className="rrs-specialist"><FeatureHeading eyebrow="TEAM LIBRARY" title={uiText("ข้อความสำเร็จรูป")} description="ค้นหาคำตอบที่ทีมตรวจแล้ว เติมในร่าง และปรับให้เหมาะกับลูกค้าก่อนส่ง"/>
    <div className="section-toolbar">
      <div className="search-input"><Search size={17} /><Input placeholder="ค้นหาชื่อ ข้อความ หรือคำลัด…" value={search} onChange={e => setSearch(e.target.value)} /></div>
      <div className="button-row"><Button variant="secondary" size="sm" onClick={load} disabled={loading}><RefreshCw size={15} />{uiText("รีเฟรช")}</Button>{admin && <Button onClick={() => setEditing("new")}><Plus size={16} />สร้างข้อความ</Button>}</div>
    </div>
    <div className="template-guidance"><Bookmark size={18} /><div><strong>ข้อความที่ทีมใช้บ่อย พร้อมหยิบไปตอบ</strong><p>เลือกใช้จากกล่องข้อความ ตรวจและแก้ไขก่อนกดส่งทุกครั้ง ระบบจะไม่ส่งแทนคุณ</p></div><Badge>{items.length} {uiText("ข้อความ")}</Badge></div>
    {error && <div className="alert alert-error" role="alert">{error}<Button size="sm" variant="ghost" onClick={load}>{uiText("ลองอีกครั้ง")}</Button></div>}
    {loading && !items.length ? <div className="skeleton-grid"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div> : <div className="template-grid">{filtered.map(item => <Card className="template-card" key={item.id}>
      <div className="template-card-top"><span className="template-symbol"><Bookmark size={20} /></span><Badge>{item.category || "ทั่วไป"}</Badge></div>
      <h2>{item.title}</h2><code className="template-shortcut">{item.shortcut}</code><p className="template-content">{item.content}</p>
      <footer><small>{uiText("แก้ไข")} {date(item.updatedAt)}</small><div className="button-row"><Button variant="ghost" size="icon" aria-label={`คัดลอก ${item.title}`} onClick={async () => { try { await navigator.clipboard.writeText(item.content); notify("คัดลอกข้อความแล้ว"); } catch { setError("คัดลอกไม่ได้ กรุณาเลือกข้อความและคัดลอกด้วยตนเอง"); } }}><Copy size={16} /></Button>{admin && <><Button variant="ghost" size="icon" aria-label={`แก้ไข ${item.title}`} onClick={() => setEditing(item)}><Pencil size={16} /></Button><Button variant="ghost" size="icon" aria-label={`ลบ ${item.title}`} disabled={busy} onClick={async () => { if (!window.confirm(`ลบข้อความ “${item.title}” ออกจากรายการของทีม?`)) return; setBusy(true); try { await api("/api/admin/action", { action: "deleteReplyTemplate", id: item.id, values: { version: item.version } }); await load(); notify("ลบข้อความสำเร็จรูปแล้ว"); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}><Trash2 size={16} /></Button></>}</div></footer>
    </Card>)}</div>}
    {!loading && !filtered.length && <Card><Empty title={search ? "ไม่พบข้อความที่ค้นหา" : "ยังไม่มีข้อความสำเร็จรูป"} detail={admin ? "สร้างข้อความที่ใช้บ่อย เพื่อให้ทีมเลือกเติมในร่างคำตอบ" : "ผู้ดูแลระบบสามารถเพิ่มข้อความสำหรับทีมได้"} /></Card>}
    {editing && <Modal title={editing === "new" ? "สร้างข้อความสำเร็จรูป" : "แก้ไขข้อความสำเร็จรูป"} close={() => setEditing(null)}><TemplateEditor item={editing === "new" ? null : editing} close={() => setEditing(null)} onSaved={async () => { setEditing(null); await load(); notify("บันทึกข้อความสำเร็จรูปแล้ว"); }} /></Modal>}
  </div>;
}

function TemplateEditor({ item, close, onSaved }: { item: ReplyTemplate | null; close: () => void; onSaved: () => Promise<void> }) {
  const [values, setValues] = useState({ title: item?.title || "", shortcut: item?.shortcut || "", content: item?.content || "", category: item?.category || "ทั่วไป" });
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [revisions,setRevisions]=useState<Omit<ReplyTemplate,"id">[]>([]);
  const [previousVersion,setPreviousVersion]=useState("");
  const [historyError,setHistoryError]=useState(false);
  useEffect(()=>{
    if(!item)return;
    let active=true;
    api<{revisions:Omit<ReplyTemplate,"id">[]}>(`/api/admin/reply-templates/${item.id}/revisions`).then(data=>{
      if(active)setRevisions(data.revisions);
    }).catch(()=>{if(active)setHistoryError(true);});
    return ()=>{active=false;};
  },[item]);
  const previous=revisions.find(snapshot=>String(snapshot.version)===previousVersion);
  const put = (key: keyof typeof values, value: string) => setValues(previous => ({ ...previous, [key]: value }));
  return <form className="form-stack" onSubmit={async e => { e.preventDefault(); setBusy(true); setError(""); try { await api("/api/admin/action", { action: "saveReplyTemplate", ...(item ? { id: item.id } : {}), values: { ...values, ...(item ? { version: item.version } : {}) } }); await onSaved(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } }}>
    <Field label="ชื่อข้อความ"><Input autoFocus required maxLength={120} value={values.title} onChange={e => put("title", e.target.value)} placeholder="เช่น ขอข้อมูลรถสำหรับประเมินราคา" /></Field>
    <div className="form-grid"><Field label="คำลัด" hint="ใช้เพื่อค้นหาได้รวดเร็ว เช่น /vehicle"><Input required maxLength={40} value={values.shortcut} onChange={e => put("shortcut", e.target.value)} placeholder="/vehicle" /></Field><Field label="หมวดหมู่"><Input required maxLength={80} value={values.category} onChange={e => put("category", e.target.value)} /></Field></div>
    <Field label={uiText("ข้อความ")} hint="ใช้ข้อมูลที่ทีมตรวจสอบแล้ว ไม่ใส่ข้อมูลลูกค้าหรือราคาที่ยังไม่ได้ยืนยัน"><Textarea required rows={7} maxLength={4000} value={values.content} onChange={e => put("content", e.target.value)} /></Field>
    <section className="reply-preview" aria-label="ตัวอย่างข้อความถึงลูกค้า"><strong>ตัวอย่างข้อความถึงลูกค้า</strong><p>{values.content||"พิมพ์ข้อความเพื่อดูตัวอย่าง"}</p></section>
    {item&&<details className="reply-versions"><summary>ประวัติรุ่น · รุ่นปัจจุบัน {item.version}</summary>
      {historyError?<p>โหลดประวัติไม่สำเร็จ กรุณาเปิดข้อความอีกครั้ง</p>:!revisions.length?<p>ยังไม่มีรุ่นก่อนหน้า</p>:<><Field label="เลือกรุ่นที่ต้องการกู้คืน"><Select value={previousVersion} onChange={e=>setPreviousVersion(e.target.value)}><option value="">เลือกรุ่น</option>{revisions.map(snapshot=><option key={snapshot.version} value={snapshot.version}>รุ่น {snapshot.version} · {date(snapshot.updatedAt)}</option>)}</Select></Field>
      {previous&&<><div className="reply-preview"><strong>{previous.title}</strong><small>{previous.shortcut} · {previous.category}</small><p>{previous.content}</p></div><Button type="button" variant="secondary" disabled={busy} onClick={async()=>{
        if(!window.confirm(`กู้คืนรุ่น ${previous.version} เป็นรุ่นใหม่และแทนที่ร่างที่กำลังแก้ไขหรือไม่`))return;
        setBusy(true);setError("");
        try{await api("/api/admin/action",{action:"restoreReplyTemplate",id:item.id,values:{version:item.version,fromVersion:previous.version}});await onSaved();}
        catch(err){setError((err as Error).message);}finally{setBusy(false);}
      }}>กู้คืนรุ่น {previous.version}</Button></>}</>}
    </details>}
    {error && <div className="alert alert-error" role="alert">{error}</div>}
    <div className="form-actions"><Button variant="secondary" type="button" onClick={close}>{uiText("ยกเลิก")}</Button><Button type="submit" disabled={busy}>{busy ? uiText("กำลังบันทึก…") : "บันทึกข้อความ"}</Button></div>
  </form>;
}
