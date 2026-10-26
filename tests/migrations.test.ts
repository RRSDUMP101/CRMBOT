/** Uses a fresh, ignored .data directory containing only synthetic fixtures. Never opens the app's configured database. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { closeDatabase, database, migrateDatabase } from '../src/lib/db';
import { inbox, markConversationRead } from '../src/lib/helpdesk';
import { messageStream } from '../src/lib/service';

const ids={org:randomUUID(),member:randomUUID(),secondMember:randomUUID(),lead:randomUUID(),conversation:randomUUID(),first:randomUUID(),second:randomUUID()};
const staff={id:ids.member,orgId:ids.org,name:'Migration tester',email:'migration@example.invalid',role:'Admin' as const};
const variables=['DEMO_MODE','AI_PROVIDER','PGLITE_DIR','APP_ORIGIN'] as const;
const previous=Object.fromEntries(variables.map(key=>[key,process.env[key]]));
const base='http://localhost/api/admin/inbox';
const readItem=async(memberId=ids.member)=>(await inbox({...staff,id:memberId},new URL(`${base}?q=Preserved%20synthetic%20customer`))).items[0];

describe('Database upgrade and durable inbox state', {concurrency:false},()=>{
  before(async()=>{
    const directory=path.join(process.cwd(),'.data',`migration-test-${randomUUID()}`);
    await mkdir(directory,{recursive:true});
    process.env.DEMO_MODE='true';process.env.AI_PROVIDER='demo';process.env.PGLITE_DIR=directory;process.env.APP_ORIGIN='http://localhost:3000';
    const legacy=new PGlite(directory);
    try {
      await legacy.waitReady;
      await legacy.exec(await readFile(path.join(process.cwd(),'migrations/001_initial.sql'),'utf8'));
      await legacy.query('INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)',[ids.org,'rrs','Preserved synthetic organization']);
      for(const member of [ids.member,ids.secondMember])await legacy.query("INSERT INTO members(id,org_id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5,'Admin')",[member,ids.org,'Migration tester',`${member}@example.invalid`,'synthetic-no-login']);
      await legacy.query('INSERT INTO leads(id,org_id,name) VALUES($1,$2,$3)',[ids.lead,ids.org,'Preserved synthetic customer']);
      await legacy.query('INSERT INTO conversations(id,org_id,lead_id) VALUES($1,$2,$3)',[ids.conversation,ids.org,ids.lead]);
      await legacy.query("INSERT INTO messages(id,org_id,conversation_id,role,content,created_at) VALUES($1,$2,$3,'user',$4,'2026-01-01T00:00:00Z'),($5,$2,$3,'user',$6,'2026-01-02T00:00:00Z')",[ids.first,ids.org,ids.conversation,'Historical synthetic evidence',ids.second,'Latest synthetic message']);
    } finally {await legacy.close();}
    await migrateDatabase();
  });

  after(async()=>{
    await closeDatabase();
    for(const key of variables){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
  });

  test('001 → 002 preserves customer records and backfills ordered inbound messages',async()=>{
    assert.equal((await database.query('SELECT name FROM leads WHERE org_id=$1 AND id=$2',[ids.org,ids.lead])).rows[0].name,'Preserved synthetic customer');
    const messages=await database.query('SELECT id,content,customer_seq FROM messages WHERE org_id=$1 AND conversation_id=$2 ORDER BY customer_seq',[ids.org,ids.conversation]);
    assert.deepEqual(messages.rows.map(row=>[row.id,row.customer_seq]),[[ids.first,1],[ids.second,2]]);
    assert.equal(messages.rows[0].content,'Historical synthetic evidence');
    const found=await inbox(staff,new URL(`${base}?q=Historical%20synthetic%20evidence`));
    assert.equal(found.total,1);assert.equal(found.items[0].id,ids.conversation);
    assert.equal(found.items[0].unreadCount,2);assert.equal(found.items[0].lastCustomerMessageId,ids.second);
  });

  test('read watermarks are per member, monotonic, and survive migration reruns',async()=>{
    await markConversationRead(staff,ids.conversation,{throughMessageId:ids.first});
    assert.equal((await readItem()).unreadCount,1);
    assert.equal((await readItem(ids.secondMember)).unreadCount,2);
    await markConversationRead(staff,ids.conversation,{throughMessageId:ids.second});
    await markConversationRead(staff,ids.conversation,{throughMessageId:ids.first});
    assert.equal((await readItem()).unreadCount,0);
    await migrateDatabase();
    assert.equal((await readItem()).unreadCount,0);
    assert.equal((await readItem(ids.secondMember)).unreadCount,2);
    const versions=await database.query('SELECT version FROM schema_migrations ORDER BY version');
    assert.deepEqual(versions.rows.map(row=>row.version),[1,2]);
  });

  test('cursor pagination preserves microseconds and UUID tie-breaks without skipping records',async()=>{
    const expected:string[]=[];
    for(let index=0;index<3;index++) {
      const lead=randomUUID(),conversation=randomUUID();expected.push(conversation);
      await database.query('INSERT INTO leads(id,org_id,name) VALUES($1,$2,$3)',[lead,ids.org,'Synthetic microsecond cursor fixture']);
      await database.query('INSERT INTO conversations(id,org_id,lead_id,updated_at) VALUES($1,$2,$3,$4)',[conversation,ids.org,lead,index===0?'2026-01-01T00:00:00.123456Z':'2026-01-01T00:00:00.123455Z']);
    }
    const found:string[]=[];let cursor:string|null=null;let pages=0;
    do {
      const url=new URL(`${base}?q=Synthetic%20microsecond%20cursor%20fixture&limit=1`);if(cursor)url.searchParams.set('cursor',cursor);
      const page=await inbox(staff,url);assert.equal(page.total,3);
      found.push(...page.items.map(item=>String(item.id)));cursor=page.nextCursor;
      if(pages===0){assert.ok(cursor);assert.equal(JSON.parse(Buffer.from(cursor,'base64url').toString('utf8')).updatedAt,'2026-01-01T00:00:00.123456Z');}
      assert.ok(++pages<=3,'cursor must move forward');
    }while(cursor);
    assert.equal(found.length,3);assert.equal(new Set(found).size,3);assert.deepEqual(new Set(found),new Set(expected));
  });

  test('new messages continue the upgraded sequence and idempotent retry does not add unread items',async()=>{
    const body={text:'สนใจ Revo ครับ',clientId:randomUUID()};
    const stream=await messageStream({orgId:ids.org,conversationId:ids.conversation},body,new AbortController().signal);
    await stream.text();assert.equal((await readItem()).unreadCount,1);
    const duplicate=await messageStream({orgId:ids.org,conversationId:ids.conversation},body,new AbortController().signal);
    await duplicate.text();assert.equal((await readItem()).unreadCount,1);
    const messages=await database.query("SELECT customer_seq FROM messages WHERE org_id=$1 AND conversation_id=$2 AND role='user' ORDER BY customer_seq",[ids.org,ids.conversation]);
    assert.deepEqual(messages.rows.map(row=>row.customer_seq),[1,2,3]);
  });
});
