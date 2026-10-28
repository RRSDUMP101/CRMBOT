import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {before,after,test} from 'node:test';
import {database,transaction,closeDatabase} from '../src/lib/db';
import {adminAction,createVisitor,messageStream} from '../src/lib/service';
import {listFiles,uploadFile,downloadFile} from '../src/lib/files';
import type {Staff} from '../src/lib/auth';

let staff:Staff;let other:Staff;let lead:string;
before(async()=>{
  process.env.DEMO_MODE='true';process.env.AI_PROVIDER='demo';process.env.APP_ORIGIN='http://localhost';
  process.env.D1_LOCAL_DIR=`.data/integrity-${randomUUID()}`;
  const members=(await database.query('SELECT * FROM members')).rows;
  const toStaff=(r:Record<string,any>)=>({id:r.id,orgId:r.org_id,name:r.name,email:r.email,role:r.role}) as Staff;
  staff=toStaff(members.find(m=>m.email==='admin@rrs.demo')!);other=toStaff(members.find(m=>m.email==='outsider@other.demo')!);
  lead=randomUUID();await database.query('INSERT INTO leads(id,org_id,name) VALUES($1,$2,$3)',[lead,staff.orgId,'Before rollback']);
});
after(closeDatabase);
test('a later failed statement rolls back all writes and revision',async()=>{
  const revision=(await database.query('SELECT revision FROM organizations WHERE id=$1',[staff.orgId])).rows[0].revision;
  await assert.rejects(transaction(staff.orgId,async c=>{
    await c.query('UPDATE leads SET name=$3 WHERE org_id=$1 AND id=$2',[staff.orgId,lead,'Must roll back']);
    await c.query('INSERT INTO leads(id,org_id) VALUES($1,$2)',[randomUUID(),randomUUID()]);
  },staff));
  assert.equal((await database.query('SELECT name FROM leads WHERE id=$1',[lead])).rows[0].name,'Before rollback');
  assert.equal((await database.query('SELECT revision FROM organizations WHERE id=$1',[staff.orgId])).rows[0].revision,revision);
  assert.equal((await database.query('SELECT count(*) AS n FROM crm_tx_guard')).rows[0].n,0);
});
test('CAS conflict retries a fresh plan instead of losing a concurrent increment',async()=>{
  let arrivals=0;let release!:()=>void;const ready=new Promise<void>(r=>release=r);
  const run=()=>transaction(staff.orgId,async c=>{
    const r=(await c.query('SELECT name FROM leads WHERE id=$1',[lead])).rows[0];
    if(++arrivals<=2){if(arrivals===2)release();await ready;}
    await c.query('UPDATE leads SET name=$2 WHERE id=$1',[lead,r.name+'!']);
  },staff);
  await Promise.all([run(),run()]);
  assert.equal((await database.query('SELECT name FROM leads WHERE id=$1',[lead])).rows[0].name,'Before rollback!!');
  assert.equal(arrivals,3);
});
test('simultaneous self-demotions preserve one active administrator',async()=>{
  const org=randomUUID(),a=randomUUID(),b=randomUUID();
  await database.query('INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)',[org,org,'Atomic admin fixture']);
  for(const id of [a,b])await database.query("INSERT INTO members(id,org_id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5,'Admin')",[id,org,'Admin',id+'@example.invalid','no-login']);
  const results=await Promise.allSettled([a,b].map(id=>adminAction({id,orgId:org,name:'Admin',email:id+'@example.invalid',role:'Admin'},{action:'updateMember',id,values:{role:'Agent'}})));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await database.query("SELECT count(*) AS n FROM members WHERE org_id=$1 AND active=1 AND role='Admin'",[org])).rows[0].n,1);
});
test('same client ID received concurrently creates one customer message and one reply',async()=>{
  const {visitor}=await createVisitor();const input={text:'สวัสดีครับ',clientId:randomUUID()};
  const responses=await Promise.all([messageStream(visitor,input,new AbortController().signal),messageStream(visitor,input,new AbortController().signal)]);
  await Promise.all(responses.map(r=>r.text()));
  const messages=(await database.query('SELECT role FROM messages WHERE conversation_id=$1',[visitor.conversationId])).rows;
  assert.equal(messages.filter(r=>r.role==='user').length,1);assert.equal(messages.filter(r=>r.role==='assistant').length,1);
});
test('private attachments enforce tenant, content validation and reserved storage quota',async()=>{
  const pdf=new TextEncoder().encode('%PDF-1.7\nSynthetic fixture');
  const request=()=>new Request('http://localhost/upload',{method:'POST',headers:{'content-type':'application/pdf','x-file-name':encodeURIComponent('ใบเสนอราคา.pdf')},body:pdf});
  await assert.rejects(uploadFile(other,lead,request()),{status:404});
  const saved=await uploadFile(staff,lead,request());assert.equal((await listFiles(staff,lead)).files[0].id,saved.id);
  const downloaded=await downloadFile(staff,saved.id);assert.equal(downloaded.headers.get('cache-control'),'private, no-store');assert.match(downloaded.headers.get('content-disposition')!,/^attachment;/);assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()),pdf);
  await assert.rejects(downloadFile(other,saved.id),{status:404});
  process.env.FILE_STORAGE_LIMIT_BYTES=String(pdf.length);
  await assert.rejects(uploadFile(staff,lead,request()),{status:409});
  assert.equal((await database.query('SELECT count(*) AS n FROM attachments WHERE org_id=$1',[staff.orgId])).rows[0].n,1);
  await assert.rejects(uploadFile(staff,lead,new Request('http://localhost/upload',{method:'POST',headers:{'content-type':'application/pdf','x-file-name':'fake.pdf'},body:'<script>unsafe</script>'})),{status:400});
});
