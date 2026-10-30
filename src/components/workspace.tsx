"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeCRMChanges } from './realtime';
import { ArrowUpRight, Bell, BookOpen, CalendarDays, ChartNoAxesCombined, ChevronRight, CircleHelp, LayoutDashboard, LogOut, Menu, MessageSquare, Plus, RefreshCw, Settings2, ShieldCheck, Sparkles, Users, Workflow, X, Bookmark, Globe, Zap } from "lucide-react";
import { Button, Card, Badge, Empty, Field, Input } from "./ui";
import { api, date, number, stages, stageNames, type Member, type Snapshot } from "./data";
import { Customers, Tasks, KnowledgePanel, SettingsPanel, MembersPanel } from "./workspace-panels";
import { InboxWorkspace } from "./inbox-workspace";
import { useFocusScope } from "./focus-scope";
import { ReplyTemplatesPanel } from "./reply-templates";
import { WidgetSettingsPanel } from "./widget-settings";
import { FlowsPanel } from "./flows-panel";

const nav = [
  { id: "inbox", label: "กล่องข้อความ", short: "แชต", icon: MessageSquare },
  { id: "customers", label: "ลูกค้าและโอกาสขาย", short: "ลูกค้า", icon: Users },
  { id: "tasks", label: "งานและนัดหมาย", short: "ติดตาม", icon: CalendarDays },
  { id: "dashboard", label: "รายงานภาพรวม", short: "รายงาน", icon: ChartNoAxesCombined },
  { id: "templates", label: "ข้อความสำเร็จรูป", short: "ข้อความ", icon: Bookmark },
  { id: "flows", label: "ระบบอัตโนมัติ", short: "อัตโนมัติ", icon: Zap },
  { id: "knowledge", label: "คลังความรู้", short: "ความรู้", icon: BookOpen },
  { id: "settings", label: "ตั้งค่าผู้ช่วย AI", short: "ผู้ช่วย AI", icon: Sparkles },
  { id: "members", label: "สมาชิกและสิทธิ์", short: "ทีม", icon: ShieldCheck },
  { id: "integrations", label: "เว็บไซต์และช่องทาง", short: "เว็บแชต", icon: Workflow },
];
type Bootstrap = { demo: boolean; provider: string; user: Member | null };
export type PanelProps = { data: Snapshot; reload: () => Promise<void>; notify: (text: string) => void };

