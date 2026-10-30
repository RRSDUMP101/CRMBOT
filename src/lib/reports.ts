import { randomUUID } from 'node:crypto';
import { database, transaction, type Executor, type Row } from './db';
import { ApiError, oneOf, requireAdmin, uuid, type Staff } from './auth';

/**
 * Read-only staff reports computed from stored conversations, messages and audit events.
 * Nothing is estimated: a metric without samples is null ("ไม่มีข้อมูล"), never zero.
 * Every query is scoped to staff.orgId. No compound SELECT (D1 limits UNION terms).
 */
export const REPORT_CHANNELS = ['website', 'whatsapp', 'line', 'facebook', 'legacy'] as const;
export const REPORT_MARKETS = ['unknown', 'domestic', 'export'] as const;
export type ReportChannel = typeof REPORT_CHANNELS[number];
export type ReportMarket = typeof REPORT_MARKETS[number];
export const CHANNEL_LABELS: Record<string, string> = { website: 'เว็บไซต์', whatsapp: 'WhatsApp', line: 'LINE', facebook: 'Facebook', legacy: 'ประวัติที่นำเข้า (ไม่ระบุช่องทาง)' };
export const MARKET_LABELS: Record<ReportMarket, string> = { domestic: 'ในประเทศ', export: 'ส่งออก', unknown: 'ยังไม่ระบุตลาด' };
export const MAX_REPORT_DAYS = 366;
export const MAX_REPORT_CONVERSATIONS = 20000;
export const DEFAULT_OVERDUE_HOURS = 4;
const PAGE_SIZE = 1000;
const DAY_MS = 86400000;
const BANGKOK_OFFSET_MS = 7 * 3600000;
const QUERY_KEYS = ['from', 'to', 'channel', 'assignee', 'market', 'overdueHours'];

export type ReportQuery = { from: string; to: string; start: string; end: string; days: number; channel: ReportChannel | null; assignee: string | null; market: ReportMarket | null; overdueHours: number };
export type Stat = { samples: number; p50Ms: number | null; p90Ms: number | null; avgMs: number | null };
export type GroupMetrics = {
  newConversations: number; inboundMessages: number;
  firstResponse: Stat; humanFirstResponse: Stat; resolution: Stat;
  awaitingFirstReply: number; resolved: number; resolvedWithoutTiming: number;
  handedOff: number; handoffRate: number | null;
  aiHandled: number; humanInvolved: number; otherOutcome: number;
  backlog: { waitingHuman: number; humanActive: number; overdue: number };
};
export type ChannelRow = GroupMetrics & { channel: string; label: string };
export type AgentRow = GroupMetrics & { agentId: string | null; name: string; active: boolean };
export type Report = {
  version: 1; generatedAt: string; timezone: 'Asia/Bangkok';
  range: { from: string; to: string; start: string; end: string; days: number };
  filters: { channel: ReportChannel | null; assignee: string | null; market: ReportMarket | null; overdueHours: number };
  viewer: { role: Staff['role']; agentBreakdown: 'all' | 'self' };
  totals: GroupMetrics; byChannel: ChannelRow[]; byAgent: AgentRow[];
  definitions: Record<string, string>;
};

