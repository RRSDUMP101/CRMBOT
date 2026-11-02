import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { ApiError, type Staff } from '../src/lib/auth';
import { closeDatabase, database, transaction } from '../src/lib/db';
import { sealSocialSecret, socialAccountAction, socialTokenFingerprint } from '../src/lib/social-accounts';
import { dispatchSocialReply, enqueueSocialReply, socialConfigFingerprint, type SocialProvider } from '../src/lib/social-channels';
import { ingestRegisteredWebhook, resolveSocialConfig, socialRuntimeAction, listRuntimeAccounts, registeredVerificationChallenge } from '../src/lib/social-account-runtime';
import { verifyRegisteredChannel } from '../src/lib/social-channel-admin';

const previous = { ...process.env }, originalFetch = globalThis.fetch;
const key = randomBytes(32).toString('base64'), secret = 'synthetic-meta-signing-secret', sender = 'U' + 'd'.repeat(32);
before(async () => {
  Object.assign(process.env, { DEMO_MODE: 'true', RRS_WORKERS: 'false', D1_LOCAL_DIR: `.data/social-runtime-${randomUUID()}`, AI_PROVIDER: 'disabled', SOCIAL_ACCOUNTS_ENABLED: 'true', SOCIAL_ACCOUNT_RUNTIME_ENABLED: 'true', SOCIAL_TOKEN_KEYS: JSON.stringify({ one: key }), SOCIAL_TOKEN_KEY_CURRENT: 'one', SOCIAL_CHANNELS_OWNER: 'crm', SOCIAL_INBOUND_ENABLED: 'true', SOCIAL_LIVE_ENABLED: 'true', WHATSAPP_LIVE_ENABLED: 'true', LINE_LIVE_ENABLED: 'true', DOMESTIC_LIVE_ENABLED: 'true', META_APP_ID: '12345678', META_APP_SECRET: secret, META_GRAPH_VERSION: 'v24.0', META_VERIFY_TOKEN: 'test-verify', APP_ORIGIN: 'https://crm.example.invalid' });
  delete process.env.FLOWS_ENABLED;
  globalThis.fetch = (async () => { throw Error('No real provider traffic'); }) as typeof fetch;
  await database.query('SELECT 1');
});
after(async () => { await closeDatabase(); globalThis.fetch = originalFetch; for (const k of Object.keys(process.env)) if (!(k in previous)) delete process.env[k]; Object.assign(process.env, previous); });
async function fixture() {
  const org = randomUUID(), member = randomUUID();
  await database.query('INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)', [org, org, 'Synthetic runtime tenant']);
  const staff: Staff = { id: member, orgId: org, name: 'Admin', email: member + '@example.invalid', role: 'Admin' };
  await database.query("INSERT INTO members(id,org_id,name,email,password_hash,role) VALUES($1,$2,'Admin',$3,'synthetic','Admin')", [member, org, staff.email]);
  process.env.SOCIAL_CHANNELS_ORG_ID = org;
  return { org, staff };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function account(f: Fixture, provider: SocialProvider, accountId: string, token = 'synthetic-token-' + accountId) {
  const id = randomUUID(), subject = [f.org, provider, accountId], encrypted = await sealSocialSecret(token, 'account-token', subject);
  const lineSecret = provider === 'line' ? '0123456789abcdef0123456789abcdef' : '';
  const encryptedSecret = lineSecret ? await sealSocialSecret(lineSecret, 'account-secret', subject) : null;
  const testRecipient = provider === 'line' ? sender : '66812345678';
  const at = new Date().toISOString();
  await database.query("INSERT INTO social_accounts(id,org_id,provider,account_id,parent_ref,display_name,display_identity,state,auth_readiness,token_ciphertext,token_iv,secret_ciphertext,secret_iv,key_version,token_fingerprint,connected_at,created_at,updated_at,runtime_inbound_enabled,runtime_live_enabled,runtime_test_recipient) VALUES($1,$2,$3,$4,'777777','Synthetic account','66812345678','webhook_pending','ready',$5,$6,$7,$8,$9,$10,$11,$11,$11,1,1,$12)", [id, f.org, provider, accountId, encrypted.ciphertext, encrypted.iv, encryptedSecret?.ciphertext || null, encryptedSecret?.iv || null, encrypted.keyVersion, socialTokenFingerprint(token), at, testRecipient]);
  return { id, accountId, token, lineSecret, provider };
}
const reject = (code: number) => (e: unknown) => e instanceof ApiError && e.status === code;
function signed(provider: SocialProvider, body: unknown, signingSecret = secret) {
  const raw = Buffer.from(JSON.stringify(body));
  const signature = createHmac('sha256', signingSecret).update(raw).digest(provider === 'line' ? 'base64' : 'hex');
  return { raw, headers: new Headers(provider === 'line' ? { 'x-line-signature': signature } : { 'x-hub-signature-256': 'sha256=' + signature }) };
}
const waEntry = (id: string, n: string, waba = '777777') => ({ id: waba, changes: [{ field: 'messages', value: { metadata: { phone_number_id: id }, messages: [{ id: 'wamid.' + n, from: '66812345678', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Synthetic hello' } }] } }] });
async function lineInbound(a: Awaited<ReturnType<typeof account>>) {
  const input = signed('line', { destination: a.accountId, events: [{ webhookEventId: randomUUID(), type: 'message', timestamp: Date.now(), source: { type: 'user', userId: sender }, message: { id: randomUUID(), type: 'text', text: 'synthetic' } }] }, a.lineSecret);
  return ingestRegisteredWebhook('line', input.raw, input.headers);
}
async function command(f: Fixture, a: Awaited<ReturnType<typeof account>>) {
  const identity = (await database.query('SELECT * FROM social_identities WHERE org_id=$1 AND account_id=$2', [f.org, a.accountId])).rows[0];
  await database.query("UPDATE conversations SET status='human_active',assignee_id=$3 WHERE org_id=$1 AND id=$2", [f.org, identity.conversation_id, f.staff.id]);
  const messageId = randomUUID();
  return transaction(f.org, async c => {
    await c.query("INSERT INTO messages(id,org_id,conversation_id,role,content) VALUES($1,$2,$3,'agent','synthetic reply')", [messageId, f.org, identity.conversation_id]);
    return (await enqueueSocialReply(c, f.org, identity.conversation_id, messageId, 'synthetic reply')).commandId!;
  });
}
async function enable(f: Fixture, a: Awaited<ReturnType<typeof account>>) {
  const config = await resolveSocialConfig(f.org, a.provider, a.accountId), fp = socialConfigFingerprint(config);
  await database.query("UPDATE social_channel_controls SET send_enabled=1,emergency_stop=0,send_mode='test',test_recipient=$4,verified_at=$5,verification_fingerprint=$6,verification_expires_at=$7,webhook_fingerprint=$6,webhook_verified_at=$5 WHERE org_id=$1 AND provider=$2 AND account_id=$3", [f.org, a.provider, a.accountId, config.testRecipient, new Date().toISOString(), fp, new Date(Date.now() + 3600000).toISOString()]);
}

test('resolver uses exact encrypted tuple and never falls back to primary env account', async () => {
  const f = await fixture(), a = await account(f, 'line', 'U' + '1'.repeat(32)), b = await account(f, 'line', 'U' + '2'.repeat(32));
  Object.assign(process.env, { LINE_BOT_USER_ID: 'wrong-primary', LINE_CHANNEL_ACCESS_TOKEN: 'wrong-primary-token' });
  assert.equal((await resolveSocialConfig(f.org, 'line', b.accountId)).accessToken, b.token);
  assert.equal((await resolveSocialConfig(f.org, 'line', a.accountId)).accessToken, a.token);
  await assert.rejects(resolveSocialConfig(f.org, 'line', 'missing'), reject(503));
  await assert.rejects(resolveSocialConfig(randomUUID(), 'line', a.accountId), reject(503));
  const safe = JSON.stringify(await listRuntimeAccounts(f.org)); assert.ok(!safe.includes(a.token)); assert.ok(!safe.includes(a.lineSecret));
});

test('global flag off preserves exact legacy mapping, per-account defaults and expiry deny runtime', async () => {
  const f = await fixture(), a = await account(f, 'line', 'U' + '3'.repeat(32));
  const legacy = { ...process.env, SOCIAL_ACCOUNT_RUNTIME_ENABLED: 'false', LINE_BOT_USER_ID: 'legacy', LINE_CHANNEL_ACCESS_TOKEN: 'legacy-token' };
  assert.equal((await resolveSocialConfig(f.org, 'line', 'legacy', { env: legacy })).accessToken, 'legacy-token');
  await assert.rejects(resolveSocialConfig(f.org, 'line', a.accountId, { env: legacy }), reject(503));
  await database.query("UPDATE social_accounts SET expires_at='2000-01-01T00:00:00Z' WHERE id=$1", [a.id]);
  await assert.rejects(resolveSocialConfig(f.org, 'line', a.accountId), reject(503));
});

test('signed WhatsApp fanout handles two explicit accounts without collapsing identical remote contacts', async () => {
  const f = await fixture(), a = await account(f, 'whatsapp', '1111111'), b = await account(f, 'whatsapp', '2222222');
  const input = signed('whatsapp', { object: 'whatsapp_business_account', entry: [waEntry(a.accountId, 'a'), waEntry(b.accountId, 'b')] });
  assert.deepEqual(await ingestRegisteredWebhook('whatsapp', input.raw, input.headers), { accepted: 2, duplicates: 0, orgId: f.org });
  assert.equal((await database.query('SELECT count(*) AS n FROM social_identities WHERE org_id=$1', [f.org])).rows[0].n, 2);
  assert.equal((await ingestRegisteredWebhook('whatsapp', input.raw, input.headers)).duplicates, 2);
});

test('all envelopes, signatures and WABA bindings validate before any account writes', async () => {
  const f = await fixture(), a = await account(f, 'whatsapp', '3333333'), b = await account(f, 'whatsapp', '4444444');
  for (const entries of [[waEntry(a.accountId, 'valid'), waEntry('unregistered', 'bad')], [waEntry(a.accountId, 'valid'), waEntry(b.accountId, 'bad', '999999')]]) {
    const input = signed('whatsapp', { object: 'whatsapp_business_account', entry: entries });
    await assert.rejects(ingestRegisteredWebhook('whatsapp', input.raw, input.headers));
    assert.equal((await database.query('SELECT count(*) AS n FROM social_events WHERE org_id=$1', [f.org])).rows[0].n, 0);
    assert.equal((await database.query('SELECT count(*) AS n FROM social_channel_controls WHERE org_id=$1', [f.org])).rows[0].n, 0);
  }
  const forged = signed('whatsapp', { object: 'whatsapp_business_account', entry: [waEntry(a.accountId, 'forged')] }, 'wrong');
  await assert.rejects(ingestRegisteredWebhook('whatsapp', forged.raw, forged.headers), reject(403));
});

test('LINE destination signatures and empty callback probes bind to the exact registered secret', async () => {
  const f = await fixture(), a = await account(f, 'line', 'U' + '4'.repeat(32));
  const probe = signed('line', { destination: a.accountId, events: [] }, a.lineSecret);
  assert.equal((await ingestRegisteredWebhook('line', probe.raw, probe.headers)).accepted, 0);
  assert.equal((await database.query('SELECT account_id FROM social_channel_controls WHERE org_id=$1', [f.org])).rows[0].account_id, a.accountId);
  const wrong = signed('line', { destination: a.accountId, events: [] }, 'wrong');
  await assert.rejects(ingestRegisteredWebhook('line', wrong.raw, wrong.headers), reject(403));
});

test('dispatch reads each account token and per-account test recipient before a single attempt', async () => {
  const f = await fixture(), a = await account(f, 'line', 'U' + '5'.repeat(32)), b = await account(f, 'line', 'U' + '6'.repeat(32));
  for (const acc of [a, b]) { await lineInbound(acc); await enable(f, acc); }
  const ids = [await command(f, a), await command(f, b)], tokens: string[] = [];
  const transport = (async (_url, init) => { tokens.push(new Headers(init?.headers).get('authorization')!); assert.equal(JSON.parse(String(init?.body)).to, sender); return Response.json({ sentMessages: [{ id: randomUUID() }] }); }) as typeof fetch;
  for (const id of ids) assert.equal((await dispatchSocialReply(f.org, id, { fetch: transport })).status, 'submitted');
  assert.deepEqual(tokens, ['Bearer ' + a.token, 'Bearer ' + b.token]);
  for (const id of ids) await dispatchSocialReply(f.org, id, { fetch: transport }); assert.equal(tokens.length, 2);
});

test('pause only fences and cancels that registered account; sibling commands remain queued', async () => {
  const f = await fixture(), a = await account(f, 'line', 'U' + '7'.repeat(32)), b = await account(f, 'line', 'U' + '8'.repeat(32));
  for (const acc of [a, b]) { await lineInbound(acc); await enable(f, acc); }
  const x = await command(f, a), y = await command(f, b);
  await socialAccountAction(f.staff, a.id, { action: 'pause' });
  assert.equal((await database.query('SELECT status FROM social_outbound_commands WHERE id=$1', [x])).rows[0].status, 'cancelled');
  assert.equal((await database.query('SELECT status FROM social_outbound_commands WHERE id=$1', [y])).rows[0].status, 'queued');
  await assert.rejects(resolveSocialConfig(f.org, 'line', a.accountId), reject(503));
  assert.equal((await resolveSocialConfig(f.org, 'line', b.accountId)).accountId, b.accountId);
});

test('runtime configure reauthorizes actor, rejects stale revision and clears send controls', async () => {
  const f = await fixture(), a = await account(f, 'line', 'U' + '9'.repeat(32)); await lineInbound(a); await enable(f, a);
  await socialRuntimeAction(f.staff, a.id, { action: 'configure', revision: 0, inboundEnabled: true, liveEnabled: false, testRecipient: sender });
  assert.equal((await resolveSocialConfig(f.org, 'line', a.accountId)).liveEnabled, false);
  assert.equal((await database.query('SELECT send_enabled FROM social_channel_controls WHERE org_id=$1', [f.org])).rows[0].send_enabled, 0);
  await assert.rejects(socialRuntimeAction(f.staff, a.id, { action: 'configure', revision: 0, inboundEnabled: true, liveEnabled: false, testRecipient: sender }), reject(409));
  await database.query("UPDATE members SET role='Agent' WHERE id=$1", [f.staff.id]);
  await assert.rejects(socialRuntimeAction(f.staff, a.id, { action: 'configure', revision: 1, inboundEnabled: true, liveEnabled: true, testRecipient: sender }), reject(403));
});

test('pause during provider IO aborts the attempt as unknown and never blindly resends', async () => {
  const f = await fixture(), a = await account(f, 'line', 'U' + 'a'.repeat(32)); await lineInbound(a); await enable(f, a); const id = await command(f, a); let calls = 0;
  const transport = (async (_url, init) => { calls++; await socialAccountAction(f.staff, a.id, { action: 'pause' }); return new Promise<Response>((_resolve, reject) => { init!.signal!.addEventListener('abort', () => reject(new Error('Synthetic aborted transport')), { once: true }); }); }) as typeof fetch;
  assert.equal((await dispatchSocialReply(f.org, id, { fetch: transport })).status, 'unknown');
  await dispatchSocialReply(f.org, id, { fetch: transport }); assert.equal(calls, 1);
});

const igEntry=(accountId:string,mid:string,extra:Record<string,unknown>={})=>({id:accountId,messaging:[{sender:{id:'66812345678'},recipient:{id:accountId},timestamp:Date.now(),message:{mid,text:'Synthetic IG inbound',...extra}}]});
async function igInbound(a:Awaited<ReturnType<typeof account>>,mid=randomUUID()) {
  Object.assign(process.env,{INSTAGRAM_INBOUND_ENABLED:'true',INSTAGRAM_LIVE_ENABLED:'true'});
  const input=signed('instagram',{object:'instagram',entry:[igEntry(a.accountId,mid)]});return ingestRegisteredWebhook('instagram',input.raw,input.headers);
}
test('Instagram is a separate signed account namespace with fanout, dedupe and default-off gates',async()=>{
  const f=await fixture(),a=await account(f,'instagram','179111111111'),b=await account(f,'instagram','179222222222');
  delete process.env.INSTAGRAM_INBOUND_ENABLED;delete process.env.INSTAGRAM_LIVE_ENABLED;
  assert.equal((await resolveSocialConfig(f.org,'instagram',a.accountId)).inboundEnabled,false);
  const input=signed('instagram',{object:'instagram',entry:[igEntry(a.accountId,'same-mid'),igEntry(b.accountId,'same-mid')]});
  await assert.rejects(ingestRegisteredWebhook('instagram',input.raw,input.headers),reject(503));
  Object.assign(process.env,{INSTAGRAM_INBOUND_ENABLED:'true',INSTAGRAM_LIVE_ENABLED:'true'});
  assert.equal((await ingestRegisteredWebhook('instagram',input.raw,input.headers)).accepted,2);
  assert.equal((await ingestRegisteredWebhook('instagram',input.raw,input.headers)).duplicates,2);
  const identities=(await database.query('SELECT provider,account_id,remote_id FROM social_identities WHERE org_id=$1',[f.org])).rows;
  assert.equal(identities.length,2);assert.ok(identities.every(r=>r.provider==='instagram'));
  await assert.rejects(ingestRegisteredWebhook('facebook',input.raw,input.headers),reject(400));
  const invalid=signed('instagram',{object:'instagram',entry:[igEntry(a.accountId,'new-valid'),igEntry('179999999999','unregistered')]});
  await assert.rejects(ingestRegisteredWebhook('instagram',invalid.raw,invalid.headers));
  assert.equal((await database.query('SELECT count(*) AS n FROM social_events WHERE org_id=$1',[f.org])).rows[0].n,2);
});
test('Instagram Page-token send is once-only, does not infer delivery and ignores unsupported receipt shapes',async()=>{
  const f=await fixture(),a=await account(f,'instagram','179333333333');await igInbound(a);await enable(f,a);const id=await command(f,a);let calls=0;
  const transport=(async(url,init)=>{calls++;assert.equal(url,'https://graph.facebook.com/v24.0/me/messages');assert.equal(init?.redirect,'manual');assert.equal(new Headers(init?.headers).get('authorization'),'Bearer '+a.token);assert.deepEqual(JSON.parse(String(init?.body)),{recipient:{id:'66812345678'},message:{text:'synthetic reply'}});return Response.json({recipient_id:'66812345678',message_id:'ig.sent.1'});}) as typeof fetch;
  assert.equal((await dispatchSocialReply(f.org,id,{fetch:transport})).status,'submitted');await dispatchSocialReply(f.org,id,{fetch:transport});assert.equal(calls,1);
  const input=signed('instagram',{object:'instagram',entry:[{id:a.accountId,messaging:[{sender:{id:'66812345678'},recipient:{id:a.accountId},timestamp:Date.now(),read:{watermark:Date.now()}}]}]});
  await ingestRegisteredWebhook('instagram',input.raw,input.headers);
  assert.equal((await database.query('SELECT status FROM social_outbound_commands WHERE id=$1',[id])).rows[0].status,'submitted');
  assert.equal((await database.query('SELECT count(*) AS n FROM social_delivery_receipts WHERE org_id=$1',[f.org])).rows[0].n,0);
  assert.equal((await database.query('SELECT test_passed_at FROM social_channel_controls WHERE org_id=$1',[f.org])).rows[0].test_passed_at,null);
});
test('Instagram 24-hour window, UTF8 cap, changed configuration and unknown outcomes fail closed',async()=>{
  const f=await fixture(),a=await account(f,'instagram','179444444444');await igInbound(a);await enable(f,a);const id=await command(f,a);
  await database.query("UPDATE social_message_provenance SET provider_timestamp='2000-01-01T00:00:00Z' WHERE org_id=$1 AND direction='in'",[f.org]);
  await assert.rejects(dispatchSocialReply(f.org,id),reject(409));
  const chat=(await database.query('SELECT conversation_id FROM social_identities WHERE org_id=$1',[f.org])).rows[0].conversation_id;
  await assert.rejects(transaction(f.org,c=>enqueueSocialReply(c,f.org,chat,randomUUID(),'ก'.repeat(334))),reject(400));
  await database.query("UPDATE social_message_provenance SET provider_timestamp=$2 WHERE org_id=$1 AND direction='in'",[f.org,new Date().toISOString()]);
  let reads=0,calls=0;const config=await resolveSocialConfig(f.org,'instagram',a.accountId);
  assert.equal((await dispatchSocialReply(f.org,id,{readConfig:async()=>{reads++;return {...config,liveEnabled:reads===1};},fetch:(async()=>{calls++;throw Error('must not send');}) as typeof fetch})).status,'cancelled');assert.equal(calls,0);
  const second=await command(f,a);assert.equal((await dispatchSocialReply(f.org,second,{fetch:(async()=>Response.json({mid:'unverified-response-shape'})) as typeof fetch})).status,'unknown');
});
test('Instagram verification pins linked Page, app, permissions and own callback token',async()=>{
  const f=await fixture(),a=await account(f,'instagram','179555555555');await igInbound(a);const config=await resolveSocialConfig(f.org,'instagram',a.accountId);
  const transport=(wrong=false)=>(async(url,init)=>{assert.equal(init?.method,'GET');const u=new URL(String(url));assert.equal(u.origin,'https://graph.facebook.com');if(u.pathname.endsWith('/debug_token'))return Response.json({data:{is_valid:true,app_id:config.appId,profile_id:config.linkedPageId,scopes:['instagram_basic','instagram_manage_messages'],expires_at:Math.floor(Date.now()/1000)+3600}});if(u.pathname.endsWith('/'+a.accountId))return Response.json({id:a.accountId,username:'synthetic'});return Response.json({id:config.linkedPageId,instagram_business_account:{id:wrong?'179000000000':a.accountId}});}) as typeof fetch;
  assert.equal((await verifyRegisteredChannel(config,transport())).detail.linkedPageMatched,true);
  await assert.rejects(verifyRegisteredChannel(config,transport(true)),reject(409));
  const env={...process.env,INSTAGRAM_VERIFY_TOKEN:'ig-specific-token'};
  assert.equal(registeredVerificationChallenge(new Request('https://crm.example.invalid/api/channels/instagram?hub.mode=subscribe&hub.verify_token=ig-specific-token&hub.challenge=123'),'instagram',env),'123');
});