export default function Workspace() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [data, setData] = useState<Snapshot | null>(null);
  const [view, setView] = useState("inbox"); const [mobile, setMobile] = useState(false);
  const railRef = useRef<HTMLElement>(null);
  useFocusScope(mobile, railRef, () => setMobile(false), true, "#workspace-menu-trigger");
  useEffect(() => { const resize = () => { if (window.innerWidth > 780) setMobile(false); }; window.addEventListener("resize", resize); return () => window.removeEventListener("resize", resize); }, []);
  const [error, setError] = useState(""); const [loading, setLoading] = useState(false); const [toast, setToast] = useState("");
  const [from, setFrom] = useState(new Date(Date.now() + 7 * 3600000 - 29 * 86400000).toISOString().slice(0, 10)); const [to, setTo] = useState(new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10));
  const notify = useCallback((text: string) => { setToast(text); }, []);
  useEffect(() => { if (toast) { const timer = setTimeout(() => setToast(""), 4500); return () => clearTimeout(timer); } }, [toast]);
  const initialize = useCallback(async () => { setError(""); try { setBootstrap(await api<Bootstrap>("/api/bootstrap")); } catch (e) { setError((e as Error).message); } }, []);
  const reload = useCallback(async () => { if (!bootstrap?.user) return; setLoading(true); try { const params = new URLSearchParams(); if (from) params.set("from", from); if (to) params.set("to", to); setData(await api<Snapshot>("/api/admin/snapshot?" + params)); setError(""); } catch (e) { setError((e as Error).message); } finally { setLoading(false); } }, [bootstrap?.user, from, to]);
  useEffect(() => { void initialize(); }, [initialize]);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(()=>bootstrap?.user?subscribeCRMChanges(()=>void reload()):undefined,[bootstrap?.user,reload]);
  useEffect(() => { if (!bootstrap?.user) return; const timer = setInterval(() => void reload(), 15000); return () => clearInterval(timer); }, [bootstrap?.user, reload]);
  if (!bootstrap) return <main className="full-state">{error ? <><h2>เชื่อมต่อระบบไม่สำเร็จ</h2><p role="alert">{error}</p><Button onClick={initialize}>ลองอีกครั้ง</Button></> : <><span className="spinner" /><p>กำลังเตรียมพื้นที่ทำงาน</p></>}</main>;
  if (!bootstrap.user) return <Login demo={bootstrap.demo} onLogin={async () => { setData(null); await initialize(); }} />;
  const props: PanelProps | null = data ? { data, reload, notify } : null;
  const active = nav.find(n => n.id === view)!;
  return <div className={`workspace workspace-v2 ${view === "inbox" ? "is-inbox" : ""}`}>
    {mobile && <button className="mobile-shade" aria-label="ปิดเมนู" onClick={() => setMobile(false)} />}
    <aside ref={railRef} tabIndex={-1} role={mobile ? "dialog" : undefined} aria-modal={mobile || undefined} aria-label="เมนูพื้นที่ทำงาน" className={`app-rail ${mobile ? "is-open" : ""}`}>
      <a href="/" className="rail-brand" title="RRS Connect"><span>R</span><small>RRS</small></a>
      <nav aria-label="เมนูหลัก">{nav.map((item, index) => <div key={item.id}>{item.id === "knowledge" && <div className="rail-divider"><span>AI</span></div>}{item.id === "members" && <div className="rail-divider" />}<button title={item.label} aria-label={item.label} aria-current={view === item.id ? "page" : undefined} onClick={() => { setView(item.id); setMobile(false); }} className={`rail-item ${view === item.id ? "active" : ""}`}><item.icon size={21} /><span>{item.short}</span></button></div>)}</nav>
      <div className="rail-account"><span className="user-avatar" title={`${bootstrap.user.name} · ${bootstrap.user.role}`}>{bootstrap.user.name.slice(0, 1)}</span><button title="ออกจากระบบ" aria-label="ออกจากระบบ" onClick={async () => { try { await api("/api/auth/logout", {}); setData(null); await initialize(); } catch (e) { setError((e as Error).message); } }}><LogOut size={18} /></button></div>
    </aside>
    <div className="workspace-body" inert={mobile || undefined}><header className="workspace-topbar"><div className="workspace-brandline"><button id="workspace-menu-trigger" className="mobile-menu" aria-label="เปิดเมนู" onClick={() => setMobile(true)}><Menu size={21} /></button><strong>RRS Connect</strong><span className="topbar-divider" /><span>รุ่งเรืองดั๊มพ์ 101</span></div><div className="workspace-topbar-actions"><Badge tone="green"><Globe size={12} />เว็บไซต์</Badge>{(bootstrap.demo || bootstrap.provider === "demo") && <span className="workspace-demo-label" title={bootstrap.provider === "demo" ? "ตัวตอบตามกฎ ยังไม่เชื่อม LLM ภายนอก" : "เชื่อม AI ภายนอก ใช้ฐานข้อมูลสาธิต"}>{bootstrap.provider === "demo" ? "Demo · AI จำลอง" : "ฐานข้อมูลสาธิต"}</span>}{bootstrap.provider === "disabled" && <span className="workspace-demo-label">แชตกับทีมงาน · AI ยังไม่เปิด</span>}<a href="/chat" target="_blank" rel="noreferrer" className="button button-secondary button-sm">เปิดแชตลูกค้า <ArrowUpRight size={15} /></a></div></header>
      <main className={`main-content ${view === "inbox" ? "inbox-main" : ""}`}>
        {view !== "inbox" && <><div className="page-heading"><div><h1>{active.label}</h1><p>{view === "dashboard" ? "ติดตามทุกบทสนทนาและโอกาสขาย ด้วยข้อมูลจริงของทีม" : view === "templates" ? "คำตอบที่ใช้บ่อย ช่วยทีมตอบได้เร็วและสม่ำเสมอ" : view === "flows" ? "ติดแท็ก มอบหมาย สร้างงาน และส่งข้อความตามเงื่อนไข ทดสอบก่อนเผยแพร่ทุกครั้ง" : "จัดการข้อมูลของทีมในที่เดียว"}</p></div><Button variant="secondary" size="sm" disabled={loading} onClick={reload}><RefreshCw size={15} className={loading ? "spin" : ""} />รีเฟรช</Button></div>{(bootstrap.demo || bootstrap.provider === "demo") && <div className="demo-banner"><Sparkles size={16} /><span>{bootstrap.demo ? "ฐานข้อมูลสาธิต · " : "ฐานข้อมูล PostgreSQL · "}{bootstrap.provider === "demo" ? "ใช้ตัวตอบตามกฎ ยังไม่เชื่อม LLM ภายนอก" : "เชื่อมผู้ให้บริการ AI ภายนอกผ่านเซิร์ฟเวอร์"}</span></div>}</>}
        {error && <div className="alert alert-error" role="alert">{error}<Button variant="ghost" size="sm" onClick={reload}>ลองอีกครั้ง</Button></div>}
        {!data && !error && <div className="workspace-loading"><span className="spinner" /><p>กำลังเปิดพื้นที่ทำงาน…</p></div>}
        {props && <>{view === "inbox" && <InboxWorkspace {...props} />}{view === "dashboard" && <Dashboard {...props} from={from} to={to} setFrom={setFrom} setTo={setTo} navigate={setView} />}{view === "customers" && <Customers {...props} />}{view === "tasks" && <Tasks {...props} />}{view === "templates" && <ReplyTemplatesPanel {...props} />}{view === "flows" && <FlowsPanel {...props} />}{view === "knowledge" && <KnowledgePanel {...props} />}{view === "settings" && <SettingsPanel {...props} />}{view === "members" && <MembersPanel {...props} />}{view === "integrations" && <WidgetSettingsPanel isAdmin={data!.user.role === "Admin"} />}</>}
      </main>{view !== "inbox" && <footer className="workspace-footer">RRS Connect <span>เขตเวลา Asia/Bangkok (UTC+7)</span></footer>}
    </div>{toast && <div className="toast" role="status"><ShieldCheck size={18} />{toast}<button onClick={() => setToast("")} aria-label="ปิดข้อความ"><X size={14} /></button></div>}
  </div>;
}