export const REPORT_DEFINITIONS: Record<string, string> = {
  cohort: 'ตัวชี้วัดเวลาและผลลัพธ์คำนวณจากบทสนทนาที่สร้างในช่วงวันที่ที่เลือก (นับทั้งวันตามเวลา Asia/Bangkok)',
  newConversations: 'จำนวนบทสนทนาที่สร้างในช่วงวันที่',
  inboundMessages: 'จำนวนข้อความจากลูกค้าที่บันทึกในช่วงวันที่ ไม่ว่าบทสนทนาจะเริ่มเมื่อใด',
  firstResponse: 'จากข้อความแรกของลูกค้าถึงคำตอบแรกที่สมบูรณ์ของ AI หรือเจ้าหน้าที่ ไม่นับบันทึกภายใน ข้อความระบบ คำตอบที่ล้มเหลว และข้อความที่ส่งไม่สำเร็จ',
  humanFirstResponse: 'จากข้อความแรกของลูกค้าถึงคำตอบแรกของเจ้าหน้าที่ เงื่อนไขเดียวกับเวลาตอบครั้งแรก',
  resolution: 'จากข้อความแรกของลูกค้าถึงการจบการสนทนาครั้งล่าสุด เฉพาะบทสนทนาที่ปัจจุบันจบแล้วและมีบันทึกเวลาจบในประวัติกิจกรรม หากไม่มีบันทึกเวลาจบหรือไม่มีข้อความลูกค้า จะนับเป็น “จบแล้วแต่คำนวณเวลาไม่ได้” และไม่ใช้เป็นตัวอย่าง',
  percentiles: 'p50/p90 ใช้วิธี nearest-rank จากตัวอย่างจริง ค่าเฉลี่ยปัดเป็นมิลลิวินาที ไม่มีตัวอย่างแสดง “ไม่มีข้อมูล” ไม่ใช่ศูนย์',
  handoff: 'บทสนทนาที่มีบันทึกเวลาส่งต่อเจ้าหน้าที่ หารด้วยบทสนทนาใหม่',
  outcome: 'AI ดูแลเอง = มีคำตอบ AI ที่สมบูรณ์ ไม่มีข้อความเจ้าหน้าที่ และไม่เคยส่งต่อ; เจ้าหน้าที่เข้าร่วม = มีข้อความเจ้าหน้าที่อย่างน้อยหนึ่งข้อความ; อื่น ๆ = ยังไม่มีผู้ตอบหรือรอเจ้าหน้าที่',
  backlog: 'งานค้าง ณ เวลาที่สร้างรายงาน ทุกช่วงวันที่: บทสนทนาที่รอเจ้าหน้าที่หรือเจ้าหน้าที่กำลังดูแล',
  overdue: 'รอเจ้าหน้าที่ และมีข้อความลูกค้าหรือคำขอส่งต่อที่ยังไม่มีคำตอบนานกว่า N ชั่วโมง',
  channel: 'ช่องทางจากตัวตนโซเชียลของบทสนทนา หรือแหล่งที่มาของข้อความที่นำเข้า หากไม่มีถือเป็นเว็บไซต์',
  agent: 'แยกตามผู้รับผิดชอบปัจจุบันของบทสนทนา ระบบไม่ได้บันทึกผู้เขียนรายข้อความ',
};

const canonical = (ms: number) => new Date(ms).toISOString().replace(/(\.\d{3})Z$/, (_, fraction: string) => fraction + '000Z');
function timestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value.replace(/(\.\d{3})\d+Z$/, '$1Z'));
  return Number.isFinite(parsed) ? parsed : null;
}
function duration(start: unknown, end: unknown): number | null {
  const a = timestamp(start), b = timestamp(end);
  if (a === null || b === null || b < a) return null;
  return b - a;
}
function calendarDay(value: string, label: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ApiError(400, `${label}ต้องอยู่ในรูปแบบ YYYY-MM-DD`);
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) throw new ApiError(400, `${label}ไม่ถูกต้อง`);
  return value;
}

/** Validates filters. Agents may only narrow to themselves or unassigned conversations. */
export async function parseReportQuery(staff: Staff, url: URL, now = Date.now()): Promise<ReportQuery> {
  for (const key of url.searchParams.keys()) if (!QUERY_KEYS.includes(key)) throw new ApiError(400, 'ตัวกรองรายงานไม่ถูกต้อง');
  const value = (key: string) => { const all = url.searchParams.getAll(key); if (all.length > 1) throw new ApiError(400, 'ตัวกรองรายงานซ้ำ'); return all[0]?.trim() || ''; };
  const today = new Date(now + BANGKOK_OFFSET_MS).toISOString().slice(0, 10);
  const from = calendarDay(value('from') || new Date(Date.parse(`${today}T00:00:00Z`) - 29 * DAY_MS).toISOString().slice(0, 10), 'วันที่เริ่มต้น');
  const to = calendarDay(value('to') || today, 'วันที่สิ้นสุด');
  const startMs = Date.parse(`${from}T00:00:00+07:00`), endMs = Date.parse(`${to}T00:00:00+07:00`) + DAY_MS;
  if (endMs <= startMs) throw new ApiError(400, 'วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่มต้น');
  const days = Math.round((endMs - startMs) / DAY_MS);
  if (days > MAX_REPORT_DAYS) throw new ApiError(400, `เลือกช่วงวันที่ได้ไม่เกิน ${MAX_REPORT_DAYS} วัน`);
  const channel = value('channel') ? oneOf(value('channel'), [...REPORT_CHANNELS], 'ช่องทาง') as ReportChannel : null;
  const market = value('market') ? oneOf(value('market'), [...REPORT_MARKETS], 'ตลาด') as ReportMarket : null;
  const rawHours = value('overdueHours') || String(DEFAULT_OVERDUE_HOURS);
  if (!/^\d{1,3}$/.test(rawHours) || Number(rawHours) < 1 || Number(rawHours) > 720) throw new ApiError(400, 'ชั่วโมงเกินกำหนดต้องอยู่ระหว่าง 1 ถึง 720');
  let assignee: string | null = null;
  const rawAssignee = value('assignee');
  if (rawAssignee === 'unassigned') assignee = 'unassigned';
  else if (rawAssignee) {
    assignee = uuid(rawAssignee, 'ผู้รับผิดชอบ');
    if (staff.role !== 'Admin' && assignee !== staff.id) throw new ApiError(403, 'รายงานรายบุคคลของผู้อื่นดูได้เฉพาะผู้ดูแลระบบ');
    const member = await database.query('SELECT id FROM members WHERE org_id=$1 AND id=$2', [staff.orgId, assignee]);
    if (!member.rows.length) throw new ApiError(400, 'ไม่พบผู้รับผิดชอบในองค์กร');
  }
  return { from, to, start: canonical(startMs), end: canonical(endMs), days, channel, assignee, market, overdueHours: Number(rawHours) };
}

