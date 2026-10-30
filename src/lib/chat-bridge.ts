import { database, transaction, type Executor, type Row } from './db';
import { BridgeError } from './bridge-protocol';

export type BridgeEntity = 'lead'|'conversation'|'message'|'socialIdentity'|'messageProvenance'|'attachment';
/** Raw snake_case columns. JSON database columns stay JSON strings, including tags/facts/sources. */
export type BridgeEvent = {
  version: 1; eventId: string; orgId: string; sequence: number;
  entity: BridgeEntity; operation: 'upsert'; record: Row; occurredAt: string;
};
export type BridgePage = {
  version: 1; orgId: string; events: BridgeEvent[]; after: number; nextCursor: number;
  headSequence: number; hasMore: boolean; bootstrapComplete: boolean;
};

export function bridgeConfig() {
  if (process.env.CRM_BRIDGE_ENABLED !== 'true') throw new BridgeError(503, 'Chat bridge is disabled');
  const orgId = process.env.CRM_BRIDGE_ORG_ID || '';
  const secret = process.env.CRM_BRIDGE_SECRET || '';
  if (!orgId || secret.length < 32) throw new BridgeError(503, 'Chat bridge is not configured');
  return { orgId, secret };
}

export function bridgeInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER, minimum = 0) {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new BridgeError(400, `Invalid ${label}`);
  return parsed;
}

// D1 rejects compound SELECTs with more than five terms, so each entity is queried
// separately in kind order. Local SQLite has a higher limit; keep these apart.
const missingParts = [
 `SELECT 'lead' AS entity,id,1 AS kind_order FROM leads r WHERE org_id=$1 AND NOT EXISTS(SELECT 1 FROM crm_bridge_entities e WHERE e.org_id=r.org_id AND e.entity='lead' AND e.record_id=r.id)`,
 `SELECT 'conversation' AS entity,id,2 AS kind_order FROM conversations r WHERE org_id=$1 AND NOT EXISTS(SELECT 1 FROM crm_bridge_entities e WHERE e.org_id=r.org_id AND e.entity='conversation' AND e.record_id=r.id)`,
 `SELECT 'message' AS entity,id,3 AS kind_order FROM messages r WHERE org_id=$1 AND NOT EXISTS(SELECT 1 FROM crm_bridge_entities e WHERE e.org_id=r.org_id AND e.entity='message' AND e.record_id=r.id)`,
 `SELECT 'socialIdentity' AS entity,id,4 AS kind_order FROM social_identities r WHERE org_id=$1 AND NOT EXISTS(SELECT 1 FROM crm_bridge_entities e WHERE e.org_id=r.org_id AND e.entity='socialIdentity' AND e.record_id=r.id)`,
 `SELECT 'messageProvenance' AS entity,message_id AS id,5 AS kind_order FROM social_message_provenance r WHERE org_id=$1 AND NOT EXISTS(SELECT 1 FROM crm_bridge_entities e WHERE e.org_id=r.org_id AND e.entity='messageProvenance' AND e.record_id=r.message_id)`,
 `SELECT 'attachment' AS entity,id,6 AS kind_order FROM social_message_attachments r WHERE org_id=$1 AND NOT EXISTS(SELECT 1 FROM crm_bridge_entities e WHERE e.org_id=r.org_id AND e.entity='attachment' AND e.record_id=r.id)`,
];

async function metadata(orgId: string, executor: Executor = database) {
  const row = (await executor.query(`SELECT o.id,COALESCE(s.sequence,0) AS head,
    (${missingParts.map(part => `EXISTS(${part})`).join(' OR ')}) AS missing
    FROM organizations o LEFT JOIN crm_bridge_state s ON s.org_id=o.id WHERE o.id=$1`, [orgId])).rows[0];
  if (!row) throw new BridgeError(404, 'Bridge organization is unavailable');
  return { headSequence: Number(row.head), bootstrapComplete: !row.missing };
}

/** Append-only log makes a bounded head a stable page even while newer writes commit. */
export async function readBridgeEvents(orgId: string, after = 0, limit = 100): Promise<BridgePage> {
  after = bridgeInteger(after, 'cursor'); limit = bridgeInteger(limit, 'limit', 100, 1);
  const meta = await metadata(orgId);
  if (after > meta.headSequence) throw new BridgeError(409, 'Cursor is ahead of this log; verify deployment and database before recovery');
  const rows = (await database.query(`SELECT sequence,event_id,entity,record_json,occurred_at
    FROM crm_bridge_events WHERE org_id=$1 AND sequence>$2 AND sequence<=$3 ORDER BY sequence LIMIT $4`,
  [orgId, after, meta.headSequence, limit])).rows;
  const events = rows.map((row, index): BridgeEvent => {
    if (Number(row.sequence) !== after + index + 1) throw new BridgeError(409, 'Bridge log has a gap; snapshot recovery is required');
    const record = JSON.parse(row.record_json);
    if (record.org_id !== orgId) throw new BridgeError(500, 'Bridge event scope mismatch');
    return { version: 1, eventId: row.event_id, orgId, sequence: Number(row.sequence), entity: row.entity,
      operation: 'upsert', record, occurredAt: row.occurred_at };
  });
  if (!events.length && after < meta.headSequence) throw new BridgeError(409, 'Bridge history is unavailable; snapshot recovery is required');
  const nextCursor = events.at(-1)?.sequence ?? after;
  return { version: 1, orgId, events, after, nextCursor, ...meta, hasMore: nextCursor < meta.headSequence };
}

/** Operator-only explicit bootstrap. A bounded call can be repeated until complete. */
export async function bootstrapBridge(orgId: string, limit = 100) {
  limit = bridgeInteger(limit, 'limit', 100, 1);
  const captured = await transaction(orgId, async executor => {
    const rows: Row[] = [];
    for (const part of missingParts) {
      if (rows.length >= limit) break;
      rows.push(...(await executor.query(`${part} ORDER BY id LIMIT $2`, [orgId, limit - rows.length])).rows);
    }
    for (const row of rows) {
      // Snapshot trigger reads the current raw source row inside the same guarded
      // batch. A prior concurrent mutation/duplicate bootstrap creates no gap.
      await executor.query('INSERT OR IGNORE INTO crm_bridge_bootstrap_items(org_id,entity,record_id) VALUES($1,$2,$3)', [orgId, row.entity, row.id]);
    }
    return rows.length;
  });
  return { captured, ...await metadata(orgId) };
}

/** ACK is diagnostic only. It never deletes events, resets a cursor or claims UI delivery. */
export async function acknowledgeBridge(orgId: string, consumerId: string, sequence: number) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(consumerId)) throw new BridgeError(400, 'Invalid consumer ID');
  sequence = bridgeInteger(sequence, 'sequence');
  await transaction(orgId, async executor => {
    const meta = await metadata(orgId, executor);
    if (sequence > meta.headSequence) throw new BridgeError(409, 'Cannot acknowledge beyond the bridge head');
    await executor.query(`INSERT INTO crm_bridge_consumers(org_id,consumer_id,acknowledged_sequence) VALUES($1,$2,$3)
      ON CONFLICT(org_id,consumer_id) DO UPDATE SET acknowledged_sequence=MAX(acknowledged_sequence,excluded.acknowledged_sequence),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')`, [orgId, consumerId, sequence]);
  });
  return (await database.query('SELECT consumer_id,acknowledged_sequence,updated_at FROM crm_bridge_consumers WHERE org_id=$1 AND consumer_id=$2', [orgId, consumerId])).rows[0];
}
