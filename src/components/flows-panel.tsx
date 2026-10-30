"use client";
import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, ChevronLeft, CirclePause, CirclePlay, FlaskConical, GitBranch, History, Plus, RefreshCw, Save, Send, ShieldAlert, Trash2, Zap } from "lucide-react";
import { api, date, stageNames, stages, statusNames, type Member } from "./data";
import { Badge, Button, Card, Empty, Field, Input, Select, Textarea } from "./ui";
import type { PanelProps } from "./workspace";
import type { ReplyTemplate } from "./inbox-data";
import type { FlowCondition, FlowDefinition, FlowStep, FlowTrigger } from "@/lib/flows";

// Staff edit flows through forms only; the server validates every definition again.
type Obj = Record<string, any>;
type FlowSummary = { id: string; name: string; status: string; draftRevision: number; currentVersion: number | null; trigger: FlowTrigger | null; updatedAt: string; executions: Record<string, number> };
type FlowList = { enabled: boolean; sendEnabled: boolean; globalPaused: boolean; canEdit: boolean; limits: { stepsPerRun: number; totalSteps: number; perFlowSubjectHour: number }; flows: FlowSummary[] };
type StepLog = { stepId: string; action: string; outcome: string; detail: Obj; createdAt: string };
type Execution = { id: string; version: number; conversationId: string; leadName: string; status: string; triggerKind: string; wakeAt: string; cancelReason: string; errorCode: string; startedAt: string; steps: StepLog[] };
type Detail = { flow: FlowSummary & { draft: FlowDefinition }; versions: { version: number; definition: FlowDefinition; sha256: string; publishedBy: string; publishedAt: string }[]; executions: Execution[] };
type Plan = { source: string; version: number | null; trigger: { label: string; matches: boolean | null }; conditions: { type: string; passed: boolean; detail: string }[]; wouldStart: boolean; blockers: string[]; actions: { stepId: string; type: string; outcome: string; detail: string; text?: string }[] };
type Ctx = { members: Member[]; templates: ReplyTemplate[]; disabled: boolean };

