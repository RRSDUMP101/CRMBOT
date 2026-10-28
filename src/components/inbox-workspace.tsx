"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowUpRight, Bookmark, Check, ChevronDown, CircleHelp, Globe, Inbox, LockKeyhole, MessageSquare, PanelRight, Pencil, RefreshCw, Search, Send, SlidersHorizontal, Sparkles, UserRound, X } from "lucide-react";
import { api, date, stageNames, stages, statusNames, type Detail } from "./data";
import { emptyCounts, queueNames, type InboxItem, type InboxQueue, type InboxResult, type ReplyTemplate } from "./inbox-data";
import { Badge, Button, Empty, Input, Select, Textarea } from "./ui";
import { ChatMessage, LeadEditor, Modal, Summary } from "./workspace-panels";
import type { PanelProps } from "./workspace";
import { useFocusScope } from "./focus-scope";

const queues: InboxQueue[] = ["all", "unread", "waiting", "mine", "unassigned", "closed"];
type Drafts = Record<string, { reply: string; note: string }>;

export function InboxWorkspace({ data, reload, notify }: PanelProps) {
  const [queue, setQueue] = useState<InboxQueue>("all");
  const [search, setSearch] = useState(""); const [query, setQuery] = useState("");
  const [owner, setOwner] = useState(""); const [status, setStatus] = useState(""); const [tag, setTag] = useState(""); const [filters, setFilters] = useState(false);
  const [result, setResult] = useState<InboxResult>({ items: [], nextCursor: null, total: 0, counts: emptyCounts });
  const [listLoading, setListLoading] = useState(true); const [listError, setListError] = useState(""); const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState(""); const [detail, setDetail] = useState<Detail | null>(null); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Drafts>({}); const [note, setNote] = useState(false); const [profileOpen, setProfileOpen] = useState(false); const [editing, setEditing] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false); const [templates, setTemplates] = useState<ReplyTemplate[]>([]); const [templateSearch, setTemplateSearch] = useState(""); const [templateLoading, setTemplateLoading] = useState(false); const [templateError, setTemplateError] = useState("");
  const selectedRef = useRef(""); const queryVersion = useRef(0); const listRequest = useRef(0); const loadedPages = useRef(1); const readMessages = useRef(new Set<string>()); const history = useRef<HTMLDivElement>(null);
  selectedRef.current = selected;
  const profileRef = useRef<HTMLElement>(null); const templateRef = useRef<HTMLDivElement>(null);
  useFocusScope(profileOpen, profileRef, () => setProfileOpen(false), true, "#customer-profile-trigger");
  useFocusScope(templateOpen, templateRef, () => setTemplateOpen(false), false, "#reply-template-trigger");
  useEffect(() => { const resize = () => { if (window.innerWidth > 1150) setProfileOpen(false); }; window.addEventListener("resize", resize); return () => window.removeEventListener("resize", resize); }, []);
  const draftKey = note ? "note" : "reply";
  const text = drafts[selected]?.[draftKey] || "";
  const putDraft = (value: string) => setDrafts(previous => ({ ...previous, [selected]: { reply: previous[selected]?.reply || "", note: previous[selected]?.note || "", [draftKey]: value } }));

  useEffect(() => { const timer = setTimeout(() => setQuery(search.trim()), 250); return () => clearTimeout(timer); }, [search]);
  const listUrl = useCallback((cursor?: string, limit = 30) => {
    const params = new URLSearchParams({ view: queue, limit: String(limit) });
    if (query) params.set("q", query); if (owner) params.set("assignee", owner); if (tag.trim()) params.set("tag", tag.trim()); if (status) params.set("status", status); if (cursor) params.set("cursor", cursor);
    return "/api/admin/inbox?" + params;
  }, [query, queue, owner, tag, status]);
  const refreshList = useCallback(async (visible = false) => {
    const request = ++listRequest.current; const version = queryVersion.current;
    if (visible) setListLoading(true);
    try {
      // Refresh all currently loaded pages instead of silently dropping older rows.
      let combined: InboxItem[] = []; let cursor: string | undefined; let latest: InboxResult | null = null;
      for (let page = 0; page < loadedPages.current; page++) {
        latest = await api<InboxResult>(listUrl(cursor)); combined = [...combined, ...latest.items]; cursor = latest.nextCursor || undefined; if (!cursor) break;
      }
      if (request !== listRequest.current || version !== queryVersion.current || !latest) return;
      setResult({ ...latest, items: combined }); setListError("");
    } catch (e) { if (request === listRequest.current) setListError((e as Error).message); }
    finally { if (request === listRequest.current) setListLoading(false); }
  }, [listUrl]);
  useEffect(() => { queryVersion.current++; loadedPages.current = 1; void refreshList(true); const timer = setInterval(() => void refreshList(), 10000); return () => { clearInterval(timer); queryVersion.current++; }; }, [refreshList]);
  const more = async () => {
    if (!result.nextCursor || loadingMore) return; const version = queryVersion.current; ++listRequest.current; setListLoading(false); setLoadingMore(true);
    try { const next = await api<InboxResult>(listUrl(result.nextCursor)); if (version !== queryVersion.current) return; setResult(previous => ({ ...next, items: [...previous.items, ...next.items.filter(item => !previous.items.some(p => p.id === item.id))] })); loadedPages.current++; }
    catch (e) { setListError((e as Error).message); } finally { setLoadingMore(false); }
  };
  const loadDetail = useCallback(async (id: string) => {
    try {
      const next = await api<Detail>(`/api/admin/conversations/${id}`);
      if (selectedRef.current !== id) return;
      setDetail(previous => previous?.conversation.id === id && (previous.conversation.version > next.conversation.version || new Date(previous.conversation.updatedAt) > new Date(next.conversation.updatedAt)) ? previous : next); setError("");
      const lastUser = [...next.messages].reverse().find(message => message.role === "user");
      if (lastUser && document.visibilityState === "visible" && !readMessages.current.has(lastUser.id)) {
        readMessages.current.add(lastUser.id);
        try { await api(`/api/admin/conversations/${id}/read`, { throughMessageId: lastUser.id }); void refreshList(); }
        catch { readMessages.current.delete(lastUser.id); }
      }
    } catch (e) { if (selectedRef.current === id) setError((e as Error).message); }
  }, [refreshList]);
  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    setDetail(null); setError(""); void loadDetail(selected);
    const timer = setInterval(() => void loadDetail(selected), 2500);
    return () => clearInterval(timer);
  }, [selected, loadDetail]);
  useEffect(() => { const panel = history.current; if (panel) panel.scrollTop = panel.scrollHeight; }, [detail?.conversation.id, detail?.messages.length]);
  const selectConversation = (id: string) => { selectedRef.current = id; setSelected(id); setNote(false); setTemplateOpen(false); setProfileOpen(false); setError(""); };
  const act = async (action: string, content?: string) => {
    const id = selected; const mode = note ? "note" : "reply"; setBusy(true); setError("");
    try {
      const updated = await api<Detail>(`/api/admin/conversations/${id}/${action}`, content === undefined ? {} : { text: content });
      if (selectedRef.current === id) setDetail(updated);
      if (action === "reply" || action === "note") setDrafts(previous => previous[id]?.[mode] !== content ? previous : ({ ...previous, [id]: { reply: previous[id]?.reply || "", note: previous[id]?.note || "", [mode]: "" } }));
      await Promise.all([refreshList(), reload()]);
      notify(({ claim: "รับช่วงแล้ว AI หยุดตอบ", release: "ส่งกลับให้ AI แล้ว", resolve: "จบการสนทนาแล้ว", reply: "ส่งข้อความแล้ว", note: "บันทึกภายในแล้ว", summarize: "อัปเดตสรุปความต้องการแล้ว" } as Record<string, string>)[action] || "บันทึกแล้ว");
    } catch (e) { if (selectedRef.current === id) setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const updateStage = async (stage: string) => {
    if (!detail) return; const id = selected; setBusy(true); setError("");
    try { await api("/api/admin/action", { action: "updateLead", id: detail.lead.id, values: { stage } }); await Promise.all([loadDetail(id), reload()]); notify("อัปเดตสถานะลูกค้าแล้ว"); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const openTemplates = async () => {
    setTemplateOpen(!templateOpen); if (templateOpen) return;
    setTemplateLoading(true); setTemplateError("");
    try { setTemplates((await api<{ templates: ReplyTemplate[] }>("/api/admin/reply-templates")).templates); }
    catch (e) { setTemplateError((e as Error).message); } finally { setTemplateLoading(false); }
  };
  const activeDetail = detail?.conversation.id === selected ? detail : null;
  const activeOwner = data.members.find(member => member.id === activeDetail?.conversation.assigneeId);
  const canReply = activeDetail?.conversation.status === "human_active";
  const shownTemplates = templates.filter(template => `${template.title} ${template.shortcut} ${template.category}`.toLowerCase().includes(templateSearch.toLowerCase()));
  const profile = activeDetail && <>
    <header className="desk-profile-heading"><h2>ข้อมูลลูกค้า</h2><div className="button-row"><Button variant="ghost" size="icon" aria-label="แก้ไขข้อมูลลูกค้า" onClick={() => setEditing(true)}><Pencil size={16} /></Button><Button className="profile-close" variant="ghost" size="icon" aria-label="ปิดข้อมูลลูกค้า" onClick={() => setProfileOpen(false)}><X size={18} /></Button></div></header>
    <div className="desk-profile-content"><div className="profile-identity"><span className="contact-avatar large">{(activeDetail.lead.name || "ล").slice(0, 1)}</span><h3>{activeDetail.lead.name || "ลูกค้าใหม่"}</h3><span className="channel-label"><Globe size={13} />{activeDetail.lead.source === "website" ? "เว็บไซต์" : activeDetail.lead.source}</span></div>
      <label className="profile-stage"><span>ขั้นตอนการขาย</span><Select aria-label="ขั้นตอนการขายของลูกค้า" value={activeDetail.lead.stage} disabled={busy} onChange={e => updateStage(e.target.value)}>{stages.map(stage => <option value={stage} key={stage}>{stageNames[stage]}</option>)}</Select></label>
      <dl className="profile-fields"><dt>เบอร์โทร</dt><dd>{activeDetail.lead.phone || "ยังไม่ระบุ"}</dd><dt>อีเมล</dt><dd>{activeDetail.lead.email || "ยังไม่ระบุ"}</dd><dt>ตลาด</dt><dd>{activeDetail.lead.market === "export" ? "ส่งออก" : activeDetail.lead.market === "domestic" ? "ในประเทศ" : "ยังไม่ยืนยัน"}</dd><dt>ความสนใจ</dt><dd>{activeDetail.lead.interests || "กำลังเก็บข้อมูล"}</dd><dt>ผู้ดูแลลูกค้า</dt><dd>{data.members.find(member => member.id === activeDetail.lead.assigneeId)?.name || "ยังไม่มอบหมาย"}</dd></dl>
      <div className="profile-section"><h3>แท็ก <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>แก้ไข</Button></h3><div className="tag-list">{activeDetail.lead.tags.length ? activeDetail.lead.tags.map(tag => <Badge key={tag}>{tag}</Badge>) : <span className="profile-placeholder">ยังไม่มีแท็ก</span>}</div></div>
      <div className="profile-section"><h3><Sparkles size={16} />สรุปความต้องการ</h3><Button variant="secondary" size="sm" className="full-width" disabled={busy} onClick={() => act("summarize")}>สรุปจากข้อมูลลูกค้า</Button>{activeDetail.lead.summary ? <Summary lead={activeDetail.lead} /> : <p className="profile-placeholder">สรุปจะแยกข้อเท็จจริงและสิ่งที่ต้องตรวจสอบ</p>}</div>
      <details className="profile-facts"><summary>ข้อมูลจากบทสนทนา <ChevronDown size={14} /></summary>{Object.entries(activeDetail.lead.facts || {}).length ? Object.entries(activeDetail.lead.facts).map(([key, value]) => <p key={key}><strong>{key}</strong><span>{value}</span></p>) : <p>ยังไม่มีข้อมูลที่จับจากบทสนทนา</p>}</details>
    </div>
  </>;

  return <section className={`desk-inbox ${selected ? "has-selection" : ""}`} aria-label="กล่องข้อความทีมขาย">
    <aside className="desk-list-pane" inert={profileOpen || undefined}>
      <div className="desk-list-header"><div><h1>กล่องข้อความ</h1><span>เว็บไซต์ · RRS Connect</span></div><Button size="icon" variant="ghost" aria-label="รีเฟรชกล่องข้อความ" disabled={listLoading} onClick={() => refreshList(true)}><RefreshCw size={17} className={listLoading ? "spin" : ""} /></Button></div>
      <div className="desk-queues" role="group" aria-label="คิวบทสนทนา">{queues.map(key => <button key={key} className={queue === key ? "active" : ""} aria-pressed={queue === key} onClick={() => { setQueue(key); setStatus(""); }}><span>{queueNames[key]}</span><b>{result.counts[key] || 0}</b></button>)}</div>
      <div className="desk-search"><Search size={17} /><Input aria-label="ค้นหาบทสนทนา" placeholder="ค้นหาลูกค้าและข้อความ" value={search} onChange={e => setSearch(e.target.value)} /><Button size="icon" variant="ghost" aria-label="ตัวกรองเพิ่มเติม" aria-expanded={filters} onClick={() => setFilters(!filters)}><SlidersHorizontal size={17} /></Button></div>
      {filters && <div className="desk-advanced-filters"><Select aria-label="สถานะบทสนทนา" value={status} onChange={e => setStatus(e.target.value)}><option value="">ทุกสถานะในคิว</option>{Object.entries(statusNames).filter(([key]) => queue === "closed" ? key === "resolved" : key !== "resolved").map(([key, name]) => <option key={key} value={key}>{name}</option>)}</Select><Select aria-label="ผู้รับผิดชอบแชต" value={owner} onChange={e => setOwner(e.target.value)}><option value="">ทุกผู้รับผิดชอบ</option>{data.members.filter(member => member.active !== false).map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</Select><Input aria-label="แท็กที่ต้องการค้นหา" value={tag} onChange={e => setTag(e.target.value)} placeholder="ชื่อแท็กตรงกัน" /><Button variant="ghost" size="sm" onClick={() => { setOwner(""); setTag(""); setStatus(""); setSearch(""); }}>ล้างตัวกรอง</Button></div>}
      <div className="desk-result-count"><span>{queueNames[queue]} <b>{result.total}</b></span><span>ล่าสุดก่อน</span></div>
      {listError && <div className="desk-inline-error" role="alert">{listError}<button onClick={() => refreshList(true)}>ลองอีกครั้ง</button></div>}
      <div className="desk-conversations">{listLoading && !result.items.length ? <div className="desk-loading"><span className="spinner" />กำลังโหลดบทสนทนา</div> : result.items.length ? result.items.map(item => <button key={item.id} className={`desk-conversation ${selected === item.id ? "selected" : ""} ${item.unreadCount > 0 ? "unread" : ""}`} onClick={() => selectConversation(item.id)}><span className="desk-avatar"><span>{(item.leadName || "ล").slice(0, 1)}</span><i><Globe size={10} /></i></span><span className="desk-conversation-text"><span className="desk-conversation-top"><strong>{item.leadName || "ลูกค้าใหม่"}</strong><time>{date(item.updatedAt, false)}</time></span><span className="desk-conversation-preview">{item.lastMessage || "ยังไม่มีข้อความ"}</span><span className="desk-conversation-bottom"><Badge tone={item.status === "waiting_human" ? "amber" : item.status === "human_active" ? "blue" : item.status === "resolved" ? "neutral" : "green"}>{statusNames[item.status]}</Badge>{item.unreadCount > 0 && <b className="unread-count" aria-label={`${item.unreadCount} ข้อความยังไม่อ่าน`}>{item.unreadCount}</b>}</span></span></button>) : <Empty title="ไม่มีแชตในคิวนี้" detail="ลองเปลี่ยนคิวหรือตัวกรองเพื่อดูบทสนทนาอื่น" />}{result.nextCursor && <Button className="desk-load-more" variant="ghost" disabled={loadingMore} onClick={more}>{loadingMore ? "กำลังโหลด…" : "โหลดบทสนทนาเพิ่มเติม"}</Button>}</div>
      <div className="desk-list-footer"><Globe size={14} /><span>รับข้อความจากเว็บไซต์</span><i className="status-dot" /></div>
    </aside>
    <section className="desk-chat-pane" inert={profileOpen || undefined}>
      {!selected ? <div className="desk-start"><span><Inbox size={37} /></span><h2>ทุกบทสนทนา อยู่ในที่เดียว</h2><p>เลือกแชตทางซ้ายเพื่อดูประวัติ<br />รับช่วงจาก AI และพาลูกค้าไปต่อ</p><div><Globe size={15} />เว็บไซต์พร้อมรับข้อความ</div><a href="/chat" target="_blank" rel="noreferrer" className="button button-secondary">เปิดแชตลูกค้า <ArrowUpRight size={16} /></a></div> : !activeDetail ? <div className="desk-loading"><span className="spinner" />กำลังเปิดบทสนทนา{error && <div role="alert">{error}<Button size="sm" onClick={() => loadDetail(selected)}>ลองอีกครั้ง</Button></div>}</div> : <>
        <header className="desk-chat-header"><Button variant="ghost" size="icon" className="desk-back" aria-label="กลับไปยังรายการแชต" onClick={() => selectConversation("")}><ArrowLeft size={19} /></Button><span className="contact-avatar">{(activeDetail.lead.name || "ล").slice(0, 1)}</span><div className="desk-chat-identity"><h2>{activeDetail.lead.name || "ลูกค้าใหม่"}</h2><span><Globe size={12} />เว็บไซต์ <i />{statusNames[activeDetail.conversation.status]}</span></div><Button variant="ghost" size="icon" className="profile-toggle" id="customer-profile-trigger" aria-label="ดูข้อมูลลูกค้า" onClick={() => { setTemplateOpen(false); setProfileOpen(true); }}><PanelRight size={20} /></Button></header>
        <div className="desk-chat-actions"><span><UserRound size={14} />{activeOwner?.name || "ยังไม่มอบหมาย"}</span><div className="button-row">{canReply ? <Button variant="secondary" size="sm" disabled={busy} onClick={() => act("release")}><Sparkles size={14} />ส่งกลับ AI</Button> : <Button size="sm" disabled={busy} onClick={() => act("claim")}><UserRound size={14} />รับช่วงตอบ</Button>}<Button variant="secondary" size="sm" disabled={busy || activeDetail.conversation.status === "resolved"} onClick={() => act("resolve")}><Check size={14} />จบแชต</Button></div></div>
        {error && <div className="desk-inline-error" role="alert">{error}</div>}
        <div className="desk-message-history" ref={history}>{activeDetail.messages.length ? activeDetail.messages.map(message => <ChatMessage key={message.id} message={message} />) : <Empty title="ยังไม่มีข้อความ" detail="ข้อความใหม่ของลูกค้าจะปรากฏที่นี่" />}</div>
        <form className={`desk-composer ${note ? "is-note" : ""}`} onSubmit={e => { e.preventDefault(); if (text.trim()) void act(note ? "note" : "reply", text); }}>
          <div className="desk-composer-tabs"><button type="button" className={!note ? "active" : ""} onClick={() => setNote(false)}><MessageSquare size={15} />ตอบลูกค้า</button><button type="button" className={note ? "active" : ""} onClick={() => { setNote(true); setTemplateOpen(false); }}><LockKeyhole size={14} />บันทึกภายใน</button>{text && <span>มีข้อความร่าง</span>}</div>
          {!canReply && !note && <div className="composer-locked"><Sparkles size={14} /><span>{activeDetail.conversation.status === "resolved" ? "แชตนี้จบแล้ว รับช่วงเพื่อเริ่มดูแลต่อ" : "รับช่วงก่อนตอบลูกค้า เพื่อให้ AI หยุดตอบ"}</span></div>}
          <Textarea aria-label={note ? "บันทึกภายใน" : "ข้อความตอบลูกค้า"} placeholder={note ? "บันทึกสำหรับทีม ลูกค้าจะไม่เห็นข้อความนี้…" : canReply ? "พิมพ์ข้อความ หรือเลือกข้อความสำเร็จรูป…" : "ร่างข้อความไว้ แล้วรับช่วงก่อนส่ง…"} value={text} onChange={e => putDraft(e.target.value)} maxLength={8000} rows={3} />
          <div className="desk-composer-footer"><div className="composer-tools"><Button variant="ghost" size="sm" type="button" id="reply-template-trigger" disabled={note} aria-expanded={templateOpen} onClick={openTemplates}><Bookmark size={16} />ข้อความสำเร็จรูป</Button>{templateOpen && <div className="template-picker" ref={templateRef} tabIndex={-1} role="dialog" aria-label="เลือกข้อความสำเร็จรูป"><div className="template-picker-heading"><strong>เลือกข้อความสำเร็จรูป</strong><Button type="button" variant="ghost" size="icon" aria-label="ปิดข้อความสำเร็จรูป" onClick={() => setTemplateOpen(false)}><X size={16} /></Button></div><div className="template-picker-search"><Search size={15} /><Input data-initial-focus aria-label="ค้นหาข้อความสำเร็จรูป" placeholder="ชื่อข้อความหรือ /คำลัด" value={templateSearch} onChange={e => setTemplateSearch(e.target.value)} /></div><div className="template-picker-items">{templateLoading ? <p className="helper-text">กำลังโหลดข้อความ…</p> : templateError ? <p className="error-text" role="alert">{templateError}</p> : shownTemplates.length ? shownTemplates.map(template => <button key={template.id} type="button" onClick={() => { putDraft((text ? text + "\n" : "") + template.content); setTemplateOpen(false); setTemplateSearch(""); }}><span><strong>{template.title}</strong><code>{template.shortcut}</code></span><p>{template.content}</p></button>) : <Empty title="ไม่พบข้อความสำเร็จรูป" detail="ผู้ดูแลสามารถเพิ่มข้อความได้จากเมนูข้อความ" />}</div><footer>เติมลงในร่างเท่านั้น ตรวจสอบก่อนส่งทุกครั้ง</footer></div>}</div><Button size="sm" type="submit" disabled={busy || !text.trim() || (!note && !canReply)}><Send size={15} />{busy ? "กำลังบันทึก…" : note ? "บันทึก" : "ส่งข้อความ"}</Button></div>
          <div className="composer-note"><CircleHelp size={12} />{note ? "ข้อความนี้เห็นเฉพาะสมาชิกในทีม" : "ร่างแยกตามลูกค้า · ไม่มีการส่งอัตโนมัติ"}</div>
        </form>
      </>}
    </section>
    <aside ref={profileRef} tabIndex={-1} role={profileOpen ? "dialog" : undefined} aria-modal={profileOpen || undefined} aria-label="ข้อมูลลูกค้า" className={`desk-profile-pane ${profileOpen ? "is-open" : ""}`}>{profile || <div className="profile-empty"><UserRound size={29} /><strong>รู้จักลูกค้าให้มากขึ้น</strong><p>ข้อมูลติดต่อ ความสนใจ และประวัติ<br />จะแสดงเมื่อเลือกบทสนทนา</p></div>}</aside>
    {profileOpen && <button className="profile-backdrop" aria-label="ปิดข้อมูลลูกค้า" onClick={() => setProfileOpen(false)} />}
    {editing && activeDetail && <Modal title="แก้ไขข้อมูลลูกค้า" close={() => setEditing(false)}><LeadEditor lead={activeDetail.lead} data={data} reload={async () => { await Promise.all([reload(), loadDetail(selected), refreshList()]); }} notify={notify} close={() => setEditing(false)} /></Modal>}
  </section>;
}
