/** Real SQLite and a synthetic signed Sale outbox. No production/provider traffic. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { database, getDatabase, closeDatabase } from '../src/lib/db';
import { applySaleEvents, pullSaleContext, refreshSaleContextIfStale, saleContextForLead, saleContextHash } from '../src/lib/sale-context';
import { verifyBridgeRequest } from '../src/lib/bridge-protocol';
import { conversationDetail } from '../src/lib/service';

const ids = { org: randomUUID(), other: randomUUID(), lead: randomUUID(), conversation: randomUUID() };
const secret = 'synthetic-sale-context-secret-at-least-32-characters', sale = 'https://sale.test';
const keys = ['DEMO_MODE','AI_PROVIDER','D1_LOCAL_DIR','APP_ORIGIN','CRM_BRIDGE_ENABLED','CRM_BRIDGE_ORG_ID','CRM_BRIDGE_SECRET','CRM_SALE_CONTEXT_ENABLED','CRM_SALE_CONTEXT_ORIGIN'] as const;
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const previousFetch = globalThis.fetch;
const outbox: Record<string, unknown>[] = [], acks: number[] = [], requests: string[] = [];
let failure: 'http' | 'network' | 'org' | null = null;
function event(sequence: number, dealId: string, version: number, change: Record<string, unknown> = {}, leadId = ids.lead) {
  const payload = { workspace: 'live', leadId, dealId, title: 'ดีล ' + dealId, stage: 2, salesStatus: 'เสนอราคา', waiting: 'customer', nextAction: 'โทรติดตาม', followDate: '2026-11-02', quotation: { number: 'QT-1', revision: 1, status: 'sent', sentAt: '2026-10-30', acceptedAt: '' }, salesOrder: null, payments: { reported: 0, confirmed: 0 }, production: null, shipment: null, ...change };
  return { event_id: `sale:live:${version}:${dealId}`, event_type: 'deal.context', schema_version: 1, org_id: ids.org, source_app: 'sale', aggregate_type: 'deal', aggregate_id: dealId, aggregate_version: version, sequence_scope: 'organization', sequence, occurred_at: new Date().toISOString(), correlation_id: 'live:' + version, causation_id: 'test', payload_hash: saleContextHash(payload), payload };
}
async function fakeSale(input: string | URL | Request, init?: RequestInit) {
  const request = new Request(input, init), url = new URL(request.url);
  assert.equal(url.origin, sale); await verifyBridgeRequest(request.clone(), { secret, orgId: ids.org }); requests.push(url.pathname);
  if (failure === 'network') throw new Error('synthetic outage');
  if (failure === 'http') return new Response('{}', { status: 500 });
  if (url.pathname === '/api/rrs/crm/outbox') {
    const after = Number(url.searchParams.get('after')), events = outbox.filter(e => Number(e.sequence) > after).slice(0, 100), head = outbox.length;
    return Response.json({ version: 1, orgId: failure === 'org' ? ids.other : ids.org, after, events, nextCursor: events.length ? Number(events.at(-1)!.sequence) : after, headSequence: head, hasMore: false });
  }
  if (url.pathname === '/api/rrs/crm/outbox/ack') { const body = await request.json(); acks.push(body.sequence); return Response.json({ consumerId: body.consumerId, acknowledgedSequence: body.sequence }); }
  throw new Error('unexpected ' + url.pathname);
}
const env = () => process.env as Record<string, unknown>;
const cursor = async () => (await database.query('SELECT * FROM crm_sale_context_cursor WHERE org_id=$1', [ids.org])).rows[0];

before(async () => {
  const directory = path.join(process.cwd(), '.data', `sale-context-${randomUUID()}`); await mkdir(directory, { recursive: true });
  Object.assign(process.env, { DEMO_MODE: 'true', AI_PROVIDER: 'disabled', APP_ORIGIN: 'http://localhost', D1_LOCAL_DIR: directory, CRM_BRIDGE_ENABLED: 'true', CRM_BRIDGE_ORG_ID: ids.org, CRM_BRIDGE_SECRET: secret, CRM_SALE_CONTEXT_ENABLED: 'true', CRM_SALE_CONTEXT_ORIGIN: sale });
  globalThis.fetch = fakeSale as typeof fetch;
  for (const org of [ids.org, ids.other]) await database.query("INSERT INTO organizations(id,slug,name) VALUES($1,$2,'Synthetic')", [org, 'org-' + org.slice(0, 8)]);
  await database.query("INSERT INTO leads(id,org_id,name,market) VALUES($1,$2,'Synthetic buyer','export')", [ids.lead, ids.org]);
  await database.query("INSERT INTO conversations(id,org_id,lead_id,status) VALUES($1,$2,$3,'human_active')", [ids.conversation, ids.org, ids.lead]);
});
after(async () => { globalThis.fetch = previousFetch; for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; await closeDatabase(); });

test('canonical hash matches the Sale producer test vector', () => {
  assert.equal(saleContextHash({ workspace: 'live', leadId: 'lead-vector', dealId: 'deal-vector', title: 'ดีลทดสอบ', stage: 2, waiting: 'customer', quotation: { number: 'QT-1', revision: 2, status: 'approved' }, payments: { reported: 1, confirmed: 0 }, production: null }), 'ceeb938edb996d54c811f81ce15deeb841f9fdefc5d08bb699e926a79194551a');
});

test('default off makes no request', async () => {
  const db = await getDatabase(), count = requests.length;
  assert.deepEqual(await pullSaleContext(db, { ...env(), CRM_SALE_CONTEXT_ENABLED: 'false' }), { status: 'disabled' });
  for (const origin of ['http://sale.test', 'https://sale.test/', 'https://sale.test/path', 'not a url']) assert.deepEqual(await pullSaleContext(db, { ...env(), CRM_SALE_CONTEXT_ORIGIN: origin }), { status: 'disabled' }, origin);
  assert.equal(requests.length, count);
});

test('signed pull applies newest version per deal, ACKs after commit, and is idempotent', async () => {
  const db = await getDatabase();
  outbox.push(event(1, 'deal-1', 5), event(2, 'deal-2', 6, { waiting: 'rrs' }), event(3, 'deal-1', 7, { quotation: { number: 'QT-1', revision: 2, status: 'approved', sentAt: '', acceptedAt: '' } }));
  assert.deepEqual(await pullSaleContext(db, env()), { status: 'ok', sequence: 3, applied: 3 });
  assert.deepEqual(acks, [3]);
  let view = await saleContextForLead(db, ids.org, ids.lead);
  assert.equal(view.deals.length, 2); const deal1 = view.deals.find(d => d.dealId === 'deal-1')!;
  assert.equal(deal1.quotation.revision, 2); assert.equal(deal1.version, 7); assert.equal(view.deals.find(d => d.dealId === 'deal-2')!.waitingLabel, 'รอฝ่ายขาย');
  // Replaying committed events changes nothing.
  await applySaleEvents(db, ids.org, outbox.slice(0, 3)); assert.equal((await cursor()).last_sequence, 3);
  // An older Sale revision arriving later never overwrites the newer one.
  outbox.push(event(4, 'deal-1', 6, { title: 'stale' }));
  assert.equal((await pullSaleContext(db, env())).status, 'ok');
  view = await saleContextForLead(db, ids.org, ids.lead); assert.equal(view.deals.find(d => d.dealId === 'deal-1')!.title, 'ดีล deal-1');
  assert.deepEqual(acks, [3, 4]);
});

test('tampered, gapped, conflicting and foreign batches are rejected without moving the cursor', async () => {
  const db = await getDatabase(), before = (await cursor()).last_sequence;
  const tampered = event(5, 'deal-1', 9); (tampered.payload as Record<string, unknown>).title = 'changed after hashing'; outbox.push(tampered);
  assert.deepEqual(await pullSaleContext(db, env()), { status: 'error', error: 'SALE_EVENT_HASH_MISMATCH' });
  assert.equal((await cursor()).last_sequence, before); assert.equal((await cursor()).last_error, 'SALE_EVENT_HASH_MISMATCH');
  outbox.pop();
  await assert.rejects(() => applySaleEvents(db, ids.org, [event(7, 'deal-1', 10)]), /SALE_EVENT_GAP/);
  await assert.rejects(() => applySaleEvents(db, ids.org, [{ ...event(4, 'deal-1', 6, { title: 'different' }) }]), /SALE_EVENT_CONFLICT/);
  await assert.rejects(() => applySaleEvents(db, ids.org, [{ ...event(5, 'deal-1', 9), org_id: ids.other }]), /SALE_EVENT_INVALID/);
  failure = 'org'; assert.deepEqual(await pullSaleContext(db, env()), { status: 'error', error: 'SALE_RESPONSE_INVALID' });
  failure = 'http'; assert.deepEqual(await pullSaleContext(db, env()), { status: 'error', error: 'SALE_PULL_HTTP_500' });
  failure = 'network'; assert.deepEqual(await pullSaleContext(db, env()), { status: 'error', error: 'SALE_NETWORK_ERROR' });
  failure = null; assert.equal((await cursor()).last_sequence, before);
  outbox.push(event(5, 'deal-2', 11, { removed: true }));
  assert.equal((await pullSaleContext(db, env())).status, 'ok');
  assert.deepEqual((await saleContextForLead(db, ids.org, ids.lead)).deals.map(d => d.dealId), ['deal-1'], 'removed deal is hidden');
});

test('staff detail includes Sale context; visitor detail and other organizations do not', async () => {
  const db = await getDatabase();
  await database.query("UPDATE crm_sale_context_cursor SET updated_at=$2 WHERE org_id=$1", [ids.org, new Date(0).toISOString()]);
  const count = requests.length, staff = await conversationDetail(ids.org, ids.conversation, true) as Record<string, any>;
  assert.ok(requests.length > count, 'stale context refreshes on view');
  assert.equal(staff.saleContext.deals[0].dealId, 'deal-1'); assert.ok(staff.saleContext.syncedAt);
  const again = requests.length; await conversationDetail(ids.org, ids.conversation, true); assert.equal(requests.length, again, 'fresh context is not pulled again');
  assert.deepEqual(await refreshSaleContextIfStale(db, env()), { status: 'fresh' });
  const visitor = await conversationDetail(ids.org, ids.conversation, false) as Record<string, unknown>;
  assert.equal('saleContext' in visitor, false, 'visitors never receive Sale context');
  assert.deepEqual((await saleContextForLead(db, ids.other, ids.lead)).deals, []);
  assert.equal(JSON.stringify(staff.saleContext).includes('price'), false);
});