const flowStatus: Record<string, [string, string]> = { draft: ["ร่าง", "neutral"], published: ["เผยแพร่แล้ว", "green"], paused: ["หยุดชั่วคราว", "amber"] };
const runStatus: Record<string, [string, string]> = { running: ["กำลังทำงาน", "blue"], waiting: ["รอเวลา", "purple"], completed: ["เสร็จแล้ว", "green"], cancelled: ["ยกเลิก", "neutral"], failed: ["ล้มเหลว", "amber"] };
const outcomeNames: Record<string, [string, string]> = { planned: ["จะทำ", "green"], done: ["ทำแล้ว", "green"], queued: ["เข้าคิวส่ง", "green"], wait: ["รอ", "purple"], waiting: ["รอ", "purple"], branch: ["แยกเงื่อนไข", "blue"], then: ["ใช่", "blue"], else: ["ไม่ใช่", "blue"], skipped: ["ข้าม", "neutral"], unchanged: ["ไม่เปลี่ยน", "neutral"], blocked: ["ถูกกัน", "amber"], started: ["เริ่ม", "blue"], cancelled: ["ยกเลิก", "neutral"], failed: ["ล้มเหลว", "amber"], yielded: ["พักรอรอบถัดไป", "neutral"] };
const triggerNames: Record<FlowTrigger["type"], string> = { inbound_message: "เมื่อมีข้อความเข้าจากลูกค้า", new_conversation: "เมื่อเริ่มบทสนทนาใหม่ (ข้อความแรก/เพิ่มเพื่อน)", keyword: "เมื่อข้อความมีคำสำคัญ", label_added: "เมื่อเพิ่มแท็กให้ลูกค้า", stage_changed: "เมื่อสถานะลูกค้าเปลี่ยน", schedule: "ตามเวลาที่กำหนด (เวลาไทย)" };
const conditionNames: Record<FlowCondition["type"], string> = { provider: "ช่องทาง", market: "ตลาด", language: "ภาษา", business_hours: "เวลาทำการ (เวลาไทย)", customer_field: "ข้อมูลลูกค้า", assignment: "ผู้รับผิดชอบ", consent: "หลักฐานความยินยอมติดต่อ" };
const stepNames: Record<FlowStep["type"], string> = { add_label: "เพิ่มแท็ก", remove_label: "นำแท็กออก", assign: "มอบหมายให้สมาชิกทีม", create_task: "สร้างงานติดตาม", wait: "รอ", branch: "แยกตามเงื่อนไข", send_message: "ส่งข้อความถึงลูกค้า", request_handoff: "ส่งต่อเจ้าหน้าที่ (จบการทำงาน)", close_conversation: "ปิดบทสนทนา", reopen_conversation: "เปิดบทสนทนาอีกครั้ง", set_stage: "เปลี่ยนสถานะลูกค้า" };
const days = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];
const newId = () => "s" + Math.random().toString(36).slice(2, 9);
const defaultTrigger = (type: FlowTrigger["type"]): FlowTrigger => type === "keyword" ? { type, keywords: ["ราคา"], match: "contains" } : type === "label_added" ? { type, label: "ติดตาม" } : type === "stage_changed" ? { type, stage: "Qualified" } : type === "schedule" ? { type, frequency: "daily", time: "09:00" } : { type } as FlowTrigger;
const conditionDefaults: Record<FlowCondition["type"], FlowCondition> = {
  provider: { type: "provider", providers: ["line"] }, market: { type: "market", markets: ["domestic"] }, language: { type: "language", languages: ["th"] },
  business_hours: { type: "business_hours", inside: true, days: [1, 2, 3, 4, 5], start: "08:30", end: "17:30" }, customer_field: { type: "customer_field", field: "tags", operator: "contains", value: "" },
  assignment: { type: "assignment", state: "unassigned" }, consent: { type: "consent", state: "recorded" },
};
const defaultCondition = (type: FlowCondition["type"]): FlowCondition => structuredClone(conditionDefaults[type]);
function defaultStep(type: FlowStep["type"], id: string, ctx: Ctx): FlowStep {
  const member = ctx.members[0]?.id || "";
  switch (type) {
    case "add_label": case "remove_label": return { id, type, label: "" };
    case "assign": return { id, type, memberId: member };
    case "create_task": return { id, type, title: "", dueInMinutes: 60, assignTo: "conversation_assignee" };
    case "wait": return { id, type, minutes: 60, cancelOnReply: true };
    case "branch": return { id, type, condition: defaultCondition("market"), then: [], else: [] };
    case "send_message": return { id, type, text: "", greeting: false };
    case "request_handoff": return { id, type, note: "" };
    case "set_stage": return { id, type, stage: "Qualified" };
    default: return { id, type } as FlowStep;
  }
}
function countSends(steps: FlowStep[]): number { return steps.reduce((total, step) => total + (step.type === "send_message" ? 1 : step.type === "branch" ? countSends(step.then) + countSends(step.else) : 0), 0); }
function triggerSummary(trigger: FlowTrigger | null) {
  if (!trigger) return "—";
  if (trigger.type === "keyword") return `${triggerNames.keyword}: ${trigger.keywords.join(", ")}`;
  if (trigger.type === "label_added") return `${triggerNames.label_added}: ${trigger.label}`;
  if (trigger.type === "stage_changed") return `${triggerNames.stage_changed} → ${stageNames[trigger.stage] || trigger.stage}`;
  if (trigger.type === "schedule") return `${trigger.frequency === "daily" ? "ทุกวัน" : "ทุกวัน" + days[trigger.weekday ?? 1]} เวลา ${trigger.time} น.`;
  return triggerNames[trigger.type];
}
function Tone({ map, value }: { map: Record<string, [string, string]>; value: string }) { const [label, tone] = map[value] || [value, "neutral"]; return <Badge tone={tone}>{label}</Badge>; }
function MultiCheck({ options, value, onChange, disabled }: { options: [string, string][]; value: (string | number)[]; onChange: (next: any[]) => void; disabled: boolean }) {
  return <div className="flow-checks">{options.map(([key, label]) => { const parsed = /^\d$/.test(key) ? Number(key) : key; const on = value.includes(parsed); return <label key={key}><input type="checkbox" disabled={disabled} checked={on} onChange={() => onChange(on ? value.filter(v => v !== parsed) : [...value, parsed])} />{label}</label>; })}</div>;
}

