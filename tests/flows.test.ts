/** Flow Builder. Real local SQLite, synthetic fixtures and injected transports only; no provider is ever called. */
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import type { NextRequest } from 'next/server';
import { database, getDatabase, closeDatabase } from '../src/lib/db';
import { hashToken, type Staff } from '../src/lib/auth';
import { adminAction, conversationAction } from '../src/lib/service';
import { ingestSocialWebhook, dispatchSocialReply, socialConfigFingerprint, type SocialChannelConfig, type FlowInboundSignal } from '../src/lib/social-channels';
import { cancelFlowExecution, createFlow, flowDetail, latestSlot, listFlows, onInboundSignal, publishFlow, runFlows, saveFlowDraft, setFlowPaused, setFlowsGlobalPause, simulateFlow, validateDefinition, type FlowDefinition, type FlowStep } from '../src/lib/flows';
import { GET, POST } from '../src/app/api/[...path]/route';

const APP = 'https://crm.example.invalid';
const keys = ['DEMO_MODE', 'RRS_WORKERS', 'D1_LOCAL_DIR', 'APP_ORIGIN', 'SESSION_SECRET', 'AI_PROVIDER', 'FLOWS_ENABLED', 'FLOWS_SEND_ENABLED'] as const;
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const previousFetch = globalThis.fetch;
let networkCalls = 0;
before(async () => {
  Object.assign(process.env, { DEMO_MODE: 'true', RRS_WORKERS: 'false', D1_LOCAL_DIR: `.data/flows-${randomUUID()}`, APP_ORIGIN: APP, SESSION_SECRET: 'synthetic-flow-secret-at-least-32-characters', AI_PROVIDER: 'disabled' });
  delete process.env.FLOWS_ENABLED; delete process.env.FLOWS_SEND_ENABLED;
  // Any accidental network use fails the suite instead of reaching a provider.
  globalThis.fetch = (async () => { networkCalls++; throw new Error('network disabled in flow tests'); }) as typeof fetch;
  await database.query('SELECT 1');
});
after(async () => { globalThis.fetch = previousFetch; await closeDatabase(); for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; });
const enable = (send = false) => { process.env.FLOWS_ENABLED = 'true'; if (send) process.env.FLOWS_SEND_ENABLED = 'true'; else delete process.env.FLOWS_SEND_ENABLED; };
const disable = () => { delete process.env.FLOWS_ENABLED; delete process.env.FLOWS_SEND_ENABLED; };

type Fixture = { org: string; admin: Staff; agent: Staff; adminToken: string; agentToken: string; config: SocialChannelConfig };
async function fixture(): Promise<Fixture> {
  const org = randomUUID();
  await database.query('INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)', [org, 'flow-' + org, 'Synthetic flow tenant']);
  const member = async (role: 'Admin' | 'Agent') => {
    const id = randomUUID(), token = randomUUID(), staff: Staff = { id, orgId: org, name: 'Synthetic ' + role, email: `${id}@example.invalid`, role };
    await database.query('INSERT INTO members(id,org_id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5,$6)', [id, org, staff.name, staff.email, 'not-a-real-hash', role]);
    await database.query("INSERT INTO staff_sessions(token_hash,org_id,member_id,expires_at) VALUES($1,$2,$3,'2099-01-01T00:00:00.000000Z')", [hashToken(token), org, id]);
    return { staff, token };
  };
  const admin = await member('Admin'), agent = await member('Agent');
  return { org, admin: admin.staff, agent: agent.staff, adminToken: admin.token, agentToken: agent.token, config: { provider: 'line', orgId: org, accountId: 'UflowFixtureBot', secret: 'fixture-flow-signing-secret', accessToken: 'fixture-never-live-token', owner: 'crm', inboundEnabled: true, liveEnabled: false } };
}
/** Signed synthetic LINE webhook through the real inbound path (and its Flow hook when enabled). */
async function inbound(f: Fixture, remote: string, text: string, mid = 'mid-' + randomUUID()) {
  const payload = { destination: f.config.accountId, events: [{ webhookEventId: 'evt-' + mid, type: 'message', timestamp: Date.now() - 1000, source: { type: 'user', userId: remote }, message: { id: mid, type: 'text', text } }] };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const result = await ingestSocialWebhook('line', bytes, new Headers({ 'x-line-signature': createHmac('sha256', f.config.secret).update(bytes).digest('base64') }), f.config);
  const identity = (await database.query('SELECT * FROM social_identities WHERE org_id=$1 AND remote_id=$2', [f.org, remote])).rows[0];
  const message = (await database.query("SELECT m.id FROM messages m JOIN social_message_provenance p ON p.org_id=m.org_id AND p.message_id=m.id WHERE m.org_id=$1 AND p.provider_message_id=$2", [f.org, mid])).rows[0];
  const signal: FlowInboundSignal = { orgId: f.org, provider: 'line', accountId: f.config.accountId, eventId: 'evt-' + mid, kind: 'message', conversationId: identity.conversation_id, leadId: identity.lead_id, messageId: message?.id, text, fresh: false, optOut: false };
  return { result, identity, conversationId: identity.conversation_id as string, leadId: identity.lead_id as string, signal };
}
const definition = (steps: FlowStep[], trigger: FlowDefinition['trigger'] = { type: 'inbound_message' }, conditions: FlowDefinition['conditions'] = []): FlowDefinition => ({ version: 1, trigger, conditions, steps });
async function published(f: Fixture, name: string, value: FlowDefinition) {
  const created = await createFlow(f.admin, { name, definition: value });
  await publishFlow(f.admin, created.flow.id, { expectedRevision: created.flow.draftRevision, confirm: true });
  return created.flow.id as string;
}
const executions = async (f: Fixture, flowId: string) => (await database.query('SELECT * FROM flow_executions WHERE org_id=$1 AND flow_id=$2 ORDER BY started_at,id', [f.org, flowId])).rows;
const lead = async (id: string) => (await database.query('SELECT * FROM leads WHERE id=$1', [id])).rows[0];
const later = (minutes: number) => () => Date.now() + minutes * 60_000;
const env = () => ({ ...process.env, FLOWS_ENABLED: 'true' }) as Record<string, unknown>;
async function enableLine(f: Fixture) {
  await database.query("UPDATE social_channel_controls SET send_enabled=1,emergency_stop=0,send_mode='live',verified_at=$4,verification_fingerprint=$5,verification_expires_at=$6,epoch=epoch+1 WHERE org_id=$1 AND provider=$2 AND account_id=$3", [f.org, 'line', f.config.accountId, new Date().toISOString(), socialConfigFingerprint(f.config), new Date(Date.now() + 86_400_000).toISOString()]);
}

