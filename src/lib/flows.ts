import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { camel, database, transaction, withDatabase, type D1Binding, type Executor, type Row } from './db';
import { ApiError, fields, oneOf, requireAdmin, str, uuid, type Staff } from './auth';
import { readSocialConfig, type FlowInboundSignal, type SocialChannelConfig, type SocialProvider } from './social-channels';

/**
 * Flow Builder ("ระบบอัตโนมัติ"): durable, versioned automation. Default OFF (FLOWS_ENABLED=true).
 * Customer sends additionally need FLOWS_SEND_ENABLED=true and go through the existing social
 * outbound queue and every one of its gates. Published versions are immutable; an execution keeps
 * the version it started with. All work is org-scoped and bounded per run.
 */
type Env = Record<string, unknown>;
type DispatchOptions = { config?: SocialChannelConfig; fetch?: typeof fetch };
export type FlowEngineOptions = { env?: Env; now?: () => number; dispatch?: DispatchOptions };
type Ctx = { env: Env; now: () => number; dispatch: DispatchOptions };
export const flowsEnabled = (env: Env = process.env) => env.FLOWS_ENABLED === 'true';
export const flowSendsEnabled = (env: Env = process.env) => flowsEnabled(env) && env.FLOWS_SEND_ENABLED === 'true';
export const FLOW_LIMITS = { stepsPerRun: 20, totalSteps: 40, branchDepth: 3, conditions: 10, perFlowSubjectHour: 5, perSubjectHour: 20, chainDepth: 3, executionsPerRun: 25, eventsPerRun: 50, schedulePerRun: 25, scheduleWindowMs: 6 * 3600_000, orgsPerRun: 10, leaseMs: 60_000, flowsPerOrg: 100 } as const;
const stamp = (ms: number) => new Date(ms).toISOString().replace(/(\.\d{3})Z$/, (_, fraction) => fraction + '000Z');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const context = (options: FlowEngineOptions = {}): Ctx => ({ env: options.env ?? process.env, now: options.now ?? Date.now, dispatch: options.dispatch ?? {} });

// ---------------------------------------------------------------------------------------------
// Definition schema (validated server-side; staff edit it through forms, never raw JSON)
// ---------------------------------------------------------------------------------------------
export const flowStages = ['New', 'Qualified', 'Follow-up', 'Won', 'Lost'] as const;
type Stage = typeof flowStages[number];
type CustomerField = 'name' | 'phone' | 'email' | 'stage' | 'source' | 'interests' | 'tags';
type FieldOperator = 'equals' | 'not_equals' | 'contains' | 'not_contains' | 'is_empty' | 'is_not_empty';
export type FlowCondition =
  | { type: 'provider'; providers: Array<SocialProvider | 'web'>; accountId?: string }
  | { type: 'market'; markets: Array<'unknown' | 'domestic' | 'export'> }
  | { type: 'language'; languages: Array<'th' | 'en' | 'other'> }
  | { type: 'business_hours'; inside: boolean; days: number[]; start: string; end: string }
  | { type: 'customer_field'; field: CustomerField; operator: FieldOperator; value?: string }
  | { type: 'assignment'; state: 'assigned' | 'unassigned' | 'assigned_to'; memberId?: string }
  | { type: 'consent'; state: 'recorded' | 'not_recorded' };
export type FlowTrigger =
  | { type: 'inbound_message' }
  | { type: 'new_conversation' }
  | { type: 'keyword'; keywords: string[]; match: 'contains' | 'exact' | 'starts_with' }
  | { type: 'label_added'; label: string }
  | { type: 'stage_changed'; stage: Stage }
  | { type: 'schedule'; frequency: 'daily' | 'weekly'; time: string; weekday?: number };
type BranchStep = { id: string; type: 'branch'; condition: FlowCondition; then: FlowStep[]; else: FlowStep[] };
type ActionStep =
  | { id: string; type: 'add_label' | 'remove_label'; label: string }
  | { id: string; type: 'assign'; memberId: string }
  | { id: string; type: 'create_task'; title: string; dueInMinutes: number; assignTo: 'conversation_assignee' | 'member' | 'none'; memberId?: string; notes?: string }
  | { id: string; type: 'wait'; minutes: number; cancelOnReply: boolean }
  | { id: string; type: 'send_message'; text?: string; templateId?: string; templateVersion?: number; greeting: boolean }
  | { id: string; type: 'request_handoff'; note?: string }
  | { id: string; type: 'close_conversation' | 'reopen_conversation' }
  | { id: string; type: 'set_stage'; stage: Stage };
export type FlowStep = ActionStep | BranchStep;
export type FlowDefinition = { version: 1; trigger: FlowTrigger; conditions: FlowCondition[]; steps: FlowStep[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'ต้องเป็นเวลา HH:MM');
const ref = z.string().regex(UUID, 'รหัสไม่ถูกต้อง');
const label = z.string().trim().min(1).max(40);
const stageEnum = z.enum(flowStages);
const conditionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('provider'), providers: z.array(z.enum(['whatsapp', 'line', 'facebook', 'web'])).min(1).max(4), accountId: z.string().trim().min(1).max(200).optional() }),
  z.strictObject({ type: z.literal('market'), markets: z.array(z.enum(['unknown', 'domestic', 'export'])).min(1).max(3) }),
  z.strictObject({ type: z.literal('language'), languages: z.array(z.enum(['th', 'en', 'other'])).min(1).max(3) }),
  z.strictObject({ type: z.literal('business_hours'), inside: z.boolean(), days: z.array(z.number().int().min(0).max(6)).min(1).max(7), start: hhmm, end: hhmm }),
  z.strictObject({ type: z.literal('customer_field'), field: z.enum(['name', 'phone', 'email', 'stage', 'source', 'interests', 'tags']), operator: z.enum(['equals', 'not_equals', 'contains', 'not_contains', 'is_empty', 'is_not_empty']), value: z.string().trim().max(200).optional() }),
  z.strictObject({ type: z.literal('assignment'), state: z.enum(['assigned', 'unassigned', 'assigned_to']), memberId: ref.optional() }),
  z.strictObject({ type: z.literal('consent'), state: z.enum(['recorded', 'not_recorded']) }),
]);
const triggerSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('inbound_message') }),
  z.strictObject({ type: z.literal('new_conversation') }),
  z.strictObject({ type: z.literal('keyword'), keywords: z.array(z.string().trim().min(1).max(80)).min(1).max(20), match: z.enum(['contains', 'exact', 'starts_with']) }),
  z.strictObject({ type: z.literal('label_added'), label }),
  z.strictObject({ type: z.literal('stage_changed'), stage: stageEnum }),
  z.strictObject({ type: z.literal('schedule'), frequency: z.enum(['daily', 'weekly']), time: hhmm, weekday: z.number().int().min(0).max(6).optional() }),
]);
const stepId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, 'รหัสขั้นตอนไม่ถูกต้อง');
const stepSchema: z.ZodType<unknown> = z.lazy(() => z.discriminatedUnion('type', [
  z.strictObject({ id: stepId, type: z.literal('add_label'), label }),
  z.strictObject({ id: stepId, type: z.literal('remove_label'), label }),
  z.strictObject({ id: stepId, type: z.literal('assign'), memberId: ref }),
  z.strictObject({ id: stepId, type: z.literal('create_task'), title: z.string().trim().min(1).max(200), dueInMinutes: z.number().int().min(0).max(525_600), assignTo: z.enum(['conversation_assignee', 'member', 'none']), memberId: ref.optional(), notes: z.string().trim().max(2000).optional() }),
  z.strictObject({ id: stepId, type: z.literal('wait'), minutes: z.number().int().min(1).max(43_200), cancelOnReply: z.boolean() }),
  z.strictObject({ id: stepId, type: z.literal('branch'), condition: conditionSchema, then: z.array(stepSchema).max(FLOW_LIMITS.totalSteps), else: z.array(stepSchema).max(FLOW_LIMITS.totalSteps) }),
  z.strictObject({ id: stepId, type: z.literal('send_message'), text: z.string().trim().min(1).max(2000).optional(), templateId: ref.optional(), templateVersion: z.number().int().min(1).optional(), greeting: z.boolean() }),
  z.strictObject({ id: stepId, type: z.literal('request_handoff'), note: z.string().trim().max(500).optional() }),
  z.strictObject({ id: stepId, type: z.literal('close_conversation') }),
  z.strictObject({ id: stepId, type: z.literal('reopen_conversation') }),
  z.strictObject({ id: stepId, type: z.literal('set_stage'), stage: stageEnum }),
]));
const definitionSchema = z.strictObject({ version: z.literal(1), trigger: triggerSchema, conditions: z.array(conditionSchema).max(FLOW_LIMITS.conditions), steps: z.array(stepSchema).min(1).max(FLOW_LIMITS.totalSteps) });

