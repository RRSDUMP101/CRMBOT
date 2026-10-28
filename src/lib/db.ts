import { randomUUID } from 'node:crypto';
import { ApiError } from './errors';

export type Row = Record<string, any>;
export type QueryResult<T extends Row = Row> = { rows: T[]; rowCount: number };
export type Executor = { query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<QueryResult<T>> };
export type D1Result = { success: boolean; results?: Row[]; meta?: { changes?: number } };
export type D1Statement = { bind(...values: unknown[]): D1Statement; all(): Promise<D1Result> };
export type D1Binding = { prepare(sql: string): D1Statement; batch(statements: D1Statement[]): Promise<D1Result[]>; withSession?(constraint: string): D1Binding };
type Local = Awaited<ReturnType<typeof import('./local-db').openLocalDatabase>>;
type Store = { local?: Local; ready?: Promise<void> };
const globalDb = globalThis as typeof globalThis & { rrsD1?: Store };
const store: Store = globalDb.rrsD1 ??= {};
export const demoMode = () => process.env.DEMO_MODE === 'true';

export function statement(binding: D1Binding, sql: string, params: unknown[] = []) {
  const ordered: unknown[] = [];
  const text = sql.replace(/\$(\d+)/g, (_, index) => {
    const value = params[Number(index) - 1];
    if (value === undefined) throw new Error('Missing SQL parameter');
    ordered.push(typeof value === 'boolean' ? Number(value) : value instanceof Date ? value.toISOString().replace(/(\.\d{3})Z$/, (_, fraction) => fraction+'000Z') : value);
    return '?';
  });
  return binding.prepare(text).bind(...ordered);
}

const jsonColumns = new Set(['settings', 'widget_config', 'tags', 'facts', 'summary', 'sources', 'metadata']);
function decode(row: Row) {
  const result = { ...row };
  for (const key of Object.keys(result)) {
    if (jsonColumns.has(key) && typeof result[key] === 'string') result[key] = JSON.parse(result[key]);
    if (key === 'active' && typeof result[key] === 'number') result[key] = result[key] === 1;
  }
  return result;
}
async function execute<T extends Row = Row>(binding: D1Binding, sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
  const result = await statement(binding, sql, params).all();
  if (!result.success) throw new Error('Database request failed');
  const rows = (result.results || []).map(decode) as T[];
  return { rows, rowCount: /^(SELECT|WITH)\b/i.test(sql.trim()) ? rows.length : result.meta?.changes ?? rows.length };
}
export async function getDatabase(): Promise<D1Binding> {
  if (process.env.RRS_WORKERS === 'true') {
    if (demoMode()) throw new Error('Demo database is unavailable in deployed Workers');
    if ((process.env.SESSION_SECRET || '').length < 32) throw new Error('SESSION_SECRET is required');
    const { getCloudflareContext } = await import('@opennextjs/cloudflare');
    const binding = (getCloudflareContext().env as unknown as { DB?: D1Binding }).DB;
    if (!binding) throw new Error('Cloudflare D1 binding DB is required');
    return binding.withSession?.('first-primary') || binding;
  }
  if (!demoMode()) throw new Error('Production requires Cloudflare D1; local storage is Demo-only');
  if (!store.ready) store.ready = (async () => {
    const { openLocalDatabase } = await import('./local-db');
    store.local ??= openLocalDatabase(process.env.D1_LOCAL_DIR || process.env.PGLITE_DIR || '.data/rrs-demo-d1');
    await store.local.migrate();
    const { seedDemoDatabase } = await import('./seed-demo');
    await seedDemoDatabase(store.local.binding);
  })().catch(error => { store.ready = undefined; throw error; });
  await store.ready;
  return store.local!.binding;
}
export const database: Executor = { async query<T extends Row = Row>(sql: string, params: unknown[] = []) {
  return execute<T>(await getDatabase(), sql, params);
} };

/**
 * The callback is a pure mutation planner: SELECTs read the old state, writes
 * are staged, and no external side effects may occur inside it. Reads after a
 * staged write do NOT see that write. Callers construct such values explicitly.
 * A constraint failure in the guard rolls back the entire D1 batch. Only that
 * proven conflict is retried; ambiguous network failures are never retried.
 */
export async function transaction<T>(orgId: string, plan: (connection: Executor) => Promise<T>, actor?: { id: string; role: string }): Promise<T> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const binding = await getDatabase();
    const org = (await execute(binding, 'SELECT revision FROM organizations WHERE id=$1', [orgId])).rows[0];
    if (!org) throw new ApiError(404, 'ไม่พบองค์กร');
    if (actor) {
      const member = (await execute(binding, 'SELECT role,active FROM members WHERE org_id=$1 AND id=$2', [orgId, actor.id])).rows[0];
      if (!member?.active || member.role !== actor.role) throw new ApiError(403, 'สิทธิ์ของคุณเปลี่ยนแล้ว กรุณาเข้าสู่ระบบใหม่');
    }
    const pending: D1Statement[] = [];
    const connection: Executor = { async query<R extends Row = Row>(sql: string, params: unknown[] = []) {
      if (/^(SELECT|WITH)\b/i.test(sql.trim())) return execute<R>(binding, sql, params);
      if (!/^(INSERT|UPDATE|DELETE)\b/i.test(sql.trim()) || /\bRETURNING\b/i.test(sql)) throw new Error('Mutation planner requires explicit reads and writes without RETURNING');
      pending.push(statement(binding, sql, params));
      return { rows: [] as R[], rowCount: 0 };
    } };
    const value = await plan(connection);
    if (!pending.length) {
      const current = (await execute(binding, 'SELECT revision FROM organizations WHERE id=$1', [orgId])).rows[0];
      if (current?.revision === org.revision) return value;
      continue;
    }
    const token = randomUUID();
    try {
      await binding.batch([
        statement(binding, 'INSERT INTO crm_tx_guard(token,ok) VALUES($1,CASE WHEN EXISTS(SELECT 1 FROM organizations WHERE id=$2 AND revision=$3) THEN 1 ELSE 0 END)', [token, orgId, org.revision]),
        ...pending,
        statement(binding, 'UPDATE organizations SET revision=revision+1 WHERE id=$1', [orgId]),
        statement(binding, 'DELETE FROM crm_tx_guard WHERE token=$1', [token]),
      ]);
      return value;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('rrs_cas_guard')) throw error;
    }
  }
  throw new ApiError(409, 'มีการแก้ไขพร้อมกัน กรุณาลองใหม่');
}
export async function migrateDatabase() {
  if (!demoMode()) throw new Error('Apply production D1 migrations with Cloudflare; never migrate on requests');
  const { openLocalDatabase } = await import('./local-db');
  store.local ??= openLocalDatabase(process.env.D1_LOCAL_DIR || process.env.PGLITE_DIR || '.data/rrs-demo-d1');
  await store.local.migrate();
}
export async function seedDemo() { await getDatabase(); }
export async function closeDatabase() { await store.ready?.catch(() => {}); store.local?.close(); store.local = undefined; store.ready = undefined; }
export function camel(row: Row): Row {
  const result: Row = {};
  for (const [key, value] of Object.entries(row)) result[key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value instanceof Date ? value.toISOString() : value;
  return result;
}