test('validation rejects bad definitions and accepts a complete one', async () => {
  const good = definition([{ id: 'a', type: 'add_label', label: 'vip' }, { id: 'b', type: 'branch', condition: { type: 'market', markets: ['export'] }, then: [{ id: 'c', type: 'send_message', text: 'สวัสดีค่ะ', greeting: true }], else: [{ id: 'd', type: 'request_handoff' }] }], { type: 'keyword', keywords: ['ราคา'], match: 'contains' }, [{ type: 'business_hours', inside: true, days: [1, 2, 3, 4, 5], start: '08:30', end: '17:30' }]);
  assert.equal(validateDefinition(good).steps.length, 2);
  const bad: Array<[string, unknown]> = [
    ['not an object', 'steps'],
    ['unknown step', definition([{ id: 'a', type: 'delete_customer' } as never])],
    ['extra field', definition([{ id: 'a', type: 'add_label', label: 'x', script: 'alert(1)' } as never])],
    ['missing label', definition([{ id: 'a', type: 'add_label' } as never])],
    ['no steps', definition([])],
    ['duplicate ids', definition([{ id: 'a', type: 'add_label', label: 'x' }, { id: 'a', type: 'add_label', label: 'y' }])],
    ['too many steps', definition(Array.from({ length: 41 }, (_, i) => ({ id: 's' + i, type: 'add_label' as const, label: 'x' })))],
    ['handoff not last', definition([{ id: 'a', type: 'request_handoff' }, { id: 'b', type: 'add_label', label: 'x' }])],
    ['text and template', definition([{ id: 'a', type: 'send_message', text: 'x', templateId: randomUUID(), greeting: false }])],
    ['neither text nor template', definition([{ id: 'a', type: 'send_message', greeting: false }])],
    ['wait too long', definition([{ id: 'a', type: 'wait', minutes: 100_000, cancelOnReply: true }])],
    ['weekly without weekday', definition([{ id: 'a', type: 'add_label', label: 'x' }], { type: 'schedule', frequency: 'weekly', time: '09:00' })],
    ['bad time', definition([{ id: 'a', type: 'add_label', label: 'x' }], { type: 'schedule', frequency: 'daily', time: '25:00' })],
    ['field without value', definition([{ id: 'a', type: 'add_label', label: 'x' }], { type: 'inbound_message' }, [{ type: 'customer_field', field: 'name', operator: 'equals' }])],
    ['assigned_to without member', definition([{ id: 'a', type: 'add_label', label: 'x' }], { type: 'inbound_message' }, [{ type: 'assignment', state: 'assigned_to' }])],
    ['branch too deep', definition([{ id: 'a', type: 'branch', condition: { type: 'consent', state: 'recorded' }, then: [{ id: 'b', type: 'branch', condition: { type: 'consent', state: 'recorded' }, then: [{ id: 'c', type: 'branch', condition: { type: 'consent', state: 'recorded' }, then: [{ id: 'd', type: 'branch', condition: { type: 'consent', state: 'recorded' }, then: [{ id: 'e', type: 'add_label', label: 'x' }], else: [] }], else: [] }], else: [] }], else: [] }])],
  ];
  for (const [label, value] of bad) assert.throws(() => validateDefinition(value), { status: 400 }, label);
  const f = await fixture();
  await assert.rejects(createFlow(f.admin, { name: 'bad', definition: { version: 2 } }), { status: 400 });
  // Publishing resolves references server-side: a missing template or foreign member is refused.
  const missingTemplate = await createFlow(f.admin, { name: 'template', definition: definition([{ id: 'a', type: 'send_message', templateId: randomUUID(), greeting: false }]) });
  await assert.rejects(publishFlow(f.admin, missingTemplate.flow.id, { expectedRevision: 1, confirm: true }), { status: 409 });
  const foreign = await fixture();
  const foreignMember = await createFlow(f.admin, { name: 'member', definition: definition([{ id: 'a', type: 'assign', memberId: foreign.admin.id }]) });
  await assert.rejects(publishFlow(f.admin, foreignMember.flow.id, { expectedRevision: 1, confirm: true }), { status: 400 });
  await assert.rejects(publishFlow(f.admin, foreignMember.flow.id, { expectedRevision: 1 }), { status: 400 }, 'publish requires explicit confirmation');
  assert.equal((await database.query('SELECT count(*) AS n FROM flow_versions WHERE org_id=$1', [f.org])).rows[0].n, 0);
});

