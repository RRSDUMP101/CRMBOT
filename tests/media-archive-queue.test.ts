/** Isolated SQLite/R2 fixtures; the only transport is a strict injected fake. */
import assert from 'node:assert/strict';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {before,after,test} from 'node:test';
import {database,closeDatabase} from '../src/lib/db';
import {ingestSocialWebhook,readSocialConfig} from '../src/lib/social-channels';
import {runMediaArchiveJobs,mediaArchiveStatus,retryMediaArchive} from '../src/lib/media-archive-queue';
import {downloadSocialAttachment} from '../src/lib/social-media';
import {mediaArchiveRunnerRequest,verifyMediaArchiveRunner} from '../src/lib/media-archive-auth';
import {getPrivateBucket} from '../src/lib/files';
import {configureMediaArchiveSchedule,checkMediaArchiveSchedule,parseDeploymentConfig} from '../scripts/media-archive-deployment.mjs';

const file=Buffer.from('%PDF-1.7\nSynthetic queue fixture.'),hash=createHash('sha256').update(file).digest('hex');
const prior={...process.env},originalFetch=fetch,fail=(async()=>{throw Error('Unexpected real network');}) as typeof fetch;
const info=()=>({url:'https://lookaside.fbsbx.com/fixture',file_size:file.length,mime_type:'application/pdf',sha256:hash});
const transport=(async(input,init)=>{assert.ok(!init?.method||init.method==='GET');if(String(input).startsWith('https://graph.facebook.com/v24.0/'))return Response.json(info());assert.equal(String(input),'https://lookaside.fbsbx.com/fixture');return new Response(file,{headers:{'Content-Type':'application/pdf'}});}) as typeof fetch;
async function fixture(){
  const org=randomUUID(),member=randomUUID();await database.query('INSERT INTO organizations(id,slug,name) VALUES($1,$1,\'Synthetic archive queue\')',[org]);
  await database.query("INSERT INTO members(id,org_id,name,email,password_hash,role) VALUES($1,$2,'Fixture',$3,'no-login','Admin')",[member,org,member+'@example.invalid']);
  Object.assign(process.env,{SOCIAL_MEDIA_ARCHIVE_ENABLED:'true',SOCIAL_CHANNELS_ORG_ID:org,SOCIAL_CHANNELS_OWNER:'crm',SOCIAL_INBOUND_ENABLED:'true',WHATSAPP_PHONE_NUMBER_ID:'1234567890',WHATSAPP_WABA_ID:'9988776655',WHATSAPP_APP_SECRET:'synthetic-app-secret',META_APP_SECRET:'synthetic-app-secret',WHATSAPP_ACCESS_TOKEN:'synthetic-never-live-token',WHATSAPP_API_VERSION:'v24.0',FILE_STORAGE_LIMIT_BYTES:'104857600'});
  const config=readSocialConfig('whatsapp'),mid=randomUUID(),payload={object:'whatsapp_business_account',entry:[{id:config.wabaId,changes:[{value:{metadata:{phone_number_id:config.accountId},messages:[{id:mid,from:'66800000001',timestamp:String(Math.floor(Date.now()/1000)-1),type:'document',document:{id:'synthetic-media-'+mid,sha256:hash,mime_type:'application/pdf'}}]}}]}]};
  const raw=new TextEncoder().encode(JSON.stringify(payload)),headers=new Headers({'x-hub-signature-256':'sha256='+createHmac('sha256',config.secret).update(raw).digest('hex')});
  const ingest=()=>ingestSocialWebhook('whatsapp',raw,headers,config);await ingest();
  const id=(await database.query('SELECT attachment_id FROM social_media_archive_jobs WHERE org_id=$1',[org])).rows[0].attachment_id;
  const staff={id:member,orgId:org,name:'Fixture',email:member+'@example.invalid',role:'Admin' as const};
  return {org,id,config,staff,ingest,payload};
}
const job=async(f:{org:string;id:string})=>(await database.query('SELECT * FROM social_media_archive_jobs WHERE org_id=$1 AND attachment_id=$2',[f.org,f.id])).rows[0];
before(async()=>{process.env.DEMO_MODE='true';process.env.D1_LOCAL_DIR='.data/archive-queue-'+randomUUID();delete process.env.RRS_WORKERS;globalThis.fetch=fail;await database.query('SELECT 1');});
after(async()=>{await closeDatabase();globalThis.fetch=originalFetch;for(const k of Object.keys(process.env))if(!(k in prior))delete process.env[k];Object.assign(process.env,prior);});

