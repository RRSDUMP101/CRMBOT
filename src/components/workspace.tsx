"use client";

import { uiText } from "./interface-text";
import { useCallback, useEffect, useRef, useState } from "react";
import { AccountPreferences, usePreferences } from "./account-preferences";
import { subscribeCRMChanges } from './realtime';
import { ArrowUpRight, Bell, BookOpen, CalendarDays, ChartColumn, ChartNoAxesCombined, ChevronRight, CircleHelp, LayoutDashboard, LogOut, Megaphone, Menu, MessageSquare, Plus, Minus, Maximize2, RefreshCw, Settings2, ShieldCheck, Sparkles, Users, Workflow, X, Bookmark, Globe, Zap, Search } from "lucide-react";
import { Button, Card, Badge, Empty, Field, Input, RrsBrand } from "./ui";
import { api, date, number, stages, stageNames, type Member, type Snapshot } from "./data";
import { Customers, Tasks, KnowledgePanel, SettingsPanel, MembersPanel } from "./workspace-panels";
import "./sales-desk.css";
import {ChannelIcon,contactName} from './chat-brand';
import type {InboxQueue,InboxResult} from "./inbox-data";
import { InboxWorkspace } from "./inbox-workspace";
import { useFocusScope } from "./focus-scope";
import { ReplyTemplatesPanel } from "./reply-templates";
import { WidgetSettingsPanel } from "./widget-settings";
import { ReportsPanel } from "./reports-panel";
import { BroadcastPanel } from "./broadcast-panel";
import { FlowsPanel } from "./flows-panel";
import { AiLifecyclePanel } from "./ai-lifecycle-panel";
import { WhatsappTemplatesPanel } from './whatsapp-templates';
import { IntegrationsApiPanel } from './integrations-api-panel';
import { OperatorWorkspace } from './operator-workspace';
import {SystemHealthPanel} from './system-health';
import {ConnectorsPanel} from './connectors-panel';

const nav = [
  { id: "dashboard", label: "ภาพรวม", short: "ภาพรวม", icon: LayoutDashboard, group: "งานประจำวัน" },
  { id: "inbox", label: "กล่องข้อความ", short: "แชต", icon: MessageSquare, group: "งานประจำวัน" },
  { id: "customers", label: "ลูกค้าและโอกาสขาย", short: "ลูกค้า", icon: Users, group: "งานประจำวัน" },
  { id: "tasks", label: "งานติดตาม", short: "งาน", icon: CalendarDays, group: "งานประจำวัน" },
  { id: "reports", label: "รายงานและ SLA", short: "รายงาน", icon: ChartColumn, group: "งานประจำวัน" },
  { id: "templates", label: "ข้อความสำเร็จรูป", short: "ข้อความ", icon: Bookmark, group: "สื่อสารและแคมเปญ" },
  { id: "broadcast", label: "แคมเปญข้อความ", short: "แคมเปญ", icon: Megaphone, group: "สื่อสารและแคมเปญ" },
  { id: "wa-templates", label: "เทมเพลต WhatsApp", short: "เทมเพลต", icon: MessageSquare, group: "สื่อสารและแคมเปญ" },
  { id: "operators", label: "ทีมและการจัดสรรงาน", short: "ทีม", icon: Users, group: "AI และระบบอัตโนมัติ" },
  { id: "flows", label: "Flow Builder", short: "Flow", icon: Zap, group: "AI และระบบอัตโนมัติ" },
  { id: "knowledge", label: "คลังความรู้", short: "ความรู้", icon: BookOpen, group: "AI และระบบอัตโนมัติ" },
  { id: "ai-lifecycle", label: "ทดสอบและอนุมัติ AI", short: "ทดสอบ AI", icon: Sparkles, group: "AI และระบบอัตโนมัติ" },
  { id: "settings", label: "บุคลิกผู้ช่วย AI", short: "ผู้ช่วย AI", icon: Sparkles, group: "AI และระบบอัตโนมัติ" },
  { id: "integrations", label: "ช่องทางและเว็บแชต", short: "เว็บแชต", icon: Workflow, group: "ตั้งค่าและเชื่อมต่อ" },
  { id: "connectors", label: "อีเมลและร้านค้า", short: "เชื่อมต่อ", icon: Globe, group: "ตั้งค่าและเชื่อมต่อ" },
  { id: "members", label: "สมาชิกและสิทธิ์", short: "สิทธิ์", icon: ShieldCheck, group: "ตั้งค่าและเชื่อมต่อ" },
  { id: "public-api", label: "API และ Webhooks", short: "API", icon: Workflow, group: "ตั้งค่าและเชื่อมต่อ", admin: true },
  { id: "system-health", label: "สถานะซิงก์และระบบ", short: "สถานะ", icon: RefreshCw, group: "ตั้งค่าและเชื่อมต่อ", admin: true },
];
const navGroups = [...new Set(nav.map(item => item.group))];
type Bootstrap = { demo: boolean; provider: string; user: Member | null };
export type PanelProps = { data: Snapshot; reload: () => Promise<void>; notify: (text: string) => void; openLeadChat?:(leadId:string)=>void };