export function FlowsPanel({ data, notify }: PanelProps) {
  const [list, setList] = useState<FlowList | null>(null); const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null); const [name, setName] = useState(""); const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { setLoading(true); try { setList(await api<FlowList>("/api/admin/flows")); setError(""); } catch (e) { setError((e as Error).message); } finally { setLoading(false); } }, []);
  useEffect(() => { void load(); }, [load]);
  const admin = !!list?.canEdit;
  async function globalPause(paused: boolean) {
    if (!window.confirm(paused ? "หยุดระบบอัตโนมัติทั้งหมดทันที? ข้อความอัตโนมัติที่ยังรอส่งจะถูกยกเลิก" : "เปิดระบบอัตโนมัติทั้งหมดให้ทำงานต่อ?")) return;
    setBusy(true); try { setList(await api<FlowList>("/api/admin/flows/control", { paused, ...(paused ? {} : { confirm: true }) })); notify(paused ? "หยุดระบบอัตโนมัติทั้งหมดแล้ว" : "เปิดระบบอัตโนมัติอีกครั้งแล้ว"); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function create() {
    if (!name.trim()) return; setBusy(true);
    try { const detail = await api<Detail>("/api/admin/flows", { name: name.trim() }); setName(""); await load(); setSelected(detail.flow.id); notify("สร้างร่างระบบอัตโนมัติแล้ว"); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const status = list && <Card className="flows-status">
    <Zap size={20} /><Badge tone={list.enabled ? "green" : "neutral"}>{list.enabled ? "ระบบทำงาน" : "ระบบปิดอยู่ (FLOWS_ENABLED)"}</Badge>
    <Badge tone={list.sendEnabled ? "green" : "neutral"}>{list.sendEnabled ? "ส่งข้อความอัตโนมัติได้" : "ไม่ส่งข้อความอัตโนมัติ"}</Badge>
    {list.globalPaused && <Badge tone="amber">หยุดฉุกเฉินทั้งหมด</Badge>}
    <p>ข้อความอัตโนมัติส่งผ่านช่องทางเดิมพร้อมการตรวจสิทธิ์ ความยินยอม และการหยุดฉุกเฉินทุกครั้ง จะไม่ส่งเมื่อเจ้าหน้าที่รับช่วงแล้ว และส่งข้อความต้อนรับได้ครั้งเดียวต่อบทสนทนา</p>
    {admin && <Button variant={list.globalPaused ? "secondary" : "destructive"} size="sm" disabled={busy} onClick={() => globalPause(!list.globalPaused)}>{list.globalPaused ? <><CirclePlay size={15} />เปิดทำงานต่อ</> : <><ShieldAlert size={15} />หยุดฉุกเฉินทั้งหมด</>}</Button>}
  </Card>;
  if (selected) return <>{status}<FlowEditor id={selected} data={data} admin={admin} notify={notify} back={() => { setSelected(null); void load(); }} /></>;
  return <>
    {status}
    <div className="section-toolbar"><p className="helper-text">ระบบอัตโนมัติ {list?.flows.length ?? 0} รายการ · ทำงานได้สูงสุด {list?.limits.stepsPerRun ?? 20} ขั้นตอนต่อรอบ</p>
      <div className="button-row"><Button variant="secondary" size="sm" disabled={loading} onClick={load}><RefreshCw size={15} />รีเฟรช</Button>
        {admin && <form className="button-row" onSubmit={e => { e.preventDefault(); void create(); }}><Input aria-label="ชื่อระบบอัตโนมัติใหม่" placeholder="ชื่อระบบอัตโนมัติใหม่" maxLength={120} value={name} onChange={e => setName(e.target.value)} /><Button type="submit" disabled={busy || !name.trim()}><Plus size={16} />สร้าง</Button></form>}</div></div>
    {error && <div className="alert alert-error" role="alert">{error}<Button size="sm" variant="ghost" onClick={load}>ลองอีกครั้ง</Button></div>}
    {list && !list.flows.length && <Card><Empty title="ยังไม่มีระบบอัตโนมัติ" detail={admin ? "สร้างร่าง ทดสอบกับบทสนทนาจริงแบบไม่บันทึกข้อมูล แล้วจึงเผยแพร่" : "ผู้ดูแลระบบสามารถสร้างและเผยแพร่ระบบอัตโนมัติได้"} /></Card>}
    <div className="flows-list">{list?.flows.map(flow => <button key={flow.id} className="card flow-card" onClick={() => setSelected(flow.id)}>
      <div className="button-row"><Tone map={flowStatus} value={flow.status} />{flow.currentVersion && <Badge tone="blue">รุ่น {flow.currentVersion}</Badge>}</div>
      <h3>{flow.name}</h3><p>{triggerSummary(flow.trigger)}</p>
      <small>รอเวลา {flow.executions.waiting || 0} · เสร็จ {flow.executions.completed || 0} · ยกเลิก {flow.executions.cancelled || 0}{flow.executions.failed ? ` · ล้มเหลว ${flow.executions.failed}` : ""} · แก้ไข {date(flow.updatedAt)}</small>
    </button>)}</div>
  </>;
}

function FlowEditor({ id, data, admin, notify, back }: { id: string; data: PanelProps["data"]; admin: boolean; notify: (text: string) => void; back: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null); const [draft, setDraft] = useState<FlowDefinition | null>(null); const [name, setName] = useState("");
  const [dirty, setDirty] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [templates, setTemplates] = useState<ReplyTemplate[]>([]);
  const apply = useCallback((next: Detail) => { setDetail(next); setDraft(next.flow.draft); setName(next.flow.name); setDirty(false); }, []);
  const load = useCallback(async () => { try { apply(await api<Detail>(`/api/admin/flows/${id}`)); setError(""); } catch (e) { setError((e as Error).message); } }, [apply, id]);
  useEffect(() => { void load(); api<{ templates: ReplyTemplate[] }>("/api/admin/reply-templates").then(r => setTemplates(r.templates), () => setTemplates([])); }, [load]);
  if (!detail || !draft) return <>{error ? <div className="alert alert-error" role="alert">{error}</div> : <div className="workspace-loading"><span className="spinner" /><p>กำลังโหลด…</p></div>}<Button variant="ghost" onClick={back}><ChevronLeft size={16} />กลับ</Button></>;
  const ctx: Ctx = { members: data.members.filter(m => m.active !== false), templates, disabled: !admin || busy };
  const edit = (next: FlowDefinition) => { setDraft(next); setDirty(true); };
  async function run(path: string, body: Obj, done: string) { setBusy(true); setError(""); try { const next = await api<Detail>(path, body); apply(next); notify(done); return true; } catch (e) { setError((e as Error).message); return false; } finally { setBusy(false); } }
  const flow = detail.flow, sends = countSends(draft.steps);
  return <div className="flow-editor">
    <div className="section-toolbar"><Button variant="ghost" size="sm" onClick={back}><ChevronLeft size={16} />ระบบอัตโนมัติทั้งหมด</Button>
      <div className="button-row"><Tone map={flowStatus} value={flow.status} />{flow.currentVersion && <Badge tone="blue">ใช้งานรุ่น {flow.currentVersion}</Badge>}<Badge>ร่างฉบับที่ {flow.draftRevision}</Badge></div></div>
    {error && <div className="alert alert-error" role="alert">{error}</div>}
    <Card className="flow-section"><Field label="ชื่อระบบอัตโนมัติ"><Input disabled={ctx.disabled} maxLength={120} value={name} onChange={e => { setName(e.target.value); setDirty(true); }} /></Field>
      {admin && <div className="button-row flow-actions">
        <Button disabled={busy || !dirty} onClick={() => run(`/api/admin/flows/${id}/draft`, { name, definition: draft, expectedRevision: flow.draftRevision }, "บันทึกร่างแล้ว")}><Save size={15} />บันทึกร่าง</Button>
        <Button variant="secondary" disabled={busy || dirty} title={dirty ? "บันทึกร่างก่อนเผยแพร่" : undefined} onClick={() => { if (window.confirm(`เผยแพร่ร่างนี้เป็นรุ่นใหม่?\n\nการทำงานที่เริ่มไปแล้วจะใช้รุ่นเดิมจนจบ${sends ? `\nมีขั้นตอนส่งข้อความถึงลูกค้า ${sends} ขั้นตอน ข้อความจะถูกอนุมัติในชื่อของคุณ และส่งเฉพาะเมื่อเปิดการส่งอัตโนมัติและช่องทางพร้อม` : ""}`)) void run(`/api/admin/flows/${id}/publish`, { expectedRevision: flow.draftRevision, confirm: true }, "เผยแพร่รุ่นใหม่แล้ว"); }}><Send size={15} />เผยแพร่</Button>
        {flow.status === "published" && <Button variant="destructive" disabled={busy} onClick={() => { if (window.confirm("หยุดระบบอัตโนมัตินี้ชั่วคราว? ข้อความที่ยังรอส่งจะถูกยกเลิก")) void run(`/api/admin/flows/${id}/pause`, {}, "หยุดชั่วคราวแล้ว"); }}><CirclePause size={15} />หยุดชั่วคราว</Button>}
        {flow.status === "paused" && <Button variant="secondary" disabled={busy} onClick={() => { if (window.confirm("ให้ระบบอัตโนมัตินี้ทำงานต่อ?")) void run(`/api/admin/flows/${id}/resume`, { confirm: true }, "เปิดทำงานต่อแล้ว"); }}><CirclePlay size={15} />ทำงานต่อ</Button>}
        {dirty && <small className="flow-hint">มีการแก้ไขที่ยังไม่บันทึก</small>}
      </div>}
    </Card>
    <Card className="flow-section"><h2>1. เริ่มทำงานเมื่อ</h2><TriggerEditor value={draft.trigger} disabled={ctx.disabled} onChange={trigger => edit({ ...draft, trigger })} /></Card>
    <Card className="flow-section"><h2>2. เงื่อนไขเริ่มต้น</h2><p className="flow-hint">ทุกเงื่อนไขต้องผ่าน ลูกค้าที่ขอหยุดรับข้อความจะไม่ถูกเริ่มเสมอ</p>
      {draft.conditions.map((condition, index) => <div className="flow-step" key={index}><ConditionEditor value={condition} ctx={ctx} onChange={next => edit({ ...draft, conditions: draft.conditions.map((c, i) => i === index ? next : c) })} />{!ctx.disabled && <Button variant="ghost" size="sm" onClick={() => edit({ ...draft, conditions: draft.conditions.filter((_, i) => i !== index) })}><Trash2 size={14} />ลบเงื่อนไข</Button>}</div>)}
      {!ctx.disabled && draft.conditions.length < 10 && <Button variant="secondary" size="sm" onClick={() => edit({ ...draft, conditions: [...draft.conditions, defaultCondition("market")] })}><Plus size={14} />เพิ่มเงื่อนไข</Button>}
    </Card>
    <Card className="flow-section"><h2>3. ขั้นตอน</h2><p className="flow-hint">ทำตามลำดับ สูงสุด 40 ขั้นตอน การรอจะบันทึกไว้และทำต่อเมื่อถึงเวลา และจะยกเลิกเมื่อลูกค้าตอบกลับ ขอหยุดรับข้อความ หรือปิดบทสนทนา</p>
      <StepList steps={draft.steps} depth={0} ctx={ctx} onChange={steps => edit({ ...draft, steps })} /></Card>
    <SimulatePanel id={id} data={data} dirty={dirty} hasPublished={!!flow.currentVersion} />
    <Card className="flow-section"><h2><History size={16} /> ประวัติรุ่น</h2>{detail.versions.length ? <ul className="flow-plan">{detail.versions.map(version => <li key={version.version}><Badge tone={version.version === flow.currentVersion ? "green" : "neutral"}>รุ่น {version.version}</Badge><div><strong>{triggerSummary(version.definition.trigger)}</strong><small> · {version.definition.steps.length} ขั้นตอนหลัก · เผยแพร่ {date(version.publishedAt)} โดย {data.members.find(m => m.id === version.publishedBy)?.name || "ผู้ดูแลระบบ"} · {version.sha256.slice(0, 10)}</small></div></li>)}</ul> : <p className="flow-hint">ยังไม่เคยเผยแพร่</p>}</Card>
    <Card className="flow-section"><h2>การทำงานล่าสุด</h2>{detail.executions.length ? <ul className="flow-plan">{detail.executions.map(execution => <li key={execution.id}><Tone map={runStatus} value={execution.status} /><div className="flow-grow"><strong>{execution.leadName || "ลูกค้า"}</strong><small> · รุ่น {execution.version} · เริ่ม {date(execution.startedAt)}{execution.status === "waiting" ? ` · ทำต่อ ${date(execution.wakeAt)}` : ""}{execution.cancelReason ? ` · ${execution.cancelReason}` : ""}{execution.errorCode ? ` · ${execution.errorCode}` : ""}</small>
      <details><summary>ขั้นตอนที่ทำ ({execution.steps.length})</summary><ul className="flow-plan">{execution.steps.map((step, index) => <li key={index}><Tone map={outcomeNames} value={step.outcome} /><small>{stepNames[step.action as FlowStep["type"]] || step.action}{step.detail?.reason ? ` · ${step.detail.reason}` : ""} · {date(step.createdAt)}</small></li>)}</ul></details></div>
      {admin && ["running", "waiting"].includes(execution.status) && <Button variant="ghost" size="sm" disabled={busy} onClick={() => { if (window.confirm("ยกเลิกการทำงานนี้?")) void run(`/api/admin/flows/${id}/executions/${execution.id}/cancel`, {}, "ยกเลิกการทำงานแล้ว"); }}>ยกเลิก</Button>}</li>)}</ul> : <p className="flow-hint">ยังไม่มีการทำงาน</p>}</Card>
  </div>;
}

function TriggerEditor({ value, onChange, disabled }: { value: FlowTrigger; onChange: (next: FlowTrigger) => void; disabled: boolean }) {
  const t = value as Obj, set = (patch: Obj) => onChange({ ...t, ...patch } as FlowTrigger);
  return <div className="flow-row">
    <Field label="เหตุการณ์"><Select disabled={disabled} value={value.type} onChange={e => onChange(defaultTrigger(e.target.value as FlowTrigger["type"]))}>{Object.entries(triggerNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select></Field>
    {value.type === "keyword" && <><Field label="คำสำคัญ (คั่นด้วยจุลภาค)"><Input disabled={disabled} value={value.keywords.join(", ")} onChange={e => set({ keywords: e.target.value.split(",").map(k => k.trim()).filter(Boolean) })} /></Field>
      <Field label="วิธีจับคู่"><Select disabled={disabled} value={value.match} onChange={e => set({ match: e.target.value })}><option value="contains">มีคำนี้อยู่</option><option value="starts_with">ขึ้นต้นด้วย</option><option value="exact">ตรงทั้งข้อความ</option></Select></Field></>}
    {value.type === "label_added" && <Field label="แท็ก"><Input disabled={disabled} maxLength={40} value={value.label} onChange={e => set({ label: e.target.value })} /></Field>}
    {value.type === "stage_changed" && <Field label="เปลี่ยนเป็น"><Select disabled={disabled} value={value.stage} onChange={e => set({ stage: e.target.value })}>{stages.map(s => <option key={s} value={s}>{stageNames[s]}</option>)}</Select></Field>}
    {value.type === "schedule" && <><Field label="รอบ"><Select disabled={disabled} value={value.frequency} onChange={e => set(e.target.value === "weekly" ? { frequency: "weekly", weekday: 1 } : { frequency: "daily", weekday: undefined })}><option value="daily">ทุกวัน</option><option value="weekly">ทุกสัปดาห์</option></Select></Field>
      {value.frequency === "weekly" && <Field label="วัน"><Select disabled={disabled} value={String(value.weekday ?? 1)} onChange={e => set({ weekday: Number(e.target.value) })}>{days.map((d, i) => <option key={i} value={i}>{d}</option>)}</Select></Field>}
      <Field label="เวลา (เวลาไทย)"><Input type="time" disabled={disabled} value={value.time} onChange={e => set({ time: e.target.value })} /></Field></>}
  </div>;
}

function ConditionEditor({ value, onChange, ctx }: { value: FlowCondition; onChange: (next: FlowCondition) => void; ctx: Ctx }) {
  const c = value as Obj, set = (patch: Obj) => onChange({ ...c, ...patch } as FlowCondition), disabled = ctx.disabled;
  return <div className="flow-row">
    <Field label="เงื่อนไข"><Select disabled={disabled} value={value.type} onChange={e => onChange(defaultCondition(e.target.value as FlowCondition["type"]))}>{Object.entries(conditionNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select></Field>
    {value.type === "provider" && <MultiCheck disabled={disabled} options={[["whatsapp", "WhatsApp"], ["line", "LINE"], ["facebook", "Facebook"], ["web", "เว็บแชต"]]} value={value.providers} onChange={providers => set({ providers })} />}
    {value.type === "market" && <MultiCheck disabled={disabled} options={[["domestic", "ในประเทศ"], ["export", "ส่งออก"], ["unknown", "ยังไม่ระบุ"]]} value={value.markets} onChange={markets => set({ markets })} />}
    {value.type === "language" && <MultiCheck disabled={disabled} options={[["th", "ไทย"], ["en", "อังกฤษ"], ["other", "อื่น ๆ"]]} value={value.languages} onChange={languages => set({ languages })} />}
    {value.type === "business_hours" && <><Field label="ช่วงเวลา"><Select disabled={disabled} value={value.inside ? "in" : "out"} onChange={e => set({ inside: e.target.value === "in" })}><option value="in">อยู่ในเวลาทำการ</option><option value="out">นอกเวลาทำการ</option></Select></Field>
      <Field label="เริ่ม"><Input type="time" disabled={disabled} value={value.start} onChange={e => set({ start: e.target.value })} /></Field><Field label="สิ้นสุด"><Input type="time" disabled={disabled} value={value.end} onChange={e => set({ end: e.target.value })} /></Field>
      <MultiCheck disabled={disabled} options={days.map((d, i) => [String(i), d] as [string, string])} value={value.days} onChange={next => set({ days: next })} /></>}
    {value.type === "customer_field" && <><Field label="ข้อมูล"><Select disabled={disabled} value={value.field} onChange={e => set({ field: e.target.value, operator: e.target.value === "tags" ? "contains" : value.operator === "not_contains" || value.operator === "contains" ? value.operator : "equals" })}>{[["tags", "แท็ก"], ["name", "ชื่อ"], ["phone", "โทรศัพท์"], ["email", "อีเมล"], ["stage", "สถานะ"], ["source", "แหล่งที่มา"], ["interests", "ความสนใจ"]].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
      <Field label="เงื่อนไข"><Select disabled={disabled} value={value.operator} onChange={e => set({ operator: e.target.value })}>{(value.field === "tags" ? [["contains", "มีแท็ก"], ["not_contains", "ไม่มีแท็ก"], ["is_empty", "ไม่มีแท็กเลย"], ["is_not_empty", "มีแท็กอย่างน้อยหนึ่ง"]] : [["equals", "เท่ากับ"], ["not_equals", "ไม่เท่ากับ"], ["contains", "มีคำว่า"], ["not_contains", "ไม่มีคำว่า"], ["is_empty", "ว่าง"], ["is_not_empty", "ไม่ว่าง"]]).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
      {!["is_empty", "is_not_empty"].includes(value.operator) && <Field label="ค่า"><Input disabled={disabled} maxLength={200} value={value.value || ""} onChange={e => set({ value: e.target.value })} /></Field>}</>}
    {value.type === "assignment" && <><Field label="ผู้รับผิดชอบ"><Select disabled={disabled} value={value.state} onChange={e => set(e.target.value === "assigned_to" ? { state: e.target.value, memberId: ctx.members[0]?.id } : { state: e.target.value, memberId: undefined })}><option value="unassigned">ยังไม่มีผู้รับผิดชอบ</option><option value="assigned">มีผู้รับผิดชอบแล้ว</option><option value="assigned_to">เป็นสมาชิกคนนี้</option></Select></Field>
      {value.state === "assigned_to" && <MemberSelect ctx={ctx} value={value.memberId || ""} onChange={memberId => set({ memberId })} />}</>}
    {value.type === "consent" && <Field label="สถานะ"><Select disabled={disabled} value={value.state} onChange={e => set({ state: e.target.value })}><option value="recorded">มีหลักฐานความยินยอมแล้ว</option><option value="not_recorded">ยังไม่มีหลักฐาน</option></Select></Field>}
  </div>;
}
function MemberSelect({ ctx, value, onChange }: { ctx: Ctx; value: string; onChange: (id: string) => void }) {
  return <Field label="สมาชิกทีม"><Select disabled={ctx.disabled} value={value} onChange={e => onChange(e.target.value)}><option value="" disabled>เลือกสมาชิก</option>{ctx.members.map(m => <option key={m.id} value={m.id}>{m.name} ({m.role})</option>)}</Select></Field>;
}

function StepList({ steps, onChange, depth, ctx }: { steps: FlowStep[]; onChange: (next: FlowStep[]) => void; depth: number; ctx: Ctx }) {
  const [adding, setAdding] = useState<FlowStep["type"]>("add_label");
  const move = (index: number, delta: number) => { const next = [...steps]; const [item] = next.splice(index, 1); next.splice(index + delta, 0, item); onChange(next); };
  return <div className="flow-steps">
    {steps.map((step, index) => <div className="flow-step" key={step.id}>
      <div className="flow-step-head"><Badge tone="blue">{index + 1}</Badge>
        <Select aria-label="ชนิดขั้นตอน" disabled={ctx.disabled} value={step.type} onChange={e => onChange(steps.map((s, i) => i === index ? defaultStep(e.target.value as FlowStep["type"], s.id, ctx) : s))}>{Object.entries(stepNames).filter(([key]) => key !== "branch" || depth < 3 || step.type === "branch").map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select>
        {!ctx.disabled && <div className="button-row"><Button variant="ghost" size="icon" aria-label="เลื่อนขึ้น" disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={15} /></Button><Button variant="ghost" size="icon" aria-label="เลื่อนลง" disabled={index === steps.length - 1} onClick={() => move(index, 1)}><ArrowDown size={15} /></Button><Button variant="ghost" size="icon" aria-label="ลบขั้นตอน" onClick={() => onChange(steps.filter((_, i) => i !== index))}><Trash2 size={15} /></Button></div>}
      </div>
      <StepFields step={step} depth={depth} ctx={ctx} onChange={next => onChange(steps.map((s, i) => i === index ? next : s))} />
    </div>)}
    {!ctx.disabled && <div className="flow-row"><Field label="เพิ่มขั้นตอน"><Select value={adding} onChange={e => setAdding(e.target.value as FlowStep["type"])}>{Object.entries(stepNames).filter(([key]) => key !== "branch" || depth < 3).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select></Field><Button variant="secondary" size="sm" onClick={() => onChange([...steps, defaultStep(adding, newId(), ctx)])}><Plus size={14} />เพิ่ม</Button></div>}
  </div>;
}
function StepFields({ step, onChange, depth, ctx }: { step: FlowStep; onChange: (next: FlowStep) => void; depth: number; ctx: Ctx }) {
  const s = step as Obj, set = (patch: Obj) => onChange({ ...s, ...patch } as FlowStep), disabled = ctx.disabled;
  switch (step.type) {
    case "add_label": case "remove_label": return <Field label="แท็ก"><Input disabled={disabled} maxLength={40} value={step.label} onChange={e => set({ label: e.target.value })} /></Field>;
    case "set_stage": return <Field label="สถานะใหม่"><Select disabled={disabled} value={step.stage} onChange={e => set({ stage: e.target.value })}>{stages.map(v => <option key={v} value={v}>{stageNames[v]}</option>)}</Select></Field>;
    case "assign": return <MemberSelect ctx={ctx} value={step.memberId} onChange={memberId => set({ memberId })} />;
    case "create_task": return <div className="flow-row"><Field label="ชื่องาน"><Input disabled={disabled} maxLength={200} value={step.title} onChange={e => set({ title: e.target.value })} /></Field>
      <Field label="ครบกำหนดในอีก (นาที)"><Input type="number" min={0} max={525600} disabled={disabled} value={step.dueInMinutes} onChange={e => set({ dueInMinutes: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} /></Field>
      <Field label="มอบหมายให้"><Select disabled={disabled} value={step.assignTo} onChange={e => set(e.target.value === "member" ? { assignTo: "member", memberId: ctx.members[0]?.id } : { assignTo: e.target.value, memberId: undefined })}><option value="conversation_assignee">ผู้รับผิดชอบบทสนทนา</option><option value="member">สมาชิกที่เลือก</option><option value="none">ยังไม่มอบหมาย</option></Select></Field>
      {step.assignTo === "member" && <MemberSelect ctx={ctx} value={step.memberId || ""} onChange={memberId => set({ memberId })} />}
      <Field label="หมายเหตุ"><Input disabled={disabled} maxLength={2000} value={step.notes || ""} onChange={e => set({ notes: e.target.value })} /></Field></div>;
    case "wait": return <div className="flow-row"><Field label="รอ (นาที)" hint={`ประมาณ ${step.minutes >= 1440 ? `${(step.minutes / 1440).toFixed(1)} วัน` : step.minutes >= 60 ? `${(step.minutes / 60).toFixed(1)} ชั่วโมง` : `${step.minutes} นาที`} สูงสุด 30 วัน`}><Input type="number" min={1} max={43200} disabled={disabled} value={step.minutes} onChange={e => set({ minutes: Math.max(1, Math.floor(Number(e.target.value) || 1)) })} /></Field>
      <label className="flow-checks"><input type="checkbox" disabled={disabled} checked={step.cancelOnReply} onChange={e => set({ cancelOnReply: e.target.checked })} />ยกเลิกเมื่อลูกค้าตอบกลับ</label></div>;
    case "send_message": return <div className="form-stack">
      <div className="flow-row"><Field label="ข้อความจาก"><Select disabled={disabled} value={step.templateId !== undefined ? "template" : "text"} onChange={e => onChange(e.target.value === "template" ? { id: step.id, type: "send_message", templateId: ctx.templates[0]?.id || "", greeting: step.greeting } : { id: step.id, type: "send_message", text: "", greeting: step.greeting })}><option value="text">พิมพ์ข้อความ</option><option value="template">ข้อความสำเร็จรูป</option></Select></Field>
        <label className="flow-checks"><input type="checkbox" disabled={disabled} checked={step.greeting} onChange={e => set({ greeting: e.target.checked })} />เป็นข้อความต้อนรับ (ส่งได้ครั้งเดียวต่อบทสนทนา)</label></div>
      {step.templateId !== undefined ? <Field label="ข้อความสำเร็จรูป" hint="ข้อความจะถูกตรึงไว้ตอนเผยแพร่ แก้ข้อความสำเร็จรูปภายหลังต้องเผยแพร่ใหม่"><Select disabled={disabled} value={step.templateId} onChange={e => set({ templateId: e.target.value })}><option value="" disabled>เลือกข้อความ</option>{ctx.templates.map(t => <option key={t.id} value={t.id}>{t.title} {t.shortcut}</option>)}</Select></Field>
        : <Field label="ข้อความ" hint="ใช้ข้อมูลที่ตรวจสอบแล้วเท่านั้น ห้ามใส่ราคา สเปก หรือเงื่อนไขที่ยังไม่ยืนยัน สูงสุด 2000 ตัวอักษร"><Textarea disabled={disabled} rows={3} maxLength={2000} value={step.text || ""} onChange={e => set({ text: e.target.value })} /></Field>}
    </div>;
    case "request_handoff": return <Field label="บันทึกถึงเจ้าหน้าที่ (ไม่ส่งถึงลูกค้า)"><Input disabled={disabled} maxLength={500} value={step.note || ""} onChange={e => set({ note: e.target.value })} /></Field>;
    case "branch": return <div className="form-stack"><ConditionEditor value={step.condition} ctx={ctx} onChange={condition => set({ condition })} />
      <div className="flow-branch"><div><strong><GitBranch size={14} /> ถ้าใช่</strong><StepList steps={step.then} depth={depth + 1} ctx={ctx} onChange={then => set({ then })} /></div><div><strong><GitBranch size={14} /> ถ้าไม่ใช่</strong><StepList steps={step.else} depth={depth + 1} ctx={ctx} onChange={next => set({ else: next })} /></div></div></div>;
    default: return null;
  }
}

function SimulatePanel({ id, data, dirty, hasPublished }: { id: string; data: PanelProps["data"]; dirty: boolean; hasPublished: boolean }) {
  const [conversationId, setConversationId] = useState(data.conversations[0]?.id || ""); const [text, setText] = useState(""); const [source, setSource] = useState("draft");
  const [search, setSearch] = useState(""); const [plan, setPlan] = useState<Plan | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const options = data.conversations.filter(c => !search || `${c.leadName || ""} ${c.lastMessage || ""}`.toLowerCase().includes(search.toLowerCase())).slice(0, 200);
  async function simulate() { setBusy(true); setError(""); try { setPlan(await api<Plan>(`/api/admin/flows/${id}/simulate`, { conversationId, source, ...(text ? { text } : {}) })); } catch (e) { setError((e as Error).message); setPlan(null); } finally { setBusy(false); } }
  return <Card className="flow-section"><h2><FlaskConical size={16} /> 4. ทดสอบกับบทสนทนา</h2>
    <p className="flow-hint">จำลองว่าระบบจะทำอะไรกับบทสนทนาที่เลือก ไม่บันทึกข้อมูล ไม่เปลี่ยนสถานะ และไม่ส่งข้อความ{dirty ? " · ใช้ร่างที่บันทึกล่าสุด กรุณาบันทึกร่างก่อน" : ""}</p>
    <div className="flow-row"><Field label="ค้นหาลูกค้า"><Input value={search} onChange={e => setSearch(e.target.value)} placeholder="ชื่อหรือข้อความ" /></Field>
      <Field label="บทสนทนา"><Select value={conversationId} onChange={e => setConversationId(e.target.value)}>{options.map(c => <option key={c.id} value={c.id}>{c.leadName || "ลูกค้า"} · {statusNames[c.status] || c.status}</option>)}</Select></Field>
      <Field label="ข้อความตัวอย่างจากลูกค้า (ไม่บังคับ)"><Input maxLength={2000} value={text} onChange={e => setText(e.target.value)} /></Field>
      <Field label="ทดสอบจาก"><Select value={source} onChange={e => setSource(e.target.value)}><option value="draft">ร่างล่าสุด</option>{hasPublished && <option value="published">รุ่นที่เผยแพร่</option>}</Select></Field>
      <Button variant="secondary" disabled={busy || !conversationId} onClick={simulate}><FlaskConical size={15} />จำลอง</Button></div>
    {error && <div className="alert alert-error" role="alert">{error}</div>}
    {plan && <div className="form-stack">
      <div className="button-row"><Badge tone={plan.wouldStart ? "green" : "amber"}>{plan.wouldStart ? "จะเริ่มทำงาน" : "จะไม่เริ่มทำงาน"}</Badge><Badge>{plan.trigger.label}{plan.trigger.matches === null ? "" : plan.trigger.matches ? " · ตรง" : " · ไม่ตรง"}</Badge>{plan.version && <Badge tone="blue">รุ่น {plan.version}</Badge>}</div>
      {plan.blockers.map(blocker => <div className="alert" key={blocker}>{blocker}</div>)}
      {!!plan.conditions.length && <ul className="flow-plan">{plan.conditions.map((c, i) => <li key={i}><Badge tone={c.passed ? "green" : "amber"}>{c.passed ? "ผ่าน" : "ไม่ผ่าน"}</Badge><small>{conditionNames[c.type as FlowCondition["type"]] || c.type} · {c.detail}</small></li>)}</ul>}
      <ol className="flow-plan">{plan.actions.map((action, i) => <li key={i}><Tone map={outcomeNames} value={action.outcome} /><div className="flow-grow"><strong>{stepNames[action.type as FlowStep["type"]] || action.type}</strong><small> · {action.detail}</small>{action.text && <blockquote>{action.text}</blockquote>}</div></li>)}</ol>
    </div>}
  </Card>;
}
