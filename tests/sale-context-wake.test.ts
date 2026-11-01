/** Real isolated SQLite and signed synthetic Sale requests; never provider traffic. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { database, getDatabase, closeDatabase } from '../src/lib/db';
import { signBridgeRequest, verifyBridgeRequest } from '../src/lib/bridge-protocol';
import { saleContextHash, saleContextForLead } from '../src/lib/sale-context';
import { handleSaleContextSync, SALE_CONTEXT_SYNC_PATH } from '../cloudflare/sale-context-sync';

const orgId = randomUUID(), leadId = randomUUID(), secret = 'synthetic-wake-secret-at-least-32-characters';
const target = 'https://crm.test' + SALE_CONTEXT_SYNC_PATH, origin = 'https://sale.test';
const previous = { DEMO_MODE: process.env.DEMO_MODE, AI_PROVIDER: process.env.AI_PROVIDER, D1_LOCAL_DIR: process.env.D1_LOCAL_DIR };
const outbox: Record<string, unknown>[] = [], calls: string[] = [];
let failAck = false, failPull = false;
const payload = { workspace: 'domestic', leadId, dealId: 'deal-wake', title: 'Synthetic deal', stage: 1 };
function event(sequence: number) { return { event_id: 'wake-event-' + sequence, event_type: 'deal.context', schema_version: 1, org_id: orgId, source_app: 'sale', aggregate_type: 'deal', aggregate_id: payload.dealId, aggregate_version: sequence, sequence_scope: 'organization', sequence, occurred_at: new Date().toISOString(), payload_hash: saleContextHash(payload), payload }; }
async function env() { return { DB: await getDatabase(), CRM_BRIDGE_ENABLED: 'true', CRM_SALE_CONTEXT_ENABLED: 'true', CRM_BRIDGE_ORG_ID: orgId, CRM_BRIDGE_SECRET: secret, CRM_SALE_CONTEXT_ORIGIN: origin }; }
async function wake(headSequence = 1, options: { body?: string; url?: string; key?: string; time?: number; headers?: Record<string, string> } = {}) {
  const url = options.url || target, body = options.body ?? JSON.stringify({ version: 1, reason: 'wake', headSequence });
  const headers = await signBridgeRequest(url, { secret: options.key || secret, orgId, method: 'POST', body, now: options.time });
  for (const [key, value] of Object.entries(options.headers || {})) headers.set(key, value);
  return new Request(url, { method: 'POST', headers, body });
}
const fakeSale: typeof fetch = async (input, init) => {
  const request = new Request(input, init), url = new URL(request.url);
  assert.equal(url.origin, origin); await verifyBridgeRequest(request.clone(), { secret, orgId }); calls.push(url.pathname);
  if (url.pathname === '/api/rrs/crm/outbox') {
    if (failPull) return new Response('private upstream body must not escape', { status: 500 });
    const after = Number(url.searchParams.get('after')), events = outbox.filter(e => Number(e.sequence) > after).slice(0, 100);
    return Response.json({ version: 1, orgId, after, events, headSequence: outbox.length, hasMore: outbox.length > after + events.length });
  }
  assert.equal(url.pathname, '/api/rrs/crm/outbox/ack');
  const body = await request.json();
  const cursor = (await database.query('SELECT last_sequence FROM crm_sale_context_cursor WHERE org_id=$1', [orgId])).rows[0];
  assert.ok(Number(cursor.last_sequence) >= body.sequence, 'ACK only follows committed projection');
  return new Response('{}', { status: failAck ? 500 : 200 });
};
before(async () => {
  const directory = path.join(process.cwd(), '.data', 'sale-wake-' + randomUUID()); await mkdir(directory, { recursive: true });
  Object.assign(process.env, { DEMO_MODE: 'true', AI_PROVIDER: 'disabled', D1_LOCAL_DIR: directory });
  await database.query("INSERT INTO organizations(id,slug,name) VALUES($1,$2,'Synthetic')", [orgId, 'wake-' + orgId.slice(0, 8)]);
});
after(async () => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; await closeDatabase(); });

test('disabled and unauthorized wakes do not call Sale or mutate the projection', async () => {
  const e = await env(), before = calls.length;
  assert.equal((await handleSaleContextSync(await wake(), { ...e, CRM_SALE_CONTEXT_ENABLED: 'false' }, fakeSale)).status, 503);
  assert.equal((await handleSaleContextSync(new Request(target), e, fakeSale)).status, 405);
  assert.equal((await handleSaleContextSync(await wake(1, { key: secret + '-wrong' }), e, fakeSale)).status, 401);
  assert.equal((await handleSaleContextSync(await wake(1, { time: Date.now() - 600_000 }), e, fakeSale)).status, 401);
  assert.equal((await handleSaleContextSync(await wake(1, { headers: { Origin: origin } }), e, fakeSale)).status, 403);
  assert.equal((await handleSaleContextSync(await wake(1, { headers: { 'X-RRS-Bridge-Org': 'foreign-org' } }), e, fakeSale)).status, 401);
  for (const body of ['{', '{}', '[]', JSON.stringify({ version: 1, reason: 'wake', headSequence: -1 }), JSON.stringify({ version: 1, reason: 'wake', headSequence: 1, payload })]) assert.equal((await handleSaleContextSync(await wake(1, { body }), e, fakeSale)).status, 400);
  assert.equal((await handleSaleContextSync(await wake(1, { url: target + '?extra=1' }), e, fakeSale)).status, 400);
  assert.equal((await handleSaleContextSync(await wake(1, { body: ' '.repeat(4097) }), e, fakeSale)).status, 413);
  assert.equal(calls.length, before);
  assert.equal((await database.query('SELECT * FROM crm_sale_context_cursor WHERE org_id=$1', [orgId])).rows.length, 0);
});

test('signed wake pulls committed context once; duplicate wake is a cheap no-op', async () => {
  outbox.push(event(1)); const e = await env();
  const response = await handleSaleContextSync(await wake(), e, fakeSale);
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await response.json(), { status: 'ok', sequence: 1, applied: 1 });
  assert.equal((await saleContextForLead(e.DB, orgId, leadId)).deals[0].dealId, payload.dealId);
  const before = calls.length;
  assert.deepEqual(await (await handleSaleContextSync(await wake(), e, fakeSale)).json(), { status: 'up_to_date', sequence: 1 });
  assert.equal(calls.length, before);
});

test('failed ACK is retried even though the context already committed; errors remain redacted', async () => {
  const e = await env(); outbox.push(event(2)); failAck = true;
  assert.equal((await handleSaleContextSync(await wake(2), e, fakeSale)).status, 503);
  failAck = false;
  assert.equal((await handleSaleContextSync(await wake(2), e, fakeSale)).status, 200);
  outbox.push(event(3)); failPull = true;
  const failed = await handleSaleContextSync(await wake(3), e, fakeSale);
  assert.equal(failed.status, 503); assert.deepEqual(await failed.json(), { error: 'SALE_CONTEXT_PULL_FAILED' });
  failPull = false;
  assert.equal((await handleSaleContextSync(await wake(3), e, fakeSale)).status, 200);
});

test('a wake processes one page and reports catch-up honestly without claiming the entire head is applied', async () => {
  for (let seq = 4; seq <= 104; seq++) outbox.push(event(seq));
  const e = await env(), before = calls.length;
  const first = await handleSaleContextSync(await wake(104), e, fakeSale);
  assert.equal(first.status, 202); assert.deepEqual(await first.json(), { status: 'catching_up', sequence: 103, applied: 100 });
  assert.equal(calls.length - before, 2, 'one outbox page and one ACK');
  assert.equal((await handleSaleContextSync(await wake(104), e, fakeSale)).status, 200);
});

test('concurrent wakes never duplicate events and the losing caller can safely retry', async () => {
  outbox.push(event(105)); const e = await env();
  const responses = await Promise.all([wake(105), wake(105)].map(async request => handleSaleContextSync(await request, e, fakeSale)));
  assert.ok(responses.some(response => response.status === 200));
  assert.ok(responses.every(response => [200, 503].includes(response.status)));
  assert.equal((await handleSaleContextSync(await wake(105), e, fakeSale)).status, 200);
  const receipt = (await database.query('SELECT COUNT(*) AS n FROM crm_sale_context_events WHERE org_id=$1 AND sequence=105', [orgId])).rows[0];
  assert.equal(receipt.n, 1);
  const cursor = (await database.query('SELECT last_sequence,acknowledged_sequence FROM crm_sale_context_cursor WHERE org_id=$1', [orgId])).rows[0];
  assert.equal(cursor.last_sequence, 105); assert.equal(cursor.acknowledged_sequence, 105);
});