test('flag off does nothing: no triggers, no lead events, runner and hook disabled', async () => {
  disable();
  const f = await fixture();
  const flowId = await published(f, 'off', definition([{ id: 'a', type: 'add_label', label: 'never' }]));
  const one = await inbound(f, 'Uoff', 'สวัสดี');
  assert.equal(one.result.accepted, 1, 'inbound itself still works');
  assert.equal((await executions(f, flowId)).length, 0);
  await adminAction(f.admin, { action: 'updateLead', id: one.leadId, values: { tags: ['vip'], stage: 'Qualified' } });
  assert.equal((await database.query('SELECT count(*) AS n FROM flow_events WHERE org_id=$1', [f.org])).rows[0].n, 0);
  assert.deepEqual(await runFlows(await getDatabase(), {}), { status: 'disabled' });
  assert.equal((await onInboundSignal(one.signal, { env: {} })).status, 'disabled');
  assert.equal((await executions(f, flowId)).length, 0);
  assert.deepEqual((await lead(one.leadId)).tags, ['vip']);
});

test('simulate returns planned actions with no side effects', async () => {
  disable();
  const f = await fixture();
  const flowId = await published(f, 'sim', definition([{ id: 'a', type: 'add_label', label: 'hot' }, { id: 'b', type: 'branch', condition: { type: 'customer_field', field: 'tags', operator: 'contains', value: 'hot' }, then: [{ id: 'c', type: 'send_message', text: 'ยินดีต้อนรับค่ะ', greeting: true }, { id: 'd', type: 'wait', minutes: 60, cancelOnReply: true }], else: [{ id: 'e', type: 'create_task', title: 'never', dueInMinutes: 5, assignTo: 'none' }] }, { id: 'f', type: 'set_stage', stage: 'Qualified' }, { id: 'g', type: 'create_task', title: 'โทรติดตาม', dueInMinutes: 30, assignTo: 'conversation_assignee' }, { id: 'h', type: 'close_conversation' }], { type: 'keyword', keywords: ['ราคา'], match: 'contains' }));
  const one = await inbound(f, 'Usimulate', 'hello');
  const tables = ['messages', 'tasks', 'leads', 'conversations', 'flow_executions', 'flow_execution_steps', 'flow_events', 'flow_greetings', 'flow_outbound_commands', 'social_outbound_commands', 'social_message_provenance', 'audit_events', 'flow_versions'];
  const fingerprint = async () => JSON.stringify([
    ...await Promise.all(tables.map(async table => (await database.query(`SELECT count(*) AS n FROM ${table} WHERE org_id=$1`, [f.org])).rows[0].n)),
    (await database.query('SELECT revision FROM organizations WHERE id=$1', [f.org])).rows[0].revision,
    await lead(one.leadId), (await database.query('SELECT * FROM conversations WHERE id=$1', [one.conversationId])).rows[0],
  ]);
  const before = await fingerprint(), calls = networkCalls;
  for (const source of ['draft', 'published'] as const) {
    const plan = await simulateFlow(f.agent, flowId, { conversationId: one.conversationId, source, text: 'ขอราคาหน่อย' });
    assert.equal(plan.sideEffects, false); assert.equal(plan.trigger.matches, true);
    assert.deepEqual(plan.actions.map(action => [action.stepId, action.outcome]), [['a', 'planned'], ['b', 'branch'], ['c', 'blocked'], ['d', 'wait'], ['f', 'planned'], ['g', 'planned'], ['h', 'planned']]);
    assert.equal(plan.actions[2].reason, 'sending_disabled'); assert.equal(plan.actions[2].text, 'ยินดีต้อนรับค่ะ');
    assert.ok(plan.blockers.some(text => text.includes('FLOWS_ENABLED')));
  }
  assert.equal((await simulateFlow(f.admin, flowId, { conversationId: one.conversationId, text: 'hello' })).trigger.matches, false);
  assert.equal(await fingerprint(), before, 'simulation changed stored state');
  assert.equal(networkCalls, calls);
});