// One channel per conversation: its exact social identity, else the provider recorded
// on its earliest message provenance (imports use 'legacy'), else the native website chat.
const CHANNEL = `COALESCE(
  (SELECT si.provider FROM social_identities si WHERE si.org_id=c.org_id AND si.conversation_id=c.id),
  (SELECT p.provider FROM messages pm JOIN social_message_provenance p ON p.org_id=pm.org_id AND p.message_id=pm.id WHERE pm.org_id=c.org_id AND pm.conversation_id=c.id ORDER BY pm.created_at,pm.id LIMIT 1),
  'website')`;
const NOT_UNDELIVERED = (alias: string) => `NOT EXISTS(SELECT 1 FROM social_message_provenance dp WHERE dp.org_id=${alias}.org_id AND dp.message_id=${alias}.id AND dp.delivery_status IN ('failed','cancelled'))`;
const BASE_COLUMNS = `c.id,c.org_id,c.status,c.assignee_id,c.created_at,c.handoff_at,l.market,${CHANNEL} AS channel`;
const BASE_JOIN = 'FROM conversations c JOIN leads l ON l.org_id=c.org_id AND l.id=c.lead_id';

function filterSql(query: ReportQuery, params: unknown[], alias = 'b') {
  const bind = (value: unknown) => { params.push(value); return `$${params.length}`; };
  const where: string[] = [];
  if (query.channel) where.push(`${alias}.channel=${bind(query.channel)}`);
  if (query.market) where.push(`${alias}.market=${bind(query.market)}`);
  if (query.assignee === 'unassigned') where.push(`${alias}.assignee_id IS NULL`);
  else if (query.assignee) where.push(`${alias}.assignee_id=${bind(query.assignee)}`);
  return where.length ? where.join(' AND ') : '1=1';
}

