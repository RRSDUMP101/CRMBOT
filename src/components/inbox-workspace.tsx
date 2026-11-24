"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { subscribeCRMChanges } from './realtime';
import { ArrowLeft, ArrowUpRight, Pin, ListFilter, Bookmark, Check, ClipboardList, ChevronDown, CircleHelp, Globe, Inbox, LockKeyhole, MessageSquare, PanelRight, Pencil, RefreshCw, Search, Send, SlidersHorizontal, Sparkles, UserRound, X, Clock3, CalendarDays, Users } from "lucide-react";
import { api, date, stageNames, stages, statusNames, WorkspaceApiError, type Detail, type SaleContext, type SaleDeal } from "./data";
import { emptyCounts, queueNames, type InboxItem, type InboxQueue, type InboxResult, type ReplyTemplate } from "./inbox-data";
import { Badge, Button, Empty, Input, Select, Textarea } from "./ui";
import { ChatMessage, LeadEditor, Modal, Summary } from "./workspace-panels";
import type { PanelProps } from "./workspace";
import { useFocusScope } from "./focus-scope";
import { WhatsAppConsent } from "./whatsapp-consent";
import {HumanAttachments,type HumanAttachmentDraft} from "./human-attachments";
import {WebChatAttachments,type WebAttachmentDraft} from "./web-chat-attachments";

function ChannelIcon({provider}: {provider?: string}) { const p = provider || "web"; const marks: Record<string, string> = {whatsapp:"☎",line:"LINE",facebook:"f",instagram:"◎",gmail:"M",outlook:"O",email:"✉"}; return <span className={`channel-platform channel-${p}`} title={p} aria-label={p}>{marks[p] || <Globe size={14}/>}</span>; }
const queues: InboxQueue[] = ["all", "unread", "waiting", "mine", "unassigned", "closed"];
type Drafts = Record<string, { reply: string; note: string }>;
type SendIssue={reference:string;status:number;time:string};
function issueGuidance(status:number){
  if(status===401||status===403)return "ตรวจสิทธิ์และการเข้าสู่ระบบก่อนส่งอีกครั้ง";
  if(status===409)return "ตรวจผู้รับผิดชอบและสถานะล่าสุดของห้องก่อนส่งอีกครั้ง";
  if(status===400||status===422)return "ตรวจข้อความในร่าง คำตอบถึงลูกค้าต้องเป็นภาษาอังกฤษ";
  if(status===429)return "กรุณารอสักครู่แล้วส่งอีกครั้ง";
  return "ยังยืนยันผลไม่ได้ ตรวจประวัติห้องหรือส่งร่างเดิมอีกครั้ง";
}