test('publish pins versions: a waiting execution resumes on its own version; new triggers use the new one', async () => {
  enable();
  const f = await fixture();
  const flowId = await published(f, 'versions', definition([{ id: 'a', type: 'add_label', label: 'v1' }, { id: 'w', type: 'wait', minutes: 10, cancelOnReply: true }, { id: 'b', type: 'add_label', label: 'v1-after' }]));
  const first = await inbound(f, 'Uversion1', 'สวัสดี');
  const [pending] = await executions(f, flowId);
  assert.equal(pending.status, 'waiting'); assert.equal(pending.version, 1);
  const detail = await flowDetail(f.admin, flowId);
  await saveFlowDraft(f.admin, flowId, { expectedRevision: detail.flow.draftRevision, definition: definition([{ id: 'a', type: 'add_label', label: 'v2' }, { id: 'w', type: 'wait', minutes: 10, cancelOnReply: true }, { id: 'b', type: 'add_label', label: 'v2-after' }]) });
  await assert.rejects(saveFlowDraft(f.admin, flowId, { expectedRevision: detail.flow.draftRevision, definition: definition([{ id: 'a', type: 'add_label', label: 'stale' }]) }), { status: 409 }, 'stale draft revision');
  await publishFlow(f.admin, flowId, { expectedRevision: detail.flow.draftRevision + 1, confirm: true });
  const versions = (await database.query('SELECT version,definition FROM flow_versions WHERE org_id=$1 AND flow_id=$2 ORDER BY version', [f.org, flowId])).rows;
  assert.deepEqual(versions.map(row => row.version), [1, 2]);
  await assert.rejects(database.query('UPDATE flow_versions SET definition=$3 WHERE org_id=$1 AND flow_id=$2', [f.org, flowId, '{}']), /flow_version_immutable/);
  await assert.rejects(database.query('DELETE FROM flow_versions WHERE org_id=$1 AND flow_id=$2', [f.org, flowId]), /flow_version_immutable/);
  const second = await inbound(f, 'Uversion2', 'สวัสดี');
  await runFlows(await getDatabase(), env(), { orgId: f.org, now: later(11) });
  assert.deepEqual((await lead(first.leadId)).tags, ['v1', 'v1-after'], 'running execution keeps version 1');
  assert.deepEqual((await lead(second.leadId)).tags, ['v2', 'v2-after'], 'new execution uses version 2');
  assert.deepEqual((await executions(f, flowId)).map(row => [row.version, row.status]), [[1, 'completed'], [2, 'completed']]);
  disable();
});

test('inbound triggers once per trigger key (dedupe), and new_conversation only once', async () => {
  enable();
  const f = await fixture();
  const keyword = await published(f, 'keyword', definition([{ id: 'a', type: 'add_label', label: 'asked-price' }], { type: 'keyword', keywords: ['ราคา'], match: 'contains' }));
  const fresh = await published(f, 'fresh', definition([{ id: 'a', type: 'add_label', label: 'new' }], { type: 'new_conversation' }));
  const one = await inbound(f, 'Udedupe', 'ขอราคาครับ', 'mid-dedupe');
  const replay = await inbound(f, 'Udedupe', 'ขอราคาครับ', 'mid-dedupe');
  assert.equal(replay.result.duplicates, 1);
  await onInboundSignal(one.signal); await onInboundSignal(one.signal);
  assert.equal((await executions(f, keyword)).length, 1);
  assert.equal((await executions(f, fresh)).length, 1);
  await inbound(f, 'Udedupe', 'ราคาเท่าไหร่');
  assert.equal((await executions(f, keyword)).length, 2, 'a different message is a different trigger key');
  assert.equal((await executions(f, fresh)).length, 1, 'new_conversation fires once per conversation');
  await inbound(f, 'Udedupe', 'hello');
  assert.equal((await executions(f, keyword)).length, 2, 'keyword mismatch does not trigger');
  assert.deepEqual((await lead(one.leadId)).tags.sort(), ['asked-price', 'new']);
  disable();
});