type CohortRow = { id: string; status: string; assignee_id: string | null; created_at: string; handoff_at: string | null; channel: string; first_customer_at: string | null; first_reply_at: string | null; first_agent_reply_at: string | null; has_agent: number; has_ai: number };
async function cohort(executor: Executor, orgId: string, query: ReportQuery, maximum: number) {
  const rows: CohortRow[] = [];
  let after = ['', ''];
  for (;;) {
    const params: unknown[] = [orgId, query.start, query.end];
    const filters = filterSql(query, params);
    params.push(after[0], after[1]);
    const cursor = `(b.created_at,b.id)>($${params.length - 1},$${params.length})`;
    const page = await executor.query<CohortRow>(`WITH base AS (SELECT ${BASE_COLUMNS} ${BASE_JOIN} WHERE c.org_id=$1 AND c.created_at>=$2 AND c.created_at<$3),
      page AS (SELECT b.*,(SELECT MIN(u.created_at) FROM messages u WHERE u.org_id=b.org_id AND u.conversation_id=b.id AND u.role='user') AS first_customer_at
        FROM base b WHERE ${filters} AND ${cursor} ORDER BY b.created_at,b.id LIMIT ${PAGE_SIZE})
      SELECT p.id,p.status,p.assignee_id,p.created_at,p.handoff_at,p.channel,p.first_customer_at,
        (SELECT MIN(r.created_at) FROM messages r WHERE r.org_id=p.org_id AND r.conversation_id=p.id AND r.role IN ('assistant','agent') AND r.status='complete' AND r.created_at>=p.first_customer_at AND ${NOT_UNDELIVERED('r')}) AS first_reply_at,
        (SELECT MIN(r.created_at) FROM messages r WHERE r.org_id=p.org_id AND r.conversation_id=p.id AND r.role='agent' AND r.status='complete' AND r.created_at>=p.first_customer_at AND ${NOT_UNDELIVERED('r')}) AS first_agent_reply_at,
        EXISTS(SELECT 1 FROM messages a WHERE a.org_id=p.org_id AND a.conversation_id=p.id AND a.role='agent') AS has_agent,
        EXISTS(SELECT 1 FROM messages a WHERE a.org_id=p.org_id AND a.conversation_id=p.id AND a.role='assistant' AND a.status='complete') AS has_ai
      FROM page p ORDER BY p.created_at,p.id`, params);
    rows.push(...page.rows);
    // Refuse rather than silently truncate: a partial cohort would misstate every percentile.
    if (rows.length > maximum) throw new ApiError(422, `ช่วงที่เลือกมีบทสนทนาเกิน ${maximum.toLocaleString('th-TH')} รายการ กรุณาเลือกช่วงวันที่หรือตัวกรองให้แคบลง`);
    if (page.rows.length < PAGE_SIZE) return rows;
    const last = page.rows[page.rows.length - 1];
    after = [last.created_at, last.id];
  }
}

async function resolvedTimes(executor: Executor, orgId: string, query: ReportQuery) {
  // Latest resolve per currently resolved cohort conversation; audit_events is append-only evidence.
  const result = await executor.query(`SELECT a.entity_id,MAX(a.created_at) AS resolved_at FROM audit_events a
    WHERE a.org_id=$1 AND a.action='conversation.resolve' AND a.created_at>=$2
      AND a.entity_id IN (SELECT c.id FROM conversations c WHERE c.org_id=$1 AND c.created_at>=$2 AND c.created_at<$3 AND c.status='resolved')
    GROUP BY a.entity_id`, [orgId, query.start, query.end]);
  return new Map(result.rows.map(row => [String(row.entity_id), String(row.resolved_at)]));
}

async function inboundCounts(executor: Executor, orgId: string, query: ReportQuery) {
  const params: unknown[] = [orgId, query.start, query.end];
  const filters = filterSql(query, params);
  return (await executor.query(`WITH counts AS (SELECT u.conversation_id AS id,count(*) AS n FROM messages u WHERE u.org_id=$1 AND u.role='user' AND u.created_at>=$2 AND u.created_at<$3 GROUP BY u.conversation_id),
      scoped AS (SELECT ${BASE_COLUMNS},counts.n ${BASE_JOIN} JOIN counts ON counts.id=c.id WHERE c.org_id=$1)
    SELECT b.channel,b.assignee_id,SUM(b.n) AS total FROM scoped b WHERE ${filters} GROUP BY b.channel,b.assignee_id`, params)).rows;
}

async function backlog(executor: Executor, orgId: string, query: ReportQuery, now: number) {
  const params: unknown[] = [orgId];
  const filters = filterSql(query, params);
  params.push(canonical(now - query.overdueHours * 3600000));
  const threshold = `$${params.length}`;
  // Waiting since: the earliest customer message after the last delivered reply, or an
  // unanswered handoff request. Nothing pending means the conversation is not overdue.
  return (await executor.query(`WITH queue AS (SELECT ${BASE_COLUMNS} ${BASE_JOIN} WHERE c.org_id=$1 AND c.status IN ('waiting_human','human_active')),
      filtered AS (SELECT b.*,(SELECT MAX(r.created_at) FROM messages r WHERE r.org_id=b.org_id AND r.conversation_id=b.id AND r.role IN ('assistant','agent') AND r.status='complete' AND ${NOT_UNDELIVERED('r')}) AS last_reply_at FROM queue b WHERE ${filters}),
      waiting AS (SELECT f.*,COALESCE(
        (SELECT MIN(u.created_at) FROM messages u WHERE u.org_id=f.org_id AND u.conversation_id=f.id AND u.role='user' AND (f.last_reply_at IS NULL OR u.created_at>f.last_reply_at)),
        CASE WHEN f.handoff_at IS NOT NULL AND (f.last_reply_at IS NULL OR f.handoff_at>f.last_reply_at) THEN f.handoff_at END) AS waiting_since FROM filtered f)
    SELECT w.channel,w.assignee_id,
      SUM(CASE WHEN w.status='waiting_human' THEN 1 ELSE 0 END) AS waiting_human,
      SUM(CASE WHEN w.status='human_active' THEN 1 ELSE 0 END) AS human_active,
      SUM(CASE WHEN w.status='waiting_human' AND w.waiting_since IS NOT NULL AND w.waiting_since<${threshold} THEN 1 ELSE 0 END) AS overdue
    FROM waiting w GROUP BY w.channel,w.assignee_id`, params)).rows;
}