export default function Workspace() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const accountPrefs = usePreferences(bootstrap?.user?.id);
  const [data, setData] = useState<Snapshot | null>(null);
  const [view, setView] = useState("inbox"); const [mobile, setMobile] = useState(false);
  const [globalSearch, setGlobalSearch] = useState("");
  const [inboxSearch, setInboxSearch] = useState<{value:string;revision:number;queue?:InboxQueue}>({ value: "", revision: 0 });
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [roomRequest,setRoomRequest]=useState<{id:string;sequence:number}>();
  const [dock,setDock]=useState<'closed'|'open'|'minimized'>('closed');
  const [dueOnly,setDueOnly]=useState(false);
  const [dockTitle,setDockTitle]=useState('');
  const [dockUnread,setDockUnread]=useState(0);
  const openSequence=useRef(0);
  const navigate = useCallback((next: string) => {
    setView(next); setMobile(false);setDueOnly(false);
    const url=new URL(location.href);
    if(next!=='inbox')url.searchParams.delete('conversation');
    url.hash=next;
    if(url.toString()!==location.href)window.history.pushState(null,'',url);
    if(next==='inbox')setDock('closed');
  }, []);
  const railRef = useRef<HTMLElement>(null);
  useFocusScope(mobile, railRef, () => setMobile(false), true, "#workspace-menu-trigger");
  useEffect(() => { const resize = () => { if (window.innerWidth > 780) setMobile(false); }; window.addEventListener("resize", resize); return () => window.removeEventListener("resize", resize); }, []);
  const [error, setError] = useState(""); const [loading, setLoading] = useState(false); const [toast, setToast] = useState("");
  const [from, setFrom] = useState(new Date(Date.now() + 7 * 3600000 - 29 * 86400000).toISOString().slice(0, 10)); const [to, setTo] = useState(new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10));
  const notify = useCallback((text: string) => { setToast(text); }, []);
  const openLeadChat=async(leadId:string)=>{
    const seq=++openSequence.current;
    try{
      const find=(view:string)=>api<InboxResult>('/api/admin/inbox?'+new URLSearchParams({lead:leadId,view,limit:'1'}));
      const row=(await find('all')).items[0] || (await find('closed')).items[0];
      if(seq!==openSequence.current)return;
      if(!row){notify('ยังไม่มีห้องสนทนาของลูกค้ารายนี้');return;}
      setRoomRequest({id:row.id,sequence:seq});setDockTitle(row.leadName||'ลูกค้า');setDockUnread(row.unreadCount);setDock('open');
      const url=new URL(location.href);url.searchParams.set('conversation',row.id);
      window.history.pushState({rrsDock:true},'',url);
    }catch(e){if(seq===openSequence.current)notify((e as Error).message);}
  };
  const changeDock=(state:'closed'|'minimized')=>{
    ++openSequence.current;setDock(state);
    const url=new URL(location.href);url.searchParams.delete('conversation');
    window.history.replaceState(null,'',url);
  };
  useEffect(()=>{
    const pop=()=>{if(!window.history.state?.rrsDock)setDock('closed');};
    window.addEventListener('popstate',pop);return()=>window.removeEventListener('popstate',pop);
  },[]);
  useEffect(() => { if (toast) { const timer = setTimeout(() => setToast(""), 4500); return () => clearTimeout(timer); } }, [toast]);
  const initialize = useCallback(async () => { setError(""); try { setBootstrap(await api<Bootstrap>("/api/bootstrap")); } catch (e) { setError((e as Error).message); } }, []);
  const reload = useCallback(async () => { if (!bootstrap?.user) return; setLoading(true); try { const params = new URLSearchParams(); if (from) params.set("from", from); if (to) params.set("to", to); setData(await api<Snapshot>("/api/admin/snapshot?" + params)); setRefreshedAt(new Date()); setError(""); } catch (e) { setError((e as Error).message); } finally { setLoading(false); } }, [bootstrap?.user, from, to]);
  useEffect(() => { void initialize(); }, [initialize]);
  // The channel connection wizard returns here from the provider's consent screen.
  useEffect(() => {
    const restoreView = () => { const hash = window.location.hash.slice(1); if (hash === "social-accounts") setView("integrations"); else if (nav.some(item => item.id === hash)) setView(hash); else if(!hash)setView("inbox"); };
    restoreView(); window.addEventListener("hashchange", restoreView); return () => window.removeEventListener("hashchange", restoreView);
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(()=>bootstrap?.user?subscribeCRMChanges(()=>void reload()):undefined,[bootstrap?.user,reload]);
  useEffect(() => { if (!bootstrap?.user) return; const timer = setInterval(() => void reload(), 15000); return () => clearInterval(timer); }, [bootstrap?.user, reload]);
  if (!bootstrap) return <main className="full-state">{error ? <><h2>{uiText("เชื่อมต่อระบบไม่สำเร็จ")}</h2><p role="alert">{error}</p><Button onClick={initialize}>{uiText("ลองอีกครั้ง")}</Button></> : <><span className="spinner" /><p>{uiText("กำลังเตรียมพื้นที่ทำงาน")}</p></>}</main>;
  if (!bootstrap.user) return <Login demo={bootstrap.demo} onLogin={async () => { setData(null); await initialize(); }} />;
  const props: PanelProps | null = data ? { data, reload, notify, openLeadChat } : null;
  const active = nav.find(n => n.id === view) || nav[1];
  const visibleNav = nav.filter(item => !item.admin || bootstrap.user?.role === "Admin");
  const restricted = !!active.admin && bootstrap.user.role !== "Admin";
  return <div className={`workspace workspace-v2 rrs-workspace ${view === "inbox" ? "is-inbox" : ""}`}>
    <a className="skip-link" href="#workspace-main">{uiText("ข้ามไปยังเนื้อหา")}</a>
    {mobile && <button className="mobile-shade" aria-label={uiText("ปิดเมนู")} onClick={() => setMobile(false)} />}
    <aside ref={railRef} tabIndex={-1} role={mobile ? "dialog" : undefined} aria-modal={mobile || undefined} aria-label={uiText("เมนูพื้นที่ทำงาน")} className={`app-rail ${mobile ? "is-open" : ""}`}>
      <a href="#inbox" onClick={() => navigate("inbox")} className="rail-brand" title="RRS CRM"><RrsBrand /></a>
      <nav aria-label={uiText("เมนูหลัก")}>{navGroups.map(group => <div className="rail-group" key={group}><p className="rail-group-label">{uiText(group)}</p>{visibleNav.filter(item => item.group === group).map(item => <button key={item.id} title={uiText(item.label)} aria-current={view === item.id ? "page" : undefined} onClick={() => navigate(item.id)} className={`rail-item ${view === item.id ? "active" : ""}`}><item.icon size={20} /><span>{uiText(item.label)}</span></button>)}</div>)}</nav>
      <div className="rail-operator-links"><a href="/operators?tab=mentions">{uiText("บันทึกและการกล่าวถึง")}</a><a href="/operators?tab=fields">{uiText("ฟิลด์เพิ่มเติม")}</a></div>
      <a className="rail-sale-link" href="https://rrs-sales-office-hub.com/" target="_blank" rel="noreferrer">{uiText("เปิด Sale Office")} <ArrowUpRight size={16} /></a>
      <div className="rail-account"><span className="user-avatar">{bootstrap.user.name.slice(0, 1)}</span><div><strong>{bootstrap.user.name}</strong><small>{bootstrap.user.role === "Admin" ? uiText("ผู้ดูแลระบบ") : uiText("ทีมขาย RRS")}</small></div><button title={uiText("ออกจากระบบ")} aria-label={uiText("ออกจากระบบ")} onClick={async () => { try { await api("/api/auth/logout", {}); setData(null);setDock('closed');setRoomRequest(undefined);await initialize(); } catch (e) { setError((e as Error).message); } }}><LogOut size={18} /></button></div>
    </aside>
    <div className="workspace-body" inert={mobile || undefined}>
      <header className="workspace-topbar">
        <div className="workspace-brandline"><button id="workspace-menu-trigger" className="mobile-menu" aria-label={uiText("เปิดเมนู")} aria-expanded={mobile} onClick={() => setMobile(true)}><Menu size={21} /></button><div><small>RRS / CRM Terminal</small><strong>{uiText(active.label)}</strong></div></div>
        <form className="workspace-search" role="search" onSubmit={event => { event.preventDefault(); setInboxSearch(previous => ({ value: globalSearch.trim(), revision: previous.revision + 1 })); navigate("inbox"); }}><Search size={18} /><Input aria-label={uiText("ค้นหาลูกค้าและข้อความในกล่องข้อความ")} placeholder={uiText("ค้นหาลูกค้าหรือข้อความ…")} value={globalSearch} onChange={event => setGlobalSearch(event.target.value)} /><button type="submit" aria-label={uiText("ค้นหาในกล่องข้อความ")}><ChevronRight size={18} /></button></form>
        <div className="workspace-topbar-actions"><button className="workspace-refresh" title={uiText("รีเฟรชข้อมูลพื้นที่ทำงาน")} aria-label={uiText("รีเฟรชข้อมูลพื้นที่ทำงาน")} disabled={loading} onClick={reload}><RefreshCw size={18} className={loading ? "spin" : ""} /><span>{refreshedAt ? `${accountPrefs.preferences.language==="en"?"Updated":"อัปเดต"} ${refreshedAt.toLocaleTimeString(accountPrefs.preferences.language==="en"?"en-GB":"th-TH", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" })}` : uiText("กำลังโหลด")}</span></button>{(bootstrap.demo || bootstrap.provider === "demo") && <span className="workspace-demo-label">{uiText("ข้อมูลสาธิต")}</span>}{bootstrap.provider === "disabled" && <span className="workspace-demo-label">{uiText("AI ยังไม่เปิด")}</span>}<a href="/chat" target="_blank" rel="noreferrer" className="button button-secondary button-sm">{uiText("เปิดเว็บแชต")} <ArrowUpRight size={15} /></a></div>
        <AccountPreferences member={data?.user || bootstrap.user} {...accountPrefs}/>
      </header>
      <main id="workspace-main" tabIndex={-1} className={`main-content ${view === "inbox" ? "inbox-main" : ""}`}>
        {view !== "inbox" && <><div className="page-heading"><h1>{uiText(active.label)}</h1></div>{(bootstrap.demo || bootstrap.provider === "demo") && <div className="demo-banner"><Sparkles size={16} /><span>{bootstrap.demo ? "ฐานข้อมูลสาธิต · " : "ฐานข้อมูล PostgreSQL · "}{bootstrap.provider === "demo" ? "ใช้ตัวตอบตามกฎ ยังไม่เชื่อม LLM ภายนอก" : "เชื่อมผู้ให้บริการ AI ภายนอกผ่านเซิร์ฟเวอร์"}</span></div>}</>}
        {error && <div className="alert alert-error" role="alert">{error}<Button variant="ghost" size="sm" onClick={reload}>{uiText("ลองอีกครั้ง")}</Button></div>}
        {!data && !error && <div className="workspace-loading"><span className="spinner" /><p>{uiText("กำลังเปิดพื้นที่ทำงาน…")}</p></div>}
        {props && <div className={view==='inbox'?'crm-inbox-full':'crm-room-dock'} hidden={view!=='inbox' && dock!=='open'}>
          {view!=='inbox' && <div className="crm-dock-header"><span><MessageSquare size={16}/> {dockTitle}</span><Button variant="ghost" size="icon" aria-label="ย่อแชท" onClick={()=>changeDock('minimized')}><Minus size={16}/></Button><Button variant="ghost" size="icon" aria-label="ขยายไปกล่องข้อความ" onClick={()=>{const url=new URL(location.href);if(roomRequest?.id)url.searchParams.set('conversation',roomRequest.id);url.hash='inbox';history.pushState(null,'',url);setView('inbox');setDock('closed');}}><Maximize2 size={15}/></Button><Button variant="ghost" size="icon" aria-label="ปิดแชท" onClick={()=>changeDock('closed')}><X size={16}/></Button></div>}
          <InboxWorkspace {...props} searchRequest={inboxSearch} navigate={navigate} roomRequest={roomRequest} visible={view==='inbox'||dock==='open'} compact={view!=='inbox'} onUnread={setDockUnread} />
        </div>}
        {view!=='inbox'&&dock==='minimized'&&<button className="crm-dock-bubble" aria-label={'กลับไปตอบ '+dockTitle+' · '+dockUnread+' ข้อความยังไม่อ่าน'} onClick={()=>setDock('open')}><MessageSquare size={23}/>{dockUnread>0&&<b>{dockUnread}</b>}</button>}
        {restricted && <Card><Empty title="พื้นที่สำหรับผู้ดูแลระบบ" detail="เลือกเมนูอื่นเพื่อทำงานต่อ หรือติดต่อผู้ดูแลหากต้องการสิทธิ์เพิ่มเติม" /></Card>}{props && !restricted && <>{view === "dashboard" && <Dashboard {...props} from={from} to={to} setFrom={setFrom} setTo={setTo} navigate={navigate} openQueue={queue=>{setInboxSearch(prev=>({revision:prev.revision+1,value:"",queue}));navigate("inbox");}} openRoom={id=>{setRoomRequest({id,sequence:++openSequence.current});navigate("inbox");}} openDue={()=>{navigate("tasks");setDueOnly(true);}} />}{view === "reports" && <ReportsPanel user={data!.user} members={data!.members} />}{view === "customers" && <Customers {...props} />}{view === "tasks" && <Tasks {...props} dueOnly={dueOnly} setDueOnly={setDueOnly} />}{view === "broadcast" && <BroadcastPanel isAdmin={data!.user.role === "Admin"} />}{view === "flows" && <FlowsPanel {...props} />}{view === "templates" && <ReplyTemplatesPanel {...props} />}{view === "knowledge" && <KnowledgePanel {...props} />}{view === "ai-lifecycle" && <AiLifecyclePanel />}{view === "wa-templates" && <WhatsappTemplatesPanel isAdmin={data!.user.role === "Admin"} />}{view === "operators" && <><div className="operator-shortcuts"><a href="/operators?tab=teams" className="button button-secondary">{uiText("ทีมและเวลาทำการ")} <ArrowUpRight size={15} /></a><a href="/operators?tab=fields" className="button button-secondary">{uiText("ฟิลด์เพิ่มเติม")} <ArrowUpRight size={15} /></a><a href="/operators?tab=mentions" className="button button-secondary">{uiText("บันทึกและการกล่าวถึง")} <ArrowUpRight size={15} /></a></div><OperatorWorkspace embedded /></>}{view === "public-api" && data!.user.role === "Admin" && <IntegrationsApiPanel />}{view === "connectors" && <ConnectorsPanel />}{view === "system-health" && data!.user.role === "Admin" && <SystemHealthPanel />}{view === "settings" && <><SettingsPanel {...props} /><Card className="rrs-optional-integration"><div><Badge>F26 · ส่วนเสริม</Badge><h2>REA ยังไม่ได้เชื่อมต่อ</h2><p>ระบบ CRM และ Sale Office ใช้งานได้ตามปกติ การวิเคราะห์เพิ่มเติมด้วย REA ยังไม่มีการเชื่อมต่อที่ได้รับอนุญาต</p></div><Button disabled>{uiText("ยังไม่เปิดใช้งาน")}</Button></Card></>}{view === "members" && <MembersPanel {...props} />}{view === "integrations" && <WidgetSettingsPanel isAdmin={data!.user.role === "Admin"} />}</>}
      </main>{view !== "inbox" && <footer className="workspace-footer">RRS Connect <span>{uiText("เขตเวลา Asia/Bangkok (UTC+7)")}</span></footer>}
    </div><nav className="mobile-bottom-nav" aria-label={uiText("เมนูมือถือ")} inert={mobile || undefined}>{["inbox", "tasks", "customers"].map(id => { const item = nav.find(item => item.id === id)!; return <button key={id} aria-current={view === id ? "page" : undefined} onClick={() => navigate(id)}><item.icon size={21} /><span>{uiText(item.short)}</span></button>; })}<button onClick={() => setMobile(true)} aria-label={uiText("เปิดเมนูทั้งหมด")}><Menu size={21} /><span>{uiText("เพิ่มเติม")}</span></button></nav>{toast && <div className="toast" role="status"><ShieldCheck size={18} />{toast}<button onClick={() => setToast("")} aria-label="ปิดข้อความ"><X size={14} /></button></div>}
  </div>;
}

function Login({ demo, onLogin }: { demo: boolean; onLogin: () => Promise<void> }) {
  const [email, setEmail] = useState(demo ? "admin@rrs.demo" : ""); const [password, setPassword] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  return <main className="login-page login-v2"><section className="login-story"><div className="brand"><RrsBrand /></div><div className="login-message"><span className="login-symbol"><MessageSquare size={28} /></span><h1>ดูแลทุกบทสนทนา<br />พาลูกค้าไปต่อได้ง่ายขึ้น</h1><p>ทีมขาย ผู้ช่วย AI และข้อมูลลูกค้า<br />เชื่อมกันในพื้นที่ทำงานเดียว</p><div className="login-pills"><span><MessageSquare size={17} />ประวัติแชตครบในที่เดียว</span><span><Users size={17} />รับช่วงดูแลได้ทันที</span><span><ChartNoAxesCombined size={17} />ติดตามผลจากข้อมูลจริง</span></div></div><small>สำหรับรุ่งเรืองดั๊มพ์ 101 · ไทยและตลาดส่งออก</small></section><section className="login-form"><div className="login-form-inner"><Badge tone="green">พื้นที่ทำงานสำหรับทีม</Badge><h2>{uiText("ยินดีต้อนรับกลับมา")}</h2><p>เข้าสู่ระบบเพื่อดูแลลูกค้าและติดตามโอกาสขาย</p><form onSubmit={async e => { e.preventDefault(); setBusy(true); setError(""); try { await api("/api/auth/login", { username: email, password }); await onLogin(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } }}><Field label={uiText("ชื่อผู้ใช้หรืออีเมล")}><Input type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} required value={email} onChange={e => setEmail(e.target.value)} /></Field><Field label={uiText("รหัสผ่าน")}><Input type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></Field>{error && <div className="alert alert-error" role="alert">{error}</div>}<Button disabled={busy} type="submit" className="full-width">{busy ? "กำลังเข้าสู่ระบบ…" : "เข้าสู่พื้นที่ทำงาน"}<ArrowUpRight size={18} /></Button></form>{demo && <div className="demo-login"><strong>บัญชีสำหรับฐานข้อมูลสาธิต</strong><p>Admin: admin@rrs.demo<br />Agent: agent@rrs.demo<br />รหัสผ่าน: <code>Demo-only-2026!</code></p><Button variant="secondary" size="sm" onClick={() => setPassword("Demo-only-2026!")}>กรอกรหัสผ่านสาธิต</Button></div>}<a href="/chat" className="text-link">เปิดแชตในมุมมองลูกค้า <ArrowUpRight size={15} /></a></div></section></main>;
}
function auditActionLabel(action: string, metadata?: Record<string, unknown>) {
  const key = action.split(" ")[0];
  if (key === "updateLead" && metadata?.previousStage !== metadata?.nextStage) return "เปลี่ยนสถานะลูกค้า";
  const labels: Record<string, string> = {
    "conversation.reply": "ส่งข้อความถึงลูกค้า", "conversation.note": "บันทึกภายใน",
    "conversation.claim": "รับช่วงสนทนา", "conversation.release": "ส่งกลับให้ผู้ช่วย AI",
    "conversation.resolve": "จบการสนทนา", "conversation.handoff": "ส่งต่อเจ้าหน้าที่",
    "conversation.summarize": "สรุปความต้องการ", "lead.contact": "บันทึกข้อมูลติดต่อ",
    "widget.updated": "ปรับตั้งค่าวิดเจ็ต", "report.exported": "ส่งออกรายงาน", updateLead: "อัปเดตข้อมูลลูกค้า",
    saveReplyTemplate: "บันทึกข้อความสำเร็จรูป", deleteReplyTemplate: "ลบข้อความสำเร็จรูป",
    createTask: "สร้างงานติดตาม", updateTask: "อัปเดตงานหรือนัดหมาย",
    saveKnowledge: "บันทึกคลังความรู้", deleteKnowledge: "ลบเนื้อหาความรู้",
    updateSettings: "ปรับตั้งค่าผู้ช่วย AI", createMember: "เพิ่มสมาชิกทีม",
    updateMember: "อัปเดตบัญชีสมาชิก", revokeMemberSessions: "ให้สมาชิกออกจากระบบทุกอุปกรณ์",
    "flow.created": "สร้างระบบอัตโนมัติ", "flow.draft_saved": "บันทึกร่างระบบอัตโนมัติ", "flow.published": "เผยแพร่ระบบอัตโนมัติ",
    "flow.paused": "หยุดระบบอัตโนมัติชั่วคราว", "flow.resumed": "เปิดระบบอัตโนมัติต่อ", "flow.global_paused": "หยุดฉุกเฉินระบบอัตโนมัติทั้งหมด",
    "flow.global_resumed": "เปิดระบบอัตโนมัติทั้งหมดต่อ", "flow.execution_cancelled": "ยกเลิกการทำงานอัตโนมัติ", "flow.send_queued": "ระบบอัตโนมัติเข้าคิวส่งข้อความ",
    "flow.handoff_requested": "ระบบอัตโนมัติส่งต่อเจ้าหน้าที่", "flow.conversation_closed": "ระบบอัตโนมัติปิดบทสนทนา", "flow.conversation_reopened": "ระบบอัตโนมัติเปิดบทสนทนา",
  };
  return uiText(labels[key] || "อัปเดตข้อมูลในระบบ");
}
function Dashboard({ data, from, to, setFrom, setTo, navigate, openQueue, openDue, openRoom }: PanelProps & { openRoom:(id:string)=>void;openQueue:(q:InboxQueue)=>void;openDue:()=>void; from: string; to: string; setFrom: (v: string) => void; setTo: (v: string) => void; navigate: (v: string) => void }) {
  const [rooms,setRooms]=useState<InboxResult>();
  const counts=rooms?.counts;
  useEffect(()=>{let live=true;api<InboxResult>('/api/admin/inbox?view=all&limit=3').then(value=>{if(live)setRooms(value);}).catch(()=>{if(live)setRooms(undefined);});return()=>{live=false;};},[data]);
  const m = data.metrics; const totalStages = Object.values(m.stages).reduce((a, b) => a + b, 0); const due = data.tasks.filter(t => ["open", "pending", "confirmed"].includes(t.status) && new Date(t.dueAt) <= new Date());
  const cards = [{ title: "บทสนทนา", value: number(m.conversations), icon: MessageSquare, caption: "เริ่มสนทนาในช่วงวันที่เลือก", accent: "teal" }, { title: "ลีดใหม่", value: number(m.newLeads), icon: Users, caption: "สร้างเมื่อเริ่มแชต ยังไม่ใช่ลีดที่คัดกรองแล้ว", accent: "blue" }, { title: "งานถึงกำหนด", value: number(m.dueTasks), icon: CalendarDays, caption: "งานค้างที่ถึงกำหนดแล้ว", accent: "amber" }, { title: "ส่งต่อเจ้าหน้าที่", value: number(m.handoffRate * 100) + "%", icon: Workflow, caption: "สัดส่วนบทสนทนาที่ขอส่งต่อ", accent: "purple" }];
  return <><div className="desk-today" aria-label={uiText("คิวที่เปิดทำต่อได้")}>{([['waiting','รอเจ้าหน้าที่'],['mine','งานของฉัน'],['unread','ยังไม่อ่าน']] as const).map(([queue,label])=><button key={queue} onClick={()=>openQueue(queue)}><span>{uiText(label)}</span><b>{counts?number(counts[queue]):'—'}</b><ChevronRight size={16}/></button>)}<button onClick={openDue}><span>{uiText("งานถึงกำหนด")}</span><b>{number(due.length)}</b><ChevronRight size={16}/></button></div><div className="filter-row"><span><span className="status-dot" />{uiText("ข้อมูลจากกิจกรรมจริงในระบบ")}</span><div className="date-filters"><label>{uiText("ตั้งแต่")} <Input type="date" value={from} onChange={e => setFrom(e.target.value)} aria-label={uiText("วันที่เริ่มต้น")} /></label><span>—</span><label>{uiText("ถึง")} <Input type="date" value={to} min={from || undefined} onChange={e => setTo(e.target.value)} aria-label={uiText("วันที่สิ้นสุด")} /></label>{(from || to) && <Button variant="ghost" size="sm" onClick={() => { setFrom(new Date(Date.now() + 7 * 3600000 - 29 * 86400000).toISOString().slice(0, 10)); setTo(new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10)); }}>{uiText("30 วันล่าสุด")}</Button>}</div></div><div className="stats-grid">{cards.map(c => <Card className="stat-card" key={c.title}><div className="stat-top"><span>{uiText(c.title)}</span><span className={`stat-icon icon-${c.accent}`}><c.icon size={20} /></span></div><strong className="stat-number">{c.value}</strong><small>{uiText(c.caption)}</small></Card>)}</div>
  <div className="dashboard-grid"><Card className="pipeline-card"><div className="card-heading"><div><h2>{uiText("ภาพรวม Pipeline")}</h2><p>{uiText("สถานะปัจจุบันของลีดที่สร้างในช่วงวันที่เลือก")}</p></div><Badge>{number(totalStages)} {uiText("ลีด")}</Badge></div><div className="pipeline-chart">{stages.map((s, i) => <div className="pipeline-chart-row" key={s}><span><i style={{ background: ["#91b9c4", "#51a4a5", "#20877c", "#0c6455", "#b8bfc5"][i] }} />{uiText(stageNames[s])}</span><div className="bar-track"><div style={{ width: totalStages ? `${Math.max(((m.stages[s] || 0) / totalStages) * 100, (m.stages[s] || 0) ? 4 : 0)}%` : "0%", background: ["#91b9c4", "#51a4a5", "#20877c", "#0c6455", "#b8bfc5"][i] }} /></div><b>{m.stages[s] || 0}</b></div>)}</div><button className="card-link" onClick={() => navigate("customers")}>{uiText("จัดการโอกาสขาย")} <ArrowUpRight size={16} /></button></Card><Card className="response-card"><div className="card-heading"><div><h2>{uiText("คุณภาพการตอบกลับ")}</h2><p>{uiText("เวลาเฉลี่ยจนได้รับคำตอบแรก")}</p></div><Sparkles size={19} /></div><div className="response-metric"><span>{uiText("ผู้ช่วย AI")}</span><strong>{m.aiFirstResponseMs == null ? "—" : number(m.aiFirstResponseMs / 1000)}<small> {uiText("วินาที")}</small></strong></div><div className="response-metric"><span>{uiText("เจ้าหน้าที่หลังส่งต่อ")}</span><strong>{m.humanFirstResponseMs == null ? "—" : number(m.humanFirstResponseMs / 1000)}<small> {uiText("วินาที")}</small></strong></div><p className="metric-help">{uiText("ไม่นับสถานะกำลังตอบและบันทึกภายใน หากยังไม่มีคำตอบจะแสดง —")}</p><div className="usage-box"><span>{uiText("ค่าใช้จ่าย AI โดยประมาณ")}</span><strong>{m.estimatedCostUsd == null ? uiText("ไม่มีข้อมูล") : `$${m.estimatedCostUsd.toFixed(4)}`}</strong><small>Input {number(m.inputTokens)} · Output {number(m.outputTokens)} tokens</small></div></Card></div>
  <Card className="desk-recent-inbox"><div className="card-heading"><h2>{uiText("กล่องข้อความ")}</h2><Button variant="ghost" size="sm" onClick={()=>openQueue('all')}>{uiText("เปิดกล่องข้อความ")}</Button></div>{rooms?.items.map(room=><button type="button" key={room.id} className="desk-recent-room" onClick={()=>openRoom(room.id)}><ChannelIcon provider={room.provider}/><span><strong>{contactName(room.leadName)}</strong><small>{room.lastMessage||uiText("ยังไม่มีข้อความ")}</small></span><time>{date(room.updatedAt)}</time></button>)}{!rooms?.items.length&&<p>{rooms?uiText("ยังไม่มีบทสนทนาที่เปิดอยู่"):uiText("ยังไม่มีข้อมูลกล่องข้อความ")}</p>}</Card>
  <div className="dashboard-grid"><Card><div className="card-heading"><div><h2>{uiText("งานที่ต้องดูแล")}</h2><p>{uiText("ช่วยให้ไม่มีลูกค้าตกหล่น")}</p></div><Button variant="ghost" size="sm" onClick={() => navigate("tasks")}>{uiText("ดูทั้งหมด")} <ChevronRight size={15} /></Button></div>{due.length ? <div className="activity-list">{due.slice(0, 5).map(t => <div className="activity-row" key={t.id}><span className="activity-icon"><CalendarDays size={17} /></span><div><strong>{t.title}</strong><small>{data.leads.find(l => l.id === t.leadId)?.name || uiText("ลูกค้าใหม่")} · {date(t.dueAt)}</small></div><Badge tone="amber">{uiText("ถึงกำหนด")}</Badge></div>)}</div> : <Empty title={uiText("ยังไม่มีงานถึงกำหนด")} detail={uiText("งานติดตามที่ครบกำหนดจะแสดงที่นี่")} />}</Card><Card><div className="card-heading"><div><h2>{uiText("กิจกรรมล่าสุด")}</h2><p>{uiText("ประวัติการเปลี่ยนแปลงในองค์กร")}</p></div><Bell size={18} /></div>{data.audit.length ? <div className="activity-list">{data.audit.slice(0, 5).map(a => <div className="activity-row" key={a.id}><span className="activity-dot" /><div><strong>{auditActionLabel(a.action, a.metadata)}</strong><small>{date(a.createdAt)} · {data.members.find(m => m.id === a.actorId)?.name || uiText("ระบบ / ลูกค้า")}</small>{a.metadata?.previousStage !== undefined && <small>{uiText(stageNames[String(a.metadata.previousStage)]) || String(a.metadata.previousStage)} → {uiText(stageNames[String(a.metadata.nextStage)]) || String(a.metadata.nextStage)}</small>}{Array.isArray(a.metadata?.fields) && <small>{uiText("ข้อมูลที่แก้:")} {(a.metadata.fields as string[]).join(", ")}</small>}</div></div>)}</div> : <Empty title={uiText("ยังไม่มีกิจกรรม")} detail={uiText("เริ่มแชตหรืออัปเดตลูกค้าเพื่อดูความเคลื่อนไหว")} />}</Card></div><details className="definitions"><summary><CircleHelp size={16} />{uiText("นิยามตัวชี้วัดและช่วงเวลา")}</summary><p>วันที่เริ่มต้นและสิ้นสุดนับทั้งวันตาม Asia/Bangkok บทสนทนาและลีดใหม่กรองตามวันที่สร้าง Pipeline แสดงสถานะปัจจุบันของลีดในกลุ่มที่เลือก งานถึงกำหนดนับงานที่ยังเปิด รวมถึงนัดที่รอยืนยันหรือยืนยันแล้วและถึงกำหนด ณ เวลาปัจจุบัน ทุกช่วงวันที่ ลีดใหม่หมายถึงโปรไฟล์ที่สร้างเมื่อเริ่มแชต ซึ่งอาจยังไม่มีข้อมูลติดต่อ อัตราส่งต่อคือจำนวนบทสนทนาที่เคยส่งต่อหารด้วยบทสนทนาในกลุ่มที่เลือก เวลาตอบ AI นับจากรับข้อความจนเริ่มส่งคำตอบจริง ส่วนเจ้าหน้าที่นับจากส่งต่อจนเจ้าหน้าที่ตอบครั้งแรก ค่าโทเคนและค่าใช้จ่ายจะแสดงเมื่อผู้ให้บริการส่งข้อมูลกลับมาเท่านั้น</p></details></>;
}