test('wait resumes via the runner only when due', async () => {
  enable();
  const f = await fixture();
  const flowId = await published(f, 'wait', definition([{ id: 'w', type: 'wait', minutes: 30, cancelOnReply: true }, { id: 'a', type: 'add_label', label: 'resumed' }, { id: 't', type: 'create_task', title: 'โทรหาลูกค้า', dueInMinutes: 60, assignTo: 'none' }]));
  const one = await inbound(f, 'Uwait', 'สวัสดี');
  assert.equal((await executions(f, flowId))[0].status, 'waiting');
  await runFlows(await getDatabase(), env(), { orgId: f.org });
  assert.equal((await executions(f, flowId))[0].status, 'waiting', 'not due yet');
  const result = await runFlows(await getDatabase(), env(), { orgId: f.org, now: later(31) });
  assert.equal(result.status, 'ok');
  const [done] = await executions(f, flowId);
  assert.equal(done.status, 'completed');
  assert.deepEqual((await lead(one.leadId)).tags, ['resumed']);
  assert.equal((await database.query("SELECT count(*) AS n FROM tasks WHERE org_id=$1 AND lead_id=$2 AND title='โทรหาลูกค้า'", [f.org, one.leadId])).rows[0].n, 1);
  await runFlows(await getDatabase(), env(), { orgId: f.org, now: later(120) });
  assert.equal((await database.query('SELECT count(*) AS n FROM tasks WHERE org_id=$1 AND lead_id=$2', [f.org, one.leadId])).rows[0].n, 1, 'no duplicate effects');
  disable();
});

test('customer reply, opt-out and closing cancel pending waits (hook and durable runner check)', async () => {
  enable();
  const f = await fixture();
  const flowId = await published(f, 'cancel', definition([{ id: 'w', type: 'wait', minutes: 30, cancelOnReply: true }, { id: 'a', type: 'add_label', label: 'should-not-happen' }], { type: 'keyword', keywords: ['start'], match: 'exact' }));
  const one = await inbound(f, 'Ureply', 'start');
  await inbound(f, 'Ureply', 'ตอบกลับแล้วครับ');
  let [row] = await executions(f, flowId);
  assert.equal(row.status, 'cancelled'); assert.equal(row.cancel_reason, 'customer_replied');
  assert.equal(JSON.parse((await database.query("SELECT detail FROM flow_execution_steps WHERE org_id=$1 AND execution_id=$2 AND outcome='cancelled'", [f.org, row.id])).rows[0].detail).reason, 'customer_replied');
  // Durable path: the reply is committed while the hook is off; the runner still cancels on resume.
  const two = await inbound(f, 'Ureply2', 'start');
  disable(); await inbound(f, 'Ureply2', 'ตอบแล้ว'); enable();
  await runFlows(await getDatabase(), env(), { orgId: f.org, now: later(31) });
  row = (await executions(f, flowId)).find(item => item.conversation_id === two.conversationId)!;
  assert.equal(row.status, 'cancelled'); assert.equal(row.cancel_reason, 'customer_replied');
  // Opt-out text cancels and prevents new executions.
  const three = await inbound(f, 'Uoptout', 'start');
  await inbound(f, 'Uoptout', 'STOP');
  row = (await executions(f, flowId)).find(item => item.conversation_id === three.conversationId)!;
  assert.equal(row.cancel_reason, 'opted_out');
  await inbound(f, 'Uoptout', 'start');
  assert.equal((await executions(f, flowId)).filter(item => item.conversation_id === three.conversationId).length, 1);
  // Staff closing the conversation cancels at resume.
  const four = await inbound(f, 'Uclose', 'start');
  await conversationAction(f.admin, four.conversationId, 'resolve', {});
  await runFlows(await getDatabase(), env(), { orgId: f.org, now: later(31) });
  row = (await executions(f, flowId)).find(item => item.conversation_id === four.conversationId)!;
  assert.equal(row.cancel_reason, 'conversation_closed');
  for (const id of [one.leadId, two.leadId, three.leadId, four.leadId]) assert.deepEqual((await lead(id)).tags, []);
  // A Flow's own close action cancels other pending automations (even ones that ignore replies).
  const patient = await published(f, 'patient', definition([{ id: 'w', type: 'wait', minutes: 60, cancelOnReply: false }, { id: 'a', type: 'add_label', label: 'late' }], { type: 'keyword', keywords: ['wait'], match: 'exact' }));
  const closer = await published(f, 'closer', definition([{ id: 'c', type: 'close_conversation' }], { type: 'keyword', keywords: ['bye'], match: 'exact' }));
  const five = await inbound(f, 'Ucloser', 'wait');
  await inbound(f, 'Ucloser', 'bye');
  assert.deepEqual([(await executions(f, patient))[0].status, (await executions(f, patient))[0].cancel_reason], ['cancelled', 'conversation_closed']);
  assert.equal((await executions(f, closer))[0].status, 'completed');
  assert.equal((await database.query('SELECT status FROM conversations WHERE id=$1', [five.conversationId])).rows[0].status, 'resolved');
  disable();
});

