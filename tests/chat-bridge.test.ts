/** Real SQLite, synthetic organizations only; no production/provider traffic. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { before, after, test } from 'node:test';
import { database, transaction, closeDatabase } from '../src/lib/db';
import { acknowledgeBridge, bootstrapBridge, readBridgeEvents } from '../src/lib/chat-bridge';
import { signBridgeRequest } from '../src/lib/bridge-protocol';
import { GET, POST } from '../src/app/api/bridge/[...path]/route';
import { conversationDetail, snapshot } from '../src/lib/service';

const ids = { org: randomUUID(), other: randomUUID(), bootstrapRace: randomUUID(), raceLead: randomUUID(), lead: randomUUID(), conversation: randomUUID(), message: randomUUID() };
const secret = 'synthetic-bridge-test-secret-at-least-32-characters';
const oldTime = '2025-02-03T04:05:06.123456Z';
const env = ['DEMO_MODE','AI_PROVIDER','D1_LOCAL_DIR','APP_ORIGIN','CRM_BRIDGE_ENABLED','CRM_BRIDGE_ORG_ID','CRM_BRIDGE_SECRET'] as const;
const previous = Object.fromEntries(env.map(key => [key, process.env[key]]));

before(async () => {
  const directory = path.join(process.cwd(), '.data', `chat-bridge-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  process.env.DEMO_MODE = 'true'; process.env.AI_PROVIDER = 'disabled'; process.env.APP_ORIGIN = 'http://localhost';
  process.env.D1_LOCAL_DIR = directory; process.env.CRM_BRIDGE_ENABLED = 'true';
  process.env.CRM_BRIDGE_ORG_ID = ids.org; process.env.CRM_BRIDGE_SECRET = secret;
  const sql = new DatabaseSync(path.join(directory, 'crm.sqlite'));
  try {
    sql.exec('PRAGMA foreign_keys=ON');
    for (const file of ['001_initial.sql','002_helpdesk.sql','003_members_and_atomic_writes.sql','004_private_files.sql']) sql.exec(await readFile(path.join('migrations/d1',file), 'utf8'));
    for (const org of [ids.org, ids.other, ids.bootstrapRace]) sql.prepare('INSERT INTO organizations(id,slug,name) VALUES(?,?,?)').run(org, org, 'Synthetic bridge organization');
    sql.prepare('INSERT INTO leads(id,org_id,name) VALUES(?,?,?)').run(ids.raceLead,ids.bootstrapRace,'Unlogged synthetic customer');
    sql.prepare('INSERT INTO leads(id,org_id,name,tags,facts,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(ids.lead, ids.org, 'Historical synthetic customer', '["preserved"]', '{"test":"fixture"}', oldTime, oldTime);
    sql.prepare('INSERT INTO conversations(id,org_id,lead_id,created_at,updated_at) VALUES(?,?,?,?,?)').run(ids.conversation, ids.org, ids.lead, oldTime, oldTime);
    sql.prepare("INSERT INTO messages(id,org_id,conversation_id,role,content,created_at,sources) VALUES(?,?,?,'user',?,?,?)").run(ids.message, ids.org, ids.conversation, 'Historical synthetic message', oldTime, '[]');
  } finally { sql.close(); }
});
after(async () => {
  await closeDatabase();
  for (const key of env) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
});

async function request(endpoint: string, method = 'GET', value?: unknown, orgId = ids.org) {
  const url = `http://localhost/api/bridge/${endpoint}`;
  const body = value === undefined ? '' : JSON.stringify(value);
  return new Request(url, { method, headers: await signBridgeRequest(url, { secret, orgId, method, body }), ...(method === 'GET' ? {} : { body }) });
}

test('migration never bootstraps existing customer data automatically; bounded bootstrap is idempotent', async () => {
  const before = await readBridgeEvents(ids.org);
  assert.equal(before.headSequence, 0); assert.equal(before.bootstrapComplete, false); assert.deepEqual(before.events, []);
  const first = await bootstrapBridge(ids.org, 1); assert.equal(first.captured, 1); assert.equal(first.bootstrapComplete, false);
  await bootstrapBridge(ids.org, 1); const third = await bootstrapBridge(ids.org, 1);
  assert.equal(third.bootstrapComplete, true); assert.equal(third.headSequence, 3);
  const page = await readBridgeEvents(ids.org);
  assert.deepEqual(page.events.map(event => event.entity), ['lead','conversation','message']);
  assert.deepEqual(page.events.map(event => event.sequence), [1,2,3]);
  assert.equal(page.events[0].record.tags, '["preserved"]'); assert.equal(page.events[0].record.facts, '{"test":"fixture"}');
  assert.equal(page.events[2].record.created_at, oldTime); assert.equal(page.events[2].record.content, 'Historical synthetic message');
  assert.equal((await bootstrapBridge(ids.org)).captured, 0);
  assert.deepEqual((await readBridgeEvents(ids.org)).events, page.events);
});

test('native insert/update mutations and log sequence commit atomically; retry has no gaps', async () => {
  const head = (await readBridgeEvents(ids.org)).headSequence;
  const lead = randomUUID(), conversation = randomUUID(), message = randomUUID();
  await assert.rejects(transaction(ids.org, async connection => {
    await connection.query('UPDATE leads SET name=$3 WHERE org_id=$1 AND id=$2', [ids.org, ids.lead, 'Must roll back']);
    await connection.query('INSERT INTO conversations(id,org_id,lead_id) VALUES($1,$2,$3)', [randomUUID(), ids.org, randomUUID()]);
  }));
  assert.equal((await readBridgeEvents(ids.org)).headSequence, head);
  assert.equal((await database.query('SELECT name FROM leads WHERE id=$1',[ids.lead])).rows[0].name, 'Historical synthetic customer');
  await transaction(ids.org, async connection => {
    await connection.query('INSERT INTO leads(id,org_id,name) VALUES($1,$2,$3)',[lead,ids.org,'New synthetic customer']);
    await connection.query('INSERT INTO conversations(id,org_id,lead_id) VALUES($1,$2,$3)',[conversation,ids.org,lead]);
    await connection.query("INSERT INTO messages(id,org_id,conversation_id,role,content,client_id) VALUES($1,$2,$3,'user',$4,$5)",[message,ids.org,conversation,'Synthetic customer message','synthetic-replay-client']);
    await connection.query('UPDATE messages SET status=$3 WHERE org_id=$1 AND id=$2',[ids.org,message,'generating']);
  });
  const page = await readBridgeEvents(ids.org,head);
  assert.deepEqual(page.events.map(event => event.sequence),[head+1,head+2,head+3,head+4]);
  assert.deepEqual(page.events.map(event => event.entity),['lead','conversation','message','message']);
  assert.equal(page.events[3].record.status,'generating');
  await assert.rejects(database.query("INSERT INTO messages(id,org_id,conversation_id,role,content,client_id) VALUES($1,$2,$3,'user',$4,$5)",[randomUUID(),ids.org,conversation,'Synthetic customer message','synthetic-replay-client']));
  assert.equal((await readBridgeEvents(ids.org)).headSequence,head+4);
  assert.equal((await bootstrapBridge(ids.org)).captured,0);
});

test('organization sequences are isolated and replay/cursor pagination returns identical event IDs', async () => {
  await database.query('INSERT INTO leads(id,org_id,name) VALUES($1,$2,$3)',[randomUUID(),ids.other,'Other tenant synthetic']);
  const other = await readBridgeEvents(ids.other);
  assert.equal(other.headSequence,1); assert.equal(other.events[0].sequence,1);
  const first = await readBridgeEvents(ids.org,0,2), again = await readBridgeEvents(ids.org,0,2);
  assert.deepEqual(first,again); assert.equal(first.hasMore,true); assert.equal(first.nextCursor,2);
  const next = await readBridgeEvents(ids.org,first.nextCursor,2);
  assert.equal(next.events[0].sequence,3);
  assert.ok([...first.events,...next.events].every(event => event.orgId===ids.org && event.record.org_id===ids.org));
  await assert.rejects(readBridgeEvents(ids.org,first.headSequence+1),{status:409});
  await assert.rejects(readBridgeEvents(ids.org,-1),{status:400});
  await assert.rejects(readBridgeEvents(ids.org,0,101),{status:400});
});

test('ACK is monotonic, tenant scoped, and retains the entire replay log', async () => {
  const before = await readBridgeEvents(ids.org);
  await acknowledgeBridge(ids.org,'sale-office',before.headSequence);
  const result = await acknowledgeBridge(ids.org,'sale-office',1);
  assert.equal(result.acknowledged_sequence,before.headSequence);
  assert.deepEqual((await readBridgeEvents(ids.org)).events,before.events);
  await assert.rejects(acknowledgeBridge(ids.org,'sale-office',before.headSequence+1),{status:409});
  assert.equal((await database.query('SELECT count(*) AS n FROM crm_bridge_consumers WHERE org_id=$1',[ids.other])).rows[0].n,0);
});

test('signed API rejects foreign tenant, unsigned/browser requests and invalid cursors, without cache', async () => {
  const valid = await GET(await request('events?after=0&limit=2'));
  assert.equal(valid.status,200); assert.match(valid.headers.get('cache-control')!,/no-store/);
  assert.equal((await valid.json()).orgId,ids.org);
  assert.equal((await GET(await request('events','GET',undefined,ids.other))).status,401);
  assert.equal((await GET(new Request('http://localhost/api/bridge/events'))).status,401);
  const browser = await request('events'); browser.headers.set('origin','http://localhost');
  assert.equal((await GET(browser)).status,403);
  for (const query of ['after=-1','after=1.5','after=1e3','limit=0','limit=101','after=0&after=1',`orgId=${ids.other}`]) assert.equal((await GET(await request(`events?${query}`))).status,400);
  assert.equal((await GET(await request('events?after=999999999'))).status,409);
  assert.equal((await POST(await request('bootstrap','POST',{limit:1}))).status,200);
  assert.equal((await POST(await request('ack','POST',{consumerId:'sale-office',sequence:1,orgId:ids.other}))).status,400);
  process.env.CRM_BRIDGE_ENABLED='false';
  assert.equal((await GET(await request('events'))).status,503);
  process.env.CRM_BRIDGE_ENABLED='true';
});

test('bootstrap races with first native update without duplicate baseline or counter gaps', async () => {
  assert.equal((await readBridgeEvents(ids.bootstrapRace)).bootstrapComplete,false);
  await Promise.all([bootstrapBridge(ids.bootstrapRace),transaction(ids.bootstrapRace,async connection=>{
    await connection.query('UPDATE leads SET name=$3 WHERE org_id=$1 AND id=$2',[ids.bootstrapRace,ids.raceLead,'Concurrent synthetic change']);
  })]);
  const result = await readBridgeEvents(ids.bootstrapRace);
  assert.ok(result.events.length===1||result.events.length===2);
  assert.deepEqual(result.events.map(event=>event.sequence),Array.from({length:result.events.length},(_,i)=>i+1));
  assert.equal(result.events.at(-1)!.record.name,'Concurrent synthetic change');
  assert.equal(result.bootstrapComplete,true);
  assert.equal((await bootstrapBridge(ids.bootstrapRace)).captured,0);
});

test('source ID mappings enforce import replay identity within organization scope', async () => {
  const params = [ids.org,'sale-office','domestic','domMessage','source-fixture-id',ids.message,'synthetic-hash'];
  const sql = 'INSERT INTO crm_bridge_import_mappings(org_id,source_system,source_workspace,entity_kind,source_id,target_id,content_hash) VALUES($1,$2,$3,$4,$5,$6,$7)';
  await database.query(sql,params); await assert.rejects(database.query(sql,params));
  await database.query(sql,[ids.other,...params.slice(1)]);
  assert.equal((await database.query('SELECT count(*) AS n FROM crm_bridge_import_mappings WHERE org_id=$1',[ids.org])).rows[0].n,1);
});

test('source private message remains hidden even before provenance is imported', async () => {
  const privateId=randomUUID();
  await database.query("INSERT INTO messages(id,org_id,conversation_id,role,content,source_owner_only) VALUES($1,$2,$3,'note',$4,1)",[privateId,ids.org,ids.conversation,'Owner-only synthetic evidence']);
  for(const internal of [false,true])assert.equal((await conversationDetail(ids.org,ids.conversation,internal,false)).messages.some(message=>message.id===privateId),false);
  assert.equal((await conversationDetail(ids.org,ids.conversation,true,true)).messages.some(message=>message.id===privateId),true);
  assert.equal((await readBridgeEvents(ids.org)).events.at(-1)!.record.source_owner_only,1);
});

test('dashboard previews and Agent audit do not reveal owner evidence',async()=>{
  const id=randomUUID();
  await database.query("INSERT INTO messages(id,org_id,conversation_id,role,content,source_owner_only,created_at) VALUES($1,$2,$3,'user',$4,1,'2099-01-01T00:00:00.000000Z')",[id,ids.org,ids.conversation,'Synthetic owner-only preview']);
  for(const action of ['whatsapp_consent.granted','social_channel.test_enabled'])await database.query('INSERT INTO audit_events(id,org_id,actor_id,action,entity_id,metadata) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),ids.org,'synthetic-admin',action,ids.conversation,JSON.stringify({evidenceNote:'Synthetic private approval evidence'})]);
  const staff={id:'synthetic-admin',orgId:ids.org,name:'Synthetic',email:'fixture@example.invalid',role:'Agent' as const},url=new URL('http://localhost/api/admin/snapshot');
  const ordinary=await snapshot(staff,url),owner=await snapshot({...staff,role:'Admin'},url);
  assert.notEqual(ordinary.conversations.find(c=>c.id===ids.conversation)?.lastMessage,'Synthetic owner-only preview');
  assert.equal(ordinary.audit.some(row=>/^whatsapp_consent\.|^social_channel\./.test(row.action)),false);
  assert.equal(owner.conversations.find(c=>c.id===ids.conversation)?.lastMessage,'Synthetic owner-only preview');
  assert.equal(owner.audit.filter(row=>/^whatsapp_consent\.|^social_channel\./.test(row.action)).length,2);
});