function Login({ demo, onLogin }: { demo: boolean; onLogin: () => Promise<void> }) {
  const [email, setEmail] = useState(demo ? "admin@rrs.demo" : ""); const [password, setPassword] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  return <main className="login-page login-v2"><section className="login-story"><div className="brand"><span className="brand-mark">R</span><span>RRS <b>Connect</b><small>พื้นที่ทำงานทีมขาย</small></span></div><div className="login-message"><span className="login-symbol"><MessageSquare size={28} /></span><h1>ดูแลทุกบทสนทนา<br />พาลูกค้าไปต่อได้ง่ายขึ้น</h1><p>ทีมขาย ผู้ช่วย AI และข้อมูลลูกค้า<br />เชื่อมกันในพื้นที่ทำงานเดียว</p><div className="login-pills"><span><MessageSquare size={17} />ประวัติแชตครบในที่เดียว</span><span><Users size={17} />รับช่วงดูแลได้ทันที</span><span><ChartNoAxesCombined size={17} />ติดตามผลจากข้อมูลจริง</span></div></div><small>สำหรับรุ่งเรืองดั๊มพ์ 101 · ไทยและตลาดส่งออก</small></section><section className="login-form"><div className="login-form-inner"><Badge tone="green">พื้นที่ทำงานสำหรับทีม</Badge><h2>ยินดีต้อนรับกลับมา</h2><p>เข้าสู่ระบบเพื่อดูแลลูกค้าและติดตามโอกาสขาย</p><form onSubmit={async e => { e.preventDefault(); setBusy(true); setError(""); try { await api("/api/auth/login", { username: email, password }); await onLogin(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } }}><Field label="ชื่อผู้ใช้หรืออีเมล"><Input type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} required value={email} onChange={e => setEmail(e.target.value)} /></Field><Field label="รหัสผ่าน"><Input type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></Field>{error && <div className="alert alert-error" role="alert">{error}</div>}<Button disabled={busy} type="submit" className="full-width">{busy ? "กำลังเข้าสู่ระบบ…" : "เข้าสู่พื้นที่ทำงาน"}<ArrowUpRight size={18} /></Button></form>{demo && <div className="demo-login"><strong>บัญชีสำหรับฐานข้อมูลสาธิต</strong><p>Admin: admin@rrs.demo<br />Agent: agent@rrs.demo<br />รหัสผ่าน: <code>Demo-only-2026!</code></p><Button variant="secondary" size="sm" onClick={() => setPassword("Demo-only-2026!")}>กรอกรหัสผ่านสาธิต</Button></div>}<a href="/chat" className="text-link">เปิดแชตในมุมมองลูกค้า <ArrowUpRight size={15} /></a></div></section></main>;
}
function auditActionLabel(action: string, metadata?: Record<string, unknown>) {
  const key = action.split(" ")[0];
  if (key === "updateLead" && metadata?.previousStage !== metadata?.nextStage) return "เปลี่ยนสถานะลูกค้า";
  const labels: Record<string, string> = {
    "conversation.reply": "ส่งข้อความถึงลูกค้า", "conversation.note": "บันทึกภายใน",
    "conversation.claim": "รับช่วงสนทนา", "conversation.release": "ส่งกลับให้ผู้ช่วย AI",
    "conversation.resolve": "จบการสนทนา", "conversation.handoff": "ส่งต่อเจ้าหน้าที่",
    "conversation.summarize": "สรุปความต้องการ", "lead.contact": "บันทึกข้อมูลติดต่อ",
    "widget.updated": "ปรับตั้งค่าวิดเจ็ต", updateLead: "อัปเดตข้อมูลลูกค้า",
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
  return labels[key] || "อัปเดตข้อมูลในระบบ";
}
function Dashboard({ data, from, to, setFrom, setTo, navigate }: PanelProps & { from: string; to: string; setFrom: (v: string) => void; setTo: (v: string) => void; navigate: (v: string) => void }) {
  const m = data.metrics; const totalStages = Object.values(m.stages).reduce((a, b) => a + b, 0); const due = data.tasks.filter(t => ["open", "pending", "confirmed"].includes(t.status) && new Date(t.dueAt) <= new Date());
  const cards = [{ title: "บทสนทนา", value: number(m.conversations), icon: MessageSquare, caption: "เริ่มสนทนาในช่วงวันที่เลือก", accent: "teal" }, { title: "ลีดใหม่", value: number(m.newLeads), icon: Users, caption: "สร้างเมื่อเริ่มแชต ยังไม่ใช่ลีดที่คัดกรองแล้ว", accent: "blue" }, { title: "งานถึงกำหนด", value: number(m.dueTasks), icon: CalendarDays, caption: "งานค้างที่ถึงกำหนดแล้ว", accent: "amber" }, { title: "ส่งต่อเจ้าหน้าที่", value: number(m.handoffRate * 100) + "%", icon: Workflow, caption: "สัดส่วนบทสนทนาที่ขอส่งต่อ", accent: "purple" }];
  return <><div className="filter-row"><span><span className="status-dot" />ข้อมูลจากกิจกรรมจริงในระบบ</span><div className="date-filters"><label>ตั้งแต่ <Input type="date" value={from} onChange={e => setFrom(e.target.value)} aria-label="วันที่เริ่มต้น" /></label><span>—</span><label>ถึง <Input type="date" value={to} min={from || undefined} onChange={e => setTo(e.target.value)} aria-label="วันที่สิ้นสุด" /></label>{(from || to) && <Button variant="ghost" size="sm" onClick={() => { setFrom(new Date(Date.now() + 7 * 3600000 - 29 * 86400000).toISOString().slice(0, 10)); setTo(new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10)); }}>30 วันล่าสุด</Button>}</div></div><div className="stats-grid">{cards.map(c => <Card className="stat-card" key={c.title}><div className="stat-top"><span>{c.title}</span><span className={`stat-icon icon-${c.accent}`}><c.icon size={20} /></span></div><strong className="stat-number">{c.value}</strong><small>{c.caption}</small></Card>)}</div>
  <div className="dashboard-grid"><Card className="pipeline-card"><div className="card-heading"><div><h2>ภาพรวม Pipeline</h2><p>สถานะปัจจุบันของลีดที่สร้างในช่วงวันที่เลือก</p></div><Badge>{number(totalStages)} ลีด</Badge></div><div className="pipeline-chart">{stages.map((s, i) => <div className="pipeline-chart-row" key={s}><span><i style={{ background: ["#91b9c4", "#51a4a5", "#20877c", "#0c6455", "#b8bfc5"][i] }} />{stageNames[s]}</span><div className="bar-track"><div style={{ width: totalStages ? `${Math.max(((m.stages[s] || 0) / totalStages) * 100, (m.stages[s] || 0) ? 4 : 0)}%` : "0%", background: ["#91b9c4", "#51a4a5", "#20877c", "#0c6455", "#b8bfc5"][i] }} /></div><b>{m.stages[s] || 0}</b></div>)}</div><button className="card-link" onClick={() => navigate("customers")}>จัดการโอกาสขาย <ArrowUpRight size={16} /></button></Card><Card className="response-card"><div className="card-heading"><div><h2>คุณภาพการตอบกลับ</h2><p>เวลาเฉลี่ยจนได้รับคำตอบแรก</p></div><Sparkles size={19} /></div><div className="response-metric"><span>ผู้ช่วย AI</span><strong>{m.aiFirstResponseMs == null ? "—" : number(m.aiFirstResponseMs / 1000)}<small> วินาที</small></strong></div><div className="response-metric"><span>เจ้าหน้าที่หลังส่งต่อ</span><strong>{m.humanFirstResponseMs == null ? "—" : number(m.humanFirstResponseMs / 1000)}<small> วินาที</small></strong></div><p className="metric-help">ไม่นับสถานะกำลังตอบและบันทึกภายใน หากยังไม่มีคำตอบจะแสดง —</p><div className="usage-box"><span>ค่าใช้จ่าย AI โดยประมาณ</span><strong>{m.estimatedCostUsd == null ? "ไม่มีข้อมูล" : `$${m.estimatedCostUsd.toFixed(4)}`}</strong><small>Input {number(m.inputTokens)} · Output {number(m.outputTokens)} tokens</small></div></Card></div>
  <div className="dashboard-grid"><Card><div className="card-heading"><div><h2>งานที่ต้องดูแล</h2><p>ช่วยให้ไม่มีลูกค้าตกหล่น</p></div><Button variant="ghost" size="sm" onClick={() => navigate("tasks")}>ดูทั้งหมด <ChevronRight size={15} /></Button></div>{due.length ? <div className="activity-list">{due.slice(0, 5).map(t => <div className="activity-row" key={t.id}><span className="activity-icon"><CalendarDays size={17} /></span><div><strong>{t.title}</strong><small>{data.leads.find(l => l.id === t.leadId)?.name || "ลูกค้าใหม่"} · {date(t.dueAt)}</small></div><Badge tone="amber">ถึงกำหนด</Badge></div>)}</div> : <Empty title="ยังไม่มีงานถึงกำหนด" detail="งานติดตามที่ครบกำหนดจะแสดงที่นี่" />}</Card><Card><div className="card-heading"><div><h2>กิจกรรมล่าสุด</h2><p>ประวัติการเปลี่ยนแปลงในองค์กร</p></div><Bell size={18} /></div>{data.audit.length ? <div className="activity-list">{data.audit.slice(0, 5).map(a => <div className="activity-row" key={a.id}><span className="activity-dot" /><div><strong>{auditActionLabel(a.action, a.metadata)}</strong><small>{date(a.createdAt)} · {data.members.find(m => m.id === a.actorId)?.name || "ระบบ / ลูกค้า"}</small>{a.metadata?.previousStage !== undefined && <small>{stageNames[String(a.metadata.previousStage)] || String(a.metadata.previousStage)} → {stageNames[String(a.metadata.nextStage)] || String(a.metadata.nextStage)}</small>}{Array.isArray(a.metadata?.fields) && <small>ข้อมูลที่แก้: {(a.metadata.fields as string[]).join(", ")}</small>}</div></div>)}</div> : <Empty title="ยังไม่มีกิจกรรม" detail="เริ่มแชตหรืออัปเดตลูกค้าเพื่อดูความเคลื่อนไหว" />}</Card></div><details className="definitions"><summary><CircleHelp size={16} />นิยามตัวชี้วัดและช่วงเวลา</summary><p>วันที่เริ่มต้นและสิ้นสุดนับทั้งวันตาม Asia/Bangkok บทสนทนาและลีดใหม่กรองตามวันที่สร้าง Pipeline แสดงสถานะปัจจุบันของลีดในกลุ่มที่เลือก งานถึงกำหนดนับงานที่ยังเปิด รวมถึงนัดที่รอยืนยันหรือยืนยันแล้วและถึงกำหนด ณ เวลาปัจจุบัน ทุกช่วงวันที่ ลีดใหม่หมายถึงโปรไฟล์ที่สร้างเมื่อเริ่มแชต ซึ่งอาจยังไม่มีข้อมูลติดต่อ อัตราส่งต่อคือจำนวนบทสนทนาที่เคยส่งต่อหารด้วยบทสนทนาในกลุ่มที่เลือก เวลาตอบ AI นับจากรับข้อความจนเริ่มส่งคำตอบจริง ส่วนเจ้าหน้าที่นับจากส่งต่อจนเจ้าหน้าที่ตอบครั้งแรก ค่าโทเคนและค่าใช้จ่ายจะแสดงเมื่อผู้ให้บริการส่งข้อมูลกลับมาเท่านั้น</p></details></>;
}