test('loop guard: no self or cross-flow retrigger, and per-subject hourly cap', async () => {
  enable();
  const f = await fixture();
  const self = await published(f, 'self', definition([{ id: 'r', type: 'remove_label', label: 'vip' }, { id: 'a', type: 'add_label', label: 'vip' }], { type: 'label_added', label: 'vip' }));
  const a = await published(f, 'a', definition([{ id: 'b', type: 'add_label', label: 'b' }], { type: 'label_added', label: 'a' }));
  const b = await published(f, 'b', definition([{ id: 'r', type: 'remove_label', label: 'a' }, { id: 'a', type: 'add_label', label: 'a' }], { type: 'label_added', label: 'b' }));
  const one = await inbound(f, 'Uloop', 'hello');
  await adminAction(f.admin, { action: 'updateLead', id: one.leadId, values: { tags: ['vip', 'a'] } });
  for (let run = 0; run < 5; run++) await runFlows(await getDatabase(), env(), { orgId: f.org });
  assert.equal((await executions(f, self)).length, 1, 'a flow never retriggers itself');
  assert.equal((await executions(f, a)).length, 1, 'A is not retriggered through B');
  assert.equal((await executions(f, b)).length, 1);
  assert.equal((await database.query("SELECT count(*) AS n FROM flow_events WHERE org_id=$1 AND status='pending'", [f.org])).rows[0].n, 0);
  const cap = await published(f, 'cap', definition([{ id: 'a', type: 'add_label', label: 'seen' }]));
  for (let index = 0; index < 7; index++) await inbound(f, 'Ucap', 'ข้อความ ' + index);
  assert.equal((await executions(f, cap)).filter(row => row.conversation_id !== one.conversationId).length, 5, 'max executions per subject per hour');
  disable();
});

test('sending goes through the existing outbound gates; human takeover blocks it; one greeting per conversation', async () => {
  enable(true);
  const f = await fixture(), calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const transport = (async (input: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(input), body: JSON.parse(String(init?.body)) }); assert.equal(init?.redirect, 'manual'); return Response.json({ sentMessages: [{ id: 'line-flow-' + calls.length }] }); }) as typeof fetch;
  const dispatch = { config: { ...f.config, liveEnabled: true }, fetch: transport };
  const greet = await published(f, 'greet', definition([{ id: 'g', type: 'send_message', text: 'สวัสดีค่ะ ยินดีต้อนรับสู่ RRS', greeting: true }]));
  // Collect signals with the hook off so the injected transport is used explicitly.
  disable();
  const one = await inbound(f, 'Usend', 'สวัสดีครับ');
  enable(true);
  await enableLine(f);
  // Human takeover: automation must not send.
  await conversationAction(f.admin, one.conversationId, 'claim', {});
  await onInboundSignal(one.signal, { dispatch });
  assert.equal(calls.length, 0);
  assert.equal((await database.query('SELECT count(*) AS n FROM social_outbound_commands WHERE org_id=$1', [f.org])).rows[0].n, 0);
  const blocked = (await database.query("SELECT outcome,detail FROM flow_execution_steps WHERE org_id=$1 AND action='send_message'", [f.org])).rows[0];
  assert.equal(blocked.outcome, 'blocked'); assert.equal(JSON.parse(blocked.detail).reason, 'human_takeover');
  // Released: the flow queues one intent through the existing outbound path and dispatches it once.
  await conversationAction(f.admin, one.conversationId, 'release', {});
  disable(); const two = await inbound(f, 'Usend', 'ยังอยู่ไหมครับ'); enable(true);
  await onInboundSignal(two.signal, { dispatch });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.line.me/v2/bot/message/push');
  assert.deepEqual(calls[0].body.messages, [{ type: 'text', text: 'สวัสดีค่ะ ยินดีต้อนรับสู่ RRS' }]);
  const command = (await database.query('SELECT * FROM social_outbound_commands WHERE org_id=$1', [f.org])).rows[0];
  assert.equal(command.status, 'submitted'); assert.equal(command.approved_by, f.admin.id);
  const provenance = (await database.query('SELECT metadata FROM social_message_provenance WHERE org_id=$1 AND message_id=$2', [f.org, command.message_id])).rows[0];
  assert.equal(provenance.metadata.approval, 'flow'); assert.equal(provenance.metadata.flow.flowId, greet);
  // One greeting per conversation, across flows and triggers.
  const second = await published(f, 'greet-again', definition([{ id: 'g', type: 'send_message', text: 'สวัสดีอีกครั้ง', greeting: true }]));
  disable(); const three = await inbound(f, 'Usend', 'ครับ'); enable(true);
  await onInboundSignal(three.signal, { dispatch });
  assert.equal(calls.length, 1, 'no duplicate greeting');
  assert.ok((await executions(f, second)).length >= 1);
  assert.equal((await database.query('SELECT count(*) AS n FROM flow_greetings WHERE org_id=$1', [f.org])).rows[0].n, 1);
  // A queued Flow intent becomes unsendable after a later takeover: the outbound guard refuses it.
  const other = await published(f, 'plain', definition([{ id: 'p', type: 'send_message', text: 'ข้อความอัตโนมัติ', greeting: false }], { type: 'keyword', keywords: ['เมนู'], match: 'exact' }));
  disable(); const four = await inbound(f, 'Uguard', 'เมนู'); enable(true);
  await database.query('UPDATE social_channel_controls SET verification_expires_at=$4 WHERE org_id=$1 AND provider=$2 AND account_id=$3', [f.org, 'line', f.config.accountId, new Date(Date.now() - 1000).toISOString()]);
  await onInboundSignal(four.signal, { dispatch });
  const queued = (await database.query("SELECT o.* FROM social_outbound_commands o JOIN flow_outbound_commands l ON l.org_id=o.org_id AND l.outbound_command_id=o.id WHERE o.org_id=$1 AND l.flow_id=$2", [f.org, other])).rows[0];
  assert.equal(queued.status, 'queued', 'unverified channel defers the intent');
  await enableLine(f);
  await conversationAction(f.admin, four.conversationId, 'claim', {});
  await assert.rejects(dispatchSocialReply(f.org, queued.id, dispatch), { status: 409 });
  assert.equal(calls.length, 1, 'no provider call after takeover');
  // Pausing a flow cancels only its own queued intents; the global pause cancels the rest.
  const intent = async (flowId: string) => (await database.query("SELECT o.status,o.error_code,p.delivery_status FROM social_outbound_commands o JOIN flow_outbound_commands l ON l.org_id=o.org_id AND l.outbound_command_id=o.id JOIN social_message_provenance p ON p.org_id=o.org_id AND p.message_id=o.message_id WHERE o.org_id=$1 AND l.flow_id=$2 AND o.conversation_id=$3", [f.org, flowId, four.conversationId])).rows[0];
  await setFlowPaused(f.admin, other, true, {});
  assert.deepEqual(Object.values(await intent(other)), ['cancelled', 'flow_paused', 'cancelled']);
  assert.equal((await intent(greet)).status, 'queued');
  await setFlowPaused(f.admin, other, false, { confirm: true });
  await setFlowsGlobalPause(f.admin, { paused: true });
  assert.deepEqual(Object.values(await intent(greet)), ['cancelled', 'flow_paused', 'cancelled']);
  await setFlowsGlobalPause(f.admin, { paused: false, confirm: true });
  assert.equal((await database.query("SELECT status FROM social_outbound_commands WHERE org_id=$1 AND conversation_id=$2", [f.org, one.conversationId])).rows[0].status, 'submitted', 'a dispatched intent is never rewritten');
  // Sending flag off: nothing new is queued at all (1 greeting for Usend; greeting + plain for Uguard).
  await conversationAction(f.admin, four.conversationId, 'release', {});
  disable(); const five = await inbound(f, 'Uguard', 'เมนู'); enable(false);
  await onInboundSignal(five.signal, { dispatch });
  assert.equal((await database.query('SELECT count(*) AS n FROM social_outbound_commands WHERE org_id=$1', [f.org])).rows[0].n, 3);
  assert.ok((await database.query("SELECT detail FROM flow_execution_steps WHERE org_id=$1 AND action='send_message' AND outcome='blocked'", [f.org])).rows.some(row => JSON.parse(row.detail).reason === 'sending_disabled'));
  disable();
});

