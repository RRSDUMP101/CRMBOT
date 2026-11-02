/** Real SQLite visitor ingestion and Flow engine; synthetic fixtures, no external traffic. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { database, closeDatabase, getDatabase } from '../src/lib/db';
import type { Staff } from '../src/lib/auth';
import { createVisitor, messageStream, saveContact } from '../src/lib/service';
import {saveWidgetConfig} from '../src/lib/helpdesk';
import { createFlow, publishFlow, onInboundSignal, runFlows, saveFlowDraft, type FlowDefinition, type FlowStep } from '../src/lib/flows';

const keys = ['DEMO_MODE', 'RRS_WORKERS', 'D1_LOCAL_DIR', 'AI_PROVIDER', 'PUBLIC_ORG_SLUG', 'FLOWS_ENABLED', 'FLOWS_SEND_ENABLED'] as const;
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const previousFetch = globalThis.fetch;
let networkCalls = 0;
before(async () => {
  Object.assign(process.env, { DEMO_MODE: 'true', RRS_WORKERS: 'false', D1_LOCAL_DIR: `.data/widget-flows-${randomUUID()}`, AI_PROVIDER: 'disabled' });
  globalThis.fetch = (async () => { networkCalls++; throw new Error('No network allowed in widget flow tests'); }) as typeof fetch;
  await database.query('SELECT 1');
});
after(async () => {
  globalThis.fetch = previousFetch; await closeDatabase();
  for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
});
async function fixture() {
  const org = randomUUID(), id = randomUUID(), slug = 'widget-flow-' + org;
  await database.query('INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)', [org, slug, 'Synthetic widget flow tenant']);
  const admin: Staff = { id, orgId: org, name: 'Synthetic admin', email: `${id}@example.invalid`, role: 'Admin' };
  await database.query("INSERT INTO members(id,org_id,name,email,password_hash,role) VALUES($1,$2,$3,$4,'not-a-real-hash','Admin')", [id, org, admin.name, admin.email]);
  process.env.PUBLIC_ORG_SLUG = slug;
  process.env.AI_PROVIDER = 'disabled';
  delete process.env.FLOWS_ENABLED; delete process.env.FLOWS_SEND_ENABLED;
  const { visitor } = await createVisitor('widget');
  return { org, admin, visitor };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
test('widget prechat gate requires explicit consent before a message can be recorded',async()=>{
 const f=await fixture();await saveWidgetConfig(f.admin,{config:{enabled:true,title:'RRS',greeting:'Hello',accentColor:'#0f766e',position:'right',allowedOrigins:[],language:'en',prechatRequired:true,icebreakers:['Hello']}});
 await assert.rejects(send(f,'Before consent'),/ยินยอม/);assert.equal((await database.query('SELECT id FROM messages WHERE org_id=$1',[f.org])).rows.length,0);
 await assert.rejects(saveContact(f.visitor,{name:'Fixture',email:'fixture@example.invalid',consent:false}),/ยินยอม/);
 await saveContact(f.visitor,{name:'Fixture',email:'fixture@example.invalid',consent:true});await send(f,'After consent');assert.equal((await database.query("SELECT id FROM messages WHERE org_id=$1 AND role='user'",[f.org])).rows.length,1);
});
async function published(f: Fixture, steps: FlowStep[], trigger: FlowDefinition['trigger'] = { type: 'inbound_message' }, provider: 'web' | 'line' = 'web') {
  const definition: FlowDefinition = { version: 1, trigger, conditions: [{ type: 'provider', providers: [provider] }], steps };
  const created = await createFlow(f.admin, { name: 'Synthetic widget flow', definition });
  await publishFlow(f.admin, created.flow.id, { expectedRevision: created.flow.draftRevision, confirm: true });
  return created.flow.id;
}
const executions = async (f: Fixture, flowId: string) => (await database.query('SELECT * FROM flow_executions WHERE org_id=$1 AND flow_id=$2 ORDER BY started_at,id', [f.org, flowId])).rows;
async function send(f: Fixture, text: string, clientId = randomUUID()) {
  const response = await messageStream(f.visitor, { text, clientId }, new AbortController().signal);
  assert.equal(response.status, 200);
  const events = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  assert.ok(events.some(event => event.type === 'done'));
  assert.ok(!events.some(event => event.type === 'error'));
  return { events, clientId };
}

test('visitor flows are default-off and the first enabled new message triggers web-scoped flows only', async () => {
  const f = await fixture();
  const web = await published(f, [{ id: 'label', type: 'add_label', label: 'widget-lead' }]);
  const line = await published(f, [{ id: 'label', type: 'add_label', label: 'wrong-channel' }], { type: 'inbound_message' }, 'line');
  await send(f, 'First input while disabled');
  assert.equal((await executions(f, web)).length, 0);
  process.env.FLOWS_ENABLED = 'true';
  await send(f, 'New input after activation');
  assert.equal((await executions(f, web)).length, 1);
  assert.equal((await executions(f, line)).length, 0);
  const lead = (await database.query('SELECT tags FROM leads WHERE org_id=$1', [f.org])).rows[0];
  assert.deepEqual(lead.tags, ['widget-lead']);
});

test('new-conversation and keyword triggers use committed message IDs; duplicate client retry does not cancel a wait', async () => {
  const f = await fixture();
  const first = await published(f, [{ id: 'task', type: 'create_task', title: 'Welcome task', dueInMinutes: 10, assignTo: 'none' }], { type: 'new_conversation' });
  const keyword = await published(f, [{ id: 'wait', type: 'wait', minutes: 60, cancelOnReply: true }, { id: 'label', type: 'add_label', label: 'later' }], { type: 'keyword', keywords: ['ราคา'], match: 'contains' });
  process.env.FLOWS_ENABLED = 'true';
  const input = await send(f, 'ขอราคา');
  const original = (await executions(f, keyword))[0];
  assert.equal(original.status, 'waiting');
  const message = (await database.query("SELECT id FROM messages WHERE org_id=$1 AND client_id=$2 AND role='user'", [f.org, input.clientId])).rows[0];
  assert.equal(original.trigger_key, 'message:' + message.id);
  assert.equal(original.trigger_event_id, 'web:' + message.id);
  await send(f, 'ขอราคา', input.clientId);
  assert.equal((await executions(f, keyword)).length, 1);
  assert.equal((await executions(f, keyword))[0].status, 'waiting');
  assert.equal((await executions(f, first)).length, 1);
  assert.equal((await database.query('SELECT count(*) AS n FROM tasks WHERE org_id=$1', [f.org])).rows[0].n, 1);
  await send(f, 'รายละเอียดเพิ่มเติม');
  assert.equal((await executions(f, keyword))[0].cancel_reason, 'customer_replied');
  assert.equal((await executions(f, first)).length, 1);
});

test('web flows cannot send provider messages or a second greeting even with flow sending enabled', async () => {
  const f = await fixture();
  const flow = await published(f, [{ id: 'greeting', type: 'send_message', text: 'A flow must not send this to the widget', greeting: true }]);
  process.env.FLOWS_ENABLED = 'true'; process.env.FLOWS_SEND_ENABLED = 'true';
  await send(f, 'hello');
  const execution = (await executions(f, flow))[0];
  const steps = (await database.query('SELECT outcome,detail FROM flow_execution_steps WHERE org_id=$1 AND execution_id=$2', [f.org, execution.id])).rows;
  assert.ok(steps.some(step => step.outcome === 'blocked' && (typeof step.detail === 'string' ? JSON.parse(step.detail) : step.detail).reason === 'non_social_channel'));
  assert.equal((await database.query("SELECT count(*) AS n FROM messages WHERE org_id=$1 AND role IN ('agent','assistant')", [f.org])).rows[0].n, 0);
  assert.equal((await database.query('SELECT count(*) AS n FROM social_outbound_commands WHERE org_id=$1', [f.org])).rows[0].n, 0);
  assert.equal(networkCalls, 0);
});

test('a delayed older inbound hook cannot cancel a wait created by a newer message', async () => {
  const f = await fixture();
  const flow = await published(f, [{ id: 'wait', type: 'wait', minutes: 60, cancelOnReply: true }, { id: 'label', type: 'add_label', label: 'later' }]);
  process.env.FLOWS_ENABLED = 'true';
  const first = await send(f, 'older');
  await send(f, 'newer');
  const rows = await executions(f, flow);
  assert.equal(rows.length, 2);
  const waiting = rows.find(row => row.status === 'waiting');
  assert.ok(waiting);
  const message = (await database.query("SELECT id FROM messages WHERE org_id=$1 AND client_id=$2 AND role='user'", [f.org, first.clientId])).rows[0];
  await onInboundSignal({ orgId: f.org, provider: 'web', accountId: '', eventId: 'web:' + message.id, kind: 'message', conversationId: f.visitor.conversationId, leadId: waiting.lead_id, messageId: message.id, text: 'older', fresh: true, optOut: false });
  assert.equal((await executions(f, flow)).find(row => row.id === waiting.id)?.status, 'waiting');
});

test('flow handoff invalidates the AI generation lease before any answer is produced', async () => {
  const f = await fixture();
  await published(f, [{ id: 'handoff', type: 'request_handoff', note: 'Route to staff' }]);
  process.env.FLOWS_ENABLED = 'true'; process.env.AI_PROVIDER = 'demo';
  const { events } = await send(f, 'hello');
  assert.equal(events.filter(event => event.type === 'token').length, 0);
  const conversation = (await database.query('SELECT status,generating_client_id FROM conversations WHERE org_id=$1 AND id=$2', [f.org, f.visitor.conversationId])).rows[0];
  assert.equal(conversation.status, 'waiting_human');
  assert.equal(conversation.generating_client_id, null);
  assert.equal((await database.query("SELECT count(*) AS n FROM messages WHERE org_id=$1 AND role='assistant'", [f.org])).rows[0].n, 0);
  assert.equal((await database.query("SELECT status FROM messages WHERE org_id=$1 AND role='user'", [f.org])).rows[0].status, 'interrupted');
  assert.equal(networkCalls, 0);
});

test('durable ingress recovers after hook failure without a browser and keeps the captured flow version', async () => {
  const f = await fixture();
  const flow = await published(f, [{ id: 'task', type: 'create_task', title: 'Pinned original task', dueInMinutes: 10, assignTo: 'none' }]);
  process.env.FLOWS_ENABLED = 'true';
  await database.query("CREATE TRIGGER synthetic_flow_start_fail BEFORE INSERT ON flow_executions BEGIN SELECT RAISE(ABORT,'synthetic_ingress_failure'); END");
  try { await send(f, 'durable'); } finally { await database.query('DROP TRIGGER synthetic_flow_start_fail'); }
  const receipt = (await database.query('SELECT * FROM flow_ingress WHERE org_id=$1', [f.org])).rows[0];
  assert.equal(receipt.status, 'pending'); assert.equal(receipt.attempts, 1);
  await saveFlowDraft(f.admin, flow, { expectedRevision: 1, name: 'Updated flow', definition: { version: 1, trigger: { type: 'inbound_message' }, conditions: [{ type: 'provider', providers: ['web'] }], steps: [{ id: 'task', type: 'create_task', title: 'Must not retroactively run', dueInMinutes: 10, assignTo: 'none' }] } });
  await publishFlow(f.admin, flow, { expectedRevision: 2, confirm: true });
  const db = await getDatabase();
  await runFlows(db, process.env, { orgId: f.org, now: () => Date.now() + 5000 });
  const tasks = (await database.query('SELECT title FROM tasks WHERE org_id=$1', [f.org])).rows;
  assert.deepEqual(tasks, [{ title: 'Pinned original task' }]);
  assert.equal((await database.query('SELECT status FROM flow_ingress WHERE org_id=$1', [f.org])).rows[0].status, 'processed');
  await runFlows(db, process.env, { orgId: f.org, now: () => Date.now() + 6000 });
  assert.equal((await database.query('SELECT count(*) AS n FROM tasks WHERE org_id=$1', [f.org])).rows[0].n, 1);
});

test('ingress and canonical message commit atomically, and replay after receipt failure does not duplicate effects', async () => {
  const f = await fixture();
  await published(f, [{ id: 'task', type: 'create_task', title: 'Exactly once task', dueInMinutes: 10, assignTo: 'none' }]);
  process.env.FLOWS_ENABLED = 'true';
  await database.query("CREATE TRIGGER synthetic_ingress_fail BEFORE INSERT ON flow_ingress BEGIN SELECT RAISE(ABORT,'synthetic_atomic_failure'); END");
  try { await assert.rejects(send(f, 'no partial message'), /synthetic_atomic_failure/); } finally { await database.query('DROP TRIGGER synthetic_ingress_fail'); }
  assert.equal((await database.query("SELECT count(*) AS n FROM messages WHERE org_id=$1 AND role='user'", [f.org])).rows[0].n, 0);
  await database.query("CREATE TRIGGER synthetic_receipt_fail BEFORE UPDATE OF status ON flow_ingress WHEN NEW.status='processed' BEGIN SELECT RAISE(ABORT,'synthetic_receipt_failure'); END");
  try { await send(f, 'commit before receipt failure'); } finally { await database.query('DROP TRIGGER synthetic_receipt_fail'); }
  assert.equal((await database.query('SELECT count(*) AS n FROM tasks WHERE org_id=$1', [f.org])).rows[0].n, 1);
  await runFlows(await getDatabase(), process.env, { orgId: f.org, now: () => Date.now() + 5000 });
  assert.equal((await database.query('SELECT count(*) AS n FROM tasks WHERE org_id=$1', [f.org])).rows[0].n, 1);
  assert.equal((await database.query('SELECT status FROM flow_ingress WHERE org_id=$1', [f.org])).rows[0].status, 'processed');
});