/** Nearest-rank percentiles over real samples; no samples means unknown (null), not zero. */
export function summarize(samples: number[]): Stat {
  if (!samples.length) return { samples: 0, p50Ms: null, p90Ms: null, avgMs: null };
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = (p: number) => sorted[Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length))) - 1];
  return { samples: sorted.length, p50Ms: rank(0.5), p90Ms: rank(0.9), avgMs: Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length) };
}

type Accumulator = { newConversations: number; inbound: number; frt: number[]; hfrt: number[]; resolution: number[]; awaitingFirstReply: number; resolved: number; resolvedWithoutTiming: number; handedOff: number; aiHandled: number; humanInvolved: number; otherOutcome: number; waitingHuman: number; humanActive: number; overdue: number; touched: boolean };
const accumulator = (): Accumulator => ({ newConversations: 0, inbound: 0, frt: [], hfrt: [], resolution: [], awaitingFirstReply: 0, resolved: 0, resolvedWithoutTiming: 0, handedOff: 0, aiHandled: 0, humanInvolved: 0, otherOutcome: 0, waitingHuman: 0, humanActive: 0, overdue: 0, touched: false });
function finish(a: Accumulator): GroupMetrics {
  return {
    newConversations: a.newConversations, inboundMessages: a.inbound,
    firstResponse: summarize(a.frt), humanFirstResponse: summarize(a.hfrt), resolution: summarize(a.resolution),
    awaitingFirstReply: a.awaitingFirstReply, resolved: a.resolved, resolvedWithoutTiming: a.resolvedWithoutTiming,
    handedOff: a.handedOff, handoffRate: a.newConversations ? a.handedOff / a.newConversations : null,
    aiHandled: a.aiHandled, humanInvolved: a.humanInvolved, otherOutcome: a.otherOutcome,
    backlog: { waitingHuman: a.waitingHuman, humanActive: a.humanActive, overdue: a.overdue },
  };
}

