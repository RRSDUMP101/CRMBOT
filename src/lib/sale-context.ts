import { createHash, randomUUID } from 'node:crypto';
import { signBridgeRequest } from './bridge-protocol';
import type { D1Binding, D1Statement, Row } from './db';

/**
 * Read-only consumer of Sale Office deal context (GET /api/rrs/crm/outbox).
 * Sale owns these facts. CRM stores the latest state per deal, never edits it and
 * never turns it into customer messages. Runs from the minute cron and when staff
 * open a conversation, so it does not depend on any open Sale page.
 */
type Env = Record<string, unknown>;
const ID = /^[A-Za-z0-9_:.@-]{1,200}$/;
const CONSUMER = 'crm-terminal';
export function saleContextConfig(env: Env) {
  if (env.CRM_SALE_CONTEXT_ENABLED !== 'true' || env.CRM_BRIDGE_ENABLED !== 'true') return null;
  const secret = env.CRM_BRIDGE_SECRET, orgId = env.CRM_BRIDGE_ORG_ID, origin = env.CRM_SALE_CONTEXT_ORIGIN;
  if (typeof secret !== 'string' || secret.length < 32 || typeof orgId !== 'string' || !ID.test(orgId) || typeof origin !== 'string') return null;
  let url: URL; try { url = new URL(origin); } catch { return null; }
  if (url.protocol !== 'https:' || url.origin !== origin) return null;
  return { secret, orgId, origin };
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
/** Same canonical SHA-256 as the Sale producer (crm-bridge-store bridgeHash). */
export const saleContextHash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export type SaleContextEvent = { event_id: string; sequence: number; aggregate_id: string; aggregate_version: number; occurred_at: string; payload_hash: string; payload: Record<string, unknown> & { leadId: string; workspace: 'live' | 'domestic'; dealId: string } };
export class SaleContextError extends Error { constructor(public code: string) { super(code); } }
export function validateSaleEvent(value: unknown, orgId: string): SaleContextEvent {
  if (!object(value) || value.schema_version !== 1 || value.org_id !== orgId || value.source_app !== 'sale' || value.event_type !== 'deal.context' || value.aggregate_type !== 'deal' || value.sequence_scope !== 'organization') throw new SaleContextError('SALE_EVENT_INVALID');
  if (!ID.test(String(value.event_id)) || !ID.test(String(value.aggregate_id)) || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1 || !Number.isSafeInteger(value.aggregate_version) || Number(value.aggregate_version) < 1) throw new SaleContextError('SALE_EVENT_INVALID');
  if (typeof value.occurred_at !== 'string' || !Number.isFinite(Date.parse(value.occurred_at)) || typeof value.payload_hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.payload_hash)) throw new SaleContextError('SALE_EVENT_INVALID');
  const payload = value.payload;
  if (!object(payload) || payload.dealId !== value.aggregate_id || !ID.test(String(payload.leadId)) || !['live', 'domestic'].includes(String(payload.workspace))) throw new SaleContextError('SALE_EVENT_INVALID');
  if (saleContextHash(payload) !== value.payload_hash) throw new SaleContextError('SALE_EVENT_HASH_MISMATCH');
  return value as unknown as SaleContextEvent;
}
const all = async (statement: D1Statement) => (await statement.all()).results ?? [];
async function cursor(db: D1Binding, orgId: string) {
  await db.batch([db.prepare('INSERT OR IGNORE INTO crm_sale_context_cursor(org_id,updated_at) VALUES(?,?)').bind(orgId, new Date().toISOString())]);
  return (await all(db.prepare('SELECT * FROM crm_sale_context_cursor WHERE org_id=?').bind(orgId)))[0] as Row;
}
/** Commit projection, receipts and cursor in one guarded batch. Replays are no-ops. */
export async function applySaleEvents(db: D1Binding, orgId: string, input: unknown[]) {
  if (input.length > 100) throw new SaleContextError('SALE_BATCH_TOO_LARGE');
  const events = input.map(value => validateSaleEvent(value, orgId));
  for (let i = 1; i < events.length; i++) if (events[i].sequence !== events[i - 1].sequence + 1) throw new SaleContextError('SALE_EVENT_GAP');
  const before = await cursor(db, orgId), last = Number(before.last_sequence);
  for (const event of events) {
    const saved = await all(db.prepare('SELECT event_id,sequence,payload_hash FROM crm_sale_context_events WHERE org_id=? AND (event_id=? OR sequence=?)').bind(orgId, event.event_id, event.sequence));
    if (saved.some(row => row.event_id !== event.event_id || Number(row.sequence) !== event.sequence || row.payload_hash !== event.payload_hash)) throw new SaleContextError('SALE_EVENT_CONFLICT');
    if (event.sequence <= last && saved.length !== 1) throw new SaleContextError('SALE_EVENT_RECEIPT_MISSING');
  }
  const pending = events.filter(event => event.sequence > last);
  if (!pending.length) return before;
  if (pending[0].sequence !== last + 1) throw new SaleContextError('SALE_EVENT_GAP');
  const next = pending[pending.length - 1].sequence, token = randomUUID(), at = new Date().toISOString();
  const guard = 'EXISTS(SELECT 1 FROM crm_sale_context_cursor WHERE org_id=? AND token=? AND last_sequence=?)';
  const batch = [db.prepare("UPDATE crm_sale_context_cursor SET last_sequence=?,token=?,last_error='',last_success_at=?,updated_at=? WHERE org_id=? AND last_sequence=?").bind(next, token, at, at, orgId, last)];
  for (const event of pending) {
    batch.push(db.prepare(`INSERT INTO crm_sale_context_events(org_id,event_id,sequence,payload_hash,received_at) SELECT ?,?,?,?,? WHERE ${guard}`).bind(orgId, event.event_id, event.sequence, event.payload_hash, at, orgId, token, next));
    // Newer Sale revision wins; an older or replayed version never overwrites it.
    batch.push(db.prepare(`INSERT INTO crm_sale_context(org_id,deal_id,lead_id,workspace,aggregate_version,sale_sequence,payload,updated_at) SELECT ?,?,?,?,?,?,?,? WHERE ${guard} ON CONFLICT(org_id,deal_id) DO UPDATE SET lead_id=excluded.lead_id,workspace=excluded.workspace,aggregate_version=excluded.aggregate_version,sale_sequence=excluded.sale_sequence,payload=excluded.payload,updated_at=excluded.updated_at WHERE excluded.aggregate_version>crm_sale_context.aggregate_version OR (excluded.aggregate_version=crm_sale_context.aggregate_version AND excluded.sale_sequence>crm_sale_context.sale_sequence)`).bind(orgId, event.aggregate_id, event.payload.leadId, event.payload.workspace, event.aggregate_version, event.sequence, JSON.stringify(event.payload), event.occurred_at, orgId, token, next));
  }
  const results = await db.batch(batch);
  if (!results[0].meta?.changes) throw new SaleContextError('SALE_CONTEXT_CONCURRENT_UPDATE');
  return cursor(db, orgId);
}
async function boundedJson(response: Response, max = 2 * 1024 * 1024) {
  const text = await response.text();
  if (text.length > max) throw new SaleContextError('SALE_RESPONSE_TOO_LARGE');
  try { return JSON.parse(text); } catch { throw new SaleContextError('SALE_RESPONSE_INVALID'); }
}
/** Pull and acknowledge up to `pages` pages. Errors are stored as codes, never as response bodies. */
export async function pullSaleContext(db: D1Binding, env: Env, fetcher: typeof fetch = fetch, pages = 10) {
  const config = saleContextConfig(env); if (!config) return { status: 'disabled' as const };
  let state = await cursor(db, config.orgId), applied = 0;
  try {
    for (let page = 0; page < pages; page++) {
      const after = Number(state.last_sequence), url = `${config.origin}/api/rrs/crm/outbox?after=${after}&limit=100`;
      const response = await fetcher(url, { headers: await signBridgeRequest(url, { ...config, method: 'GET' }), redirect: 'manual', signal: AbortSignal.timeout(8000) });
      if (!response.ok) { await response.body?.cancel(); throw new SaleContextError('SALE_PULL_HTTP_' + response.status); }
      const body = await boundedJson(response);
      if (!object(body) || body.version !== 1 || body.orgId !== config.orgId || body.after !== after || !Array.isArray(body.events) || !Number.isSafeInteger(body.headSequence) || typeof body.hasMore !== 'boolean') throw new SaleContextError('SALE_RESPONSE_INVALID');
      state = await applySaleEvents(db, config.orgId, body.events); applied += body.events.length;
      if (Number(state.last_sequence) > Number(state.acknowledged_sequence)) {
        const ackUrl = config.origin + '/api/rrs/crm/outbox/ack', ackBody = JSON.stringify({ consumerId: CONSUMER, sequence: Number(state.last_sequence) });
        const ack = await fetcher(ackUrl, { method: 'POST', headers: await signBridgeRequest(ackUrl, { ...config, method: 'POST', body: ackBody }), body: ackBody, redirect: 'manual', signal: AbortSignal.timeout(8000) });
        if (!ack.ok) { await ack.body?.cancel(); throw new SaleContextError('SALE_ACK_HTTP_' + ack.status); }
        await ack.body?.cancel();
        await db.batch([db.prepare('UPDATE crm_sale_context_cursor SET acknowledged_sequence=MAX(acknowledged_sequence,?) WHERE org_id=?').bind(Number(state.last_sequence), config.orgId)]);
      }
      if (!body.hasMore) break;
    }
    // Record a successful check even when nothing changed, so on-view refresh stays throttled.
    const at = new Date().toISOString();
    await db.batch([db.prepare("UPDATE crm_sale_context_cursor SET last_error='',last_success_at=?,updated_at=? WHERE org_id=?").bind(at, at, config.orgId)]);
    return { status: 'ok' as const, sequence: Number(state.last_sequence), applied };
  } catch (error) {
    const code = error instanceof SaleContextError ? error.code : 'SALE_NETWORK_ERROR';
    await db.batch([db.prepare('UPDATE crm_sale_context_cursor SET last_error=?,updated_at=? WHERE org_id=?').bind(code, new Date().toISOString(), config.orgId)]);
    return { status: 'error' as const, error: code };
  }
}
const waitingNames: Record<string, string> = { rrs: 'รอฝ่ายขาย', customer: 'รอลูกค้า', none: 'ไม่มีงานค้าง' };
/** Staff-only view for one lead. Visitors never receive this. */
export async function saleContextForLead(db: D1Binding, orgId: string, leadId: string) {
  const rows = await all(db.prepare('SELECT deal_id,workspace,aggregate_version,payload,updated_at FROM crm_sale_context WHERE org_id=? AND lead_id=? ORDER BY updated_at DESC LIMIT 20').bind(orgId, leadId));
  const sync = (await all(db.prepare('SELECT last_success_at,last_error FROM crm_sale_context_cursor WHERE org_id=?').bind(orgId)))[0];
  return {
    syncedAt: sync?.last_success_at ?? null, error: sync?.last_error || null,
    deals: rows.map(row => { const p = JSON.parse(String(row.payload)); return { ...p, waitingLabel: waitingNames[String(p.waiting)] ?? '', updatedAt: row.updated_at, version: Number(row.aggregate_version) }; }).filter(deal => !deal.removed),
  };
}
/** On-view refresh without a pull per request: at most once per `maxAgeMs`. */
export async function refreshSaleContextIfStale(db: D1Binding, env: Env, maxAgeMs = 15000) {
  const config = saleContextConfig(env); if (!config) return { status: 'disabled' as const };
  const row = (await all(db.prepare('SELECT updated_at FROM crm_sale_context_cursor WHERE org_id=?').bind(config.orgId)))[0];
  if (row && Date.now() - Date.parse(String(row.updated_at)) < maxAgeMs) return { status: 'fresh' as const };
  return pullSaleContext(db, env, fetch, 1);
}
