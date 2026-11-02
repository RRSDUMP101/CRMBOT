import { randomUUID } from 'node:crypto';
import { ApiError, fields, requireAdmin, str, uuid, type Staff } from './auth';
import { database, transaction, type Executor, type Row } from './db';
import { readSocialConfig, socialConfigFingerprint, socialVerificationChallenge, prepareSocialWebhook, commitSocialWebhook, type SocialChannelConfig, type SocialProvider } from './social-channels';
import { readStoredSocialCredentials, registryConfig, socialTokenFingerprint } from './social-accounts';
import { socialChannelAction, socialChannelStatus } from './social-channel-admin';

type Env = Record<string, string | undefined>;
type Options = { env?: Env; connection?: Executor };
export const socialAccountRuntimeEnabled = (env: Env = process.env) => env.SOCIAL_ACCOUNT_RUNTIME_ENABLED === 'true';
const time = () => new Date().toISOString();
function requireRuntime(env: Env) {
  if (!socialAccountRuntimeEnabled(env) || env.SOCIAL_ACCOUNTS_ENABLED !== 'true') throw new ApiError(503, 'account_runtime_disabled');
}
/** Exact tuple only: an unavailable registry account never falls back to another credential. */
export async function resolveSocialConfig(orgId: string, provider: SocialProvider, accountId: string, options: Options = {}): Promise<SocialChannelConfig> {
  const env = options.env || process.env;
  if (!socialAccountRuntimeEnabled(env)) {
    const config = readSocialConfig(provider, env);
    if (config.orgId !== orgId || config.accountId !== accountId) throw new ApiError(503, 'channel_account_unavailable');
    return config;
  }
  requireRuntime(env);
  const row = (await (options.connection || database).query('SELECT * FROM social_accounts WHERE org_id=$1 AND provider=$2 AND account_id=$3', [orgId, provider, accountId])).rows[0];
  if (!row || !['webhook_pending', 'testing', 'ready'].includes(row.state) || row.auth_readiness !== 'ready' || (row.expires_at && Date.parse(row.expires_at) <= Date.now())) throw new ApiError(503, 'registered_account_unavailable');
  const { token, secret } = await readStoredSocialCredentials(row, env);
  if (socialTokenFingerprint(token) !== row.token_fingerprint) throw new ApiError(503, 'registered_credential_mismatch');
  const global = readSocialConfig(provider, env), config = registryConfig(row, token, secret, env);
  return { ...config, registryAccountId: row.id, owner: global.owner, inboundEnabled: global.inboundEnabled && !!row.runtime_inbound_enabled, liveEnabled: global.liveEnabled && !!row.runtime_live_enabled, testRecipient: row.runtime_test_recipient || '', expectedDisplayPhone: provider === 'whatsapp' ? row.display_identity : undefined };
}
export async function listRuntimeAccounts(orgId: string, provider?: SocialProvider, env: Env = process.env) {
  if (!socialAccountRuntimeEnabled(env)) return (provider ? [provider] : ['whatsapp', 'line', 'facebook', 'instagram'] as SocialProvider[]).flatMap(p => { const c = readSocialConfig(p, env); return c.orgId === orgId && c.accountId ? [{ accountId: c.accountId, provider: p, displayName: c.accountId, inboundEnabled: c.inboundEnabled, liveEnabled: c.liveEnabled }] : []; });
  requireRuntime(env);
  const rows = (await database.query("SELECT provider,account_id,display_name,runtime_inbound_enabled,runtime_live_enabled FROM social_accounts WHERE org_id=$1 AND provider IN ('whatsapp','line','facebook','instagram') AND state NOT IN ('disconnected','expired')" + (provider ? ' AND provider=$2' : '') + ' ORDER BY provider,display_name,account_id', provider ? [orgId, provider] : [orgId])).rows;
  return rows.map(r => ({ accountId: String(r.account_id), provider: r.provider as SocialProvider, displayName: String(r.display_name), inboundEnabled: !!r.runtime_inbound_enabled, liveEnabled: !!r.runtime_live_enabled }));
}
export async function disableRegisteredAccount(c: Executor, orgId: string, provider: string, accountId: string) {
  await c.query("UPDATE social_channel_controls SET send_enabled=0,emergency_stop=1,send_mode='disabled',verification_id=NULL,epoch=epoch+1,updated_at=$4 WHERE org_id=$1 AND provider=$2 AND account_id=$3", [orgId, provider, accountId, time()]);
  await c.query("UPDATE social_message_provenance SET delivery_status='cancelled' WHERE org_id=$1 AND message_id IN (SELECT message_id FROM social_outbound_commands WHERE org_id=$1 AND provider=$2 AND account_id=$3 AND status='queued')", [orgId, provider, accountId]);
  await c.query("UPDATE social_outbound_commands SET status='cancelled',error_code='account_runtime_disabled',updated_at=$4 WHERE org_id=$1 AND provider=$2 AND account_id=$3 AND status='queued'", [orgId, provider, accountId, time()]);
}
export async function socialRuntimeAction(staff: Staff, id: string, input: Record<string, unknown>, options: { env?: Env; fetch?: typeof fetch } = {}) {
  requireAdmin(staff); const env = options.env || process.env; requireRuntime(env); uuid(id);
  const action = str(input.action, 'คำสั่ง', 30, true);
  if (action === 'configure') {
    fields(input, ['action', 'revision', 'inboundEnabled', 'liveEnabled', 'testRecipient']);
    if (!Number.isSafeInteger(input.revision) || typeof input.inboundEnabled !== 'boolean' || typeof input.liveEnabled !== 'boolean') throw new ApiError(400, 'invalid_runtime_configuration');
    const recipient = str(input.testRecipient, 'ผู้รับทดสอบ', 200);
    await transaction(staff.orgId, async c => {
      const row = (await c.query('SELECT * FROM social_accounts WHERE org_id=$1 AND id=$2', [staff.orgId, id])).rows[0];
      if (!row) throw new ApiError(404, 'runtime_account_not_found');
      if (row.revision !== input.revision) throw new ApiError(409, 'account_changed');
      if (recipient && !(row.provider === 'whatsapp' ? /^[1-9]\d{7,14}$/ : row.provider === 'line' ? /^U[a-f0-9]{32}$/ : /^\d{5,40}$/).test(recipient)) throw new ApiError(400, 'test_recipient_not_configured');
      if (input.liveEnabled && (!input.inboundEnabled || !recipient)) throw new ApiError(400, 'test_recipient_not_configured');
      await c.query("UPDATE social_accounts SET runtime_inbound_enabled=$3,runtime_live_enabled=$4,runtime_test_recipient=$5,inbound_readiness=CASE WHEN inbound_readiness='unsupported' THEN 'pending' ELSE inbound_readiness END,outbound_readiness='pending',state=CASE WHEN state='ready' THEN 'testing' ELSE state END,revision=revision+1,updated_at=$6 WHERE org_id=$1 AND id=$2", [staff.orgId, id, Number(input.inboundEnabled), Number(input.liveEnabled), recipient, time()]);
      await disableRegisteredAccount(c, staff.orgId, row.provider, row.account_id);
      await c.query("INSERT INTO audit_events(id,org_id,actor_id,action,entity_id,metadata) VALUES($1,$2,$3,'social_account.runtime_configured',$4,$5)", [randomUUID(), staff.orgId, staff.id, id, JSON.stringify({ inboundEnabled: input.inboundEnabled, liveEnabled: input.liveEnabled, recipientConfigured: !!recipient })]);
    }, staff);
    return { ok: true };
  }
  fields(input, ['action', 'confirm']);
  if (!['verify', 'disable', 'enable-test', 'enable'].includes(action)) throw new ApiError(400, 'invalid_channel_action');
  const row = (await database.query('SELECT * FROM social_accounts WHERE org_id=$1 AND id=$2', [staff.orgId, id])).rows[0];
  if (!row) throw new ApiError(404, 'runtime_account_not_found');
  if (action === 'disable') { await transaction(staff.orgId, c => disableRegisteredAccount(c, staff.orgId, row.provider, row.account_id), staff); return { ok: true }; }
  const load = (connection?:Executor) => resolveSocialConfig(staff.orgId, row.provider, row.account_id, { env,connection });
  return socialChannelAction(staff, row.provider, input, { config: await load(), readConfig: load, fetch: options.fetch, registeredPhone: row.display_identity });
}
export async function socialRuntimeStatus(staff: Staff, id: string, env: Env = process.env) {
  requireAdmin(staff); requireRuntime(env);
  const row = (await database.query('SELECT provider,account_id,display_identity FROM social_accounts WHERE org_id=$1 AND id=$2', [staff.orgId, uuid(id)])).rows[0];
  if (!row) throw new ApiError(404, 'runtime_account_not_found');
  return socialChannelStatus(staff, row.provider, { config: await resolveSocialConfig(staff.orgId, row.provider, row.account_id, { env }), registeredPhone: row.display_identity });
}