test('emergency pause per flow and globally stops starts, resumes and queued sends', async () => {
  enable();
  const f = await fixture();
  const flowId = await published(f, 'pause', definition([{ id: 'w', type: 'wait', minutes: 5, cancelOnReply: false }, { id: 'a', type: 'add_label', label: 'after-pause' }], { type: 'keyword', keywords: ['go'], match: 'exact' }));
  const one = await inbound(f, 'Upause', 'go');
  await setFlowPaused(f.admin, flowId, true, {});
  await runFlows(await getDatabase(), env(), { orgId: f.org, now: later(10) });
  assert.equal((await executions(f, flowId))[0].status, 'waiting', 'paused flow does not advance');
  await inbound(f, 'Upause2', 'go');
  assert.equal((await executions(f, flowId)).length, 1, 'paused flow does not start');
  await assert.rejects(setFlowPaused(f.admin, flowId, false, {}), { status: 400 }, 'resume needs confirmation');
  await setFlowPaused(f.admin, flowId, false, { confirm: true });
  await setFlowsGlobalPause(f.admin, { paused: true });
  await runFlows(await getDatabase(), env(), { orgId: f.org, now: later(10) });
  assert.equal((await executions(f, flowId))[0].status, 'waiting', 'global pause stops the runner');
  await inbound(f, 'Upause3', 'go');
  assert.equal((await executions(f, flowId)).length, 1);
  await setFlowsGlobalPause(f.admin, { paused: false, confirm: true });
  await runFlows(await getDatabase(), env(), { orgId: f.org, now: later(10) });
  assert.equal((await executions(f, flowId))[0].status, 'completed');
  assert.deepEqual((await lead(one.leadId)).tags, ['after-pause']);
  disable();
});

