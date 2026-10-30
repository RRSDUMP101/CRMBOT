"use client";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { CircleHelp, Clock, Download, Inbox, MessageSquare, RefreshCw, TriangleAlert, Users, Workflow, Timer, CheckCheck, MessagesSquare } from "lucide-react";
import type { GroupMetrics, Report, Stat } from "@/lib/reports";
import { api, type Member } from "./data";
import { Badge, Button, Card, Empty, Field, Input, Select } from "./ui";

const NO_DATA = "ไม่มีข้อมูล";
const channelOptions = [["", "ทุกช่องทาง"], ["website", "เว็บไซต์"], ["whatsapp", "WhatsApp"], ["line", "LINE"], ["facebook", "Facebook"], ["legacy", "ประวัติที่นำเข้า"]] as const;
const marketOptions = [["", "ทุกตลาด"], ["domestic", "ในประเทศ"], ["export", "ส่งออก"], ["unknown", "ยังไม่ระบุตลาด"]] as const;
const bangkokDay = (offsetDays = 0) => new Date(Date.now() + 7 * 3600000 - offsetDays * 86400000).toISOString().slice(0, 10);
const decimal = (value: number, digits = 1) => new Intl.NumberFormat("th-TH", { maximumFractionDigits: digits }).format(value);
const count = (value: number) => new Intl.NumberFormat("th-TH").format(value);