export async function buildReport(staff: Staff, url: URL, options: { now?: number; executor?: Executor; maxConversations?: number } = {}): Promise<Report> {
  const now = options.now ?? Date.now(), executor = options.executor ?? database;
  const query = await parseReportQuery(staff, url, now);
  const conversations = await cohort(executor, staff.orgId, query, Math.min(options.maxConversations ?? MAX_REPORT_CONVERSATIONS, MAX_REPORT_CONVERSATIONS));
  const resolved = await resolvedTimes(executor, staff.orgId, query);
  const inbound = await inboundCounts(executor, staff.orgId, query);
  const open = await backlog(executor, staff.orgId, query, now);
  const members = (await executor.query('SELECT id,name,active FROM members WHERE org_id=$1', [staff.orgId])).rows;

  const totals = accumulator(), channels = new Map<string, Accumulator>(), agents = new Map<string, Accumulator>();
  const groups = (channel: string, assignee: string | null) => {
    const agentKey = assignee ?? '';
    if (!channels.has(channel)) channels.set(channel, accumulator());
    if (!agents.has(agentKey)) agents.set(agentKey, accumulator());
    return [totals, channels.get(channel)!, agents.get(agentKey)!];
  };
  for (const row of conversations) {
    const frt = duration(row.first_customer_at, row.first_reply_at), hfrt = duration(row.first_customer_at, row.first_agent_reply_at);
    const isResolved = row.status === 'resolved', resolvedAt = isResolved ? resolved.get(row.id) : undefined;
    const resolution = resolvedAt ? duration(row.first_customer_at, resolvedAt) : null;
    const handedOff = row.handoff_at !== null && row.handoff_at !== undefined;
    const human = Number(row.has_agent) === 1;
    const aiOnly = !human && Number(row.has_ai) === 1 && !handedOff && (row.status === 'bot_active' || row.status === 'resolved');
    for (const group of groups(row.channel, row.assignee_id)) {
      group.touched = true; group.newConversations++;
      if (frt !== null) group.frt.push(frt); else if (row.first_customer_at) group.awaitingFirstReply++;
      if (hfrt !== null) group.hfrt.push(hfrt);
      if (isResolved) { group.resolved++; if (resolution !== null) group.resolution.push(resolution); else group.resolvedWithoutTiming++; }
      if (handedOff) group.handedOff++;
      if (human) group.humanInvolved++; else if (aiOnly) group.aiHandled++; else group.otherOutcome++;
    }
  }
  for (const row of inbound) for (const group of groups(String(row.channel), row.assignee_id ?? null)) { group.touched = true; group.inbound += Number(row.total) || 0; }
  for (const row of open) for (const group of groups(String(row.channel), row.assignee_id ?? null)) {
    group.touched = true; group.waitingHuman += Number(row.waiting_human) || 0; group.humanActive += Number(row.human_active) || 0; group.overdue += Number(row.overdue) || 0;
  }

  const order = (channel: string) => { const index = (REPORT_CHANNELS as readonly string[]).indexOf(channel); return index < 0 ? REPORT_CHANNELS.length : index; };
  const byChannel: ChannelRow[] = [...channels].filter(([, a]) => a.touched).sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))
    .map(([channel, a]) => ({ channel, label: CHANNEL_LABELS[channel] || channel, ...finish(a) }));
  const names = new Map(members.map((m: Row) => [String(m.id), { name: String(m.name), active: m.active === true || m.active === 1 }]));
  // Agents see only their own row. Unassigned is listed last; names are display names only.
  const agentBreakdown = staff.role === 'Admin' ? 'all' : 'self';
  if (agentBreakdown === 'self' && !agents.has(staff.id)) agents.set(staff.id, accumulator());
  const byAgent: AgentRow[] = [...agents].filter(([id, a]) => agentBreakdown === 'all' ? a.touched : id === staff.id)
    .map(([id, a]) => ({ agentId: id || null, name: id ? names.get(id)?.name ?? 'สมาชิกที่ไม่พบ' : 'ยังไม่มีผู้รับผิดชอบ', active: id ? names.get(id)?.active ?? false : true, ...finish(a) }))
    .sort((a, b) => (a.agentId === null ? 1 : 0) - (b.agentId === null ? 1 : 0) || a.name.localeCompare(b.name, 'th'));
  return {
    version: 1, generatedAt: canonical(now), timezone: 'Asia/Bangkok',
    range: { from: query.from, to: query.to, start: query.start, end: query.end, days: query.days },
    filters: { channel: query.channel, assignee: query.assignee, market: query.market, overdueHours: query.overdueHours },
    viewer: { role: staff.role, agentBreakdown }, totals: finish(totals), byChannel, byAgent, definitions: REPORT_DEFINITIONS,
  };
}