export function InboxWorkspace({ data, reload, notify, searchRequest, navigate, roomRequest, visible=true, compact=false, onUnread }: PanelProps & { roomRequest?: {id:string; sequence:number}; visible?:boolean; compact?:boolean; onUnread?:(count:number)=>void; searchRequest?: { value: string; revision: number; queue?:InboxQueue }; navigate?: (view: string) => void }) {
  const [shown, setShown] = useState({preview:true,status:true,date:true,channel:true});
  const [pageSize, setPageSize] = useState(25);
  const [queue, setQueue] = useState<InboxQueue>("all");
  useEffect(() => {
    if (!searchRequest?.revision) return;
    // A submitted header search must reveal its results on the single-pane mobile view.
    selectedRef.current = ""; setSelected(""); setDetail(null); setProfileOpen(false); setTemplateOpen(false); setError("");
    setSearch(searchRequest.value); setQueue(searchRequest.queue||"all"); setOwner(""); setStatus(""); setTag("");
  }, [searchRequest]);
  const [search, setSearch] = useState(""); const [query, setQuery] = useState("");
  const [owner, setOwner] = useState(""); const [status, setStatus] = useState(""); const [tag, setTag] = useState(""); const [filters, setFilters] = useState(false);
  const [result, setResult] = useState<InboxResult>({ items: [], nextCursor: null, total: 0, counts: emptyCounts });
  const [listLoading, setListLoading] = useState(true); const [listError, setListError] = useState(""); const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState(""); const [detail, setDetail] = useState<Detail | null>(null); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Drafts>({}); const [note, setNote] = useState(false); const [profileOpen, setProfileOpen] = useState(false); const [editing, setEditing] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false); const [templates, setTemplates] = useState<ReplyTemplate[]>([]); const [templateSearch, setTemplateSearch] = useState(""); const [templateLoading, setTemplateLoading] = useState(false); const [templateError, setTemplateError] = useState("");
  const selectedRef = useRef(""); const queryVersion = useRef(0); const listRequest = useRef(0); const loadedPages = useRef(1); const readMessages = useRef(new Set<string>()); const history = useRef<HTMLDivElement>(null);
  selectedRef.current = selected;
  useEffect(()=>{
    const requested=new URLSearchParams(window.location.search).get('conversation');
    if(requested && /^[a-f0-9-]{36}$/i.test(requested))setSelected(requested);
  },[]);
  const profileRef = useRef<HTMLElement>(null); const templateRef = useRef<HTMLDivElement>(null);
  useFocusScope(profileOpen, profileRef, () => setProfileOpen(false), true, "#customer-profile-trigger");
  useFocusScope(templateOpen, templateRef, () => setTemplateOpen(false), false, "#reply-template-trigger");
  useEffect(() => { const resize = () => { if (window.innerWidth > 1260) setProfileOpen(false); }; window.addEventListener("resize", resize); return () => window.removeEventListener("resize", resize); }, []);
  const visibleRef=useRef(visible);
  visibleRef.current=visible;
  const actionPending=useRef(false);
  const humanFiles=useRef(new Map<string,HumanAttachmentDraft>());
  const webFiles=useRef(new Map<string,WebAttachmentDraft>());
  const attempts=useRef(new Map<string,{text:string;clientId:string}>());
  const [issues,setIssues]=useState<Record<string,SendIssue>>({});
  const [insertions,setInsertions]=useState<Record<string,{before:string;after:string}>>({});
  const keepAtEnd=useRef(true);
  const [queueOpen,setQueueOpen]=useState(false);
  useEffect(()=>{
    if(!roomRequest?.id)return;
    selectedRef.current=roomRequest.id;setSelected(roomRequest.id);setNote(false);setError("");setProfileOpen(false);setTemplateOpen(false);keepAtEnd.current=true;
  },[roomRequest]);
  useEffect(()=>{
    if(!visible){setProfileOpen(false);setTemplateOpen(false);setEditing(false);}
  },[visible]);
  useEffect(()=>{
    if(!onUnread || !selected)return;
    const item=result.items.find(row=>row.id===selected);
    if(item)onUnread(item.unreadCount);
  },[result,selected,onUnread]);
  const draftKey = note ? "note" : "reply";
  const text = drafts[selected]?.[draftKey] || "";
  const issue=issues[selected+':'+draftKey];
  const insertion=!note&&insertions[selected]?.after===text?insertions[selected]:null;
  const putDraft = (value: string) => setDrafts(previous => ({ ...previous, [selected]: { reply: previous[selected]?.reply || "", note: previous[selected]?.note || "", [draftKey]: value } }));
  const insertTemplate=(content:string)=>{
    const after=text?text+"\n"+content:content;
    setInsertions(previous=>({...previous,[selected]:{before:text,after}}));
    putDraft(after);setTemplateOpen(false);setTemplateSearch("");
  };

  useEffect(() => { const timer = setTimeout(() => setQuery(search.trim()), 250); return () => clearTimeout(timer); }, [search]);
  const listUrl = useCallback((cursor?: string, limit = pageSize) => {
    const params = new URLSearchParams({ view: queue, limit: String(limit) });
    if (query) params.set("q", query); if (owner) params.set("assignee", owner); if (tag.trim()) params.set("tag", tag.trim()); if (status) params.set("status", status); if (cursor) params.set("cursor", cursor);
    return "/api/admin/inbox?" + params;
  }, [query, queue, owner, tag, status, pageSize]);
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
      if (lastUser && visibleRef.current && document.visibilityState === "visible" && !readMessages.current.has(lastUser.id)) {
        readMessages.current.add(lastUser.id);
        try { await api(`/api/admin/conversations/${id}/read`, { throughMessageId: lastUser.id }); void refreshList(); }
        catch { readMessages.current.delete(lastUser.id); }
      }
    } catch (e) { if (selectedRef.current === id) setError((e as Error).message); }
  }, [refreshList]);
  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    if(!visible)return;
    setError(""); void loadDetail(selected);
    const timer = setInterval(() => void loadDetail(selected), 2500);
    return () => clearInterval(timer);
  }, [selected, loadDetail, visible]);
  useEffect(()=>subscribeCRMChanges(()=>{void refreshList();if(visibleRef.current && selectedRef.current)void loadDetail(selectedRef.current);}),[refreshList,loadDetail]);
  useEffect(() => { const panel = history.current; if (panel && keepAtEnd.current) panel.scrollTop = panel.scrollHeight; }, [detail?.conversation.id, detail?.messages.length]);
  const selectConversation = (id: string) => {
    keepAtEnd.current=true;setQueueOpen(false);
    if(!compact){
      const url=new URL(location.href);
      if(id)url.searchParams.set('conversation',id);else url.searchParams.delete('conversation');
      if(url.toString()!==location.href){
        if(id && !selected) window.history.pushState({...window.history.state,rrsInboxRoom:true},'',url);
        else window.history.replaceState({...window.history.state,rrsInboxRoom:!!id},'',url);
      }
    }
    selectedRef.current = id; setSelected(id); setNote(false); setTemplateOpen(false); setProfileOpen(false); setError(""); };
  useEffect(()=>{
    const restore=()=>{const id=new URLSearchParams(location.search).get('conversation')||'';if(id&&!/^[a-f0-9-]{36}$/i.test(id))return;selectedRef.current=id;setSelected(id);setProfileOpen(false);setTemplateOpen(false);setNote(false);keepAtEnd.current=true;};
    window.addEventListener('popstate',restore);return()=>window.removeEventListener('popstate',restore);
  },[]);
  const act = async (action: string, content?: string) => {
    if(actionPending.current)return;
    actionPending.current=true;
    const id = selected; const mode = note ? "note" : "reply"; setBusy(true); setError("");
    const key=id+':'+action;
    let request=attempts.current.get(key);
    try {
      if(content!==undefined && request?.text!==content){request={text:content,clientId:crypto.randomUUID()};attempts.current.set(key,request);}
      const updated = await api<Detail>(`/api/admin/conversations/${id}/${action}`, request && content!==undefined ? request : {});
      attempts.current.delete(key);
      setIssues(previous=>{const next={...previous};delete next[key];return next;});
      if (selectedRef.current === id) setDetail(updated);
      if (action === "reply" || action === "note") setDrafts(previous => previous[id]?.[mode] !== content ? previous : ({ ...previous, [id]: { reply: previous[id]?.reply || "", note: previous[id]?.note || "", [mode]: "" } }));
      await Promise.allSettled([refreshList(), reload()]);
      notify(({ claim: "รับช่วงแล้ว AI หยุดตอบ", release: "ส่งกลับให้ AI แล้ว", resolve: "จบการสนทนาแล้ว", reply: "บันทึกคำตอบแล้ว ตรวจสถานะการส่งใต้ข้อความ", note: "บันทึกภายในแล้ว", summarize: "อัปเดตสรุปความต้องการแล้ว" } as Record<string, string>)[action] || "บันทึกแล้ว");
    } catch (e) {
      if(request&&content!==undefined){
        const failure={reference:request.clientId,status:e instanceof WorkspaceApiError?e.status:0,time:new Date().toISOString()};
        setIssues(previous=>({...previous,[key]:failure}));
      }else if(selectedRef.current===id)setError((e as Error).message);
    }
    finally { actionPending.current=false; setBusy(false); }
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
  const humanActive=activeDetail?.conversation.status==="human_active";
  const canReply=humanActive && activeDetail?.conversation.assigneeId===data.user.id;
  const shownTemplates = templates.filter(template => `${template.title} ${template.shortcut} ${template.category}`.toLowerCase().includes(templateSearch.toLowerCase()));
  const nextTask = activeDetail ? data.tasks.filter(task => task.leadId === activeDetail.lead.id && ["open", "pending", "confirmed"].includes(task.status)).sort((a, b) => a.dueAt.localeCompare(b.dueAt))[0] : null;
  const profile = activeDetail && <>
    <header className="desk-profile-heading"><h2>ข้อมูลลูกค้า</h2><div className="button-row"><Button variant="ghost" size="icon" aria-label="แก้ไขข้อมูลลูกค้า" onClick={() => setEditing(true)}><Pencil size={16} /></Button><Button className="profile-close" variant="ghost" size="icon" aria-label="ปิดข้อมูลลูกค้า" onClick={() => setProfileOpen(false)}><X size={18} /></Button></div></header>
    <div className="desk-profile-content"><div className="profile-identity"><span className="contact-avatar large">{(activeDetail.lead.name || "ล").slice(0, 1)}</span><h3>{activeDetail.lead.name || "ลูกค้าใหม่"}</h3><span className="channel-label"><Globe size={13} />{activeDetail.lead.source === "website" ? "เว็บไซต์" : activeDetail.lead.source}</span></div>
      <div className="profile-next-task"><div><h3><CalendarDays size={16} />งานถัดไป</h3>{navigate && <button type="button" onClick={() => navigate("tasks")}>ดูงาน <ArrowUpRight size={14} /></button>}</div>{nextTask ? <><strong>{nextTask.title}</strong><p><Clock3 size={14} />{date(nextTask.dueAt)}</p><small>{data.members.find(member => member.id === nextTask.assigneeId)?.name || "ยังไม่มอบหมาย"}</small></> : <p>ยังไม่มีงานติดตามที่เปิดอยู่</p>}</div>
      <label className="profile-stage"><span>ขั้นตอนการขาย</span><Select aria-label="ขั้นตอนการขายของลูกค้า" value={activeDetail.lead.stage} disabled={busy} onChange={e => updateStage(e.target.value)}>{stages.map(stage => <option value={stage} key={stage}>{stageNames[stage]}</option>)}</Select></label>
      <dl className="profile-fields"><dt>เบอร์โทร</dt><dd>{activeDetail.lead.phone || "ยังไม่ระบุ"}</dd><dt>อีเมล</dt><dd>{activeDetail.lead.email || "ยังไม่ระบุ"}</dd><dt>ตลาด</dt><dd>{activeDetail.lead.market === "export" ? "ส่งออก" : activeDetail.lead.market === "domestic" ? "ในประเทศ" : "ยังไม่ยืนยัน"}</dd><dt>ความสนใจ</dt><dd>{activeDetail.lead.interests || "กำลังเก็บข้อมูล"}</dd><dt>ผู้ดูแลลูกค้า</dt><dd>{data.members.find(member => member.id === activeDetail.lead.assigneeId)?.name || "ยังไม่มอบหมาย"}</dd></dl>
      {data.user.role === 'Admin' && <WhatsAppConsent key={activeDetail.conversation.id} conversationId={activeDetail.conversation.id}/>}
      <div className="profile-section"><h3>แท็ก <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>แก้ไข</Button></h3><div className="tag-list">{activeDetail.lead.tags.length ? activeDetail.lead.tags.map(tag => <Badge key={tag}>{tag}</Badge>) : <span className="profile-placeholder">ยังไม่มีแท็ก</span>}</div></div>
      {activeDetail.saleContext && <SaleContextSection context={activeDetail.saleContext} conversationId={selected} visible={visible} />}
      <div className="profile-section"><h3><Sparkles size={16} />สรุปความต้องการ</h3><Button variant="secondary" size="sm" className="full-width" disabled={busy} onClick={() => act("summarize")}>สรุปจากข้อมูลลูกค้า</Button>{activeDetail.lead.summary ? <Summary lead={activeDetail.lead} /> : <p className="profile-placeholder">สรุปจะแยกข้อเท็จจริงและสิ่งที่ต้องตรวจสอบ</p>}</div>
      <details className="profile-facts"><summary>ข้อมูลจากบทสนทนา <ChevronDown size={14} /></summary>{Object.entries(activeDetail.lead.facts || {}).length ? Object.entries(activeDetail.lead.facts).map(([key, value]) => <p key={key}><strong>{key}</strong><span>{value}</span></p>) : <p>ยังไม่มีข้อมูลที่จับจากบทสนทนา</p>}</details>
    </div>
  </>;

  return <section className={`desk-inbox ${selected ? "has-selection" : ""} ${compact?"desk-inbox-compact":""} ${queueOpen?"queue-open":""}`} data-preview={shown.preview} data-status={shown.status} data-date={shown.date} data-channel={shown.channel} aria-label="กล่องข้อความทีมขาย">
    <div className="desk-priorities" aria-label="คิวงานที่ต้องดูแล" inert={profileOpen || undefined}>{([{ key: "waiting", label: "รอเจ้าหน้าที่", icon: Clock3, tone: "amber" }, { key: "mine", label: "งานของฉัน", icon: ClipboardList, tone: "blue" }, { key: "unassigned", label: "ยังไม่มอบหมาย", icon: Users, tone: "slate" }] as const).map(item => <button key={item.key} type="button" className={`priority-card priority-${item.tone} ${queue === item.key ? "is-active" : ""}`} aria-pressed={queue === item.key} onClick={() => { setQueue(item.key); setStatus(""); }}><span className="priority-icon"><item.icon size={23} /></span><span><small>{item.label}</small><strong>{listLoading && !result.items.length ? "—" : result.counts[item.key]}</strong></span><ArrowUpRight size={17} /></button>)}</div>
    <nav className="desk-view-menu" aria-label="เลือกคิวงาน" inert={profileOpen||undefined}><h2>คิวงาน</h2>{queues.map(key=><button key={key} type="button" aria-pressed={queue===key} onClick={()=>{setQueue(key);setStatus("");}}><span>{queueNames[key]}</span><b>{result.counts[key]}</b></button>)}</nav>
    <aside className="desk-list-pane" inert={profileOpen || undefined}>
      <div className="desk-list-header"><div><h1>{queueNames[queue]}</h1></div><Button className="desk-choose-queue" variant="secondary" size="sm" aria-expanded={queueOpen} onClick={()=>setQueueOpen(!queueOpen)}><ListFilter size={15}/>เลือกคิว</Button><Button size="icon" variant="ghost" aria-label="รีเฟรชกล่องข้อความ" disabled={listLoading} onClick={() => refreshList(true)}><RefreshCw size={17} className={listLoading ? "spin" : ""} /></Button></div>
      <div className="desk-queues" role="group" aria-label="คิวบทสนทนา">{queues.map(key => <button key={key} className={queue === key ? "active" : ""} aria-pressed={queue === key} onClick={() => { setQueue(key); setStatus(""); setQueueOpen(false); }}><span>{queueNames[key]}</span><b>{result.counts[key] || 0}</b></button>)}</div>
      <div className="desk-search"><Search size={17} /><Input aria-label="ค้นหาบทสนทนา" placeholder="ชื่อลูกค้า เบอร์โทร หรือเลขใบเสนอราคา" value={search} onChange={e => setSearch(e.target.value)} /><Button size="icon" variant="ghost" aria-label="ตัวกรองเพิ่มเติม" aria-expanded={filters} onClick={() => setFilters(!filters)}><SlidersHorizontal size={17} /></Button></div>
      {filters && <div className="desk-advanced-filters"><Select aria-label="สถานะบทสนทนา" value={status} onChange={e => setStatus(e.target.value)}><option value="">ทุกสถานะในคิว</option>{Object.entries(statusNames).filter(([key]) => queue === "closed" ? key === "resolved" : key !== "resolved").map(([key, name]) => <option key={key} value={key}>{name}</option>)}</Select><Select aria-label="ผู้รับผิดชอบแชต" value={owner} onChange={e => setOwner(e.target.value)}><option value="">ทุกผู้รับผิดชอบ</option>{data.members.filter(member => member.active !== false).map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</Select><Input aria-label="แท็กที่ต้องการค้นหา" value={tag} onChange={e => setTag(e.target.value)} placeholder="ชื่อแท็กตรงกัน" /><Button variant="ghost" size="sm" onClick={() => { setOwner(""); setTag(""); setStatus(""); setSearch(""); }}>ล้างตัวกรอง</Button></div>}
      <div className="desk-result-count"><details className="inbox-columns"><summary>คอลัมน์</summary><div>{([["preview","ตัวอย่างข้อความ"],["status","สถานะ"],["date","วันที่"],["channel","ช่องทาง"]] as const).map(([key,label])=><label key={key}><input type="checkbox" checked={shown[key]} onChange={e=>setShown(v=>({...v,[key]:e.target.checked}))}/>{label}</label>)}</div></details><span>{queueNames[queue]} <b>{result.total}</b></span><label>แสดง <Select aria-label="จำนวนบทสนทนาต่อครั้ง" value={pageSize} onChange={e => setPageSize(Number(e.target.value))}>{[10,25,50,100].map(n => <option key={n} value={n}>{n} รายการ</option>)}</Select></label></div>
      {listError && <div className="desk-inline-error" role="alert">{listError}<button onClick={() => refreshList(true)}>ลองอีกครั้ง</button></div>}
      <div className="desk-conversations">{listLoading && !result.items.length ? <div className="desk-loading"><span className="spinner" />กำลังโหลดบทสนทนา</div> : result.items.length ? result.items.map(item => <button key={item.id} className={`desk-conversation ${selected === item.id ? "selected" : ""} ${item.unreadCount > 0 ? "unread" : ""}`} onClick={() => selectConversation(item.id)}><span className="desk-avatar"><span>{(item.leadName || "ล").slice(0, 1)}</span><i><ChannelIcon provider={item.provider} /></i></span><span className="desk-conversation-text"><span className="desk-conversation-top"><strong>{item.leadName || "ลูกค้าใหม่"}</strong><time>{date(item.updatedAt)}</time></span><span className="desk-conversation-preview">{item.lastMessage || "ยังไม่มีข้อความ"}</span><span className="desk-conversation-bottom"><Badge tone={item.status === "waiting_human" ? "amber" : item.status === "human_active" ? "blue" : item.status === "resolved" ? "neutral" : "green"}>{statusNames[item.status]}</Badge>{item.unreadCount > 0 && <b className="unread-count" aria-label={`${item.unreadCount} ข้อความยังไม่อ่าน`}>{item.unreadCount}</b>}</span></span></button>) : <Empty title="ไม่มีแชตในคิวนี้" detail="ลองเปลี่ยนคิวหรือตัวกรองเพื่อดูบทสนทนาอื่น" />}{result.nextCursor && <Button className="desk-load-more" variant="ghost" disabled={loadingMore} onClick={more}>{loadingMore ? "กำลังโหลด…" : "โหลดบทสนทนาเพิ่มเติม"}</Button>}</div>
    </aside>
    <section className="desk-chat-pane" inert={profileOpen || undefined}>
      {!selected ? <div className="desk-start"><span><Inbox size={37} /></span><h2>เลือกบทสนทนา</h2><p>เลือกชื่อลูกค้าจากรายการเพื่อเปิดประวัติและตอบกลับ</p><a href="/chat" target="_blank" rel="noreferrer" className="button button-secondary">เปิดแชตลูกค้า <ArrowUpRight size={16} /></a></div> : !activeDetail ? <div className="desk-loading"><Button className="desk-back" variant="ghost" onClick={()=>selectConversation("")}>กลับไปรายการ</Button>{!error && <><span className="spinner" />กำลังเปิดบทสนทนา</>}{error && <div role="alert">{error}<Button size="sm" onClick={() => loadDetail(selected)}>ลองอีกครั้ง</Button></div>}</div> : <>
        <header className="desk-chat-header"><Button variant="ghost" size="icon" className="desk-back" aria-label="กลับไปยังรายการแชต" onClick={() => selectConversation("")}><ArrowLeft size={19} /></Button><span className="contact-avatar">{(activeDetail.lead.name || "ล").slice(0, 1)}</span><div className="desk-chat-identity"><h2>{activeDetail.lead.name || "ลูกค้าใหม่"}</h2><span><Globe size={12} />{activeDetail.lead.source === "website" ? "เว็บไซต์" : activeDetail.lead.source} <i />{statusNames[activeDetail.conversation.status]}</span></div><Button variant="ghost" size="icon" className="profile-toggle" id="customer-profile-trigger" aria-label="ดูข้อมูลลูกค้า" onClick={() => { setTemplateOpen(false); setProfileOpen(true); }}><PanelRight size={20} /></Button></header>
        <div className="desk-chat-actions"><span><UserRound size={14} />{activeOwner?.name || "ยังไม่มอบหมาย"}</span><div className="button-row">{humanActive ? <Button variant="secondary" size="sm" disabled={busy || (!canReply && data.user.role!=="Admin")} onClick={() => act("release")}><Sparkles size={14} />ส่งกลับ AI</Button> : <Button size="sm" disabled={busy} onClick={() => act("claim")}><UserRound size={14} />รับช่วงจาก AI</Button>}<Button variant="secondary" size="sm" disabled={busy || activeDetail.conversation.status === "resolved" || (humanActive && !canReply && data.user.role!=="Admin")} onClick={() => act("resolve")}><Check size={14} />จบแชต</Button></div></div>
        <div className={`desk-ownership-status ${canReply ? "is-human" : ""}`}><span className="status-dot" />{humanActive ? "AI พักอยู่ · เจ้าหน้าที่กำลังดูแล" : activeDetail.conversation.status === "resolved" ? "จบการสนทนาแล้ว" : activeDetail.conversation.status === "waiting_human" ? "ลูกค้ารอเจ้าหน้าที่รับช่วง" : "ผู้ช่วย AI กำลังดูแล"}</div>
        {activeDetail.saleContext?.deals.find(deal=>deal.quotation) && <PinnedQuotation context={activeDetail.saleContext} />}
        {error && <div className="desk-inline-error" role="alert">{error}</div>}
        <div className="desk-message-history" ref={history} onScroll={e=>{const box=e.currentTarget;keepAtEnd.current=box.scrollHeight-box.scrollTop-box.clientHeight<64;}}>{activeDetail.messages.length ? activeDetail.messages.map((message,index) => {
          const day=dayLabel(message.createdAt);
          return <Fragment key={message.id}>{(!index||day!==dayLabel(activeDetail.messages[index-1].createdAt))&&<div className="desk-history-date">{day}</div>}<ChatMessage message={message} /></Fragment>;
        }) : <Empty title="ยังไม่มีข้อความ" detail="ข้อความใหม่ของลูกค้าจะปรากฏที่นี่" />}</div>
        <form className={`desk-composer ${note ? "is-note" : ""}`} onSubmit={e => { e.preventDefault(); if (text.trim()) void act(note ? "note" : "reply", text); }}>
          <div className="desk-composer-tabs" role="group" aria-label="ประเภทข้อความ"><button type="button" aria-pressed={!note} className={!note ? "active" : ""} onClick={() => setNote(false)}><MessageSquare size={15} />ตอบลูกค้า</button><button type="button" aria-pressed={note} className={note ? "active" : ""} onClick={() => { setNote(true); setTemplateOpen(false); }}><LockKeyhole size={14} />บันทึกภายใน</button>{text && <span>มีข้อความร่าง</span>}</div>
          {!canReply && !note && <div className="composer-locked"><Sparkles size={14} /><span>{activeDetail.conversation.status === "resolved" ? "แชตนี้จบแล้ว รับช่วงเพื่อเริ่มดูแลต่อ" : humanActive ? "ห้องนี้มีเจ้าหน้าที่คนอื่นรับผิดชอบ" : "รับช่วงก่อนตอบลูกค้า เพื่อให้ AI หยุดตอบ"}</span></div>}
          <Textarea aria-label={note ? "บันทึกภายใน" : "ข้อความตอบลูกค้า"} placeholder={note ? "บันทึกสำหรับทีม ลูกค้าจะไม่เห็นข้อความนี้…" : canReply ? "พิมพ์ข้อความ หรือเลือกข้อความสำเร็จรูป…" : "ร่างข้อความไว้ แล้วรับช่วงก่อนส่ง…"} value={text} onChange={e => putDraft(e.target.value)} maxLength={6000} rows={3} />
          <div className="desk-composer-footer"><div className="composer-tools"><Button variant="ghost" size="sm" type="button" id="reply-template-trigger" disabled={note} aria-expanded={templateOpen} onClick={openTemplates}><Bookmark size={16} />ข้อความสำเร็จรูป</Button>{templateOpen && <div className="template-picker" ref={templateRef} tabIndex={-1} role="dialog" aria-label="เลือกข้อความสำเร็จรูป"><div className="template-picker-heading"><strong>เลือกข้อความสำเร็จรูป</strong><Button type="button" variant="ghost" size="icon" aria-label="ปิดข้อความสำเร็จรูป" onClick={() => setTemplateOpen(false)}><X size={16} /></Button></div><div className="template-picker-search"><Search size={15} /><Input data-initial-focus aria-label="ค้นหาข้อความสำเร็จรูป" placeholder="ชื่อข้อความหรือ /คำลัด" value={templateSearch} onChange={e => setTemplateSearch(e.target.value)} /></div><div className="template-picker-items">{templateLoading ? <p className="helper-text">กำลังโหลดข้อความ…</p> : templateError ? <p className="error-text" role="alert">{templateError}</p> : shownTemplates.length ? shownTemplates.map(template => <button key={template.id} type="button" onClick={()=>insertTemplate(template.content)}><span><strong>{template.title}</strong><code>{template.shortcut}</code></span><p>{template.content}</p></button>) : <Empty title="ไม่พบข้อความสำเร็จรูป" detail="ผู้ดูแลสามารถเพิ่มข้อความได้จากเมนูข้อความ" />}</div><footer>เติมลงในร่างเท่านั้น ตรวจสอบก่อนส่งทุกครั้ง</footer></div>}</div><Button size="sm" type="submit" disabled={busy || !text.trim() || (!note && !canReply)}><Send size={15} />{busy ? "กำลังบันทึก…" : note ? "บันทึก" : "ส่งข้อความ"}</Button></div>
          {!note && <HumanAttachments drafts={humanFiles.current} key={selected} conversationId={selected} version={activeDetail.conversation.version} disabled={busy || !canReply || activeDetail.conversation.assigneeId !== data.user.id} onSent={async()=>{await Promise.all([loadDetail(selected),refreshList(),reload()]);}} />}
          {!note && <WebChatAttachments drafts={webFiles.current} key={'web-'+selected} conversationId={selected} version={activeDetail.conversation.version} disabled={busy || !canReply || activeDetail.conversation.assigneeId !== data.user.id} onSent={async()=>{await Promise.all([loadDetail(selected),refreshList(),reload()]);}} />}
          <div className="composer-note"><CircleHelp size={12} />{note ? "ข้อความนี้เห็นเฉพาะสมาชิกในทีม" : "ร่างแยกตามลูกค้า · ไม่มีการส่งอัตโนมัติ"}</div>
          {insertion&&<Button type="button" variant="ghost" size="sm" onClick={()=>{putDraft(insertion.before);setInsertions(previous=>{const next={...previous};delete next[selected];return next;});}}>ย้อนการเติมข้อความสำเร็จรูป</Button>}
          {issue&&<div className="desk-send-issue" role="alert">
            <strong>{note?"ยังยืนยันการบันทึกโน้ตไม่ได้":"ยังยืนยันการส่งข้อความไม่ได้"}</strong>
            <p>{issueGuidance(issue.status)}</p><small>เลขอ้างอิง <code>{issue.reference}</code></small>
            <div className="button-row"><Button type="button" size="sm" variant="secondary" onClick={async()=>{
              const report=["RRS CRM",draftKey,"ref="+issue.reference,"status="+(issue.status||"network"),"utc="+issue.time].join(" | ");
              try{await navigator.clipboard.writeText(report);notify("คัดลอกเลขอ้างอิงแล้ว");}catch{notify("เลือกเลขอ้างอิงบนหน้าจอเพื่อคัดลอก");}
            }}>คัดลอกเลขอ้างอิง</Button>{attempts.current.get(selected+':'+draftKey)?.text===text&&<Button type="button" size="sm" disabled={busy||(!note&&!canReply)} onClick={()=>void act(draftKey,text)}>ลองส่งร่างเดิมอีกครั้ง</Button>}</div>
          </div>}
        </form>
      </>}
    </section>
    <aside ref={profileRef} tabIndex={-1} role={profileOpen ? "dialog" : undefined} aria-modal={profileOpen || undefined} aria-label="ข้อมูลลูกค้า" className={`desk-profile-pane ${profileOpen ? "is-open" : ""}`}>{profile || <div className="profile-empty"><UserRound size={29} /><strong>รู้จักลูกค้าให้มากขึ้น</strong><p>ข้อมูลติดต่อ ความสนใจ และประวัติ<br />จะแสดงเมื่อเลือกบทสนทนา</p></div>}</aside>
    {profileOpen && <button className="profile-backdrop" aria-label="ปิดข้อมูลลูกค้า" onClick={() => setProfileOpen(false)} />}
    {editing && activeDetail && <Modal title="แก้ไขข้อมูลลูกค้า" close={() => setEditing(false)}><LeadEditor lead={activeDetail.lead} data={data} reload={async () => { await Promise.all([reload(), loadDetail(selected), refreshList()]); }} notify={notify} close={() => setEditing(false)} /></Modal>}
  </section>;
}

const dayFormat=new Intl.DateTimeFormat('th-TH',{timeZone:'Asia/Bangkok',day:'numeric',month:'long',year:'numeric'});
const dayLabel=(value:string)=>dayFormat.format(new Date(value));
function PinnedQuotation({context}:{context:SaleContext}){
  const deal=context.deals.find(item=>item.quotation);
  if(!deal?.quotation)return null;
  const quote=deal.quotation;
  const path=deal.workspace==='domestic'?'/domestic/quotations':'/quotations';
  const params=new URLSearchParams({mode:deal.workspace,deal:deal.dealId,section:quote.id?'edit':'saved'});
  if(quote.id)params.set('id',quote.id);
  return <a className="desk-pinned" target="_blank" rel="noreferrer" href={'https://rrs-sales-office-hub.com'+path+'?'+params}><Pin size={15}/><strong>{quote.number}</strong><span>ฉบับ {quote.revision} · {quotationNames[quote.status]||quote.status}</span><ArrowUpRight size={14}/></a>;
}

const quotationNames: Record<string, string> = { draft: "ร่าง", review: "รอผู้บริหารตรวจ", approved: "อนุมัติแล้ว", sent: "ส่งแล้ว", accepted: "ลูกค้ายอมรับ", expired: "หมดอายุ", cancelled: "ยกเลิก" };
const productionNames: Record<string, string> = { planned: "วางแผน", producing: "กำลังผลิต", qc: "รอ QC", qc_passed: "ผ่าน QC", delivered: "ส่งมอบแล้ว", cancelled: "ยกเลิก" };
const shipmentNames: Record<string, string> = { preparing: "เตรียมส่ง", active: "กำลังขนส่ง", completed: "ส่งถึงแล้ว", cancelled: "ยกเลิก" };
/** Read-only Sale Office facts. Editing stays in Sale Office; nothing here is sent to the customer. */
function SaleContextSection({context,conversationId,visible}:{context:SaleContext;conversationId:string;visible:boolean}){
  const [revision,setRevision]=useState(0);
  const [live,setLive]=useState<{id:string;deals:Pick<SaleDeal,'dealId'|'title'|'workspace'|'owner'|'customer'|'followDate'>[];failed?:boolean}|null>(null);
  useEffect(()=>{
    if(!visible)return;
    let active=true;setLive(null);
    api<{deals:Pick<SaleDeal,'dealId'|'title'|'workspace'|'owner'|'customer'|'followDate'>[]}>(`/api/admin/conversations/${conversationId}/sale-profile`).then(result=>{
      if(active)setLive({id:conversationId,deals:result.deals});
    }).catch(()=>{if(active)setLive({id:conversationId,deals:[],failed:true});});
    return ()=>{active=false;};
  },[conversationId,visible,revision]);
  const profile=live?.id===conversationId?live:null;
  return <div className="profile-section" aria-label="ข้อมูลฝ่ายขายจาก Sale Office"><h3><ClipboardList size={16} />Sale Office</h3><p className="sale-context-readonly"><LockKeyhole size={12} />ข้อมูลอ้างอิง · อ่านอย่างเดียว</p>
    <Button type="button" variant="ghost" size="sm" onClick={()=>setRevision(v=>v+1)}><RefreshCw size={13}/>รีเฟรชข้อมูลฝ่ายขาย</Button>
    {profile?.failed&&<p role="status">โหลดข้อมูลลูกค้าจาก Sale Office ไม่สำเร็จ</p>}
    {profile?.deals.map(deal=><dl className="sale-context" key={deal.dealId}>
      <dt>ดีลที่ผูกกับลูกค้า</dt><dd>{deal.title}</dd>
      {deal.customer&&<><dt>ลูกค้าใน Sale Office</dt><dd>{deal.customer.name||"ยังไม่ระบุ"}</dd><dt>อีเมลที่ฝ่ายขายใช้</dt><dd>{deal.customer.email||"ยังไม่ระบุ"}</dd></>}
      {deal.owner!==undefined&&<><dt>ผู้รับผิดชอบดีล</dt><dd>{deal.owner||"ยังไม่มอบหมาย"}</dd></>}
      <dt>วันติดตาม</dt><dd>{deal.followDate||"ยังไม่กำหนด"}</dd>
      <dt>แก้ไขข้อมูล</dt><dd><a href={`https://rrs-sales-office-hub.com/${deal.workspace==="domestic"?"domestic/customer?":"customer?mode=live&"}deal=${encodeURIComponent(deal.dealId)}`} target="_blank" rel="noreferrer">เปิดดีลนี้ใน Sale Office <ArrowUpRight size={12}/></a></dd>
    </dl>)}
    {!context.deals.length ? <p className="profile-placeholder">ยังไม่มีดีลที่เชื่อมกับลูกค้ารายนี้</p> : context.deals.map(deal => <dl className="sale-context" key={deal.dealId}>
      <dt>ดีล</dt><dd>{deal.title} · {deal.workspace === "domestic" ? "ในประเทศ" : "ส่งออก"}</dd>
      <dt>สถานะ</dt><dd>{deal.salesStatus || "—"}{deal.waitingLabel ? ` · ${deal.waitingLabel}` : ""}</dd>
      <dt>งานถัดไป</dt><dd>{deal.nextAction || "—"}{deal.followDate ? ` · ${deal.followDate}` : ""}</dd>
      <dt>ใบเสนอราคา</dt><dd>{deal.quotation ? `${deal.quotation.number} r${deal.quotation.revision} · ${quotationNames[deal.quotation.status] || deal.quotation.status}` : "—"}</dd>
      <dt>ใบสั่งขาย</dt><dd>{deal.salesOrder ? deal.salesOrder.number : "—"}</dd>
      <dt>การชำระเงิน</dt><dd>{deal.payments.confirmed} ยืนยันแล้ว · {deal.payments.reported} รอตรวจ</dd>
      <dt>ผลิต / ขนส่ง</dt><dd>{deal.production ? productionNames[deal.production.status] || deal.production.status : "—"} / {deal.shipment ? shipmentNames[deal.shipment.status] || deal.shipment.status : "—"}</dd>
    </dl>)}
    <p className="helper-text">{context.error ? "ซิงก์จาก Sale ล่าสุดไม่สำเร็จ ข้อมูลอาจไม่ใช่ล่าสุด" : context.syncedAt ? `ซิงก์จาก Sale ${date(context.syncedAt)}` : "ยังไม่เคยซิงก์จาก Sale"} · แก้ไขได้ใน Sale Office เท่านั้น</p>
  </div>;
}