const invalid = (where: string, message: string) => new ApiError(400, `ข้อกำหนดระบบอัตโนมัติไม่ถูกต้อง (${where}): ${message}`);
function checkCondition(condition: FlowCondition, where: string) {
  if (condition.type === 'customer_field') {
    const needsValue = !['is_empty', 'is_not_empty'].includes(condition.operator);
    if (needsValue && !condition.value) throw invalid(where, 'กรุณาระบุค่าที่ใช้เปรียบเทียบ');
    if (condition.field === 'tags' && ['equals', 'not_equals'].includes(condition.operator)) throw invalid(where, 'แท็กใช้ได้เฉพาะ มี/ไม่มี/ว่าง/ไม่ว่าง');
  }
  if (condition.type === 'assignment' && (condition.state === 'assigned_to') !== !!condition.memberId) throw invalid(where, 'เลือกสมาชิกทีมเฉพาะเมื่อกำหนดผู้รับผิดชอบเป็นบุคคล');
  if (condition.type === 'business_hours' && condition.start === condition.end) throw invalid(where, 'เวลาเริ่มและสิ้นสุดต้องต่างกัน');
}
/** Zod structure plus semantic rules. `published` additionally requires pinned send text. */
export function validateDefinition(raw: unknown, mode: 'draft' | 'published' = 'draft'): FlowDefinition {
  const parsed = definitionSchema.safeParse(raw);
  if (!parsed.success) { const issue = parsed.error.issues[0]; throw invalid(issue?.path.join('.') || 'definition', issue?.message || 'invalid'); }
  const definition = parsed.data as FlowDefinition;
  const ids = new Set<string>(); let total = 0;
  const walk = (steps: FlowStep[], depth: number, where: string) => {
    if (depth > FLOW_LIMITS.branchDepth) throw invalid(where, `แยกเงื่อนไขซ้อนได้ไม่เกิน ${FLOW_LIMITS.branchDepth} ชั้น`);
    steps.forEach((step, index) => {
      const at = `${where}.${index}`;
      if (ids.has(step.id)) throw invalid(at, 'รหัสขั้นตอนซ้ำ'); ids.add(step.id);
      if (++total > FLOW_LIMITS.totalSteps) throw invalid(at, `รองรับไม่เกิน ${FLOW_LIMITS.totalSteps} ขั้นตอน`);
      if (step.type === 'request_handoff' && index !== steps.length - 1) throw invalid(at, 'ส่งต่อเจ้าหน้าที่ต้องเป็นขั้นตอนสุดท้ายของชุด');
      if (step.type === 'create_task' && (step.assignTo === 'member') !== !!step.memberId) throw invalid(at, 'เลือกสมาชิกทีมเมื่อมอบหมายงานให้บุคคล');
      if (step.type === 'send_message') {
        if (mode === 'draft' && !!step.text === !!step.templateId) throw invalid(at, 'เลือกพิมพ์ข้อความหรือข้อความสำเร็จรูปอย่างใดอย่างหนึ่ง');
        if (mode === 'published' && !step.text) throw invalid(at, 'รุ่นที่เผยแพร่ต้องมีข้อความที่อนุมัติแล้ว');
      }
      if (step.type === 'branch') { checkCondition(step.condition, at + '.condition'); walk(step.then, depth + 1, at + '.then'); walk(step.else, depth + 1, at + '.else'); }
    });
  };
  definition.conditions.forEach((condition, index) => checkCondition(condition, `conditions.${index}`));
  walk(definition.steps, 0, 'steps');
  const t = definition.trigger;
  if (t.type === 'schedule' && (t.frequency === 'weekly') !== (t.weekday !== undefined)) throw invalid('trigger', 'กำหนดวันในสัปดาห์เฉพาะรอบรายสัปดาห์');
  return definition;
}
export const defaultFlowDefinition = (): FlowDefinition => ({ version: 1, trigger: { type: 'inbound_message' }, conditions: [], steps: [{ id: 's1', type: 'add_label', label: 'ติดตาม' }] });

// ---------------------------------------------------------------------------------------------
// Compilation: branches become forward-only jumps, so a program can never loop.
// ---------------------------------------------------------------------------------------------
type Instr = { op: 'act'; step: ActionStep } | { op: 'unless'; stepId: string; condition: FlowCondition; target: number } | { op: 'jump'; stepId: string; target: number };
export function compileFlow(steps: FlowStep[]): Instr[] {
  const program: Instr[] = [];
  const emit = (list: FlowStep[]) => {
    for (const step of list) {
      if (step.type !== 'branch') { program.push({ op: 'act', step }); continue; }
      const test: Instr & { op: 'unless' } = { op: 'unless', stepId: step.id, condition: step.condition, target: -1 };
      program.push(test); emit(step.then);
      if (step.else.length) { const skip: Instr & { op: 'jump' } = { op: 'jump', stepId: step.id, target: -1 }; program.push(skip); test.target = program.length; emit(step.else); skip.target = program.length; }
      else test.target = program.length;
    }
  };
  emit(steps);
  return program;
}
function walkSteps(steps: FlowStep[], visit: (step: FlowStep) => void) { for (const step of steps) { visit(step); if (step.type === 'branch') { walkSteps(step.then, visit); walkSteps(step.else, visit); } } }
function mapSteps(steps: FlowStep[], map: (step: ActionStep) => ActionStep): FlowStep[] {
  return steps.map(step => step.type === 'branch' ? { ...step, then: mapSteps(step.then, map), else: mapSteps(step.else, map) } : map(step));
}

// ---------------------------------------------------------------------------------------------
// Subject state, triggers and conditions
// ---------------------------------------------------------------------------------------------
type Subject = { conversation: Row; lead: Row; identity: Row | null; lastCustomerText: string };
async function loadSubject(c: Executor, orgId: string, conversationId: string): Promise<Subject | null> {
  const conversation = (await c.query('SELECT * FROM conversations WHERE org_id=$1 AND id=$2', [orgId, conversationId])).rows[0];
  if (!conversation) return null;
  const lead = (await c.query('SELECT * FROM leads WHERE org_id=$1 AND id=$2', [orgId, conversation.lead_id])).rows[0];
  if (!lead) return null;
  const identity = (await c.query('SELECT * FROM social_identities WHERE org_id=$1 AND conversation_id=$2', [orgId, conversationId])).rows[0] || null;
  const last = (await c.query("SELECT content FROM messages WHERE org_id=$1 AND conversation_id=$2 AND role='user' ORDER BY customer_seq DESC LIMIT 1", [orgId, conversationId])).rows[0];
  return { conversation, lead, identity, lastCustomerText: String(last?.content || '') };
}
const tagsOf = (lead: Row): string[] => Array.isArray(lead.tags) ? lead.tags.map(String) : [];
export function detectLanguage(text: string): 'th' | 'en' | 'other' { return /[฀-๿]/.test(text) ? 'th' : /[A-Za-z]/.test(text) ? 'en' : 'other'; }
const minutesOf = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
/** Asia/Bangkok is UTC+7 without daylight saving. */
function bangkok(ms: number) { const local = new Date(ms + 7 * 3600_000); return { day: local.getUTCDay(), minutes: local.getUTCHours() * 60 + local.getUTCMinutes() }; }
export function evaluateCondition(condition: FlowCondition, subject: Subject, now: number, text?: string): { passed: boolean; detail: string } {
  const { lead, conversation, identity } = subject;
  switch (condition.type) {
    case 'provider': {
      const provider = identity?.provider || 'web';
      const passed = condition.providers.includes(provider) && (!condition.accountId || identity?.account_id === condition.accountId);
      return { passed, detail: `ช่องทาง ${provider}` };
    }
    case 'market': return { passed: condition.markets.includes(lead.market), detail: `ตลาด ${lead.market}` };
    case 'language': { const language = detectLanguage(text ?? subject.lastCustomerText); return { passed: condition.languages.includes(language), detail: `ภาษา ${language}` }; }
    case 'business_hours': {
      const { day, minutes } = bangkok(now), start = minutesOf(condition.start), end = minutesOf(condition.end);
      const inside = start < end ? condition.days.includes(day) && minutes >= start && minutes < end
        : (condition.days.includes(day) && minutes >= start) || (condition.days.includes((day + 6) % 7) && minutes < end);
      return { passed: inside === condition.inside, detail: inside ? 'อยู่ในเวลาทำการ' : 'นอกเวลาทำการ' };
    }
    case 'customer_field': {
      if (condition.field === 'tags') {
        const tags = tagsOf(lead), wanted = (condition.value || '').toLowerCase(), has = tags.some(tag => tag.toLowerCase() === wanted);
        const passed = condition.operator === 'contains' ? has : condition.operator === 'not_contains' ? !has : condition.operator === 'is_empty' ? !tags.length : !!tags.length;
        return { passed, detail: `แท็ก ${tags.join(', ') || '—'}` };
      }
      const value = String(lead[condition.field] ?? '').trim().toLowerCase(), target = (condition.value || '').toLowerCase();
      const passed = { equals: value === target, not_equals: value !== target, contains: value.includes(target), not_contains: !value.includes(target), is_empty: !value, is_not_empty: !!value }[condition.operator];
      return { passed, detail: `${condition.field} ${value ? 'มีค่า' : 'ว่าง'}` };
    }
    case 'assignment': {
      const owner = conversation.assignee_id || null;
      const passed = condition.state === 'assigned' ? !!owner : condition.state === 'unassigned' ? !owner : owner === condition.memberId;
      return { passed, detail: owner ? 'มีผู้รับผิดชอบ' : 'ยังไม่มีผู้รับผิดชอบ' };
    }
    case 'consent': {
      const recorded = !!(lead.contact_consent_at && lead.contact_consent_version);
      return { passed: recorded === (condition.state === 'recorded'), detail: recorded ? 'มีหลักฐานความยินยอม' : 'ยังไม่มีหลักฐานความยินยอม' };
    }
  }
}
export function keywordMatches(trigger: Extract<FlowTrigger, { type: 'keyword' }>, text: string) {
  const value = text.trim().toLowerCase();
  return trigger.keywords.some(keyword => { const k = keyword.toLowerCase(); return trigger.match === 'exact' ? value === k : trigger.match === 'starts_with' ? value.startsWith(k) : value.includes(k); });
}
/** Most recent scheduled slot (UTC ms) at or before `now`. */
export function latestSlot(trigger: Extract<FlowTrigger, { type: 'schedule' }>, now: number) {
  const local = now + 7 * 3600_000, day = new Date(local).getUTCDay(), midnight = local - (local % 86_400_000);
  let slot = midnight + minutesOf(trigger.time) * 60_000;
  if (trigger.frequency === 'weekly') slot -= (((day - (trigger.weekday ?? 0)) % 7) + 7) % 7 * 86_400_000;
  if (slot > local) slot -= (trigger.frequency === 'weekly' ? 7 : 1) * 86_400_000;
  return slot - 7 * 3600_000;
}