/** RFC 4180 cell with spreadsheet formula-injection protection. Null stays an empty cell. */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : String(value);
  if (/^[\s]*[=+\-@]/.test(text) || /^[\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text;
}
const seconds = (ms: number | null) => ms === null ? null : Math.round(ms / 1000);
const percent = (rate: number | null) => rate === null ? null : Math.round(rate * 10000) / 100;
const CSV_COLUMNS = ['ขอบเขต', 'กลุ่ม', 'บทสนทนาใหม่', 'ข้อความลูกค้า',
  'ตอบครั้งแรก: ตัวอย่าง', 'ตอบครั้งแรก p50 (วินาที)', 'ตอบครั้งแรก p90 (วินาที)', 'ตอบครั้งแรก เฉลี่ย (วินาที)', 'ยังไม่มีคำตอบแรก',
  'เจ้าหน้าที่ตอบครั้งแรก: ตัวอย่าง', 'เจ้าหน้าที่ตอบครั้งแรก p50 (วินาที)', 'เจ้าหน้าที่ตอบครั้งแรก p90 (วินาที)', 'เจ้าหน้าที่ตอบครั้งแรก เฉลี่ย (วินาที)',
  'จบการสนทนา', 'เวลาจบ: ตัวอย่าง', 'เวลาจบ p50 (วินาที)', 'เวลาจบ p90 (วินาที)', 'เวลาจบ เฉลี่ย (วินาที)', 'จบแล้วแต่คำนวณเวลาไม่ได้',
  'ส่งต่อเจ้าหน้าที่', 'อัตราส่งต่อ (%)', 'AI ดูแลเอง', 'เจ้าหน้าที่เข้าร่วม', 'อื่น ๆ',
  'รอเจ้าหน้าที่ (ตอนนี้)', 'เจ้าหน้าที่กำลังดูแล (ตอนนี้)', 'รอเกินกำหนด (ตอนนี้)'];
function csvMetrics(m: GroupMetrics) {
  const stat = (s: Stat) => [s.samples, seconds(s.p50Ms), seconds(s.p90Ms), seconds(s.avgMs)];
  return [m.newConversations, m.inboundMessages, ...stat(m.firstResponse), m.awaitingFirstReply, ...stat(m.humanFirstResponse),
    m.resolved, ...stat(m.resolution), m.resolvedWithoutTiming, m.handedOff, percent(m.handoffRate), m.aiHandled, m.humanInvolved, m.otherOutcome,
    m.backlog.waitingHuman, m.backlog.humanActive, m.backlog.overdue];
}
/** Aggregates only: no customer names, contacts, message text or member e-mail addresses. */
export function reportCsv(report: Report, assigneeName?: string | null) {
  const f = report.filters;
  const lines: (string | number | null)[][] = [
    ['รายงาน', 'RRS Connect'],
    ['ช่วงวันที่ (Asia/Bangkok)', `${report.range.from} ถึง ${report.range.to}`],
    ['สร้างเมื่อ (UTC)', report.generatedAt],
    ['ตัวกรอง', `ช่องทาง: ${f.channel ? CHANNEL_LABELS[f.channel] : 'ทั้งหมด'}; ตลาด: ${f.market ? MARKET_LABELS[f.market] : 'ทั้งหมด'}; ผู้รับผิดชอบ: ${f.assignee === 'unassigned' ? 'ยังไม่มีผู้รับผิดชอบ' : f.assignee ? assigneeName ?? 'ระบุ' : 'ทั้งหมด'}; รอเกิน ${f.overdueHours} ชั่วโมง`],
    ['หมายเหตุ', 'ช่องว่างหมายถึงไม่มีข้อมูล ไม่ใช่ศูนย์'],
    [],
    CSV_COLUMNS,
    ['รวม', 'ทั้งหมด', ...csvMetrics(report.totals)],
    ...report.byChannel.map(row => ['ช่องทาง', row.label, ...csvMetrics(row)]),
    ...report.byAgent.map(row => ['ผู้รับผิดชอบ', row.name, ...csvMetrics(row)]),
  ];
  return '﻿' + lines.map(line => line.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export async function exportReport(staff: Staff, url: URL, options: { now?: number } = {}) {
  requireAdmin(staff);
  const format = url.searchParams.get('format') ?? 'csv';
  if (format !== 'csv') throw new ApiError(400, 'รองรับเฉพาะรูปแบบ CSV');
  const report = await buildReport(staff, new URL(stripFormat(url)), options);
  const assigneeName = report.filters.assignee && report.filters.assignee !== 'unassigned' ? report.byAgent.find(row => row.agentId === report.filters.assignee)?.name
    ?? String((await database.query('SELECT name FROM members WHERE org_id=$1 AND id=$2', [staff.orgId, report.filters.assignee])).rows[0]?.name ?? '') : null;
  const body = reportCsv(report, assigneeName);
  // An export is data leaving the system: record who exported which filters. The actor
  // re-check inside the transaction refuses a member whose role or status just changed.
  await transaction(staff.orgId, async connection => {
    await connection.query('INSERT INTO audit_events(id,org_id,actor_id,action,entity_id,metadata) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), staff.orgId, staff.id, 'report.exported', staff.orgId, JSON.stringify({ format: 'csv', ...report.range, ...report.filters })]);
  }, staff);
  return { body, filename: `rrs-report-${report.range.from}-${report.range.to}.csv` };
}
function stripFormat(url: URL) { const copy = new URL(url); copy.searchParams.delete('format'); return copy; }