export function formatDuration(ms: number | null | undefined) {
  if (ms == null) return NO_DATA;
  const seconds = ms / 1000;
  if (seconds < 60) return `${decimal(seconds)} วินาที`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${decimal(minutes)} นาที`;
  const hours = minutes / 60;
  if (hours < 48) return `${decimal(hours)} ชั่วโมง`;
  return `${decimal(hours / 24)} วัน`;
}
const rate = (value: number | null | undefined) => value == null ? NO_DATA : `${decimal(value * 100)}%`;
const share = (part: number, total: number) => total ? `${decimal((part / total) * 100)}%` : NO_DATA;

type Filters = { from: string; to: string; channel: string; market: string; assignee: string; overdueHours: string };
const defaults = (): Filters => ({ from: bangkokDay(29), to: bangkokDay(), channel: "", market: "", assignee: "", overdueHours: "4" });
function queryString(filters: Filters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value.trim()) params.set(key, value.trim());
  return params.toString();
}

export function ReportsPanel({ user, members }: { user: Member; members: Member[] }) {
  const isAdmin = user.role === "Admin";
  const [filters, setFilters] = useState<Filters>(defaults);
  const [applied, setApplied] = useState(() => queryString(defaults()));
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false); const [error, setError] = useState("");
  const revision = useRef(0);
  const ids = { result: useId(), times: useId(), outcome: useId(), channels: useId(), agents: useId() };

  async function load(query: string) {
    const current = ++revision.current; setLoading(true); setError("");
    try { const next = await api<Report>("/api/admin/reports?" + query); if (current === revision.current) setReport(next); }
    catch (e) { if (current === revision.current) { setError((e as Error).message); setReport(null); } }
    finally { if (current === revision.current) setLoading(false); }
  }
  useEffect(() => { void load(applied); return () => { revision.current++; }; }, [applied]);
  function submit(event: FormEvent) {
    event.preventDefault();
    const query = queryString(filters);
    if (query === applied) void load(query); else setApplied(query);
  }
  const set = (key: keyof Filters) => (event: { target: { value: string } }) => setFilters(previous => ({ ...previous, [key]: event.target.value }));
  const exportHref = "/api/admin/reports/export?" + new URLSearchParams([["format", "csv"], ...new URLSearchParams(applied)]).toString();
  const t = report?.totals;

  return <div className="reports-panel">
    <form className="reports-filters" aria-label="ตัวกรองรายงาน" onSubmit={submit}>
      <Field label="ตั้งแต่วันที่"><Input type="date" required value={filters.from} max={filters.to || undefined} onChange={set("from")} /></Field>
      <Field label="ถึงวันที่"><Input type="date" required value={filters.to} min={filters.from || undefined} onChange={set("to")} /></Field>
      <Field label="ช่องทาง"><Select value={filters.channel} onChange={set("channel")}>{channelOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field>
      <Field label="ตลาด"><Select value={filters.market} onChange={set("market")}>{marketOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field>
      <Field label="ผู้รับผิดชอบ"><Select value={filters.assignee} onChange={set("assignee")}>
        <option value="">ทุกคน</option>
        {isAdmin ? members.map(member => <option key={member.id} value={member.id}>{member.name}{member.active === false ? " (ปิดใช้งาน)" : ""}</option>) : <option value={user.id}>ของฉัน</option>}
        <option value="unassigned">ยังไม่มีผู้รับผิดชอบ</option>
      </Select></Field>
      <Field label="รอเกินกี่ชั่วโมง" hint="ใช้นับงานรอเกินกำหนด"><Input type="number" inputMode="numeric" min={1} max={720} step={1} required value={filters.overdueHours} onChange={set("overdueHours")} /></Field>
      <div className="reports-actions">
        <Button type="submit" disabled={loading}><RefreshCw size={15} className={loading ? "spin" : ""} />{loading ? "กำลังคำนวณ…" : "ดูรายงาน"}</Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => { const next = defaults(); setFilters(next); setApplied(queryString(next)); }}>30 วันล่าสุด</Button>
        {isAdmin && report && <a className="button button-secondary button-sm" href={exportHref} download><Download size={15} />ส่งออก CSV</a>}
      </div>
    </form>

    {error && <div className="alert alert-error" role="alert">{error}<Button variant="ghost" size="sm" onClick={() => void load(applied)}>ลองอีกครั้ง</Button></div>}
    <section id={ids.result} aria-busy={loading} aria-label="ผลรายงาน">
      {!report && loading && <div className="workspace-loading" role="status"><span className="spinner" /><p>กำลังคำนวณรายงานจากข้อมูลจริง…</p></div>}
      {report && t && <>
        <p className="reports-meta" role="status"><Badge tone="green">ข้อมูลจริง</Badge> {report.range.from} ถึง {report.range.to} · เวลา Asia/Bangkok · สร้างเมื่อ {new Intl.DateTimeFormat("th-TH", { timeZone: "Asia/Bangkok", dateStyle: "medium", timeStyle: "short" }).format(new Date(report.generatedAt))}</p>
        <div className="stats-grid reports-cards">
          <Metric title="บทสนทนาใหม่" value={count(t.newConversations)} caption="สร้างในช่วงวันที่เลือก" icon={MessageSquare} accent="teal" />
          <Metric title="ข้อความจากลูกค้า" value={count(t.inboundMessages)} caption="ข้อความที่เข้ามาในช่วงวันที่" icon={MessagesSquare} accent="blue" />
          <Metric title="ตอบครั้งแรก (p50)" value={formatDuration(t.firstResponse.p50Ms)} caption={statCaption(t.firstResponse)} icon={Timer} accent="teal" />
          <Metric title="เจ้าหน้าที่ตอบครั้งแรก (p50)" value={formatDuration(t.humanFirstResponse.p50Ms)} caption={statCaption(t.humanFirstResponse)} icon={Users} accent="purple" />
          <Metric title="เวลาจบการสนทนา (p50)" value={formatDuration(t.resolution.p50Ms)} caption={statCaption(t.resolution)} icon={CheckCheck} accent="blue" />
          <Metric title="อัตราส่งต่อเจ้าหน้าที่" value={rate(t.handoffRate)} caption={`ส่งต่อ ${count(t.handedOff)} จาก ${count(t.newConversations)} บทสนทนา`} icon={Workflow} accent="purple" />
          <Metric title="งานค้างตอนนี้" value={count(t.backlog.waitingHuman + t.backlog.humanActive)} caption={`รอเจ้าหน้าที่ ${count(t.backlog.waitingHuman)} · กำลังดูแล ${count(t.backlog.humanActive)}`} icon={Inbox} accent="amber" />
          <Metric title={`รอเกิน ${report.filters.overdueHours} ชั่วโมง`} value={count(t.backlog.overdue)} caption="รอเจ้าหน้าที่และยังไม่มีคำตอบ" icon={TriangleAlert} accent="amber" />
        </div>

        <div className="reports-grid">
          <Card><div className="card-heading"><div><h2 id={ids.times}>เวลาตอบกลับและปิดงาน</h2><p>จากบทสนทนาที่เริ่มในช่วงวันที่เลือก</p></div><Clock size={19} aria-hidden="true" /></div>
            <div className="table-wrap"><table aria-labelledby={ids.times}><thead><tr><th scope="col">ตัวชี้วัด</th><th scope="col">ตัวอย่าง</th><th scope="col">p50</th><th scope="col">p90</th><th scope="col">เฉลี่ย</th></tr></thead><tbody>
              <StatRow label="ตอบครั้งแรก (AI หรือเจ้าหน้าที่)" stat={t.firstResponse} />
              <StatRow label="เจ้าหน้าที่ตอบครั้งแรก" stat={t.humanFirstResponse} />
              <StatRow label="เวลาจบการสนทนา" stat={t.resolution} />
            </tbody></table></div>
            <p className="reports-note">ยังไม่มีคำตอบแรก {count(t.awaitingFirstReply)} บทสนทนา · จบแล้ว {count(t.resolved)} บทสนทนา (คำนวณเวลาไม่ได้ {count(t.resolvedWithoutTiming)})</p>
          </Card>
          <Card><div className="card-heading"><div><h2 id={ids.outcome}>AI และเจ้าหน้าที่</h2><p>ใครเป็นผู้ดูแลบทสนทนาใหม่</p></div><Users size={19} aria-hidden="true" /></div>
            <div className="table-wrap"><table aria-labelledby={ids.outcome}><thead><tr><th scope="col">ผลลัพธ์</th><th scope="col">บทสนทนา</th><th scope="col">สัดส่วน</th></tr></thead><tbody>
              <tr><th scope="row">AI ดูแลเอง</th><td>{count(t.aiHandled)}</td><td>{share(t.aiHandled, t.newConversations)}</td></tr>
              <tr><th scope="row">เจ้าหน้าที่เข้าร่วม</th><td>{count(t.humanInvolved)}</td><td>{share(t.humanInvolved, t.newConversations)}</td></tr>
              <tr><th scope="row">อื่น ๆ (ยังไม่มีผู้ตอบ / รอเจ้าหน้าที่)</th><td>{count(t.otherOutcome)}</td><td>{share(t.otherOutcome, t.newConversations)}</td></tr>
              <tr><th scope="row">ส่งต่อเจ้าหน้าที่</th><td>{count(t.handedOff)}</td><td>{rate(t.handoffRate)}</td></tr>
            </tbody></table></div>
          </Card>
        </div>

        <Card className="reports-table-card"><div className="card-heading"><div><h2 id={ids.channels}>แยกตามช่องทาง</h2><p>เว็บไซต์และช่องทางโซเชียลที่ยืนยันตัวตนแล้ว</p></div></div>
          {report.byChannel.length ? <GroupTable labelledBy={ids.channels} firstColumn="ช่องทาง" rows={report.byChannel.map(row => ({ key: row.channel, label: row.label, metrics: row }))} /> : <Empty title={NO_DATA} detail="ยังไม่มีบทสนทนาหรืองานค้างตามตัวกรองนี้" />}
        </Card>
        <Card className="reports-table-card"><div className="card-heading"><div><h2 id={ids.agents}>แยกตามผู้รับผิดชอบ</h2><p>{report.viewer.agentBreakdown === "all" ? "ตามผู้รับผิดชอบปัจจุบันของบทสนทนา" : "แสดงเฉพาะข้อมูลของคุณ ผู้ดูแลระบบดูรายบุคคลของทีมได้"}</p></div></div>
          {report.byAgent.length ? <GroupTable labelledBy={ids.agents} firstColumn="ผู้รับผิดชอบ" rows={report.byAgent.map(row => ({ key: row.agentId ?? "unassigned", label: row.name + (row.active ? "" : " (ปิดใช้งาน)"), metrics: row }))} /> : <Empty title={NO_DATA} detail="ยังไม่มีบทสนทนาที่มอบหมายตามตัวกรองนี้" />}
        </Card>

        <details className="definitions"><summary><CircleHelp size={16} aria-hidden="true" />นิยามตัวชี้วัด</summary><dl className="reports-definitions">{Object.entries(definitionLabels).map(([key, label]) => report.definitions[key] ? <div key={key}><dt>{label}</dt><dd>{report.definitions[key]}</dd></div> : null)}</dl></details>
      </>}
    </section>
  </div>;
}

const definitionLabels: Record<string, string> = { cohort: "กลุ่มข้อมูล", newConversations: "บทสนทนาใหม่", inboundMessages: "ข้อความจากลูกค้า", firstResponse: "ตอบครั้งแรก", humanFirstResponse: "เจ้าหน้าที่ตอบครั้งแรก", resolution: "เวลาจบการสนทนา", percentiles: "p50 / p90 / เฉลี่ย", handoff: "อัตราส่งต่อ", outcome: "AI และเจ้าหน้าที่", backlog: "งานค้าง", overdue: "รอเกินกำหนด", channel: "ช่องทาง", agent: "ผู้รับผิดชอบ" };
function statCaption(stat: Stat) { return stat.samples ? `${count(stat.samples)} ตัวอย่าง · p90 ${formatDuration(stat.p90Ms)}` : "ยังไม่มีตัวอย่างในช่วงนี้"; }
function Metric({ title, value, caption, icon: Icon, accent }: { title: string; value: string; caption: string; icon: typeof Clock; accent: string }) {
  return <Card className="stat-card"><div className="stat-top"><span>{title}</span><span className={`stat-icon icon-${accent}`} aria-hidden="true"><Icon size={20} /></span></div><strong className="stat-number">{value}</strong><small>{caption}</small></Card>;
}
function StatRow({ label, stat }: { label: string; stat: Stat }) {
  return <tr><th scope="row">{label}</th><td>{count(stat.samples)}</td><td>{formatDuration(stat.p50Ms)}</td><td>{formatDuration(stat.p90Ms)}</td><td>{formatDuration(stat.avgMs)}</td></tr>;
}
function GroupTable({ labelledBy, firstColumn, rows }: { labelledBy: string; firstColumn: string; rows: { key: string; label: string; metrics: GroupMetrics }[] }) {
  return <div className="table-wrap"><table aria-labelledby={labelledBy}><thead><tr>
    <th scope="col">{firstColumn}</th><th scope="col">บทสนทนาใหม่</th><th scope="col">ข้อความลูกค้า</th><th scope="col">ตอบครั้งแรก p50</th><th scope="col">เจ้าหน้าที่ตอบ p50</th><th scope="col">เวลาจบ p50</th><th scope="col">อัตราส่งต่อ</th><th scope="col">รอเจ้าหน้าที่</th><th scope="col">กำลังดูแล</th><th scope="col">รอเกินกำหนด</th>
  </tr></thead><tbody>{rows.map(({ key, label, metrics: m }) => <tr key={key}>
    <th scope="row">{label}</th><td>{count(m.newConversations)}</td><td>{count(m.inboundMessages)}</td>
    <td>{formatDuration(m.firstResponse.p50Ms)}<small>{count(m.firstResponse.samples)} ตัวอย่าง</small></td>
    <td>{formatDuration(m.humanFirstResponse.p50Ms)}<small>{count(m.humanFirstResponse.samples)} ตัวอย่าง</small></td>
    <td>{formatDuration(m.resolution.p50Ms)}<small>{count(m.resolution.samples)} ตัวอย่าง</small></td>
    <td>{rate(m.handoffRate)}</td><td>{count(m.backlog.waitingHuman)}</td><td>{count(m.backlog.humanActive)}</td><td>{count(m.backlog.overdue)}</td>
  </tr>)}</tbody></table></div>;
}