function object(value: unknown): Record<string, any> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'Invalid webhook object'); return value as Record<string, any>; }
function array(value: unknown): any[] { if (!Array.isArray(value) || value.length > 100) throw new ApiError(400, 'Invalid event list'); return value; }
/** Partition only by signed explicit destination IDs. Every envelope is authenticated and normalized before the first write. */
export async function ingestRegisteredWebhook(provider: SocialProvider, raw: Uint8Array, headers: Headers, options: { env?: Env; defer?: (task: Promise<unknown>) => void } = {}) {
  const env = options.env || process.env; requireRuntime(env);
  const orgId = env.SOCIAL_CHANNELS_ORG_ID || ''; if (!orgId) throw new ApiError(503, 'channel_organization_missing');
  if (raw.byteLength > 1_000_000) throw new ApiError(413, 'Payload too large');
  let payload: Record<string, any>; try { payload = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))); } catch { throw new ApiError(400, 'Invalid webhook JSON'); }
  const parts: { accountId: string; payload: Record<string, any> }[] = [];
  if (provider === 'line') parts.push({ accountId: String(payload.destination || ''), payload });
  else {
    if (payload.object !== (provider === 'whatsapp' ? 'whatsapp_business_account' : provider==='instagram'?'instagram':'page')) throw new ApiError(400, 'Invalid webhook provider');
    for (const entry of array(payload.entry)) {
      object(entry);
      if (provider === 'facebook'||provider==='instagram') parts.push({ accountId: String(entry.id || ''), payload: { ...payload, entry: [entry] } });
      else for (const change of array(entry.changes)) { const value = object(object(change).value); parts.push({ accountId: String(value.metadata?.phone_number_id || ''), payload: { ...payload, entry: [{ ...entry, changes: [change] }] } }); }
    }
  }
  if (!parts.length || parts.length > 100) throw new ApiError(400, 'Invalid webhook envelopes');
  const prepared = [];
  for (const part of parts) {
    const config = await resolveSocialConfig(orgId, provider, part.accountId, { env });
    prepared.push(prepareSocialWebhook(provider, raw, headers, config, part.payload));
  }
  if (prepared.reduce((n, p) => n + p.events.length, 0) > 100) throw new ApiError(400, 'Event limit exceeded');
  let accepted = 0, duplicates = 0;
  for (const item of prepared) { const result = await commitSocialWebhook(item, { defer: options.defer, resolveCurrent: c => resolveSocialConfig(orgId, provider, item.config.accountId, { env, connection: c }) }); accepted += result.accepted; duplicates += result.duplicates; }
  return { accepted, duplicates, orgId };
}
export function registeredVerificationChallenge(request: Request, provider: SocialProvider, env: Env = process.env) {
  requireRuntime(env);
  const base = readSocialConfig(provider, env);
  // Meta verifies an app callback before account selection; receiving data still requires each registered destination.
  return socialVerificationChallenge(request, { ...base, accountId: 'app-callback', wabaId: provider === 'whatsapp' ? 'app-callback' : undefined, secret: provider === 'line' ? '' : env.META_APP_SECRET || '', verifyToken: provider === 'whatsapp' ? env.WHATSAPP_VERIFY_TOKEN || env.META_VERIFY_TOKEN : provider==='instagram'?env.INSTAGRAM_VERIFY_TOKEN||env.META_VERIFY_TOKEN:env.META_VERIFY_TOKEN });
}
