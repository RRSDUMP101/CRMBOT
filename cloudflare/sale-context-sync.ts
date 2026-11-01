import { BridgeError, verifyBridgeRequest } from '../src/lib/bridge-protocol';
import { pullSaleContext, saleContextConfig } from '../src/lib/sale-context';
import type { D1Binding } from '../src/lib/db';

export const SALE_CONTEXT_SYNC_PATH = '/api/bridge/sale-context/sync';
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => Response.json(body, {
  status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', ...extra },
});

/**
 * A signed wake only asks CRM to pull Sale's committed outbox. It carries no
 * business data and can never dispatch a customer message. One page bounds a
 * wake's work; the existing scheduled consumer catches up a larger backlog.
 * Handle at Worker ingress so this POST cannot wake Sale again through the
 * general application-mutation notifier.
 */
export async function handleSaleContextSync(request: Request, env: Record<string, unknown>, fetcher: typeof fetch = fetch) {
  if (request.method !== 'POST') return json({ error: 'SALE_CONTEXT_METHOD_NOT_ALLOWED' }, 405, { Allow: 'POST' });
  const config = saleContextConfig(env);
  if (!config || !env.DB) return json({ error: 'SALE_CONTEXT_DISABLED' }, 503);
  try {
    const { body } = await verifyBridgeRequest(request, config, 4096);
    const url = new URL(request.url);
    if (url.pathname !== SALE_CONTEXT_SYNC_PATH || url.search) throw new BridgeError(400, 'Invalid wake target');
    let input: unknown;
    try { input = JSON.parse(body); } catch { throw new BridgeError(400, 'Invalid wake JSON'); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BridgeError(400, 'Invalid wake');
    const wake = input as Record<string, unknown>;
    if (Object.keys(wake).some(key => !['version', 'reason', 'headSequence'].includes(key)) || wake.version !== 1 || wake.reason !== 'wake' || !Number.isSafeInteger(wake.headSequence) || Number(wake.headSequence) < 1) throw new BridgeError(400, 'Invalid wake fields');
    const db = (env.DB as D1Binding).withSession?.('first-primary') || env.DB as D1Binding;
    const row = (await db.prepare('SELECT last_sequence,acknowledged_sequence FROM crm_sale_context_cursor WHERE org_id=?').bind(config.orgId).all()).results?.[0];
    const head = Number(wake.headSequence);
    // A prior ACK failure must be retried even when its projection is current.
    if (row && Number(row.last_sequence) >= head && Number(row.acknowledged_sequence) >= head) return json({ status: 'up_to_date', sequence: Number(row.last_sequence) });
    const result = await pullSaleContext(db, env, fetcher, 1);
    if (result.status !== 'ok') return json({ error: 'SALE_CONTEXT_PULL_FAILED' }, 503);
    return json({ ...result, status: result.sequence >= head ? 'ok' : 'catching_up' }, result.sequence >= head ? 200 : 202);
  } catch (error) {
    if (error instanceof BridgeError) return json({ error: error.status === 400 ? 'SALE_CONTEXT_INVALID_WAKE' : 'SALE_CONTEXT_AUTH_FAILED' }, error.status);
    // Never expose provider bodies, credentials or business payloads.
    return json({ error: 'SALE_CONTEXT_UNAVAILABLE' }, 503);
  }
}