test('signed native inbound transaction enqueues once and background archive survives provider expiry',async()=>{
  const f=await fixture();await f.ingest();assert.equal((await database.query('SELECT count(*) n FROM social_media_archive_jobs WHERE org_id=$1',[f.org])).rows[0].n,1);
  let calls=0;const fetcher=(async(...args:Parameters<typeof fetch>)=>{calls++;return transport(...args);}) as typeof fetch;
  assert.equal((await runMediaArchiveJobs(f.org,4,{fetch:fetcher})).results[0].status,'archived');assert.equal(calls,2);
  assert.equal((await job(f)).attempts,1);assert.equal((await runMediaArchiveJobs(f.org,4,{fetch:fail})).results.length,0);
  assert.deepEqual(Buffer.from(await(await downloadSocialAttachment(f.org,f.id,fail)).arrayBuffer()),file);
  assert.equal((await database.query('SELECT count(*) n FROM social_outbound_commands WHERE org_id=$1',[f.org])).rows[0].n,0);
});
test('a failed queue insert rolls back inbound message, provider receipt and bridge events atomically',async()=>{
  const f=await fixture(),count=async()=> (await database.query('SELECT (SELECT count(*) FROM messages WHERE org_id=$1) messages,(SELECT count(*) FROM social_events WHERE org_id=$1) receipts,(SELECT count(*) FROM crm_bridge_events WHERE org_id=$1) events',[f.org])).rows[0],before=await count();
  const payload=structuredClone(f.payload);payload.entry[0].changes[0].value.messages[0].id=randomUUID();const raw=new TextEncoder().encode(JSON.stringify(payload));
  await database.query("CREATE TRIGGER fixture_archive_failure BEFORE INSERT ON social_media_archive_jobs BEGIN SELECT RAISE(ABORT,'synthetic_queue_failure'); END");
  try{await assert.rejects(ingestSocialWebhook('whatsapp',raw,new Headers({'x-hub-signature-256':'sha256='+createHmac('sha256',f.config.secret).update(raw).digest('hex')}),f.config),/synthetic_queue_failure/);}finally{await database.query('DROP TRIGGER fixture_archive_failure');}
  assert.deepEqual(await count(),before);
});
test('concurrent workers claim only once; an expired lease is recovered after restart',async()=>{
  const f=await fixture();let calls=0;const fetcher=(async(...args:Parameters<typeof fetch>)=>{calls++;await new Promise(r=>setTimeout(r,10));return transport(...args);}) as typeof fetch;
  await Promise.all([runMediaArchiveJobs(f.org,1,{fetch:fetcher}),runMediaArchiveJobs(f.org,1,{fetch:fetcher})]);assert.equal(calls,2);
  const g=await fixture();await database.query("UPDATE social_media_archive_jobs SET status='working',attempts=1,lease_token='abandoned',lease_until=100 WHERE org_id=$1",[g.org]);
  assert.equal((await runMediaArchiveJobs(g.org,1,{fetch:transport,now:()=>200})).results[0].status,'archived');assert.equal((await job(g)).attempts,2);
});
test('provider outage backs off durably and recovers without a browser download',async()=>{
  const f=await fixture();let now=1000,calls=0;const offline=(async()=>{calls++;return new Response(null,{status:503});}) as typeof fetch;
  await runMediaArchiveJobs(f.org,1,{fetch:offline,now:()=>now});assert.equal((await job(f)).status,'retry');assert.equal((await job(f)).next_attempt_at,16000);
  assert.equal((await runMediaArchiveJobs(f.org,1,{fetch:offline,now:()=>now})).results.length,0);assert.equal(calls,1);
  now=16000;await runMediaArchiveJobs(f.org,1,{fetch:transport,now:()=>now});assert.equal((await job(f)).status,'archived');
});
test('hash, size and MIME mismatch never create an archive',async()=>{
  for(const invalid of [{sha256:'0'.repeat(64)},{file_size:file.length+1},{mime_type:'image/png'},{file_size:30*1024*1024}]){
    const f=await fixture(),fetcher=(async(input,init)=>String(input).startsWith('https://graph.facebook.com/')?Response.json({...info(),...invalid}):transport(input,init)) as typeof fetch;
    await runMediaArchiveJobs(f.org,1,{fetch:fetcher});assert.equal((await job(f)).status,'failed');assert.equal((await database.query('SELECT count(*) n FROM social_media_archive WHERE org_id=$1',[f.org])).rows[0].n,0);assert.equal(await(await getPrivateBucket()).get(f.org+'/'+f.id),null);
  }
});
test('expired provider data stops after bounded retries and authorized Admin may retry explicitly',async()=>{
  const f=await fixture();let now=1;for(let i=0;i<8;i++){await runMediaArchiveJobs(f.org,1,{fetch:(async()=>new Response(null,{status:404})) as typeof fetch,now:()=>now});now=(await job(f)).next_attempt_at||now;}
  assert.equal((await job(f)).status,'failed');assert.equal((await job(f)).attempts,8);
  assert.equal((await mediaArchiveStatus(f.staff)).jobs[0].error_code,'provider_or_storage_unavailable');
  await assert.rejects(retryMediaArchive({...f.staff,role:'Agent'},f.id),{status:403});await assert.rejects(mediaArchiveStatus({...f.staff,role:'Agent'}),{status:403});
  await retryMediaArchive(f.staff,f.id);assert.equal((await job(f)).status,'queued');await runMediaArchiveJobs(f.org,1,{fetch:transport});assert.equal((await job(f)).status,'archived');
});
test('current ownership, account and private scope are checked before and during archival',async()=>{
  const f=await fixture();process.env.SOCIAL_CHANNELS_OWNER='sale';await runMediaArchiveJobs(f.org,1,{fetch:fail});assert.equal((await job(f)).status,'blocked');
  process.env.SOCIAL_CHANNELS_OWNER='crm';await database.query('UPDATE social_media_archive_jobs SET next_attempt_at=0 WHERE org_id=$1',[f.org]);
  const fetcher=(async(input,init)=>{if(!String(input).startsWith('https://graph.facebook.com/'))process.env.WHATSAPP_PHONE_NUMBER_ID='9999999999';return transport(input,init);}) as typeof fetch;
  await runMediaArchiveJobs(f.org,1,{fetch:fetcher});assert.equal((await job(f)).status,'retry');assert.equal((await database.query('SELECT count(*) n FROM social_media_archive WHERE org_id=$1',[f.org])).rows[0].n,0);
  const g=await fixture();await database.query("UPDATE social_message_attachments SET metadata='{\"sourceOwnerOnly\":true}' WHERE org_id=$1",[g.org]);await runMediaArchiveJobs(g.org,1,{fetch:fail});assert.equal((await job(g)).status,'cancelled');
});
test('removal during fetch cancels job and leaves no downloadable object',async()=>{
  const f=await fixture(),fetcher=(async(input,init)=>{if(!String(input).startsWith('https://graph.facebook.com/'))await database.query("UPDATE social_message_attachments SET removed_at='2026-01-01',storage_state='removed' WHERE org_id=$1",[f.org]);return transport(input,init);}) as typeof fetch;
  await runMediaArchiveJobs(f.org,1,{fetch:fetcher});assert.equal((await job(f)).status,'cancelled');assert.equal(await(await getPrivateBucket()).get(f.org+'/'+f.id),null);await assert.rejects(downloadSocialAttachment(f.org,f.id,fail),{status:404});
});
test('owner-only and cross-organization Admin retries fail; import metadata cannot become native work',async()=>{
  const f=await fixture(),g=await fixture();await assert.rejects(retryMediaArchive(g.staff,f.id),{status:404});
  Object.assign(process.env,{SOCIAL_CHANNELS_ORG_ID:f.org});await database.query("UPDATE social_message_attachments SET metadata='{\"sourceSystem\":\"rrs-sale-office\"}' WHERE org_id=$1",[f.org]);
  await runMediaArchiveJobs(f.org,1,{fetch:fail});assert.equal((await job(f)).status,'cancelled');await assert.rejects(retryMediaArchive(f.staff,f.id),{status:404});
});
test('purpose-bound runner proof rejects missing, wrong target/body/key and expired requests; replay is harmless',async()=>{
  const secret='synthetic-archive-purpose-key-32characters',origin='https://crm.example.invalid',now=Date.now();
  const req=mediaArchiveRunnerRequest(origin,secret,now);assert.equal(req.headers.get('host'),new URL(origin).host);await verifyMediaArchiveRunner(req.clone(),origin,secret,now);await verifyMediaArchiveRunner(req.clone(),origin,secret,now);
  for(const bad of [new Request(req.url,{method:'POST',body:'{}'}),new Request(req.url+'?x=1',req.clone()),new Request(req.url,{method:'POST',body:'[]',headers:req.headers})])await assert.rejects(verifyMediaArchiveRunner(bad,origin,secret,now),{status:403});
  await assert.rejects(verifyMediaArchiveRunner(req.clone(),origin,secret+'changed',now),{status:403});await assert.rejects(verifyMediaArchiveRunner(req.clone(),origin,secret,now+60_001),{status:403});
});
test('deployment schedule follows explicit ownership gate and preserves unrelated configuration',()=>{
  assert.deepEqual(parseDeploymentConfig('{/* comment */"origin":"https://crm.example.invalid/a//b",// line\n"triggers":{"crons":[],},}'),{origin:'https://crm.example.invalid/a//b',triggers:{crons:[]}});
  const base={vars:{SOCIAL_MEDIA_ARCHIVE_ENABLED:'false',SOCIAL_CHANNELS_OWNER:'crm',SOCIAL_INBOUND_ENABLED:'true',SOCIAL_CHANNELS_ORG_ID:randomUUID()},triggers:{crons:[]},d1_databases:[{binding:'DB',database_id:'preserved'}]};
  assert.deepEqual(checkMediaArchiveSchedule(base),{enabled:false,cronConfigured:false});const enabled=configureMediaArchiveSchedule({...base,vars:{...base.vars,SOCIAL_MEDIA_ARCHIVE_ENABLED:'true'}});
  assert.deepEqual(enabled.triggers.crons,['* * * * *']);assert.deepEqual(enabled.d1_databases,base.d1_databases);assert.equal(checkMediaArchiveSchedule(enabled).enabled,true);
  assert.throws(()=>checkMediaArchiveSchedule({...base,triggers:{crons:['* * * * *']}}));assert.throws(()=>configureMediaArchiveSchedule({...enabled,vars:{...enabled.vars,SOCIAL_CHANNELS_OWNER:'sale'}}));
});