test('scheduled trigger runs once per slot for matching conversations', async () => {
  enable();
  const f = await fixture();
  const now = Date.now(), local = new Date(now + 7 * 3600_000), time = `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`;
  assert.ok(now - latestSlot({ type: 'schedule', frequency: 'daily', time }, now) < 60_000);
  disable();
  const one = await inbound(f, 'Uschedule1', 'hello');
  const two = await inbound(f, 'Uschedule2', 'hello');
  await database.query("UPDATE leads SET market='export' WHERE id=$1", [two.leadId]);
  enable();
  const flowId = await published(f, 'daily', definition([{ id: 'a', type: 'add_label', label: 'daily' }], { type: 'schedule', frequency: 'daily', time }, [{ type: 'market', markets: ['domestic'] }]));
  await runFlows(await getDatabase(), env(), { orgId: f.org, now: () => now + 30_000 });
  await runFlows(await getDatabase(), env(), { orgId: f.org, now: () => now + 60_000 });
  assert.equal((await executions(f, flowId)).length, 1);
  assert.deepEqual((await lead(one.leadId)).tags, ['daily']);
  assert.deepEqual((await lead(two.leadId)).tags, []);
  disable();
});

test('organization isolation for triggers, reads, simulation and mutations', async () => {
  enable();
  const a = await fixture(), b = await fixture();
  const flowId = await published(a, 'isolated', definition([{ id: 'x', type: 'add_label', label: 'org-a' }]));
  const inB = await inbound(b, 'Ushared', 'hello');
  const inA = await inbound(a, 'Ushared', 'hello');
  assert.deepEqual((await executions(a, flowId)).map(row => row.conversation_id), [inA.conversationId]);
  assert.deepEqual((await lead(inB.leadId)).tags, []);
  await assert.rejects(flowDetail(b.admin, flowId), { status: 404 });
  await assert.rejects(simulateFlow(b.admin, flowId, { conversationId: inB.conversationId }), { status: 404 });
  await assert.rejects(simulateFlow(a.admin, flowId, { conversationId: inB.conversationId }), { status: 404 });
  await assert.rejects(publishFlow(b.admin, flowId, { expectedRevision: 1, confirm: true }), { status: 404 });
  await assert.rejects(setFlowPaused(b.admin, flowId, true, {}), { status: 404 });
  const execution = (await executions(a, flowId))[0];
  await assert.rejects(cancelFlowExecution(b.admin, flowId, execution.id), { status: 404 });
  assert.equal((await listFlows(b.admin)).flows.length, 0);
  assert.equal((await listFlows(a.admin)).flows.length, 1);
  disable();
});

test('Agents are read-only; mutations require Admin and same-origin through the API route', async () => {
  const f = await fixture(), flow = await createFlow(f.admin, { name: 'route' });
  const one = await inbound(f, 'Uroute', 'hello');
  const call = (method: 'GET' | 'POST', path: string, token: string, body?: unknown, origin = APP) => (method === 'GET' ? GET : POST)(new Request(APP + path, { method, headers: { cookie: `rrs_staff=${token}`, ...(method === 'POST' ? { origin, 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }) as unknown as NextRequest);
  assert.equal((await call('GET', '/api/admin/flows', '')).status, 401);
  const list = await call('GET', '/api/admin/flows', f.agentToken);
  assert.equal(list.status, 200); assert.equal((await list.json()).canEdit, false);
  assert.equal((await call('GET', `/api/admin/flows/${flow.flow.id}`, f.agentToken)).status, 200);
  assert.equal((await call('POST', `/api/admin/flows/${flow.flow.id}/simulate`, f.agentToken, { conversationId: one.conversationId })).status, 200);
  for (const [path, body] of [['/api/admin/flows', { name: 'agent' }], [`/api/admin/flows/${flow.flow.id}/draft`, { expectedRevision: 1, definition: definition([{ id: 'a', type: 'add_label', label: 'x' }]) }], [`/api/admin/flows/${flow.flow.id}/publish`, { expectedRevision: 1, confirm: true }], [`/api/admin/flows/${flow.flow.id}/pause`, {}], ['/api/admin/flows/control', { paused: true }]] as const)
    assert.equal((await call('POST', path, f.agentToken, body)).status, 403, path);
  await assert.rejects(createFlow(f.agent, { name: 'agent' }), { status: 403 });
  await assert.rejects(publishFlow(f.agent, flow.flow.id, { expectedRevision: 1, confirm: true }), { status: 403 });
  await assert.rejects(setFlowsGlobalPause(f.agent, { paused: true }), { status: 403 });
  assert.equal((await call('POST', '/api/admin/flows', f.adminToken, { name: 'foreign' }, 'https://attacker.example.invalid')).status, 403, 'cross-origin POST');
  const created = await call('POST', '/api/admin/flows', f.adminToken, { name: 'ผ่านหน้าเว็บ' });
  assert.equal(created.status, 200);
  const published = await call('POST', `/api/admin/flows/${(await created.json()).flow.id}/publish`, f.adminToken, { expectedRevision: 1, confirm: true });
  assert.equal(published.status, 200); assert.equal((await published.json()).publishedVersion, 1);
  assert.deepEqual((await database.query("SELECT action FROM audit_events WHERE org_id=$1 AND action LIKE 'flow.%' ORDER BY created_at", [f.org])).rows.map(row => row.action), ['flow.created', 'flow.created', 'flow.published']);
});
