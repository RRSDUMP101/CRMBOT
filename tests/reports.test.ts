/** Synthetic tenants and a disposable local SQLite D1. Expected values are computed by hand below. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { NextRequest } from 'next/server';
import { database, closeDatabase } from '../src/lib/db';
import { hashToken, type Staff } from '../src/lib/auth';
import { buildReport, csvCell, exportReport, summarize, type Report } from '../src/lib/reports';
import { GET } from '../src/app/api/[...path]/route';

const origin = 'http://localhost';
const keys = ['DEMO_MODE', 'RRS_WORKERS', 'D1_LOCAL_DIR', 'APP_ORIGIN', 'SESSION_SECRET', 'AI_PROVIDER'] as const;
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
// Range 2026-03-01..2026-03-02 Bangkok = [2026-02-28T17:00Z, 2026-03-02T17:00Z). "Now" is 2026-03-03 00:30 Bangkok.
const NOW = Date.parse('2026-03-02T17:30:00Z');
const RANGE = 'from=2026-03-01&to=2026-03-02';
const MALICIOUS_NAME = '=HYPERLINK("https://evil.invalid","x"),\nแอบแฝง';
const SECRET_TEXT = 'Synthetic confidential customer text';

type Member = { staff: Staff; token: string };
let A: { org: string; admin: Member; agent1: Member; agent2: Member; c: Record<string, string> };
let B: { org: string; admin: Member };
let L: { org: string; admin: Member };

before(async () => {
  Object.assign(process.env, { DEMO_MODE: 'true', RRS_WORKERS: 'false', D1_LOCAL_DIR: `.data/reports-${randomUUID()}`, APP_ORIGIN: origin, SESSION_SECRET: 'synthetic-report-secret-at-least-32-characters', AI_PROVIDER: 'disabled' });
  A = await seedA(); B = await seedB(); L = await seedLegacy();
});
after(async () => { await closeDatabase(); for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });

async function organization(label: string) {
  const id = randomUUID();
  await database.query('INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)', [id, 'report-' + id.slice(0, 8), 'Synthetic report tenant ' + label]);
  return id;
}
async function member(org: string, name: string, role: 'Admin' | 'Agent'): Promise<Member> {
  const id = randomUUID(), token = randomUUID(), email = `${id}@example.invalid`;
  await database.query('INSERT INTO members(id,org_id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5,$6)', [id, org, name, email, 'not-a-login-hash', role]);
  await database.query("INSERT INTO staff_sessions(token_hash,org_id,member_id,expires_at) VALUES($1,$2,$3,'2099-01-01T00:00:00.000000Z')", [hashToken(token), org, id]);
  return { staff: { id, orgId: org, name, email, role }, token };
}
type ConversationOptions = { created: string; status: string; assignee?: string; market?: string; handoff?: string; provider?: 'whatsapp' | 'line' | 'facebook' };
async function conversation(org: string, o: ConversationOptions) {
  const lead = randomUUID(), id = randomUUID();
  await database.query('INSERT INTO leads(id,org_id,name,email,market,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6)', [lead, org, 'Synthetic customer ' + id.slice(0, 6), 'customer-' + id.slice(0, 6) + '@example.invalid', o.market ?? 'unknown', o.created]);
  await database.query('INSERT INTO conversations(id,org_id,lead_id,status,assignee_id,handoff_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7)', [id, org, lead, o.status, o.assignee ?? null, o.handoff ?? null, o.created]);
  if (o.provider) await database.query('INSERT INTO social_identities(id,org_id,provider,account_id,remote_id,lead_id,conversation_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)', [randomUUID(), org, o.provider, 'account-1', 'remote-' + id.slice(0, 8), lead, id, o.created]);
  return id;
}
async function message(org: string, conversationId: string, role: string, at: string, o: { status?: string; provider?: string; delivery?: string } = {}) {
  const id = randomUUID();
  await database.query('INSERT INTO messages(id,org_id,conversation_id,role,content,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, org, conversationId, role, `${SECRET_TEXT} ${role}`, o.status ?? 'complete', at]);
  if (o.provider) await database.query('INSERT INTO social_message_provenance(org_id,message_id,provider,account_id,remote_id,provider_message_id,provider_type,direction,delivery_status,provider_timestamp) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [org, id, o.provider, o.provider === 'legacy' ? 'legacy:domestic' : 'account-1', 'remote', 'mid-' + id, 'text', role === 'user' ? 'in' : 'out', o.delivery ?? (role === 'user' ? 'received' : 'sent'), at]);
  return id;
}
async function auditEvent(org: string, action: string, entity: string, at: string, actor = 'synthetic-actor') {
  await database.query('INSERT INTO audit_events(id,org_id,actor_id,action,entity_id,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), org, actor, action, entity, '{}', at]);
}

async function seedA() {
  const org = await organization('A');
  const admin = await member(org, 'Admin A', 'Admin'), agent1 = await member(org, MALICIOUS_NAME, 'Agent'), agent2 = await member(org, 'Agent Two', 'Agent');
  const c: Record<string, string> = {};
  // C1 website, agent1, domestic: notes/system ignored, FRT 30 s, human 10 min, resolved twice -> latest 60 min.
  c.C1 = await conversation(org, { created: '2026-03-01T01:00:00.000000Z', status: 'resolved', assignee: agent1.staff.id, market: 'domestic', handoff: '2026-03-01T01:02:00.000000Z' });
  await message(org, c.C1, 'user', '2026-03-01T01:00:00.000000Z');
  await message(org, c.C1, 'system', '2026-03-01T01:00:05.000000Z');
  await message(org, c.C1, 'note', '2026-03-01T01:00:10.000000Z');
  await message(org, c.C1, 'assistant', '2026-03-01T01:00:30.000000Z');
  await message(org, c.C1, 'user', '2026-03-01T01:05:00.000000Z');
  await message(org, c.C1, 'agent', '2026-03-01T01:10:00.000000Z');
  await auditEvent(org, 'conversation.resolve', c.C1, '2026-03-01T01:30:00.000000Z');
  await auditEvent(org, 'conversation.resolve', c.C1, '2026-03-01T02:00:00.000000Z');
  await auditEvent(org, 'conversation.release', c.C1, '2026-03-01T03:00:00.000000Z');
  // C2 WhatsApp, agent2, export: failed delivery at 20 min ignored, delivered reply at 30 min; human_active.
  c.C2 = await conversation(org, { created: '2026-03-01T03:00:00.000000Z', status: 'human_active', assignee: agent2.staff.id, market: 'export', handoff: '2026-03-01T03:25:00.000000Z', provider: 'whatsapp' });
  await message(org, c.C2, 'user', '2026-03-01T03:00:00.000000Z', { provider: 'whatsapp' });
  await message(org, c.C2, 'user', '2026-03-01T03:01:00.000000Z', { provider: 'whatsapp' });
  await message(org, c.C2, 'agent', '2026-03-01T03:20:00.000000Z', { provider: 'whatsapp', delivery: 'failed' });
  await message(org, c.C2, 'agent', '2026-03-01T03:30:00.000000Z', { provider: 'whatsapp', delivery: 'sent' });
  // C3 website, unassigned: failed AI attempt ignored, complete AI at 20 s, AI handled.
  c.C3 = await conversation(org, { created: '2026-03-02T10:00:00.000000Z', status: 'bot_active' });
  await message(org, c.C3, 'user', '2026-03-02T10:00:00.000000Z');
  await message(org, c.C3, 'assistant', '2026-03-02T10:00:05.000000Z', { status: 'failed' });
  await message(org, c.C3, 'assistant', '2026-03-02T10:00:20.000000Z');
  // C4 LINE, unassigned, domestic: no reply (a note is not a reply), waiting 5.5 h.
  c.C4 = await conversation(org, { created: '2026-03-02T12:00:00.000000Z', status: 'waiting_human', market: 'domestic', provider: 'line' });
  await message(org, c.C4, 'user', '2026-03-02T12:00:00.000000Z', { provider: 'line' });
  await message(org, c.C4, 'note', '2026-03-02T12:30:00.000000Z');
  // C5 website, agent1, export: resolved without an org-scoped resolve event (another tenant's event must not count).
  c.C5 = await conversation(org, { created: '2026-03-01T05:00:00.000000Z', status: 'resolved', assignee: agent1.staff.id, market: 'export' });
  await message(org, c.C5, 'user', '2026-03-01T05:00:00.000000Z');
  await message(org, c.C5, 'agent', '2026-03-01T05:01:00.000000Z');
  // C6 created one microsecond before the range: not in the cohort, but its in-range customer message and backlog count.
  c.C6 = await conversation(org, { created: '2026-02-28T16:59:59.999999Z', status: 'waiting_human', assignee: agent2.staff.id, handoff: '2026-02-28T17:05:00.000000Z' });
  await message(org, c.C6, 'user', '2026-02-28T16:59:59.999999Z');
  await message(org, c.C6, 'agent', '2026-02-28T17:10:00.000000Z');
  await message(org, c.C6, 'user', '2026-03-02T13:00:00.000000Z');
  // C7 exactly at the exclusive end: excluded everywhere.
  c.C7 = await conversation(org, { created: '2026-03-02T17:00:00.000000Z', status: 'bot_active' });
  await message(org, c.C7, 'user', '2026-03-02T17:00:00.000000Z');
  // C8 exactly at the inclusive start, no messages.
  c.C8 = await conversation(org, { created: '2026-02-28T17:00:00.000000Z', status: 'bot_active' });
  // C9 Facebook, agent1, domestic: reply at 10 min, a newer customer message 1.5 h ago.
  c.C9 = await conversation(org, { created: '2026-03-02T15:00:00.000000Z', status: 'waiting_human', assignee: agent1.staff.id, market: 'domestic', provider: 'facebook' });
  await message(org, c.C9, 'user', '2026-03-02T15:00:00.000000Z', { provider: 'facebook' });
  await message(org, c.C9, 'agent', '2026-03-02T15:10:00.000000Z', { provider: 'facebook' });
  await message(org, c.C9, 'user', '2026-03-02T16:00:00.000000Z', { provider: 'facebook' });
  return { org, admin, agent1, agent2, c };
}
async function seedB() {
  const org = await organization('B'), admin = await member(org, 'Admin B', 'Admin');
  const id = await conversation(org, { created: '2026-03-01T02:00:00.000000Z', status: 'waiting_human', assignee: admin.staff.id });
  for (const at of ['2026-03-01T02:00:00.000000Z', '2026-03-01T02:01:00.000000Z', '2026-03-01T02:02:00.000000Z']) await message(org, id, 'user', at);
  // Same entity id as tenant A's C5 but recorded in tenant B: must never resolve A's conversation.
  await auditEvent(org, 'conversation.resolve', A.c.C5, '2026-03-01T06:00:00.000000Z');
  return { org, admin };
}
async function seedLegacy() {
  const org = await organization('L'), admin = await member(org, 'Admin L', 'Admin');
  const imported = await conversation(org, { created: '2026-03-01T01:00:00.000000Z', status: 'bot_active' });
  await message(org, imported, 'user', '2026-03-01T01:00:00.000000Z', { provider: 'legacy' });
  const whatsapp = await conversation(org, { created: '2026-03-01T02:00:00.000000Z', status: 'bot_active', provider: 'whatsapp' });
  await message(org, whatsapp, 'user', '2026-03-01T02:00:00.000000Z', { provider: 'whatsapp' });
  await conversation(org, { created: '2026-03-01T03:00:00.000000Z', status: 'bot_active' });
  return { org, admin };
}

const reportUrl = (query = '') => new URL(`${origin}/api/admin/reports?${RANGE}${query ? '&' + query : ''}`);
const report = (staff: Staff, query = '', now = NOW) => buildReport(staff, reportUrl(query), { now });
const stat = (samples: number, p50Ms: number | null, p90Ms: number | null, avgMs: number | null) => ({ samples, p50Ms, p90Ms, avgMs });
const none = stat(0, null, null, null);
const request = (path: string, token?: string) => GET(new NextRequest(origin + path, { headers: token ? { cookie: `rrs_staff=${token}` } : {} }));

test('totals match hand-computed values; notes, system messages, failed AI and undelivered replies are excluded', async () => {
  const r = await report(A.admin.staff);
  assert.equal(r.version, 1); assert.equal(r.timezone, 'Asia/Bangkok');
  assert.deepEqual(r.range, { from: '2026-03-01', to: '2026-03-02', start: '2026-02-28T17:00:00.000000Z', end: '2026-03-02T17:00:00.000000Z', days: 2 });
  assert.deepEqual({ ...r.totals }, {
    newConversations: 7, inboundMessages: 10,
    // FRT samples: C3 20 s, C1 30 s, C5 60 s, C9 10 min, C2 30 min.
    firstResponse: stat(5, 60000, 1800000, 502000),
    humanFirstResponse: stat(4, 600000, 1800000, 765000),
    resolution: stat(1, 3600000, 3600000, 3600000),
    awaitingFirstReply: 1, resolved: 2, resolvedWithoutTiming: 1,
    handedOff: 2, handoffRate: 2 / 7,
    aiHandled: 1, humanInvolved: 4, otherOutcome: 2,
    backlog: { waitingHuman: 3, humanActive: 1, overdue: 2 },
  });
  assert.equal(r.generatedAt, '2026-03-02T17:30:00.000000Z');
  assert.ok(r.definitions.firstResponse.includes('บันทึกภายใน'));
});

test('per-channel and per-agent breakdowns are exact and complete', async () => {
  const r = await report(A.admin.staff);
  assert.deepEqual(r.byChannel.map(row => row.channel), ['website', 'whatsapp', 'line', 'facebook']);
  const channel = (name: string) => r.byChannel.find(row => row.channel === name)!;
  assert.equal(channel('website').label, 'เว็บไซต์');
  assert.deepEqual({ ...channel('website'), channel: undefined, label: undefined }, {
    channel: undefined, label: undefined, newConversations: 4, inboundMessages: 5,
    firstResponse: stat(3, 30000, 60000, 36667), humanFirstResponse: stat(2, 60000, 600000, 330000), resolution: stat(1, 3600000, 3600000, 3600000),
    awaitingFirstReply: 0, resolved: 2, resolvedWithoutTiming: 1, handedOff: 1, handoffRate: 0.25, aiHandled: 1, humanInvolved: 2, otherOutcome: 1,
    backlog: { waitingHuman: 1, humanActive: 0, overdue: 1 },
  });
  assert.deepEqual([channel('whatsapp').firstResponse, channel('whatsapp').handoffRate, channel('whatsapp').backlog], [stat(1, 1800000, 1800000, 1800000), 1, { waitingHuman: 0, humanActive: 1, overdue: 0 }]);
  assert.deepEqual([channel('line').newConversations, channel('line').inboundMessages, channel('line').firstResponse, channel('line').awaitingFirstReply, channel('line').backlog], [1, 1, none, 1, { waitingHuman: 1, humanActive: 0, overdue: 1 }]);
  assert.deepEqual([channel('facebook').inboundMessages, channel('facebook').humanFirstResponse, channel('facebook').handoffRate, channel('facebook').backlog], [2, stat(1, 600000, 600000, 600000), 0, { waitingHuman: 1, humanActive: 0, overdue: 0 }]);
  // Sum of channel rows equals the totals.
  for (const key of ['newConversations', 'inboundMessages', 'handedOff', 'aiHandled', 'humanInvolved', 'otherOutcome'] as const) assert.equal(r.byChannel.reduce((sum, row) => sum + row[key], 0), r.totals[key], key);

  assert.equal(r.viewer.agentBreakdown, 'all');
  assert.deepEqual(new Set(r.byAgent.slice(0, 2).map(row => row.agentId)), new Set([A.agent1.staff.id, A.agent2.staff.id]));
  const agent = (id: string | null) => r.byAgent.find(row => row.agentId === id)!;
  assert.equal(r.byAgent.length, 3); assert.equal(r.byAgent.at(-1)!.agentId, null); assert.equal(r.byAgent.at(-1)!.name, 'ยังไม่มีผู้รับผิดชอบ');
  const a1 = agent(A.agent1.staff.id), a2 = agent(A.agent2.staff.id), un = agent(null);
  assert.equal(a1.name, MALICIOUS_NAME);
  assert.deepEqual([a1.newConversations, a1.inboundMessages, a1.firstResponse, a1.humanFirstResponse, a1.resolution, a1.resolved, a1.resolvedWithoutTiming, a1.handedOff, a1.humanInvolved, a1.backlog],
    [3, 5, stat(3, 60000, 600000, 230000), stat(3, 600000, 600000, 420000), stat(1, 3600000, 3600000, 3600000), 2, 1, 1, 3, { waitingHuman: 1, humanActive: 0, overdue: 0 }]);
  assert.equal(a1.handoffRate, 1 / 3);
  assert.deepEqual([a2.newConversations, a2.inboundMessages, a2.firstResponse, a2.backlog], [1, 3, stat(1, 1800000, 1800000, 1800000), { waitingHuman: 1, humanActive: 1, overdue: 1 }]);
  assert.deepEqual([un.newConversations, un.inboundMessages, un.firstResponse, un.awaitingFirstReply, un.handoffRate, un.aiHandled, un.otherOutcome, un.backlog],
    [3, 2, stat(1, 20000, 20000, 20000), 1, 0, 1, 2, { waitingHuman: 1, humanActive: 0, overdue: 1 }]);
  assert.ok(!r.byAgent.some(row => row.agentId === A.admin.staff.id), 'members without data are omitted');
});

test('filters narrow every metric consistently, and overdue follows the hour threshold', async () => {
  const web = await report(A.admin.staff, 'channel=website');
  assert.deepEqual([web.totals.newConversations, web.totals.inboundMessages, web.totals.firstResponse, web.totals.backlog], [4, 5, stat(3, 30000, 60000, 36667), { waitingHuman: 1, humanActive: 0, overdue: 1 }]);
  assert.deepEqual(web.byChannel.map(row => row.channel), ['website']);
  const domestic = await report(A.admin.staff, 'market=domestic');
  assert.deepEqual([domestic.totals.newConversations, domestic.totals.inboundMessages, domestic.totals.backlog], [3, 5, { waitingHuman: 2, humanActive: 0, overdue: 1 }]);
  const unassigned = await report(A.admin.staff, 'assignee=unassigned');
  assert.deepEqual([unassigned.totals.newConversations, unassigned.totals.inboundMessages, unassigned.totals.aiHandled], [3, 2, 1]);
  const one = await report(A.admin.staff, `assignee=${A.agent1.staff.id}`);
  assert.deepEqual([one.totals.newConversations, one.totals.humanFirstResponse, one.byAgent.map(row => row.agentId)], [3, stat(3, 600000, 600000, 420000), [A.agent1.staff.id]]);
  assert.equal((await report(A.admin.staff, 'overdueHours=1')).totals.backlog.overdue, 3);
  assert.equal((await report(A.admin.staff, 'overdueHours=6')).totals.backlog.overdue, 0);
  // Only C6 has waited 4.5 h; with "now" 1 hour earlier it falls under the default threshold.
  assert.equal((await report(A.admin.staff, '', NOW - 3600000)).totals.backlog.overdue, 1);
});

test('no samples is unknown (null), never zero', async () => {
  const empty = await buildReport(A.admin.staff, new URL(`${origin}/api/admin/reports?from=2025-01-01&to=2025-01-01`), { now: NOW });
  assert.equal(empty.totals.newConversations, 0); assert.equal(empty.totals.inboundMessages, 0);
  assert.deepEqual([empty.totals.firstResponse, empty.totals.humanFirstResponse, empty.totals.resolution], [none, none, none]);
  assert.equal(empty.totals.handoffRate, null);
  // Backlog is current state and remains visible for any range.
  assert.deepEqual(empty.totals.backlog, { waitingHuman: 3, humanActive: 1, overdue: 2 });
  const legacyOnly = await report(A.admin.staff, 'channel=legacy');
  assert.deepEqual([legacyOnly.totals.firstResponse, legacyOnly.totals.handoffRate, legacyOnly.byChannel, legacyOnly.byAgent], [none, null, [], []]);
  assert.deepEqual(summarize([]), none);
  assert.deepEqual(summarize([5, 1, 3, 2, 4]), stat(5, 3, 5, 3));
  assert.deepEqual(summarize([10]), stat(1, 10, 10, 10));
});

test('channel comes from the social identity, then message provenance, else the website', async () => {
  const r = await report(L.admin.staff);
  assert.deepEqual(r.byChannel.map(row => [row.channel, row.newConversations]), [['website', 1], ['whatsapp', 1], ['legacy', 1]]);
  assert.equal((await report(L.admin.staff, 'channel=legacy')).totals.inboundMessages, 1);
});

test('reports are isolated per organization', async () => {
  const b = await report(B.admin.staff);
  assert.deepEqual([b.totals.newConversations, b.totals.inboundMessages, b.totals.resolved, b.totals.backlog.waitingHuman], [1, 3, 0, 1]);
  assert.deepEqual(b.byAgent.map(row => row.name), ['Admin B']);
  // Another tenant's member is not a valid filter, and tenant B's audit event never resolves tenant A's C5.
  await assert.rejects(report(A.admin.staff, `assignee=${B.admin.staff.id}`), { status: 400 });
  assert.equal((await report(A.admin.staff)).totals.resolvedWithoutTiming, 1);
  const viaApi = await (await request(`/api/admin/reports?${RANGE}`, B.admin.token)).json();
  assert.equal(viaApi.totals.newConversations, 1);
  assert.ok(!JSON.stringify(viaApi).includes(A.agent1.staff.id));
});

test('Agents view org aggregates and only their own row; per-person filters of others and CSV export are refused', async () => {
  assert.equal((await request(`/api/admin/reports?${RANGE}`)).status, 401);
  assert.equal((await request(`/api/admin/reports/export?format=csv&${RANGE}`)).status, 401);
  const response = await request(`/api/admin/reports?${RANGE}`, A.agent2.token);
  assert.equal(response.status, 200); assert.match(response.headers.get('cache-control')!, /no-store/);
  const agentView: Report = await response.json();
  assert.equal(agentView.viewer.agentBreakdown, 'self');
  assert.equal(agentView.totals.newConversations, 7);
  assert.deepEqual(agentView.byAgent.map(row => row.agentId), [A.agent2.staff.id]);
  assert.ok(!JSON.stringify(agentView).includes(MALICIOUS_NAME.slice(0, 10)), 'other agents are not named to an Agent');
  assert.equal((await request(`/api/admin/reports?${RANGE}&assignee=${A.agent1.staff.id}`, A.agent2.token)).status, 403);
  const own = await (await request(`/api/admin/reports?${RANGE}&assignee=${A.agent2.staff.id}`, A.agent2.token)).json();
  assert.equal(own.totals.newConversations, 1);
  assert.equal((await request(`/api/admin/reports?${RANGE}&assignee=unassigned`, A.agent2.token)).status, 200);
  assert.equal((await request(`/api/admin/reports/export?format=csv&${RANGE}`, A.agent2.token)).status, 403);
  await assert.rejects(exportReport(A.agent2.staff, new URL(`${origin}/api/admin/reports/export?${RANGE}`)), { status: 403 });
  const adminView: Report = await (await request(`/api/admin/reports?${RANGE}`, A.admin.token)).json();
  assert.equal(adminView.byAgent.length, 3);
});

test('query validation bounds the range and rejects unknown or malformed filters', async () => {
  const status = async (query: string) => (await request(`/api/admin/reports?${query}`, A.admin.token)).status;
  assert.equal(await status('from=2026-02-30&to=2026-03-01'), 400);
  assert.equal(await status('from=2026-03-02&to=2026-03-01'), 400);
  assert.equal(await status('from=2025-01-01&to=2026-01-02'), 400); // 367 days
  assert.equal(await status('from=2025-01-02&to=2026-01-02'), 200); // 366 days
  assert.equal(await status(`${RANGE}&unknown=1`), 400);
  assert.equal(await status(`${RANGE}&channel=sms`), 400);
  assert.equal(await status(`${RANGE}&market=asia`), 400);
  assert.equal(await status(`${RANGE}&overdueHours=0`), 400);
  assert.equal(await status(`${RANGE}&overdueHours=1.5`), 400);
  assert.equal(await status(`${RANGE}&assignee=not-a-uuid`), 400);
  assert.equal(await status(`${RANGE}&channel=line&channel=website`), 400);
  assert.equal(await status(`${RANGE}&format=csv`), 400);
  assert.equal((await request(`/api/admin/reports/export?format=xlsx&${RANGE}`, A.admin.token)).status, 400);
});

function parseCsv(text: string) {
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += ch; }
    else if (ch === '"' && cell === '') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

test('CSV cells are RFC 4180 escaped and formula-like text is neutralized', () => {
  assert.equal(csvCell(null), ''); assert.equal(csvCell(undefined), ''); assert.equal(csvCell(0), '0'); assert.equal(csvCell(28.57), '28.57');
  assert.equal(csvCell('plain ข้อความ'), 'plain ข้อความ');
  assert.equal(csvCell('a,b'), '"a,b"'); assert.equal(csvCell('say "hi"'), '"say ""hi"""'); assert.equal(csvCell('line\nbreak'), '"line\nbreak"');
  for (const value of ['=1+1', '+1', '-1', '@SUM(A1)', ' =1+1']) assert.ok(csvCell(value).replace(/^"/, '').startsWith("'"), value);
  assert.equal(csvCell('=cmd|"/c calc"!A1'), `"'=cmd|""/c calc""!A1"`);
  assert.equal(csvCell('\t=1'), "'\t=1"); assert.equal(csvCell('\r=1'), `"'\r=1"`);
});

test('Admin CSV export carries the same filtered aggregates, no customer data, and is audited', async () => {
  const before = Number((await database.query("SELECT count(*) AS n FROM audit_events WHERE org_id=$1 AND action='report.exported'", [A.org])).rows[0].n);
  const file = await exportReport(A.admin.staff, new URL(`${origin}/api/admin/reports/export?format=csv&${RANGE}`), { now: NOW });
  assert.equal(file.filename, 'rrs-report-2026-03-01-2026-03-02.csv');
  assert.ok(file.body.startsWith('﻿'));
  const rows = parseCsv(file.body.slice(1));
  const header = rows.findIndex(row => row[0] === 'ขอบเขต');
  assert.ok(header > 0);
  for (const row of rows) for (const cell of row) assert.ok(!/^\s*[=+\-@]/.test(cell) && !/^[\t\r]/.test(cell), `unsafe cell ${JSON.stringify(cell)}`);
  const line = (scope: string, group: string) => rows.find(row => row[0] === scope && row[1] === group)!;
  assert.deepEqual(line('รวม', 'ทั้งหมด'), ['รวม', 'ทั้งหมด', '7', '10', '5', '60', '1800', '502', '1', '4', '600', '1800', '765', '2', '1', '3600', '3600', '3600', '1', '2', '28.57', '1', '4', '2', '3', '1', '2']);
  // Unknown stays an empty cell, distinct from zero.
  assert.deepEqual(line('ช่องทาง', 'LINE'), ['ช่องทาง', 'LINE', '1', '1', '0', '', '', '', '1', '0', '', '', '', '0', '0', '', '', '', '0', '0', '0', '0', '0', '1', '1', '0', '1']);
  const malicious = line('ผู้รับผิดชอบ', "'" + MALICIOUS_NAME);
  assert.ok(malicious, 'agent display name is exported with its formula neutralized');
  assert.ok(file.body.includes(`"'=HYPERLINK(""https://evil.invalid"",""x""),\nแอบแฝง"`));
  assert.equal(rows.filter(row => row[0] === 'ผู้รับผิดชอบ').length, 3);
  for (const forbidden of [SECRET_TEXT, 'Synthetic customer', '@example.invalid', A.agent1.staff.id]) assert.ok(!file.body.includes(forbidden), forbidden);
  const filtered = parseCsv((await exportReport(A.admin.staff, new URL(`${origin}/api/admin/reports/export?format=csv&${RANGE}&channel=website`), { now: NOW })).body.slice(1));
  assert.equal(filtered.find(row => row[0] === 'รวม')![2], '4');
  const audits = (await database.query("SELECT actor_id,entity_id,metadata FROM audit_events WHERE org_id=$1 AND action='report.exported' ORDER BY rowid", [A.org])).rows;
  assert.equal(audits.length, before + 2);
  assert.equal(audits[0].actor_id, A.admin.staff.id); assert.equal(audits[0].entity_id, A.org);
  assert.equal(audits.at(-1)!.metadata.channel, 'website'); assert.equal(audits.at(-1)!.metadata.from, '2026-03-01');

  const response = await request(`/api/admin/reports/export?format=csv&${RANGE}`, A.admin.token);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="rrs-report-2026-03-01-2026-03-02.csv"');
  assert.match(response.headers.get('cache-control')!, /no-store/);
  const text = await response.text();
  assert.ok(text.includes('ขอบเขต'));
  // A member whose Admin role was just removed cannot complete an export.
  await database.query("UPDATE members SET role='Agent' WHERE org_id=$1 AND id=$2", [A.org, A.admin.staff.id]);
  try { await assert.rejects(exportReport(A.admin.staff, new URL(`${origin}/api/admin/reports/export?${RANGE}`), { now: NOW }), { status: 403 }); }
  finally { await database.query("UPDATE members SET role='Admin' WHERE org_id=$1 AND id=$2", [A.org, A.admin.staff.id]); }
});

test('cohort paging has no gaps or duplicates across equal timestamps, and oversized ranges are refused instead of truncated', async () => {
  const org = await organization('P'), admin = await member(org, 'Admin P', 'Admin');
  // 1,003 conversations sharing one created_at (keyset tie on id) plus one customer message each.
  await database.query(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1003)
    INSERT INTO leads(id,org_id,created_at,updated_at) SELECT $1||'-lead-'||printf('%05d',i),$1,'2026-03-01T00:00:00.000000Z','2026-03-01T00:00:00.000000Z' FROM n`, [org]);
  await database.query(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1003)
    INSERT INTO conversations(id,org_id,lead_id,status,created_at,updated_at) SELECT $1||'-conv-'||printf('%05d',i),$1,$1||'-lead-'||printf('%05d',i),'bot_active','2026-03-01T00:00:00.000000Z','2026-03-01T00:00:00.000000Z' FROM n`, [org]);
  await database.query(`INSERT INTO messages(id,org_id,conversation_id,role,content,created_at) SELECT id||'-m',org_id,id,'user','x','2026-03-01T00:00:00.000000Z' FROM conversations WHERE org_id=$1`, [org]);
  const r = await report(admin.staff);
  assert.deepEqual([r.totals.newConversations, r.totals.inboundMessages, r.totals.awaitingFirstReply, r.totals.otherOutcome], [1003, 1003, 1003, 1003]);
  await assert.rejects(buildReport(admin.staff, reportUrl(), { now: NOW, maxConversations: 1000 }), { status: 422 });
});