// ---------------------------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------------------------
type Version = { id: string; version: number; publishedBy: string; definition: FlowDefinition };
const versionCache = new Map<string, Version>();
async function loadVersion(c: Executor, orgId: string, flowId: string, version: number): Promise<Version> {
  const key = `${orgId}:${flowId}:${version}`, cached = versionCache.get(key);
  if (cached) return cached;
  const row = (await c.query('SELECT definition,published_by FROM flow_versions WHERE org_id=$1 AND flow_id=$2 AND version=$3', [orgId, flowId, version])).rows[0];
  if (!row) throw new ApiError(404, 'ไม่พบรุ่นของระบบอัตโนมัติ');
  const value = { id: flowId, version, publishedBy: String(row.published_by), definition: JSON.parse(String(row.definition)) as FlowDefinition };
  if (versionCache.size > 500) versionCache.clear();
  versionCache.set(key, value);
  return value;
}
async function publishedFlows(c: Executor, orgId: string): Promise<Version[]> {
  const rows = (await c.query("SELECT id,current_version FROM flows WHERE org_id=$1 AND status='published' AND current_version IS NOT NULL ORDER BY created_at,id LIMIT $2", [orgId, FLOW_LIMITS.flowsPerOrg])).rows;
  const result: Version[] = [];
  for (const row of rows) result.push(await loadVersion(c, orgId, row.id, Number(row.current_version)));
  return result;
}
async function globallyPaused(c: Executor, orgId: string) { return Number((await c.query('SELECT paused FROM flow_controls WHERE org_id=$1', [orgId])).rows[0]?.paused || 0) === 1; }
async function logStep(c: Executor, orgId: string, executionId: string, index: number, stepId: string, action: string, outcome: string, detail: Row, at: string) {
  await c.query('INSERT INTO flow_execution_steps(id,org_id,execution_id,step_index,step_id,action,outcome,detail,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [randomUUID(), orgId, executionId, index, stepId, action, outcome, JSON.stringify(detail), at]);
}
async function cancelExecutionRow(c: Executor, row: Row, reason: string, at: string) {
  await c.query("UPDATE flow_executions SET status='cancelled',cancel_reason=$3,lease_token='',lease_until='',finished_at=$4,updated_at=$4 WHERE org_id=$1 AND id=$2", [row.org_id, row.id, reason, at]);
  await logStep(c, row.org_id, row.id, Number(row.step_index), 'execution', 'cancel', 'cancelled', { reason }, at);
}
/** Set-based, so the D1 batch stays two statements however many executions are pending. */
async function cancelConversationExecutions(c: Executor, orgId: string, conversationId: string, scope: 'active' | 'reply', reason: string, at: string, exceptId = '') {
  const filter = scope === 'active' ? "status IN ('running','waiting')" : "status='waiting' AND cancel_on_reply=1", where = `org_id=$1 AND conversation_id=$2 AND id!=$3 AND ${filter}`;
  const count = Number((await c.query(`SELECT count(*) AS n FROM flow_executions WHERE ${where}`, [orgId, conversationId, exceptId])).rows[0].n);
  if (!count) return 0;
  // Log first: the batch runs in order, so the log reads the rows before they are cancelled.
  await c.query(`INSERT INTO flow_execution_steps(id,org_id,execution_id,step_index,step_id,action,outcome,detail,created_at) SELECT lower(hex(randomblob(16))),org_id,id,step_index,'execution','cancel','cancelled',json_object('reason',$4),$5 FROM flow_executions WHERE ${where}`, [orgId, conversationId, exceptId, reason, at]);
  await c.query(`UPDATE flow_executions SET status='cancelled',cancel_reason=$4,lease_token='',lease_until='',finished_at=$5,updated_at=$5 WHERE ${where}`, [orgId, conversationId, exceptId, reason, at]);
  return count;
}
type Origin = { flowId: string; executionId: string; chain: string; depth: number };
/** Stage-only planner write: records label additions and stage changes as durable flow events. */
export async function recordLeadChange(c: Executor, orgId: string, leadId: string, before: { tags: unknown; stage: unknown }, after: { tags: unknown; stage: unknown }, origin?: Origin, at = stamp(Date.now())) {
  const list = (value: unknown) => Array.isArray(value) ? value.map(String) : [];
  const previous = new Set(list(before.tags).map(tag => tag.toLowerCase()));
  const changes: Array<[string, string, string]> = list(after.tags).filter(tag => !previous.has(tag.toLowerCase())).map(tag => ['label_added', tag, '']);
  if (typeof after.stage === 'string' && after.stage !== before.stage) changes.push(['stage_changed', after.stage, String(before.stage ?? '')]);
  for (const [kind, value, previousValue] of changes) await c.query('INSERT INTO flow_events(id,org_id,kind,lead_id,value,previous_value,origin_flow_id,origin_execution_id,flow_chain,depth,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [randomUUID(), orgId, kind, leadId, value, previousValue, origin?.flowId ?? null, origin?.executionId ?? null, origin?.chain ?? '', origin?.depth ?? 0, at]);
}

// ---------------------------------------------------------------------------------------------
// Send gates shared by the engine and the simulator. The outbound queue re-checks everything.
// ---------------------------------------------------------------------------------------------
export const sendBlockReasons: Record<string, string> = {
  sending_disabled: 'การส่งข้อความอัตโนมัติปิดอยู่ (FLOWS_SEND_ENABLED)', greeting_already_sent: 'บทสนทนานี้ได้รับข้อความต้อนรับแล้ว',
  non_social_channel: 'ส่งได้เฉพาะ WhatsApp, LINE และ Facebook ที่ CRM เป็นเจ้าของ', opted_out: 'ลูกค้าขอหยุดรับข้อความ',
  human_takeover: 'เจ้าหน้าที่รับช่วงแล้ว ระบบอัตโนมัติจะไม่ส่ง', conversation_closed: 'บทสนทนาปิดแล้ว',
  channel_not_live: 'ช่องทางยังไม่เปิดส่งจริง', channel_stopped: 'ช่องทางถูกหยุดส่งหรือยังไม่เปิดส่ง', consent_missing: 'ยังไม่มีหลักฐานความยินยอม WhatsApp',
  daily_limit: 'ถึงขีดจำกัดข้อความอัตโนมัติต่อวัน', approver_inactive: 'ผู้เผยแพร่ไม่ใช่ผู้ดูแลระบบที่ใช้งานอยู่', template_missing: 'ไม่พบข้อความสำเร็จรูป',
};
function sendBlocker(env: Env, subject: Subject, greeting: boolean, greetingSent: boolean): string | null {
  if (!flowSendsEnabled(env)) return 'sending_disabled';
  if (greeting && greetingSent) return 'greeting_already_sent';
  if (!subject.identity) return 'non_social_channel';
  if (subject.identity.opt_out) return 'opted_out';
  if (subject.conversation.status === 'human_active') return 'human_takeover';
  if (subject.conversation.status === 'resolved') return 'conversation_closed';
  return null;
}
async function channelBlocker(c: Executor, ctx: Ctx, subject: Subject): Promise<string | null> {
  const identity = subject.identity!;
  const config = ctx.dispatch.config ?? readSocialConfig(identity.provider as SocialProvider, ctx.env as Record<string, string | undefined>);
  if (config.owner !== 'crm' || !config.inboundEnabled || !config.liveEnabled || config.provider !== identity.provider || config.accountId !== identity.account_id) return 'channel_not_live';
  const controls = (await c.query('SELECT send_enabled,emergency_stop FROM social_channel_controls WHERE org_id=$1 AND provider=$2 AND account_id=$3', [identity.org_id, identity.provider, identity.account_id])).rows[0];
  if (!controls || !Number(controls.send_enabled) || Number(controls.emergency_stop)) return 'channel_stopped';
  if (identity.provider === 'whatsapp' && !(subject.lead.contact_consent_at && subject.lead.contact_consent_version)) return 'consent_missing';
  return null;
}
const dailyLimit = (env: Env) => Math.max(1, Math.min(5000, Number.parseInt(String(env.FLOWS_DAILY_SEND_LIMIT || '200'), 10) || 200));
const bangkokDayStart = (now: number) => { const local = now + 7 * 3600_000; return local - (local % 86_400_000) - 7 * 3600_000; };

/** Called by the social outbound guard for every queued intent. Returns true for a Flow intent. */
export async function flowOutboundGuard(c: Executor, command: Row): Promise<boolean> {
  const link = (await c.query('SELECT * FROM flow_outbound_commands WHERE org_id=$1 AND outbound_command_id=$2', [command.org_id, command.id])).rows[0];
  if (!link) return false;
  if (!flowSendsEnabled(process.env)) throw new ApiError(503, 'Flow sending is disabled');
  if (link.approved_by !== command.approved_by) throw new ApiError(409, 'Flow approval linkage changed');
  if (await globallyPaused(c, command.org_id)) throw new ApiError(503, 'Flows are paused');
  const flow = (await c.query('SELECT status FROM flows WHERE org_id=$1 AND id=$2', [command.org_id, link.flow_id])).rows[0];
  if (flow?.status !== 'published') throw new ApiError(409, 'Flow is paused or unpublished');
  const execution = (await c.query('SELECT status FROM flow_executions WHERE org_id=$1 AND id=$2', [command.org_id, link.execution_id])).rows[0];
  if (!execution || ['cancelled', 'failed'].includes(execution.status)) throw new ApiError(409, 'Flow execution stopped');
  const approver = (await c.query('SELECT role,active FROM members WHERE org_id=$1 AND id=$2', [command.org_id, link.approved_by])).rows[0];
  if (!approver?.active || approver.role !== 'Admin') throw new ApiError(409, 'Flow approver is no longer an active Admin');
  return true;
}

// ---------------------------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------------------------
type StartInput = { orgId: string; flow: Version; conversationId: string; triggerKind: string; triggerEventId: string; triggerKey: string; text?: string; chain?: string; depth?: number };
async function startExecution(ctx: Ctx, input: StartInput): Promise<{ id?: string; skipped?: string }> {
  const { orgId, flow } = input, now = ctx.now(), at = stamp(now);
  return transaction(orgId, async c => {
    if (await globallyPaused(c, orgId)) return { skipped: 'global_pause' };
    const current = (await c.query('SELECT status,current_version FROM flows WHERE org_id=$1 AND id=$2', [orgId, flow.id])).rows[0];
    if (current?.status !== 'published' || Number(current.current_version) !== flow.version) return { skipped: 'flow_not_published' };
    if ((await c.query('SELECT 1 FROM flow_executions WHERE org_id=$1 AND flow_id=$2 AND trigger_key=$3 LIMIT 1', [orgId, flow.id, input.triggerKey])).rows.length) return { skipped: 'duplicate_trigger' };
    const subject = await loadSubject(c, orgId, input.conversationId);
    if (!subject) return { skipped: 'subject_missing' };
    if (subject.identity?.opt_out) return { skipped: 'opted_out' };
    const hourAgo = stamp(now - 3600_000);
    const perFlow = Number((await c.query('SELECT count(*) AS n FROM flow_executions WHERE org_id=$1 AND conversation_id=$2 AND flow_id=$3 AND started_at>$4', [orgId, input.conversationId, flow.id, hourAgo])).rows[0].n);
    const perSubject = Number((await c.query('SELECT count(*) AS n FROM flow_executions WHERE org_id=$1 AND conversation_id=$2 AND started_at>$3', [orgId, input.conversationId, hourAgo])).rows[0].n);
    if (perFlow >= FLOW_LIMITS.perFlowSubjectHour || perSubject >= FLOW_LIMITS.perSubjectHour) return { skipped: 'rate_limited' };
    for (const condition of flow.definition.conditions) if (!evaluateCondition(condition, subject, now, input.text).passed) return { skipped: 'conditions_not_met' };
    const id = randomUUID();
    await c.query("INSERT INTO flow_executions(id,org_id,flow_id,version,conversation_id,lead_id,trigger_kind,trigger_event_id,trigger_key,status,step_index,wake_at,chain_depth,flow_chain,started_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'running',0,$10,$11,$12,$10,$10)",
      [id, orgId, flow.id, flow.version, input.conversationId, subject.lead.id, input.triggerKind, input.triggerEventId, input.triggerKey, at, input.depth ?? 0, input.chain ?? '']);
    await logStep(c, orgId, id, 0, 'trigger', input.triggerKind, 'started', { version: flow.version }, at);
    return { id };
  });
}

type StepResult = { outcome: string; detail?: Row; stop?: boolean; wait?: { until: number; cancelOnReply: boolean; customerSeq: number }; commandId?: string };
type Running = { orgId: string; executionId: string; token: string; flow: Version; program: Instr[] };
async function performAction(c: Executor, ctx: Ctx, run: Running, execution: Row, subject: Subject, step: ActionStep): Promise<StepResult> {
  const { orgId } = run, now = ctx.now(), at = stamp(now), { lead, conversation } = subject;
  const origin: Origin = { flowId: run.flow.id, executionId: run.executionId, chain: [execution.flow_chain, run.flow.id].filter(Boolean).join(','), depth: Number(execution.chain_depth) + 1 };
  const audit = (action: string, metadata: Row) => c.query('INSERT INTO audit_events(id,org_id,actor_id,action,entity_id,metadata) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), orgId, 'flow:' + run.flow.id, action, conversation.id, JSON.stringify({ flowId: run.flow.id, version: run.flow.version, executionId: run.executionId, stepId: step.id, ...metadata })]);
  switch (step.type) {
    case 'add_label': case 'remove_label': {
      const tags = tagsOf(lead), has = tags.some(tag => tag.toLowerCase() === step.label.toLowerCase());
      if (step.type === 'add_label' ? has : !has) return { outcome: 'unchanged', detail: { label: step.label } };
      if (step.type === 'add_label' && tags.length >= 20) return { outcome: 'skipped', detail: { reason: 'tag_limit' } };
      const next = step.type === 'add_label' ? [...tags, step.label] : tags.filter(tag => tag.toLowerCase() !== step.label.toLowerCase());
      await c.query('UPDATE leads SET tags=$3,updated_at=$4 WHERE org_id=$1 AND id=$2', [orgId, lead.id, JSON.stringify(next), at]);
      await recordLeadChange(c, orgId, lead.id, { tags, stage: lead.stage }, { tags: next, stage: lead.stage }, origin, at);
      return { outcome: 'done', detail: { label: step.label } };
    }
    case 'set_stage': {
      if (lead.stage === step.stage) return { outcome: 'unchanged', detail: { stage: step.stage } };
      await c.query('UPDATE leads SET stage=$3,updated_at=$4 WHERE org_id=$1 AND id=$2', [orgId, lead.id, step.stage, at]);
      await recordLeadChange(c, orgId, lead.id, { tags: lead.tags, stage: lead.stage }, { tags: lead.tags, stage: step.stage }, origin, at);
      return { outcome: 'done', detail: { previous: lead.stage, stage: step.stage } };
    }
    case 'assign': {
      if (!(await c.query('SELECT 1 FROM members WHERE org_id=$1 AND id=$2 AND active=1', [orgId, step.memberId])).rows.length) return { outcome: 'skipped', detail: { reason: 'member_inactive' } };
      if (conversation.status === 'human_active' && conversation.assignee_id && conversation.assignee_id !== step.memberId) return { outcome: 'skipped', detail: { reason: 'human_takeover' } };
      if (conversation.assignee_id === step.memberId && lead.assignee_id === step.memberId) return { outcome: 'unchanged', detail: {} };
      await c.query('UPDATE conversations SET assignee_id=$3,updated_at=$4 WHERE org_id=$1 AND id=$2', [orgId, conversation.id, step.memberId, at]);
      await c.query('UPDATE leads SET assignee_id=$3,updated_at=$4 WHERE org_id=$1 AND id=$2', [orgId, lead.id, step.memberId, at]);
      return { outcome: 'done', detail: { memberId: step.memberId } };
    }
    case 'create_task': {
      let owner: string | null = step.assignTo === 'conversation_assignee' ? conversation.assignee_id || lead.assignee_id || null : null;
      if (step.assignTo === 'member' && (await c.query('SELECT 1 FROM members WHERE org_id=$1 AND id=$2 AND active=1', [orgId, step.memberId])).rows.length) owner = step.memberId!;
      const id = randomUUID();
      await c.query("INSERT INTO tasks(id,org_id,lead_id,title,due_at,kind,status,assignee_id,notes) VALUES($1,$2,$3,$4,$5,'followup','open',$6,$7)", [id, orgId, lead.id, step.title, stamp(now + step.dueInMinutes * 60_000), owner, step.notes || '']);
      return { outcome: 'done', detail: { taskId: id, assigneeId: owner } };
    }
    case 'wait':
      return { outcome: 'waiting', detail: { minutes: step.minutes, cancelOnReply: step.cancelOnReply }, wait: { until: now + step.minutes * 60_000, cancelOnReply: step.cancelOnReply, customerSeq: Number(conversation.customer_message_seq || 0) } };
    case 'send_message': {
      const greetingSent = step.greeting && (await c.query('SELECT 1 FROM flow_greetings WHERE org_id=$1 AND conversation_id=$2', [orgId, conversation.id])).rows.length > 0;
      const blocked = sendBlocker(ctx.env, subject, step.greeting, greetingSent) ?? await channelBlocker(c, ctx, subject);
      if (blocked) return { outcome: blocked === 'greeting_already_sent' ? 'skipped' : 'blocked', detail: { reason: blocked } };
      const approver = (await c.query('SELECT role,active FROM members WHERE org_id=$1 AND id=$2', [orgId, run.flow.publishedBy])).rows[0];
      if (!approver?.active || approver.role !== 'Admin') return { outcome: 'blocked', detail: { reason: 'approver_inactive' } };
      const sentToday = Number((await c.query('SELECT count(*) AS n FROM flow_outbound_commands WHERE org_id=$1 AND created_at>=$2', [orgId, stamp(bangkokDayStart(now))])).rows[0].n);
      if (sentToday >= dailyLimit(ctx.env)) return { outcome: 'blocked', detail: { reason: 'daily_limit' } };
      const messageId = randomUUID(), text = step.text!;
      await c.query("INSERT INTO messages(id,org_id,conversation_id,role,content) VALUES($1,$2,$3,'agent',$4)", [messageId, orgId, conversation.id, text]);
      const { enqueueSocialReply } = await import('./social-channels');
      const intent = await enqueueSocialReply(c, orgId, conversation.id, messageId, text, { approvedBy: run.flow.publishedBy, metadata: { flow: { flowId: run.flow.id, version: run.flow.version, executionId: run.executionId, stepId: step.id, greeting: step.greeting } } });
      if (!intent.commandId) return { outcome: 'blocked', detail: { reason: 'non_social_channel' } };
      await c.query('INSERT INTO flow_outbound_commands(org_id,outbound_command_id,execution_id,flow_id,version,step_id,approved_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [orgId, intent.commandId, run.executionId, run.flow.id, run.flow.version, step.id, run.flow.publishedBy, at]);
      if (step.greeting) await c.query('INSERT INTO flow_greetings(org_id,conversation_id,execution_id,created_at) VALUES($1,$2,$3,$4)', [orgId, conversation.id, run.executionId, at]);
      await c.query('UPDATE conversations SET updated_at=$3 WHERE org_id=$1 AND id=$2', [orgId, conversation.id, at]);
      await audit('flow.send_queued', { messageId, outboundCommandId: intent.commandId, greeting: step.greeting });
      return { outcome: 'queued', detail: { messageId, outboundCommandId: intent.commandId }, commandId: intent.commandId };
    }
    case 'request_handoff': {
      if (conversation.status === 'bot_active') await c.query("UPDATE conversations SET status='waiting_human',version=version+1,generating_client_id=NULL,generation_started_at=NULL,handoff_at=COALESCE(handoff_at,$3),updated_at=$3 WHERE org_id=$1 AND id=$2", [orgId, conversation.id, at]);
      await c.query("INSERT INTO messages(id,org_id,conversation_id,role,content) VALUES($1,$2,$3,'note',$4)", [randomUUID(), orgId, conversation.id, step.note || 'ระบบอัตโนมัติขอส่งต่อให้เจ้าหน้าที่ดูแล']);
      await audit('flow.handoff_requested', { previousStatus: conversation.status });
      return { outcome: 'done', detail: { previousStatus: conversation.status }, stop: true };
    }
    case 'close_conversation': {
      if (conversation.status === 'human_active') return { outcome: 'skipped', detail: { reason: 'human_takeover' } };
      if (conversation.status === 'resolved') return { outcome: 'unchanged', detail: {} };
      await c.query("UPDATE conversations SET status='resolved',version=version+1,generating_client_id=NULL,generation_started_at=NULL,updated_at=$3 WHERE org_id=$1 AND id=$2", [orgId, conversation.id, at]);
      // Closing cancels every other pending automation for this conversation.
      await cancelConversationExecutions(c, orgId, conversation.id, 'active', 'conversation_closed', at, run.executionId);
      await audit('flow.conversation_closed', { previousStatus: conversation.status });
      return { outcome: 'done', detail: { previousStatus: conversation.status } };
    }
    case 'reopen_conversation': {
      if (conversation.status !== 'resolved') return { outcome: 'unchanged', detail: {} };
      await c.query("UPDATE conversations SET status='waiting_human',version=version+1,handoff_at=COALESCE(handoff_at,$3),updated_at=$3 WHERE org_id=$1 AND id=$2", [orgId, conversation.id, at]);
      await audit('flow.conversation_reopened', {});
      return { outcome: 'done', detail: {} };
    }
  }
}

type InstructionResult = { halt: true } | { halt: false; pc: number; done: boolean; waiting: boolean; commandId?: string };
async function runInstruction(c: Executor, ctx: Ctx, run: Running, pc: number): Promise<InstructionResult> {
  const { orgId, executionId, program } = run, at = stamp(ctx.now());
  const execution = (await c.query('SELECT * FROM flow_executions WHERE org_id=$1 AND id=$2', [orgId, executionId])).rows[0];
  if (!execution || execution.status !== 'running' || execution.lease_token !== run.token || Number(execution.step_index) !== pc) return { halt: true };
  const flow = (await c.query('SELECT status FROM flows WHERE org_id=$1 AND id=$2', [orgId, run.flow.id])).rows[0];
  if (flow?.status !== 'published' || await globallyPaused(c, orgId)) {
    // Emergency pause: stop here and keep the position; resuming continues from the same step.
    await c.query("UPDATE flow_executions SET lease_token='',lease_until='',updated_at=$3 WHERE org_id=$1 AND id=$2", [orgId, executionId, at]);
    return { halt: true };
  }
  const subject = await loadSubject(c, orgId, execution.conversation_id);
  if (!subject) throw new ApiError(404, 'subject_missing');
  const instr = program[pc];
  let next = pc + 1, result: StepResult;
  if (instr.op === 'jump') { next = instr.target; result = { outcome: 'jump' }; }
  else if (instr.op === 'unless') {
    const evaluated = evaluateCondition(instr.condition, subject, ctx.now());
    if (!evaluated.passed) next = instr.target;
    result = { outcome: evaluated.passed ? 'then' : 'else', detail: { condition: instr.condition.type, observed: evaluated.detail } };
  } else result = await performAction(c, ctx, run, execution, subject, instr.step);
  const done = !!result.stop || next >= program.length;
  if (result.wait) {
    await c.query("UPDATE flow_executions SET status='waiting',step_index=$3,steps_run=steps_run+1,wake_at=$4,wait_customer_seq=$5,cancel_on_reply=$6,lease_token='',lease_until='',updated_at=$7 WHERE org_id=$1 AND id=$2", [orgId, executionId, next, stamp(result.wait.until), result.wait.customerSeq, result.wait.cancelOnReply ? 1 : 0, at]);
  } else if (done) {
    await c.query("UPDATE flow_executions SET status='completed',step_index=$3,steps_run=steps_run+1,lease_token='',lease_until='',finished_at=$4,updated_at=$4 WHERE org_id=$1 AND id=$2", [orgId, executionId, Math.min(next, program.length), at]);
  } else {
    await c.query('UPDATE flow_executions SET step_index=$3,steps_run=steps_run+1,updated_at=$4 WHERE org_id=$1 AND id=$2', [orgId, executionId, next, at]);
  }
  if (instr.op !== 'jump') await logStep(c, orgId, executionId, pc, instr.op === 'act' ? instr.step.id : instr.stepId, instr.op === 'act' ? instr.step.type : 'branch', result.outcome, result.detail || {}, at);
  return { halt: false, pc: next, done, waiting: !!result.wait, commandId: result.commandId };
}

async function dispatchFlowSend(ctx: Ctx, orgId: string, commandId: string) {
  const { dispatchSocialReply } = await import('./social-channels');
  // The durable intent stays visible if this attempt is deferred; the outbound guard re-checks at every attempt.
  return dispatchSocialReply(orgId, commandId, ctx.dispatch).then(result => result.status, () => 'deferred');
}

/** Claims a due execution with a lease, runs at most FLOW_LIMITS.stepsPerRun instructions, then releases it. */
async function advanceExecution(ctx: Ctx, orgId: string, executionId: string): Promise<string> {
  const token = randomUUID();
  const claim = await transaction(orgId, async c => {
    const execution = (await c.query('SELECT * FROM flow_executions WHERE org_id=$1 AND id=$2', [orgId, executionId])).rows[0], at = stamp(ctx.now());
    if (!execution || !['running', 'waiting'].includes(execution.status) || execution.wake_at > at || (execution.lease_token && execution.lease_until > at)) return null;
    if (await globallyPaused(c, orgId)) return null;
    if ((await c.query('SELECT status FROM flows WHERE org_id=$1 AND id=$2', [orgId, execution.flow_id])).rows[0]?.status !== 'published') return null;
    if (execution.status === 'waiting') {
      // Durable cancellation: holds even if the inbound hook was missed.
      const subject = await loadSubject(c, orgId, execution.conversation_id);
      const reason = !subject ? 'subject_missing' : subject.identity?.opt_out ? 'opted_out' : subject.conversation.status === 'resolved' ? 'conversation_closed'
        : Number(execution.cancel_on_reply) && Number(subject.conversation.customer_message_seq || 0) > Number(execution.wait_customer_seq ?? 0) ? 'customer_replied' : '';
      if (reason) { await cancelExecutionRow(c, execution, reason, at); return { cancelled: reason }; }
    }
    await c.query("UPDATE flow_executions SET status='running',lease_token=$3,lease_until=$4,attempt=attempt+1,updated_at=$5 WHERE org_id=$1 AND id=$2", [orgId, executionId, token, stamp(ctx.now() + FLOW_LIMITS.leaseMs), at]);
    return { execution };
  });
  if (!claim) return 'skipped';
  if ('cancelled' in claim) return 'cancelled';
  const execution = claim.execution;
  const flow = await loadVersion(database, orgId, execution.flow_id, Number(execution.version));
  const run: Running = { orgId, executionId, token, flow, program: compileFlow(flow.definition.steps) };
  let pc = Number(execution.step_index);
  for (let count = 0; ; count++) {
    if (pc >= run.program.length) {
      await transaction(orgId, c => c.query("UPDATE flow_executions SET status='completed',lease_token='',lease_until='',finished_at=$4,updated_at=$4 WHERE org_id=$1 AND id=$2 AND lease_token=$3", [orgId, executionId, token, stamp(ctx.now())]));
      return 'completed';
    }
    if (count >= FLOW_LIMITS.stepsPerRun) {
      // Bounded work per run: yield and let the runner continue later.
      await transaction(orgId, async c => {
        await c.query("UPDATE flow_executions SET lease_token='',lease_until='',wake_at=$4,updated_at=$4 WHERE org_id=$1 AND id=$2 AND lease_token=$3", [orgId, executionId, token, stamp(ctx.now())]);
        await logStep(c, orgId, executionId, pc, 'execution', 'yield', 'yielded', { stepsPerRun: FLOW_LIMITS.stepsPerRun }, stamp(ctx.now()));
      });
      return 'yielded';
    }
    let result: InstructionResult;
    try { result = await transaction(orgId, c => runInstruction(c, ctx, run, pc)); }
    catch (error) {
      const code = error instanceof ApiError ? `api_${error.status}` : 'step_failed';
      await transaction(orgId, async c => {
        const row = (await c.query('SELECT * FROM flow_executions WHERE org_id=$1 AND id=$2', [orgId, executionId])).rows[0];
        if (!row || row.lease_token !== token) return;
        const at = stamp(ctx.now());
        await c.query("UPDATE flow_executions SET status='failed',error_code=$3,lease_token='',lease_until='',finished_at=$4,updated_at=$4 WHERE org_id=$1 AND id=$2", [orgId, executionId, code, at]);
        await logStep(c, orgId, executionId, pc, 'execution', 'fail', 'failed', { code }, at);
      }).catch(() => undefined);
      return 'failed';
    }
    if (result.halt) return 'halted';
    // Dispatch right after the commit, before later steps can change the conversation.
    if (result.commandId) await dispatchFlowSend(ctx, orgId, result.commandId);
    if (result.waiting) return 'waiting';
    if (result.done) return 'completed';
    pc = result.pc;
  }
}

/** Inbound hook, called only after the social inbound transaction has committed. */
export async function onInboundSignal(signal: FlowInboundSignal, options: FlowEngineOptions = {}) {
  const ctx = context(options);
  if (!flowsEnabled(ctx.env)) return { status: 'disabled' as const, started: 0, cancelled: 0 };
  const { orgId, conversationId } = signal, at = stamp(ctx.now());
  const reason = signal.optOut ? 'opted_out' : signal.kind === 'message' ? 'customer_replied' : '';
  const cancelled = !reason ? 0 : await transaction(orgId, c => cancelConversationExecutions(c, orgId, conversationId, signal.optOut ? 'active' : 'reply', reason, at));
  if (signal.optOut || await globallyPaused(database, orgId)) return { status: 'ok' as const, started: 0, cancelled };
  const started: string[] = [];
  for (const flow of await publishedFlows(database, orgId)) {
    const trigger = flow.definition.trigger;
    let key = '';
    if (signal.kind === 'message' && signal.messageId && (trigger.type === 'inbound_message' || (trigger.type === 'keyword' && keywordMatches(trigger, signal.text || '')))) key = 'message:' + signal.messageId;
    if (trigger.type === 'new_conversation' && signal.fresh && (signal.kind === 'message' || signal.kind === 'follow')) key = 'conversation:' + conversationId;
    if (!key) continue;
    const result = await startExecution(ctx, { orgId, flow, conversationId, triggerKind: trigger.type, triggerEventId: signal.eventId, triggerKey: key, text: signal.text });
    if (result.id) started.push(result.id);
  }
  for (const id of started) await advanceExecution(ctx, orgId, id);
  return { status: 'ok' as const, started: started.length, cancelled };
}

async function processLeadEvents(ctx: Ctx, orgId: string, discard: boolean) {
  const events = (await database.query("SELECT * FROM flow_events WHERE org_id=$1 AND status='pending' ORDER BY created_at,id LIMIT $2", [orgId, FLOW_LIMITS.eventsPerRun])).rows;
  if (!events.length) return 0;
  const flows = discard ? [] : (await publishedFlows(database, orgId)).filter(flow => ['label_added', 'stage_changed'].includes(flow.definition.trigger.type));
  for (const event of events) {
    const chain = String(event.flow_chain || '').split(',').filter(Boolean);
    if (Number(event.depth) < FLOW_LIMITS.chainDepth) for (const flow of flows) {
      // Loop guard: a flow is never triggered by a change that it (directly or indirectly) caused.
      if (chain.includes(flow.id)) continue;
      const trigger = flow.definition.trigger;
      const matched = (event.kind === 'label_added' && trigger.type === 'label_added' && trigger.label.toLowerCase() === String(event.value).toLowerCase())
        || (event.kind === 'stage_changed' && trigger.type === 'stage_changed' && trigger.stage === event.value);
      if (!matched) continue;
      const conversation = (await database.query('SELECT id FROM conversations WHERE org_id=$1 AND lead_id=$2 ORDER BY updated_at DESC,id DESC LIMIT 1', [orgId, event.lead_id])).rows[0];
      if (conversation) await startExecution(ctx, { orgId, flow, conversationId: conversation.id, triggerKind: trigger.type, triggerEventId: event.id, triggerKey: 'event:' + event.id, chain: chain.join(','), depth: Number(event.depth) });
    }
    await transaction(orgId, async c => { await c.query("UPDATE flow_events SET status='processed',processed_at=$3 WHERE org_id=$1 AND id=$2 AND status='pending'", [orgId, event.id, stamp(ctx.now())]); });
  }
  return events.length;
}
async function processSchedules(ctx: Ctx, orgId: string) {
  let started = 0;
  for (const flow of await publishedFlows(database, orgId)) {
    const trigger = flow.definition.trigger;
    if (trigger.type !== 'schedule') continue;
    const now = ctx.now(), slotMs = latestSlot(trigger, now);
    if (now - slotMs > FLOW_LIMITS.scheduleWindowMs) continue;
    const slot = stamp(slotMs), at = stamp(now);
    const state = await transaction(orgId, async c => {
      const row = (await c.query('SELECT cursor,done FROM flow_schedule_runs WHERE org_id=$1 AND flow_id=$2 AND slot=$3', [orgId, flow.id, slot])).rows[0];
      if (row) return row;
      await c.query("INSERT INTO flow_schedule_runs(org_id,flow_id,slot,version,cursor,done,updated_at) VALUES($1,$2,$3,$4,'',0,$5)", [orgId, flow.id, slot, flow.version, at]);
      return { cursor: '', done: 0 };
    });
    if (Number(state.done)) continue;
    const candidates = (await database.query("SELECT id FROM conversations WHERE org_id=$1 AND status!='resolved' AND updated_at>=$2 AND id>$3 ORDER BY id LIMIT $4", [orgId, stamp(now - 90 * 86_400_000), state.cursor, FLOW_LIMITS.schedulePerRun])).rows;
    for (const candidate of candidates) if ((await startExecution(ctx, { orgId, flow, conversationId: candidate.id, triggerKind: 'schedule', triggerEventId: slot, triggerKey: `schedule:${slot}:${candidate.id}` })).id) started++;
    await transaction(orgId, async c => { await c.query('UPDATE flow_schedule_runs SET cursor=$4,done=$5,updated_at=$6 WHERE org_id=$1 AND flow_id=$2 AND slot=$3 AND cursor=$7', [orgId, flow.id, slot, candidates.at(-1)?.id ?? state.cursor, candidates.length < FLOW_LIMITS.schedulePerRun ? 1 : 0, at, state.cursor]); });
  }
  return started;
}
async function processDue(ctx: Ctx, orgId: string) {
  const at = stamp(ctx.now());
  const due = (await database.query("SELECT e.id FROM flow_executions e JOIN flows f ON f.org_id=e.org_id AND f.id=e.flow_id WHERE e.org_id=$1 AND f.status='published' AND e.status IN ('running','waiting') AND e.wake_at<=$2 AND (e.lease_token='' OR e.lease_until<=$2) ORDER BY e.wake_at,e.id LIMIT $3", [orgId, at, FLOW_LIMITS.executionsPerRun])).rows;
  for (const row of due) await advanceExecution(ctx, orgId, row.id);
  return due.length;
}

/** Scheduled runner. Bounded per run; resumes durable waits, scheduled triggers and label/stage events. */
export async function runFlows(db: D1Binding, env: Env = process.env, options: Omit<FlowEngineOptions, 'env'> & { orgId?: string } = {}) {
  if (!flowsEnabled(env)) return { status: 'disabled' as const };
  const ctx = context({ ...options, env });
  return withDatabase(db, async () => {
    const totals = { orgs: 0, events: 0, scheduled: 0, advanced: 0, errors: 0 };
    const orgIds = new Set<string>(options.orgId ? [options.orgId] : []), limit = FLOW_LIMITS.orgsPerRun, at = stamp(ctx.now());
    if (!options.orgId) {
      // Oldest due work first, so a busy organization cannot starve the others.
      for (const row of (await database.query("SELECT org_id,MIN(wake_at) AS due FROM flow_executions WHERE status IN ('running','waiting') AND wake_at<=$1 GROUP BY org_id ORDER BY due LIMIT $2", [at, limit])).rows) orgIds.add(row.org_id);
      for (const row of (await database.query("SELECT org_id,MIN(created_at) AS due FROM flow_events WHERE status='pending' GROUP BY org_id ORDER BY due LIMIT $1", [limit])).rows) orgIds.add(row.org_id);
      for (const row of (await database.query("SELECT DISTINCT f.org_id FROM flows f JOIN flow_versions v ON v.org_id=f.org_id AND v.flow_id=f.id AND v.version=f.current_version WHERE f.status='published' AND json_extract(v.definition,'$.trigger.type')='schedule' ORDER BY f.org_id LIMIT $1", [limit])).rows) orgIds.add(row.org_id);
    }
    for (const orgId of [...orgIds].slice(0, limit)) {
      totals.orgs++;
      try {
        const paused = await globallyPaused(database, orgId);
        // During an emergency pause, label/stage changes are discarded rather than replayed later.
        totals.events += await processLeadEvents(ctx, orgId, paused);
        if (paused) continue;
        totals.scheduled += await processSchedules(ctx, orgId);
        totals.advanced += await processDue(ctx, orgId);
      } catch { totals.errors++; console.error('[rrs] flow_runner_org_failed'); }
    }
    return { status: totals.errors ? 'error' as const : 'ok' as const, ...totals };
  });
}

// ---------------------------------------------------------------------------------------------
// Simulation: read-only plan for one conversation. No writes, no provider calls.
// ---------------------------------------------------------------------------------------------
async function resolveTemplates(c: Executor, orgId: string, definition: FlowDefinition, strict: boolean): Promise<FlowDefinition> {
  const ids = new Set<string>();
  walkSteps(definition.steps, step => { if (step.type === 'send_message' && step.templateId && !step.text) ids.add(step.templateId); });
  const found = new Map<string, Row>();
  if (ids.size) for (const row of (await c.query(`SELECT id,content,version FROM reply_templates WHERE org_id=$1 AND id IN (${[...ids].map((_, i) => '$' + (i + 2)).join(',')})`, [orgId, ...ids])).rows) found.set(row.id, row);
  return { ...definition, steps: mapSteps(definition.steps, step => {
    if (step.type !== 'send_message' || !step.templateId || step.text) return step;
    const template = found.get(step.templateId);
    if (!template) { if (strict) throw new ApiError(409, 'ไม่พบข้อความสำเร็จรูปที่เลือก กรุณาเลือกใหม่'); return step; }
    if (strict && String(template.content).length > 2000) throw new ApiError(400, 'ข้อความสำเร็จรูปสำหรับระบบอัตโนมัติต้องยาวไม่เกิน 2000 ตัวอักษร');
    return { ...step, text: String(template.content), templateVersion: Number(template.version) };
  }) };
}
async function assertMembers(c: Executor, orgId: string, definition: FlowDefinition) {
  const ids = new Set<string>();
  const condition = (value: FlowCondition) => { if (value.type === 'assignment' && value.memberId) ids.add(value.memberId); };
  definition.conditions.forEach(condition);
  walkSteps(definition.steps, step => { if (step.type === 'assign') ids.add(step.memberId); if (step.type === 'create_task' && step.memberId) ids.add(step.memberId); if (step.type === 'branch') condition(step.condition); });
  if (!ids.size) return;
  const rows = (await c.query(`SELECT id FROM members WHERE org_id=$1 AND active=1 AND id IN (${[...ids].map((_, i) => '$' + (i + 2)).join(',')})`, [orgId, ...ids])).rows;
  if (rows.length !== ids.size) throw new ApiError(400, 'ไม่พบสมาชิกทีมที่เลือก หรือบัญชีถูกปิดใช้งาน');
}
const triggerLabels: Record<FlowTrigger['type'], string> = { inbound_message: 'เมื่อมีข้อความเข้าจากลูกค้า', new_conversation: 'เมื่อเริ่มบทสนทนาใหม่', keyword: 'เมื่อข้อความมีคำสำคัญ', label_added: 'เมื่อเพิ่มแท็กให้ลูกค้า', stage_changed: 'เมื่อสถานะลูกค้าเปลี่ยน', schedule: 'ตามเวลาที่กำหนด' };
export async function simulateFlow(staff: Staff, flowId: string, body: Record<string, unknown>) {
  fields(body, ['conversationId', 'source', 'text']);
  const conversationId = uuid(body.conversationId, 'บทสนทนา'), source = body.source === undefined ? 'draft' : oneOf(body.source, ['draft', 'published'], 'แหล่งข้อกำหนด');
  const text = str(body.text, 'ข้อความตัวอย่าง', 2000), now = Date.now(), env = process.env;
  const flow = await scopedFlow(database, staff.orgId, flowId);
  let definition: FlowDefinition, version: number | null = null, approver: string | null = null;
  if (source === 'published') {
    if (!flow.current_version) throw new ApiError(409, 'ยังไม่มีรุ่นที่เผยแพร่');
    const loaded = await loadVersion(database, staff.orgId, flowId, Number(flow.current_version));
    definition = loaded.definition; version = loaded.version; approver = loaded.publishedBy;
  } else definition = await resolveTemplates(database, staff.orgId, validateDefinition(JSON.parse(String(flow.draft_definition)), 'draft'), false);
  const subject = await loadSubject(database, staff.orgId, conversationId);
  if (!subject) throw new ApiError(404, 'ไม่พบบทสนทนา');
  const trigger = definition.trigger;
  const triggerMatch = trigger.type === 'keyword' ? (text ? keywordMatches(trigger, text) : null) : trigger.type === 'inbound_message' ? true : null;
  const conditions = definition.conditions.map(condition => ({ type: condition.type, ...evaluateCondition(condition, subject, now, text || undefined) }));
  const blockers: string[] = [];
  if (!flowsEnabled(env)) blockers.push('ระบบอัตโนมัติยังปิดอยู่ (FLOWS_ENABLED) — ผลนี้เป็นการจำลองเท่านั้น');
  if (await globallyPaused(database, staff.orgId)) blockers.push('ระบบอัตโนมัติถูกหยุดฉุกเฉินทั้งองค์กร');
  if (flow.status === 'paused') blockers.push('ระบบอัตโนมัตินี้ถูกหยุดชั่วคราว');
  if (subject.identity?.opt_out) blockers.push('ลูกค้าขอหยุดรับข้อความ — จะไม่เริ่มทำงาน');
  if (triggerMatch === false) blockers.push('ข้อความตัวอย่างไม่ตรงคำสำคัญ');
  if (conditions.some(condition => !condition.passed)) blockers.push('เงื่อนไขเริ่มต้นไม่ผ่าน');
  // Virtual state lets later branches observe earlier simulated changes.
  const state = { tags: tagsOf(subject.lead), stage: String(subject.lead.stage), status: String(subject.conversation.status), assignee: subject.conversation.assignee_id || null, greetingSent: (await database.query('SELECT 1 FROM flow_greetings WHERE org_id=$1 AND conversation_id=$2', [staff.orgId, conversationId])).rows.length > 0 };
  const view = (): Subject => ({ ...subject, lead: { ...subject.lead, tags: state.tags, stage: state.stage }, conversation: { ...subject.conversation, status: state.status, assignee_id: state.assignee } });
  const controls = subject.identity ? (await database.query('SELECT send_enabled,emergency_stop FROM social_channel_controls WHERE org_id=$1 AND provider=$2 AND account_id=$3', [staff.orgId, subject.identity.provider, subject.identity.account_id])).rows[0] : undefined;
  const members = new Map((await database.query('SELECT id,name,role,active FROM members WHERE org_id=$1', [staff.orgId])).rows.map(row => [row.id, row]));
  const actions: Row[] = [];
  const program = compileFlow(definition.steps);
  let pc = 0, elapsed = 0;
  while (pc < program.length && actions.length < 200) {
    const instr = program[pc];
    if (instr.op === 'jump') { pc = instr.target; continue; }
    if (instr.op === 'unless') {
      const evaluated = evaluateCondition(instr.condition, view(), now + elapsed, text || undefined);
      actions.push({ stepId: instr.stepId, type: 'branch', outcome: 'branch', detail: `${evaluated.detail} → ${evaluated.passed ? 'ทำชุด “ใช่”' : 'ทำชุด “ไม่ใช่”'}` });
      pc = evaluated.passed ? pc + 1 : instr.target; continue;
    }
    const step = instr.step, plan: Row = { stepId: step.id, type: step.type, outcome: 'planned', detail: '' };
    if (step.type === 'add_label' || step.type === 'remove_label') {
      const has = state.tags.some(tag => tag.toLowerCase() === step.label.toLowerCase());
      if (step.type === 'add_label' ? has : !has) { plan.outcome = 'skipped'; plan.detail = `แท็ก “${step.label}” ${has ? 'มีอยู่แล้ว' : 'ไม่มีอยู่'}`; }
      else { state.tags = step.type === 'add_label' ? [...state.tags, step.label] : state.tags.filter(tag => tag.toLowerCase() !== step.label.toLowerCase()); plan.detail = `${step.type === 'add_label' ? 'เพิ่ม' : 'นำออก'}แท็ก “${step.label}”`; }
    } else if (step.type === 'set_stage') {
      if (state.stage === step.stage) { plan.outcome = 'skipped'; plan.detail = `สถานะเป็น ${step.stage} อยู่แล้ว`; } else { plan.detail = `${state.stage} → ${step.stage}`; state.stage = step.stage; }
    } else if (step.type === 'assign') {
      const member = members.get(step.memberId);
      if (!member?.active) { plan.outcome = 'skipped'; plan.detail = 'สมาชิกไม่พร้อมใช้งาน'; }
      else if (state.status === 'human_active' && state.assignee && state.assignee !== step.memberId) { plan.outcome = 'skipped'; plan.detail = 'มีเจ้าหน้าที่ดูแลอยู่แล้ว'; }
      else { state.assignee = step.memberId; plan.detail = `มอบหมายให้ ${member.name}`; }
    } else if (step.type === 'create_task') {
      plan.detail = `สร้างงาน “${step.title}” ครบกำหนดใน ${step.dueInMinutes} นาที`;
    } else if (step.type === 'wait') {
      elapsed += step.minutes * 60_000; plan.outcome = 'wait';
      plan.detail = `รอ ${step.minutes} นาที แล้วทำต่อ${step.cancelOnReply ? ' (ยกเลิกหากลูกค้าตอบกลับ)' : ''}`;
    } else if (step.type === 'send_message') {
      let reason = !step.text ? 'template_missing' : sendBlocker(env, view(), step.greeting, state.greetingSent);
      if (!reason && (!controls || !Number(controls.send_enabled) || Number(controls.emergency_stop))) reason = 'channel_stopped';
      if (!reason && subject.identity?.provider === 'whatsapp' && !(subject.lead.contact_consent_at && subject.lead.contact_consent_version)) reason = 'consent_missing';
      if (!reason && approver && (members.get(approver)?.role !== 'Admin' || !members.get(approver)?.active)) reason = 'approver_inactive';
      plan.text = step.text || '';
      if (reason) { plan.outcome = reason === 'greeting_already_sent' ? 'skipped' : 'blocked'; plan.reason = reason; plan.detail = sendBlockReasons[reason]; }
      else { plan.detail = 'เข้าคิวส่งผ่านช่องทางเดิม (ตรวจสิทธิ์ ความยินยอม และช่วงเวลาตอบกลับซ้ำตอนส่งจริง)'; if (step.greeting) state.greetingSent = true; }
    } else if (step.type === 'request_handoff') {
      plan.detail = 'ส่งต่อเจ้าหน้าที่และจบการทำงาน'; if (state.status === 'bot_active') state.status = 'waiting_human';
      actions.push(plan); break;
    } else if (step.type === 'close_conversation') {
      if (state.status === 'human_active') { plan.outcome = 'skipped'; plan.detail = 'มีเจ้าหน้าที่ดูแลอยู่'; } else if (state.status === 'resolved') { plan.outcome = 'skipped'; plan.detail = 'ปิดอยู่แล้ว'; } else { state.status = 'resolved'; plan.detail = 'ปิดบทสนทนา'; }
    } else if (step.type === 'reopen_conversation') {
      if (state.status !== 'resolved') { plan.outcome = 'skipped'; plan.detail = 'บทสนทนายังเปิดอยู่'; } else { state.status = 'waiting_human'; plan.detail = 'เปิดบทสนทนาอีกครั้ง'; }
    }
    actions.push(plan); pc++;
  }
  return { source, version, simulatedAt: stamp(now), sideEffects: false, trigger: { type: trigger.type, label: triggerLabels[trigger.type], matches: triggerMatch }, conditions, wouldStart: !blockers.length, blockers, actions, sendEnabled: flowSendsEnabled(env) };
}

// ---------------------------------------------------------------------------------------------
// Admin API (Admin mutations; Agents read and simulate only)
// ---------------------------------------------------------------------------------------------
async function scopedFlow(c: Executor, orgId: string, id: string) {
  const row = (await c.query('SELECT * FROM flows WHERE org_id=$1 AND id=$2', [orgId, uuid(id, 'ระบบอัตโนมัติ')])).rows[0];
  if (!row) throw new ApiError(404, 'ไม่พบระบบอัตโนมัติ');
  return row;
}
async function audit(c: Executor, staff: Staff, action: string, entityId: string, metadata: Row = {}) {
  await c.query('INSERT INTO audit_events(id,org_id,actor_id,action,entity_id,metadata) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), staff.orgId, staff.id, action, entityId, JSON.stringify(metadata)]);
}
const revision = (value: unknown) => { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new ApiError(400, 'กรุณาระบุรุ่นร่างที่กำลังแก้ไข'); return value; };
function flowView(row: Row) {
  let trigger: FlowTrigger | null = null;
  try { trigger = (JSON.parse(String(row.draft_definition)) as FlowDefinition).trigger; } catch { trigger = null; }
  return { id: row.id, name: row.name, status: row.status, draftRevision: Number(row.draft_revision), currentVersion: row.current_version === null ? null : Number(row.current_version), trigger, createdAt: row.created_at, updatedAt: row.updated_at };
}
async function cancelQueuedSends(c: Executor, orgId: string, flowId: string | null, at: string) {
  // Only placeholders present in a statement are bound, so all three share one parameter list.
  const links = `SELECT outbound_command_id FROM flow_outbound_commands WHERE org_id=$1${flowId ? ' AND flow_id=$3' : ''}`, params = [orgId, at, flowId ?? ''];
  const count = Number((await c.query(`SELECT count(*) AS n FROM social_outbound_commands WHERE org_id=$1 AND status='queued' AND id IN (${links})`, params)).rows[0].n);
  if (!count) return 0;
  // Provenance first: it selects the commands that are still queued before they are cancelled.
  await c.query(`UPDATE social_message_provenance SET delivery_status='cancelled' WHERE org_id=$1 AND delivery_status='queued' AND message_id IN (SELECT message_id FROM social_outbound_commands WHERE org_id=$1 AND status='queued' AND id IN (${links}))`, params);
  await c.query(`UPDATE social_outbound_commands SET status='cancelled',error_code='flow_paused',updated_at=$2 WHERE org_id=$1 AND status='queued' AND id IN (${links})`, params);
  return count;
}
export async function listFlows(staff: Staff) {
  const [rows, counts, control] = await Promise.all([
    database.query('SELECT * FROM flows WHERE org_id=$1 ORDER BY updated_at DESC,id LIMIT $2', [staff.orgId, FLOW_LIMITS.flowsPerOrg]),
    database.query('SELECT flow_id,status,count(*) AS n FROM flow_executions WHERE org_id=$1 GROUP BY flow_id,status', [staff.orgId]),
    database.query('SELECT paused,updated_at FROM flow_controls WHERE org_id=$1', [staff.orgId]),
  ]);
  const stats: Record<string, Record<string, number>> = {};
  for (const row of counts.rows) (stats[row.flow_id] ??= {})[row.status] = Number(row.n);
  return { enabled: flowsEnabled(), sendEnabled: flowSendsEnabled(), globalPaused: Number(control.rows[0]?.paused || 0) === 1, canEdit: staff.role === 'Admin', limits: { stepsPerRun: FLOW_LIMITS.stepsPerRun, totalSteps: FLOW_LIMITS.totalSteps, perFlowSubjectHour: FLOW_LIMITS.perFlowSubjectHour }, flows: rows.rows.map(row => ({ ...flowView(row), executions: stats[row.id] || {} })) };
}
export async function flowDetail(staff: Staff, flowId: string) {
  const flow = await scopedFlow(database, staff.orgId, flowId);
  const versions = (await database.query('SELECT version,definition,definition_sha256,published_by,published_at FROM flow_versions WHERE org_id=$1 AND flow_id=$2 ORDER BY version DESC LIMIT 50', [staff.orgId, flow.id])).rows;
  const executions = (await database.query('SELECT e.*,l.name AS lead_name FROM flow_executions e JOIN leads l ON l.org_id=e.org_id AND l.id=e.lead_id WHERE e.org_id=$1 AND e.flow_id=$2 ORDER BY e.started_at DESC,e.id LIMIT 30', [staff.orgId, flow.id])).rows;
  const steps = executions.length ? (await database.query(`SELECT execution_id,step_index,step_id,action,outcome,detail,created_at FROM flow_execution_steps WHERE org_id=$1 AND execution_id IN (${executions.map((_, i) => '$' + (i + 2)).join(',')}) ORDER BY created_at,id`, [staff.orgId, ...executions.map(row => row.id)])).rows : [];
  return {
    flow: { ...flowView(flow), draft: JSON.parse(String(flow.draft_definition)) },
    versions: versions.map(row => ({ version: Number(row.version), definition: JSON.parse(String(row.definition)), sha256: row.definition_sha256, publishedBy: row.published_by, publishedAt: row.published_at })),
    executions: executions.map(row => ({ id: row.id, version: Number(row.version), conversationId: row.conversation_id, leadName: row.lead_name, status: row.status, triggerKind: row.trigger_kind, stepIndex: Number(row.step_index), wakeAt: row.wake_at, cancelReason: row.cancel_reason, errorCode: row.error_code, startedAt: row.started_at, updatedAt: row.updated_at,
      steps: steps.filter(step => step.execution_id === row.id).map(step => ({ ...camel(step), detail: JSON.parse(String(step.detail)) })) })),
  };
}
export async function createFlow(staff: Staff, body: Record<string, unknown>) {
  requireAdmin(staff); fields(body, ['name', 'definition']);
  const name = str(body.name, 'ชื่อระบบอัตโนมัติ', 120, true);
  const definition = body.definition === undefined ? defaultFlowDefinition() : validateDefinition(body.definition, 'draft');
  const id = randomUUID(), at = stamp(Date.now());
  await transaction(staff.orgId, async c => {
    if (Number((await c.query('SELECT count(*) AS n FROM flows WHERE org_id=$1', [staff.orgId])).rows[0].n) >= FLOW_LIMITS.flowsPerOrg) throw new ApiError(400, `รองรับระบบอัตโนมัติสูงสุด ${FLOW_LIMITS.flowsPerOrg} รายการต่อองค์กร`);
    await c.query("INSERT INTO flows(id,org_id,name,status,draft_definition,draft_revision,created_by,created_at,updated_at) VALUES($1,$2,$3,'draft',$4,1,$5,$6,$6)", [id, staff.orgId, name, JSON.stringify(definition), staff.id, at]);
    await audit(c, staff, 'flow.created', id, { name });
  }, staff);
  return flowDetail(staff, id);
}
export async function saveFlowDraft(staff: Staff, flowId: string, body: Record<string, unknown>) {
  requireAdmin(staff); fields(body, ['name', 'definition', 'expectedRevision']);
  const expected = revision(body.expectedRevision), definition = validateDefinition(body.definition, 'draft');
  const name = body.name === undefined ? undefined : str(body.name, 'ชื่อระบบอัตโนมัติ', 120, true);
  await transaction(staff.orgId, async c => {
    const flow = await scopedFlow(c, staff.orgId, flowId);
    if (Number(flow.draft_revision) !== expected) throw new ApiError(409, 'ร่างนี้ถูกแก้ไขแล้ว กรุณาโหลดรายการใหม่');
    await c.query('UPDATE flows SET name=$3,draft_definition=$4,draft_revision=draft_revision+1,updated_at=$5 WHERE org_id=$1 AND id=$2', [staff.orgId, flow.id, name ?? flow.name, JSON.stringify(definition), stamp(Date.now())]);
    await audit(c, staff, 'flow.draft_saved', flow.id, { revision: expected + 1 });
  }, staff);
  return flowDetail(staff, flowId);
}
export async function publishFlow(staff: Staff, flowId: string, body: Record<string, unknown>) {
  requireAdmin(staff); fields(body, ['expectedRevision', 'confirm']);
  if (body.confirm !== true) throw new ApiError(400, 'กรุณายืนยันการเผยแพร่');
  const expected = revision(body.expectedRevision);
  const published = await transaction(staff.orgId, async c => {
    const flow = await scopedFlow(c, staff.orgId, flowId);
    if (Number(flow.draft_revision) !== expected) throw new ApiError(409, 'ร่างนี้ถูกแก้ไขแล้ว กรุณาโหลดรายการใหม่');
    const resolved = await resolveTemplates(c, staff.orgId, validateDefinition(JSON.parse(String(flow.draft_definition)), 'draft'), true);
    await assertMembers(c, staff.orgId, resolved);
    const definition = validateDefinition(resolved, 'published'), json = JSON.stringify(definition), hash = sha256(json), at = stamp(Date.now());
    const latest = (await c.query('SELECT version,definition_sha256 FROM flow_versions WHERE org_id=$1 AND flow_id=$2 ORDER BY version DESC LIMIT 1', [staff.orgId, flow.id])).rows[0];
    let version = Number(latest?.version || 0) + 1, sends = 0;
    walkSteps(definition.steps, step => { if (step.type === 'send_message') sends++; });
    if (latest && latest.definition_sha256 === hash && Number(flow.current_version) === Number(latest.version)) version = Number(latest.version);
    else await c.query('INSERT INTO flow_versions(org_id,flow_id,version,definition,definition_sha256,published_by,published_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [staff.orgId, flow.id, version, json, hash, staff.id, at]);
    await c.query("UPDATE flows SET status='published',current_version=$3,updated_at=$4 WHERE org_id=$1 AND id=$2", [staff.orgId, flow.id, version, at]);
    await audit(c, staff, 'flow.published', flow.id, { version, sha256: hash, sendSteps: sends, previousVersion: flow.current_version });
    return version;
  }, staff);
  return { ...(await flowDetail(staff, flowId)), publishedVersion: published };
}
export async function setFlowPaused(staff: Staff, flowId: string, paused: boolean, body: Record<string, unknown>) {
  requireAdmin(staff); fields(body, ['confirm']);
  if (!paused && body.confirm !== true) throw new ApiError(400, 'กรุณายืนยันการเปิดใช้งานต่อ');
  await transaction(staff.orgId, async c => {
    const flow = await scopedFlow(c, staff.orgId, flowId), at = stamp(Date.now());
    if (paused ? flow.status !== 'published' : flow.status !== 'paused' || !flow.current_version) throw new ApiError(409, paused ? 'หยุดได้เฉพาะระบบอัตโนมัติที่เผยแพร่อยู่' : 'ระบบอัตโนมัตินี้ไม่ได้หยุดอยู่');
    await c.query('UPDATE flows SET status=$3,updated_at=$4 WHERE org_id=$1 AND id=$2', [staff.orgId, flow.id, paused ? 'paused' : 'published', at]);
    const cancelled = paused ? await cancelQueuedSends(c, staff.orgId, flow.id, at) : 0;
    await audit(c, staff, paused ? 'flow.paused' : 'flow.resumed', flow.id, { cancelledQueuedSends: cancelled });
  }, staff);
  return flowDetail(staff, flowId);
}
export async function setFlowsGlobalPause(staff: Staff, body: Record<string, unknown>) {
  requireAdmin(staff); fields(body, ['paused', 'confirm']);
  if (typeof body.paused !== 'boolean') throw new ApiError(400, 'สถานะหยุดฉุกเฉินไม่ถูกต้อง');
  if (!body.paused && body.confirm !== true) throw new ApiError(400, 'กรุณายืนยันการเปิดใช้งานต่อ');
  const paused = body.paused;
  await transaction(staff.orgId, async c => {
    const at = stamp(Date.now());
    await c.query('INSERT INTO flow_controls(org_id,paused,updated_by,updated_at) VALUES($1,$2,$3,$4) ON CONFLICT(org_id) DO UPDATE SET paused=excluded.paused,updated_by=excluded.updated_by,updated_at=excluded.updated_at', [staff.orgId, paused ? 1 : 0, staff.id, at]);
    const cancelled = paused ? await cancelQueuedSends(c, staff.orgId, null, at) : 0;
    await audit(c, staff, paused ? 'flow.global_paused' : 'flow.global_resumed', staff.orgId, { cancelledQueuedSends: cancelled });
  }, staff);
  return listFlows(staff);
}
export async function cancelFlowExecution(staff: Staff, flowId: string, executionId: string) {
  requireAdmin(staff);
  await transaction(staff.orgId, async c => {
    const flow = await scopedFlow(c, staff.orgId, flowId);
    const row = (await c.query('SELECT * FROM flow_executions WHERE org_id=$1 AND flow_id=$2 AND id=$3', [staff.orgId, flow.id, uuid(executionId, 'การทำงาน')])).rows[0];
    if (!row) throw new ApiError(404, 'ไม่พบการทำงาน');
    if (!['running', 'waiting'].includes(row.status)) throw new ApiError(409, 'การทำงานนี้สิ้นสุดแล้ว');
    await cancelExecutionRow(c, row, 'cancelled_by_staff', stamp(Date.now()));
    await audit(c, staff, 'flow.execution_cancelled', row.id, { flowId: flow.id });
  }, staff);
  return flowDetail(staff, flowId);
}
/** Router for /api/admin/flows/... (the route asserts same-origin for every POST). */
export async function flowsApi(staff: Staff, method: string, path: string[], body?: Record<string, unknown>) {
  const [id, action, executionId, executionAction] = path;
  if (method === 'GET' && path.length === 0) return listFlows(staff);
  if (method === 'GET' && path.length === 1) return flowDetail(staff, id);
  if (method !== 'POST' || !body) throw new ApiError(404, 'ไม่พบ API ที่ร้องขอ');
  if (path.length === 0) return createFlow(staff, body);
  if (path.length === 1 && id === 'control') return setFlowsGlobalPause(staff, body);
  if (path.length === 2 && action === 'draft') return saveFlowDraft(staff, id, body);
  if (path.length === 2 && action === 'simulate') return simulateFlow(staff, id, body);
  if (path.length === 2 && action === 'publish') return publishFlow(staff, id, body);
  if (path.length === 2 && (action === 'pause' || action === 'resume')) return setFlowPaused(staff, id, action === 'pause', body);
  if (path.length === 4 && action === 'executions' && executionAction === 'cancel') { fields(body, []); return cancelFlowExecution(staff, id, executionId); }
  throw new ApiError(404, 'ไม่พบ API ที่ร้องขอ');
}
