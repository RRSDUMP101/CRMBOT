/** Synthetic SQLite, signed fixture webhooks and an injected transport only. Never contacts a provider or a real customer. */
import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import {before,after,test} from 'node:test';
import {database,closeDatabase} from '../src/lib/db';
import {hashToken,type Staff} from '../src/lib/auth';
import {dispatchSocialReply,ingestSocialWebhook,socialConfigFingerprint,type SocialChannelConfig} from '../src/lib/social-channels';
import {addBroadcastSuppression,controlBroadcast,createBroadcast,getBroadcast,importBroadcastCsv,launchBroadcast,listBroadcasts,normalizeRemote,parseCsv,previewBroadcast,runBroadcastBatch,testSendBroadcast,updateBroadcast,type BroadcastOptions} from '../src/lib/broadcast';
import {GET,POST} from '../src/app/api/admin/broadcasts/[[...path]]/route';

const origin='https://crm.example.invalid',TEST_WA='66810000000',TEST_LINE='U'+'b'.repeat(32),LINE_BOT='U'+'a'.repeat(32);
const saved={...process.env},originalFetch=globalThis.fetch;
before(async()=>{
  Object.assign(process.env,{DEMO_MODE:'true',RRS_WORKERS:'false',D1_LOCAL_DIR:`.data/broadcast-${randomUUID()}`,APP_ORIGIN:origin,SESSION_SECRET:'synthetic-broadcast-secret-at-least-32-characters',AI_PROVIDER:'disabled'});
  delete process.env.BROADCAST_ENABLED;
  globalThis.fetch=(async()=>{throw new Error('Unexpected real network call');}) as typeof fetch;
  await database.query('SELECT 1');
});
after(async()=>{await closeDatabase();globalThis.fetch=originalFetch;for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);});

type Member=Staff&{token:string};
type Fixture={org:string;admin:Member;agent:Member;wa:SocialChannelConfig;line:SocialChannelConfig};
async function fixture():Promise<Fixture>{
  const org=randomUUID();
  await database.query('INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)',[org,org,'Synthetic broadcast tenant']);
  const member=async(role:'Admin'|'Agent'):Promise<Member>=>{
    const id=randomUUID(),token=randomUUID(),email=`${id}@example.invalid`;
    await database.query('INSERT INTO members(id,org_id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5,$6)',[id,org,'Synthetic '+role,email,'not-a-real-hash',role]);
    await database.query("INSERT INTO staff_sessions(token_hash,org_id,member_id,expires_at) VALUES($1,$2,$3,'2099-01-01T00:00:00.000000Z')",[hashToken(token),org,id]);
    return {id,orgId:org,name:'Synthetic '+role,email,role,token};
  };
  return {org,admin:await member('Admin'),agent:await member('Agent'),
    wa:{provider:'whatsapp',orgId:org,accountId:'1234567890',wabaId:'9988776655',appId:'4567890',secret:'fixture-wa-secret',verifyToken:'fixture-verify',accessToken:'fixture-never-live-token',apiVersion:'v24.0',webhookUrl:origin+'/api/channels/whatsapp',testRecipient:TEST_WA,owner:'crm',inboundEnabled:true,liveEnabled:true,whatsappAccountMode:'business'},
    line:{provider:'line',orgId:org,accountId:LINE_BOT,secret:'fixture-line-secret',accessToken:'fixture-line-token',webhookUrl:origin+'/api/channels/line',testRecipient:TEST_LINE,owner:'crm',inboundEnabled:true,liveEnabled:true}};
}
async function ingest(config:SocialChannelConfig,payload:unknown){
  const bytes=new TextEncoder().encode(JSON.stringify(payload)),signature=createHmac('sha256',config.secret).update(bytes).digest(config.provider==='line'?'base64':'hex');
  return ingestSocialWebhook(config.provider,bytes,new Headers({[config.provider==='line'?'x-line-signature':'x-hub-signature-256']:config.provider==='line'?signature:'sha256='+signature}),config);
}
const waInbound=(config:SocialChannelConfig,remote:string,text='Synthetic inbound',ageMs=60_000)=>ingest(config,{object:'whatsapp_business_account',entry:[{id:config.wabaId,changes:[{field:'messages',value:{metadata:{phone_number_id:config.accountId},messages:[{id:'wamid.in.'+randomUUID(),from:remote,timestamp:String(Math.floor((Date.now()-ageMs)/1000)),type:'text',text:{body:text}}]}}]}]});
const lineEvent=(config:SocialChannelConfig,remote:string,type:'follow'|'unfollow'|'message')=>ingest(config,{destination:config.accountId,events:[{webhookEventId:'evt-'+randomUUID(),type,timestamp:Date.now()-1000,source:{type:'user',userId:remote},...(type==='message'?{message:{id:'mid-'+randomUUID(),type:'text',text:'Synthetic LINE'}}:{})}]});
const identity=async(config:SocialChannelConfig,remote:string)=>(await database.query('SELECT * FROM social_identities WHERE org_id=$1 AND provider=$2 AND account_id=$3 AND remote_id=$4',[config.orgId,config.provider,config.accountId,remote])).rows[0];
async function consent(config:SocialChannelConfig,remote:string){const i=await identity(config,remote);await database.query('UPDATE leads SET contact_consent_at=$3,contact_consent_version=$4 WHERE org_id=$1 AND id=$2',[config.orgId,i.lead_id,new Date().toISOString(),'synthetic-explicit-consent-v1']);}
async function enable(config:SocialChannelConfig,mode:'test'|'live'){
  await database.query('UPDATE social_channel_controls SET send_enabled=1,emergency_stop=0,send_mode=$4,test_recipient=$5,verified_at=$6,verification_fingerprint=$7,verification_expires_at=$8,epoch=epoch+1 WHERE org_id=$1 AND provider=$2 AND account_id=$3',
    [config.orgId,config.provider,config.accountId,mode,config.testRecipient,new Date().toISOString(),socialConfigFingerprint(config),new Date(Date.now()+86_400_000).toISOString()]);
}
type Sent={host:string;to:string;body:Record<string,any>;headers:Headers};
function provider(options:{fail?:Set<string>;template?:Record<string,unknown>;onSend?:(sent:Sent)=>Promise<void>}={}){
  const sent:Sent[]=[];let templateChecks=0;
  const transport=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=new URL(String(input));assert.equal(init?.redirect,'manual');assert.ok(['graph.facebook.com','api.line.me'].includes(url.hostname));
    if(url.pathname.endsWith('/message_templates')){templateChecks++;return Response.json({data:[options.template??{name:'promo_fixture',status:'APPROVED',language:'th',components:[{type:'BODY',text:'สวัสดี {{1}} โปรสังเคราะห์ {{2}}'},{type:'FOOTER',text:'RRS fixture'}]}]});}
    const body=JSON.parse(String(init?.body)),entry={host:url.hostname,to:String(body.to),body,headers:new Headers(init?.headers)};sent.push(entry);
    await options.onSend?.(entry);
    if(options.fail?.has(entry.to))throw new Error('synthetic network interruption');
    return url.hostname==='api.line.me'?Response.json({sentMessages:[{id:'line-out-'+randomUUID()}]}):Response.json({messages:[{id:'wamid.out.'+randomUUID()}]});
  }) as typeof fetch;
  return {sent,transport,templateChecks:()=>templateChecks};
}
const opts=(f:Fixture,p:{transport:typeof fetch}):BroadcastOptions=>({configs:{whatsapp:f.wa,line:f.line},fetch:p.transport});
const A='66811110001',B='66811110002',C='66811110003',D='66811110004',E='66811110005';
/** TEST and A are eligible for text; B lacks consent; C sent STOP; D is suppressed; E is outside 24 hours. */
async function waWorld(f:Fixture){
  for(const remote of [TEST_WA,A,B,C,D])await waInbound(f.wa,remote);
  await waInbound(f.wa,E,'Old synthetic inbound',3*86_400_000);
  for(const remote of [TEST_WA,A,C,D,E])await consent(f.wa,remote);
  await waInbound(f.wa,C,'STOP');
  await addBroadcastSuppression(f.admin,{provider:'whatsapp',remoteId:'+66 81-111-0004',reason:'Synthetic do-not-contact request',confirm:true});
}
const count=async(sql:string,params:unknown[])=>Number((await database.query(sql,params)).rows[0].n);
async function tested(f:Fixture,id:string,p:{transport:typeof fetch}){const result=await testSendBroadcast(f.admin,id,{requestId:randomUUID()},opts(f,p));assert.equal(result.passed,true,JSON.stringify(result));return result;}
async function launched(f:Fixture,p:{transport:typeof fetch},input:Record<string,unknown>={name:'Synthetic campaign',provider:'whatsapp',messageText:'Synthetic offer for consented customers'}){
  const created=await createBroadcast(f.admin,input,opts(f,p)),id=created.campaign.id;
  await tested(f,id,p);
  const preview=await previewBroadcast(f.admin,id,opts(f,p));
  await launchBroadcast(f.admin,id,{confirm:true,expectedVersion:preview.version,expectedRecipients:preview.eligible},opts(f,p));
  return {id,preview};
}

test('default off: sends, launches and runs are refused and the shared guard blocks queued broadcast intents',async()=>{
  const f=await fixture(),p=provider();await waWorld(f);delete process.env.BROADCAST_ENABLED;
  const {campaign}=await createBroadcast(f.admin,{name:'Default off',provider:'whatsapp',messageText:'Synthetic offer'},opts(f,p));
  assert.equal((await previewBroadcast(f.admin,campaign.id,opts(f,p))).eligible,2,'drafts and dry-run previews remain available');
  await assert.rejects(testSendBroadcast(f.admin,campaign.id,{requestId:randomUUID()},opts(f,p)),{status:503});
  await assert.rejects(launchBroadcast(f.admin,campaign.id,{confirm:true,expectedVersion:1,expectedRecipients:2},opts(f,p)),{status:503});
  await assert.rejects(runBroadcastBatch(f.admin,campaign.id,{},opts(f,p)),{status:503});
  assert.equal((await listBroadcasts(f.admin,opts(f,p))).gates.enabled,false);
  process.env.BROADCAST_ENABLED='true';
  // Flag alone is not enough: the channel's own durable send control is still stopped.
  await assert.rejects(testSendBroadcast(f.admin,campaign.id,{requestId:randomUUID()},opts(f,p)),{status:503});
  assert.equal(p.sent.length,0);assert.equal(await count('SELECT COUNT(*) AS n FROM social_outbound_commands WHERE org_id=$1',[f.org]),0);

  await enable(f.wa,'live');
  const others=[...Array(3)].map((_,i)=>'6681222000'+i);
  for(const remote of others){await waInbound(f.wa,remote);await consent(f.wa,remote);}
  // The flag is switched off during the first provider call: the next claim must be refused.
  const flip=provider({onSend:async()=>{if(flip.sent.length===2)process.env.BROADCAST_ENABLED='false';}});
  const {id,preview}=await launched(f,flip);assert.equal(preview.eligible,5);
  const run=await runBroadcastBatch(f.admin,id,{limit:3},opts(f,flip));
  assert.equal(run.batch.outcome.submitted,1);assert.equal(run.batch.outcome.blocked,1);assert.equal(flip.sent.length,2,'one test send and one campaign send');
  const queued=(await database.query("SELECT r.outbound_command_id FROM broadcast_recipients r JOIN social_outbound_commands o ON o.id=r.outbound_command_id WHERE r.org_id=$1 AND r.campaign_id=$2 AND o.status='queued'",[f.org,id])).rows;
  assert.ok(queued.length>=1);
  await assert.rejects(dispatchSocialReply(f.org,queued[0].outbound_command_id,{config:f.wa,fetch:flip.transport}),{status:503});
  assert.equal(flip.sent.length,2);
  process.env.BROADCAST_ENABLED='true';
  const recovered=await runBroadcastBatch(f.admin,id,{limit:10},opts(f,flip));
  assert.ok(recovered.batch.recovered>=1);assert.equal(recovered.detail.campaign.status,'completed');
  assert.equal(flip.sent.length,6,'test send plus each of five recipients exactly once');
  assert.equal(new Set(flip.sent.slice(1).map(s=>s.to)).size,5);
  delete process.env.BROADCAST_ENABLED;
});

test('eligibility excludes missing consent, opt-outs, suppressions, provider rules and LINE identities without a follow',async()=>{
  const f=await fixture(),p=provider();await waWorld(f);
  const text=await createBroadcast(f.admin,{name:'Text',provider:'whatsapp',messageText:'Synthetic text'},opts(f,p));
  const preview=await previewBroadcast(f.admin,text.campaign.id,opts(f,p));
  assert.equal(preview.matched,6);assert.equal(preview.eligible,2);
  assert.deepEqual(preview.excluded,{no_consent:1,opted_out:1,suppressed:1,outside_24h_window:1});
  assert.equal(preview.dryRun,true);assert.ok(preview.samples.every(s=>/^••••\d{4}$/.test(s.recipient)));
  for(const remote of [TEST_WA,A,B,C,D,E])assert.equal(JSON.stringify(preview).includes(remote),false,'samples are masked');
  assert.equal(await count("SELECT COUNT(*) AS n FROM broadcast_suppressions WHERE org_id=$1 AND remote_id=$2 AND reason='opt_out_keyword'",[f.org,C]),1,'STOP durably suppresses broadcasts');
  // Approved templates may reach consented customers outside the 24 hour window.
  const template=await createBroadcast(f.admin,{name:'Template',provider:'whatsapp',messageKind:'template',template:{name:'promo_fixture',language:'th',params:['คุณลูกค้า','ส่วนลด']}},opts(f,p));
  const t=await previewBroadcast(f.admin,template.campaign.id,opts(f,p));assert.equal(t.eligible,3);assert.equal(t.excluded.outside_24h_window,undefined);
  // Segments filter on lead tags and stage without widening eligibility.
  const lead=(await identity(f.wa,A)).lead_id;await database.query(`UPDATE leads SET tags='["vip"]',stage='Qualified' WHERE id=$1`,[lead]);
  const tagged=await createBroadcast(f.admin,{name:'Tagged',provider:'whatsapp',messageText:'VIP',segment:{tags:['vip'],stages:['Qualified'],markets:['export']}},opts(f,p));
  const tp=await previewBroadcast(f.admin,tagged.campaign.id,opts(f,p));assert.equal(tp.matched,1);assert.equal(tp.eligible,1);

  const followed='U'+'1'.repeat(32),messaged='U'+'2'.repeat(32),blocked='U'+'3'.repeat(32);
  await lineEvent(f.line,followed,'follow');await lineEvent(f.line,messaged,'message');await lineEvent(f.line,blocked,'follow');await lineEvent(f.line,blocked,'unfollow');
  const line=await createBroadcast(f.admin,{name:'LINE',provider:'line',messageText:'Synthetic LINE news'},opts(f,p));
  const lp=await previewBroadcast(f.admin,line.campaign.id,opts(f,p));
  assert.equal(lp.matched,3);assert.equal(lp.eligible,1);assert.deepEqual(lp.excluded,{not_followed:1,opted_out:1});
  await assert.rejects(createBroadcast(f.admin,{name:'LINE template',provider:'line',messageKind:'template'},opts(f,p)),{status:400});

  // LINE end to end: test recipient, launch and push only to the followed identity.
  process.env.BROADCAST_ENABLED='true';await lineEvent(f.line,TEST_LINE,'follow');await enable(f.line,'live');
  const {id}=await launched(f,p,{name:'LINE live',provider:'line',messageText:'Synthetic LINE news'});
  await runBroadcastBatch(f.admin,id,{limit:10},opts(f,p));
  const pushes=p.sent.filter(s=>s.host==='api.line.me');
  assert.deepEqual(pushes.map(s=>s.to).sort(),[TEST_LINE,TEST_LINE,followed].sort());
  assert.ok(pushes.every(s=>s.headers.get('x-line-retry-key')),'LINE retry key makes the provider call idempotent');
  delete process.env.BROADCAST_ENABLED;
});

test('CSV import is a dry run: rows never create identities, consent or recipients',async()=>{
  const f=await fixture(),p=provider();await waWorld(f);
  const {campaign}=await createBroadcast(f.admin,{name:'Imported',provider:'whatsapp',messageText:'Synthetic import'},opts(f,p));
  const before={identities:await count('SELECT COUNT(*) AS n FROM social_identities WHERE org_id=$1',[f.org]),leads:await count('SELECT COUNT(*) AS n FROM leads WHERE org_id=$1',[f.org]),consented:await count('SELECT COUNT(*) AS n FROM leads WHERE org_id=$1 AND contact_consent_at IS NOT NULL',[f.org])};
  const csv='﻿name,phone\r\n"Synthetic, A",+66 81-111-0001\r\nB,66811110002\r\nDup,+66811110001\r\nLocal,0811110009\r\nUnknown,66819999999\r\nBad,abc\r\n\r\n';
  const result=await importBroadcastCsv(f.admin,campaign.id,{csv,column:'phone'});
  assert.equal(result.dryRun,true);assert.equal(result.recipientsCreated,0);
  assert.equal(result.totalRows,6);assert.equal(result.valid,3);assert.equal(result.duplicates,1);assert.equal(result.invalid,2);
  assert.deepEqual(result.invalidReasons,{phone_requires_country_code:1,invalid_phone:1});
  assert.equal(result.matched,2);assert.equal(result.matchedEligible,1);assert.equal(result.unmatched,1);assert.deepEqual(result.excluded,{no_consent:1});
  assert.equal(await count('SELECT COUNT(*) AS n FROM broadcast_recipients WHERE org_id=$1',[f.org]),0);
  assert.equal(await count('SELECT COUNT(*) AS n FROM social_identities WHERE org_id=$1',[f.org]),before.identities);
  assert.equal(await count('SELECT COUNT(*) AS n FROM leads WHERE org_id=$1',[f.org]),before.leads);
  assert.equal(await count('SELECT COUNT(*) AS n FROM leads WHERE org_id=$1 AND contact_consent_at IS NOT NULL',[f.org]),before.consented);
  const stored=JSON.stringify((await database.query('SELECT * FROM broadcast_import_rows WHERE org_id=$1',[f.org])).rows);
  for(const raw of ['66811110001','66811110002','66819999999','0811110009'])assert.equal(stored.includes(raw),false,'raw imported values are not stored');
  // Using the import as a filter narrows the audience to existing identities only.
  const updated=await updateBroadcast(f.admin,campaign.id,{expectedVersion:1,segment:{importId:result.importId}},opts(f,p));
  const preview=await previewBroadcast(f.admin,campaign.id,opts(f,p));
  assert.equal(updated.campaign.version,2);assert.equal(preview.matched,2);assert.equal(preview.eligible,1);
  assert.throws(()=>parseCsv('a,"unterminated'),{status:400});
  assert.deepEqual(parseCsv('x,"a ""b"", c"\n'),[['x','a "b", c']]);
  assert.deepEqual(normalizeRemote('whatsapp','0066 81 111 0001'),{value:'66811110001'});
  assert.deepEqual(normalizeRemote('line','not-a-line-id'),{error:'invalid_line_id'});
});

test('test send reaches only the configured test recipient through the shared outbound guard',async()=>{
  const f=await fixture(),p=provider();await waWorld(f);process.env.BROADCAST_ENABLED='true';
  const {campaign}=await createBroadcast(f.admin,{name:'Test only',provider:'whatsapp',messageText:'Synthetic test text'},opts(f,p));
  await enable(f.wa,'test');
  const requestId=randomUUID(),first=await testSendBroadcast(f.admin,campaign.id,{requestId},opts(f,p));
  assert.equal(first.status,'submitted');assert.equal(first.recipient,'••••0000');
  assert.deepEqual(p.sent.map(s=>s.to),[TEST_WA]);assert.equal(p.sent[0].body.text.body,'Synthetic test text');
  assert.equal((await testSendBroadcast(f.admin,campaign.id,{requestId},opts(f,p))).status,'submitted');assert.equal(p.sent.length,1,'same request is idempotent');
  // No configured test recipient: refused before anything is queued.
  await assert.rejects(testSendBroadcast(f.admin,campaign.id,{requestId:randomUUID()},{...opts(f,p),configs:{whatsapp:{...f.wa,testRecipient:''}}}),{status:409});
  // Re-pointing the configured test recipient at a customer invalidates channel verification: nothing is queued or sent.
  await assert.rejects(testSendBroadcast(f.admin,campaign.id,{requestId:randomUUID()},{...opts(f,p),configs:{whatsapp:{...f.wa,testRecipient:A}}}),{status:503});
  assert.equal(p.sent.length,1);assert.equal(await count('SELECT COUNT(*) AS n FROM social_outbound_commands WHERE org_id=$1 AND remote_id=$2',[f.org,A]),0);
  assert.equal((await getBroadcast(f.admin,campaign.id,opts(f,p))).testPassedForVersion,true);
  // Simulate a still-queued test intent: the shared guard pins it to the verified recipient and current version.
  const testCommand=(await database.query('SELECT outbound_command_id FROM broadcast_test_sends WHERE org_id=$1',[f.org])).rows[0].outbound_command_id;
  await database.query("UPDATE social_outbound_commands SET status='queued',attempt_id=NULL WHERE id=$1",[testCommand]);
  await assert.rejects(dispatchSocialReply(f.org,testCommand,{config:{...f.wa,testRecipient:'66819998887'},fetch:p.transport}),{status:503});
  assert.equal(p.sent.length,1);
  assert.equal(await count('SELECT COUNT(*) AS n FROM broadcast_recipients WHERE org_id=$1',[f.org]),0,'test sends never create campaign recipients');
  // A queued test intent is stale once the draft changes, and test evidence no longer applies.
  await updateBroadcast(f.admin,campaign.id,{expectedVersion:1,messageText:'Edited'},opts(f,p));
  await assert.rejects(dispatchSocialReply(f.org,testCommand,{config:f.wa,fetch:p.transport}),/stale/);
  assert.equal(p.sent.length,1);
  assert.equal((await getBroadcast(f.admin,campaign.id,opts(f,p))).testPassedForVersion,false);
  delete process.env.BROADCAST_ENABLED;
});

test('launch requires Admin, explicit confirmation, exact previewed count/version, live gates and a passed test',async()=>{
  const f=await fixture(),p=provider();await waWorld(f);process.env.BROADCAST_ENABLED='true';
  const {campaign}=await createBroadcast(f.admin,{name:'Confirm',provider:'whatsapp',messageText:'Synthetic confirm'},opts(f,p));
  await enable(f.wa,'live');
  const preview=await previewBroadcast(f.admin,campaign.id,opts(f,p));assert.equal(preview.eligible,2);
  const good={confirm:true,expectedVersion:preview.version,expectedRecipients:preview.eligible};
  await assert.rejects(launchBroadcast(f.admin,campaign.id,good,opts(f,p)),/ทดสอบส่ง/,'a passed test send is required');
  await tested(f,campaign.id,p);
  await assert.rejects(launchBroadcast(f.agent,campaign.id,good,opts(f,p)),{status:403});
  await assert.rejects(launchBroadcast(f.admin,campaign.id,{...good,confirm:undefined},opts(f,p)),{status:422});
  await assert.rejects(launchBroadcast(f.admin,campaign.id,{...good,confirm:'true'},opts(f,p)),{status:422});
  await assert.rejects(launchBroadcast(f.admin,campaign.id,{...good,expectedRecipients:3},opts(f,p)),(error:any)=>error.status===409&&/ 2 /.test(error.message));
  await assert.rejects(launchBroadcast(f.admin,campaign.id,{...good,expectedVersion:preview.version+1},opts(f,p)),{status:409});
  await enable(f.wa,'test');
  await assert.rejects(launchBroadcast(f.admin,campaign.id,good,opts(f,p)),{status:503},'restricted test mode is not a live gate');
  await enable(f.wa,'live');await database.query('UPDATE social_channel_controls SET emergency_stop=1 WHERE org_id=$1',[f.org]);
  await assert.rejects(launchBroadcast(f.admin,campaign.id,good,opts(f,p)),{status:503},'emergency stop');
  await enable(f.wa,'live');
  assert.equal(await count('SELECT COUNT(*) AS n FROM broadcast_recipients WHERE org_id=$1',[f.org]),0);
  const result=await launchBroadcast(f.admin,campaign.id,good,opts(f,p));
  assert.equal(result.campaign.status,'sending');assert.equal(result.campaign.launchedCount,2);assert.equal(result.stats.recipients.pending,2);
  assert.equal(p.sent.length,1,'launch itself sends nothing; only the runner dispatches bounded batches');
  await assert.rejects(launchBroadcast(f.admin,campaign.id,{...good,expectedVersion:result.campaign.version},opts(f,p)),{status:409},'cannot launch twice');
  const audit=(await database.query("SELECT metadata FROM audit_events WHERE org_id=$1 AND action='broadcast.launched'",[f.org])).rows[0];
  assert.equal(audit.metadata.recipients,2);assert.equal(JSON.stringify(audit.metadata).includes(A),false);
  // An edited draft needs a fresh test of that exact version.
  const second=await createBroadcast(f.admin,{name:'Edited',provider:'whatsapp',messageText:'First'},opts(f,p));
  await tested(f,second.campaign.id,p);
  const edited=await updateBroadcast(f.admin,second.campaign.id,{expectedVersion:1,messageText:'Second'},opts(f,p));
  await assert.rejects(launchBroadcast(f.admin,second.campaign.id,{confirm:true,expectedVersion:edited.campaign.version,expectedRecipients:2},opts(f,p)),/ทดสอบส่ง/);
  delete process.env.BROADCAST_ENABLED;
});

test('recipient enqueue is idempotent: reruns and concurrent runners never duplicate, unknown is never retried',async()=>{
  const f=await fixture();await waWorld(f);process.env.BROADCAST_ENABLED='true';await enable(f.wa,'live');
  const extra=['66813330001','66813330002','66813330003'];
  for(const remote of extra){await waInbound(f.wa,remote);await consent(f.wa,remote);}
  const p=provider({fail:new Set([extra[2]])});
  const {id,preview}=await launched(f,p);assert.equal(preview.eligible,5);
  const runs=await Promise.allSettled([runBroadcastBatch(f.admin,id,{limit:2},opts(f,p)),runBroadcastBatch(f.admin,id,{limit:2},opts(f,p))]);
  assert.ok(runs.some(r=>r.status==='fulfilled'));
  for(const r of runs)if(r.status==='rejected')assert.equal((r.reason as {status:number}).status,409);
  for(let i=0;i<5&&(await getBroadcast(f.admin,id,opts(f,p))).campaign.status==='sending';i++)await runBroadcastBatch(f.admin,id,{limit:2},opts(f,p));
  const detail=await getBroadcast(f.admin,id,opts(f,p));
  assert.equal(detail.campaign.status,'completed');
  assert.deepEqual(detail.stats.recipients,{submitted:4,unknown:1});
  const campaignSends=p.sent.slice(1);
  assert.equal(campaignSends.length,5);assert.equal(new Set(campaignSends.map(s=>s.to)).size,5);
  assert.equal(await count('SELECT COUNT(*) AS n FROM broadcast_recipients WHERE org_id=$1 AND campaign_id=$2',[f.org,id]),5);
  assert.equal(await count('SELECT COUNT(*) AS n FROM social_outbound_commands o JOIN broadcast_recipients r ON r.outbound_command_id=o.id WHERE r.campaign_id=$1',[id]),5);
  assert.equal(await count("SELECT COUNT(*) AS n FROM broadcast_recipients WHERE campaign_id=$1 AND idempotency_key=campaign_id||':'||identity_id",[id]),5);
  await assert.rejects(runBroadcastBatch(f.admin,id,{limit:10},opts(f,p)),{status:409});
  const unknown=(await database.query("SELECT outbound_command_id FROM broadcast_recipients WHERE campaign_id=$1 AND status='unknown'",[id])).rows[0].outbound_command_id;
  assert.equal((await dispatchSocialReply(f.org,unknown,{config:f.wa,fetch:p.transport})).status,'unknown');
  assert.equal(p.sent.length,6,'an unknown provider outcome is never sent again');
  // Recipient messages are visible in the CRM conversation with broadcast provenance.
  const provenance=(await database.query("SELECT metadata FROM social_message_provenance WHERE org_id=$1 AND json_extract(metadata,'$.approval')='broadcast'",[f.org])).rows;
  assert.equal(provenance.length,5);assert.ok(provenance.every(row=>row.metadata.campaignId===id));
  delete process.env.BROADCAST_ENABLED;
});

test('an interrupted send with an expired lease is settled as unknown by the runner and never resent',async()=>{
  const f=await fixture();await waWorld(f);process.env.BROADCAST_ENABLED='true';await enable(f.wa,'live');
  const p=provider({onSend:async()=>{if(p.sent.length===2)await database.query('UPDATE social_channel_controls SET emergency_stop=1 WHERE org_id=$1',[f.org]);}});
  const {id}=await launched(f,p);
  const first=await runBroadcastBatch(f.admin,id,{limit:2},opts(f,p));assert.equal(first.batch.outcome.blocked,1);
  // Simulate a worker that claimed the intent and stopped before recording any provider outcome.
  const stuck=(await database.query("SELECT r.outbound_command_id AS id,r.remote_id FROM broadcast_recipients r JOIN social_outbound_commands o ON o.id=r.outbound_command_id WHERE r.campaign_id=$1 AND o.status='queued'",[id])).rows[0];
  await database.query("UPDATE social_outbound_commands SET status='sending',attempt_id=$2,lease_expires_at=$3 WHERE id=$1",[stuck.id,randomUUID(),new Date(Date.now()-60_000).toISOString()]);
  await enable(f.wa,'live');
  const done=await runBroadcastBatch(f.admin,id,{limit:5},opts(f,p));
  assert.equal(done.detail.campaign.status,'completed');assert.equal(done.detail.stats.recipients.unknown,1);
  assert.equal((await database.query('SELECT status,error_code FROM social_outbound_commands WHERE id=$1',[stuck.id])).rows[0].error_code,'dispatch_lease_expired');
  assert.equal(p.sent.slice(1).filter(sent=>sent.to===stuck.remote_id).length,0,'never sent or resent after an ambiguous interruption');assert.equal(p.sent.length,2);
  delete process.env.BROADCAST_ENABLED;
});

test('pause stops further enqueue; replies and opt-outs after launch suppress later sends; resume needs confirmation',async()=>{
  const f=await fixture();await waWorld(f);process.env.BROADCAST_ENABLED='true';await enable(f.wa,'live');
  const extra=['66814440001','66814440002','66814440003','66814440004'];
  for(const remote of extra){await waInbound(f.wa,remote);await consent(f.wa,remote);}
  // The emergency stop is pressed during the first campaign send: the second intent stays queued, unclaimed.
  const p=provider({onSend:async sent=>{if(p.sent.length===2)await database.query('UPDATE social_channel_controls SET emergency_stop=1 WHERE org_id=$1 AND provider=$2',[f.org,'whatsapp']);void sent;}});
  const {id}=await launched(f,p);
  const first=await runBroadcastBatch(f.admin,id,{limit:2},opts(f,p));
  assert.equal(first.batch.outcome.submitted,1);assert.equal(first.batch.outcome.blocked,1);assert.equal(p.sent.length,2);
  const paused=await controlBroadcast(f.admin,id,'pause',{expectedVersion:first.detail.campaign.version},opts(f,p));
  assert.equal(paused.campaign.status,'paused');assert.equal(paused.stats.recipients.queued,undefined,'never-claimed intents return to pending');
  assert.equal(await count("SELECT COUNT(*) AS n FROM social_outbound_commands WHERE org_id=$1 AND error_code='broadcast_paused' AND status='cancelled'",[f.org]),1);
  await enable(f.wa,'live');
  await assert.rejects(runBroadcastBatch(f.admin,id,{limit:5},opts(f,p)),{status:409});assert.equal(p.sent.length,2,'paused campaigns enqueue nothing');
  const pending=(await database.query("SELECT remote_id FROM broadcast_recipients WHERE campaign_id=$1 AND status='pending' ORDER BY created_at,id",[id])).rows.map(row=>row.remote_id as string);
  assert.equal(pending.length,5);
  const [replier,stopper]=pending.filter(remote=>remote!==TEST_WA);
  await waInbound(f.wa,replier,'Synthetic reply after launch',-2000);await waInbound(f.wa,stopper,'STOP',-2000);
  await assert.rejects(controlBroadcast(f.admin,id,'resume',{expectedVersion:paused.campaign.version},opts(f,p)),{status:422});
  const resumed=await controlBroadcast(f.admin,id,'resume',{expectedVersion:paused.campaign.version,confirm:true},opts(f,p));
  assert.equal(resumed.campaign.status,'sending');
  const done=await runBroadcastBatch(f.admin,id,{limit:10},opts(f,p));
  assert.equal(done.detail.campaign.status,'completed');
  assert.equal(done.detail.stats.skipReasons.replied,1);assert.equal(done.detail.stats.skipReasons.opted_out,1);
  const sentTo=p.sent.slice(1).map(s=>s.to);
  assert.equal(sentTo.includes(replier),false);assert.equal(sentTo.includes(stopper),false);
  assert.equal(new Set(sentTo).size,sentTo.length,'no recipient received a duplicate after pause/resume');
  for(const action of ['broadcast.launched','broadcast.paused','broadcast.resumed','broadcast.batch','broadcast.completed'])assert.ok(await count('SELECT COUNT(*) AS n FROM audit_events WHERE org_id=$1 AND action=$2',[f.org,action]),action);
  // Cancel is terminal and cannot be resumed.
  const other=await launched(f,p,{name:'Cancel me',provider:'whatsapp',messageText:'Synthetic offer for consented customers'});
  const current=await getBroadcast(f.admin,other.id,opts(f,p));
  const cancelled=await controlBroadcast(f.admin,other.id,'cancel',{expectedVersion:current.campaign.version,confirm:true},opts(f,p));
  assert.equal(cancelled.campaign.status,'cancelled');assert.equal(cancelled.stats.recipients.pending,undefined);
  await assert.rejects(controlBroadcast(f.admin,other.id,'resume',{expectedVersion:cancelled.campaign.version,confirm:true},opts(f,p)),{status:409});
  delete process.env.BROADCAST_ENABLED;
});

test('template campaigns verify the approved template and send its exact parameters',async()=>{
  const f=await fixture();await waWorld(f);process.env.BROADCAST_ENABLED='true';await enable(f.wa,'live');
  const rejected=provider({template:{name:'promo_fixture',status:'REJECTED',language:'th',components:[{type:'BODY',text:'x {{1}} {{2}}'}]}});
  const draft=await createBroadcast(f.admin,{name:'Template',provider:'whatsapp',messageKind:'template',template:{name:'promo_fixture',language:'th',params:['คุณลูกค้า','ส่วนลด']}},opts(f,rejected));
  await assert.rejects(testSendBroadcast(f.admin,draft.campaign.id,{requestId:randomUUID()},opts(f,rejected)),{status:409});
  assert.equal(rejected.sent.length,0);
  const p=provider(),{id,preview}=await launched(f,p,{name:'Template ok',provider:'whatsapp',messageKind:'template',template:{name:'promo_fixture',language:'th',params:['คุณลูกค้า','ส่วนลด']}});
  assert.equal(preview.eligible,3,'E is outside 24 hours but reachable by an approved template');
  const done=await runBroadcastBatch(f.admin,id,{limit:10},opts(f,p));
  assert.equal(done.detail.campaign.templateBody,'สวัสดี คุณลูกค้า โปรสังเคราะห์ ส่วนลด');
  assert.ok(p.sent.length===4&&p.sent.map(s=>s.to).includes(E));
  for(const sent of p.sent){assert.equal(sent.body.type,'template');assert.deepEqual(sent.body.template,{name:'promo_fixture',language:{code:'th'},components:[{type:'body',parameters:[{type:'text',text:'คุณลูกค้า'},{type:'text',text:'ส่วนลด'}]}]});}
  assert.ok(p.templateChecks()>=3,'template re-verified for test, launch and run');
  delete process.env.BROADCAST_ENABLED;
});

test('organization isolation: campaigns, identities and controls never cross tenants',async()=>{
  const f=await fixture(),g=await fixture(),p=provider();await waWorld(f);process.env.BROADCAST_ENABLED='true';
  // Same account and remote IDs in another tenant never join this tenant's audience.
  for(const remote of [A,D,'66815550001']){await waInbound(g.wa,remote);await consent(g.wa,remote);}
  const {campaign}=await createBroadcast(f.admin,{name:'Tenant A',provider:'whatsapp',messageText:'Synthetic tenant'},opts(f,p));
  assert.equal((await previewBroadcast(f.admin,campaign.id,opts(f,p))).matched,6);
  const foreign={...opts(g,p)};
  await assert.rejects(getBroadcast(g.admin,campaign.id,foreign),{status:404});
  await assert.rejects(previewBroadcast(g.admin,campaign.id,foreign),{status:404});
  await assert.rejects(updateBroadcast(g.admin,campaign.id,{expectedVersion:1,name:'x'},foreign),{status:404});
  await assert.rejects(importBroadcastCsv(g.admin,campaign.id,{csv:'phone\n66811110001\n'}),{status:404});
  await assert.rejects(testSendBroadcast(g.admin,campaign.id,{requestId:randomUUID()},foreign),{status:404});
  await assert.rejects(launchBroadcast(g.admin,campaign.id,{confirm:true,expectedVersion:1,expectedRecipients:2},foreign),{status:404});
  await assert.rejects(controlBroadcast(g.admin,campaign.id,'cancel',{expectedVersion:1,confirm:true},foreign),{status:404});
  await assert.rejects(runBroadcastBatch(g.admin,campaign.id,{},foreign),{status:404});
  assert.equal((await listBroadcasts(g.admin,foreign)).campaigns.length,0);
  // A channel configured for another organization cannot be used to create a campaign.
  await assert.rejects(createBroadcast(g.admin,{name:'Wrong scope',provider:'whatsapp',messageText:'x'},opts(f,p)),{status:409});
  const gp=await createBroadcast(g.admin,{name:'Tenant B',provider:'whatsapp',messageText:'Synthetic tenant'},foreign);
  const gPreview=await previewBroadcast(g.admin,gp.campaign.id,foreign);assert.equal(gPreview.matched,3);assert.equal(gPreview.eligible,3,'suppressions and opt-outs are tenant scoped');
  assert.equal(p.sent.length,0);
  delete process.env.BROADCAST_ENABLED;
});

test('Agents can read the list but cannot mutate; the route enforces HTTPS, session and same origin',async()=>{
  const f=await fixture(),p=provider();await waWorld(f);
  const {campaign}=await createBroadcast(f.admin,{name:'Read only',provider:'whatsapp',messageText:'Synthetic'},opts(f,p));
  const id=campaign.id,o=opts(f,p);
  const listed=await listBroadcasts(f.agent,o);assert.equal(listed.canManage,false);assert.equal(listed.campaigns[0].id,id);
  const detail=await getBroadcast(f.agent,id,o);assert.equal(detail.canManage,false);assert.deepEqual(detail.testSends,[]);
  for(const attempt of [
    ()=>createBroadcast(f.agent,{name:'x',provider:'whatsapp',messageText:'x'},o),()=>updateBroadcast(f.agent,id,{expectedVersion:1,name:'x'},o),
    ()=>previewBroadcast(f.agent,id,o),()=>importBroadcastCsv(f.agent,id,{csv:'phone\n66811110001\n'}),()=>testSendBroadcast(f.agent,id,{requestId:randomUUID()},o),
    ()=>launchBroadcast(f.agent,id,{confirm:true,expectedVersion:1,expectedRecipients:2},o),()=>controlBroadcast(f.agent,id,'cancel',{expectedVersion:1,confirm:true},o),
    ()=>runBroadcastBatch(f.agent,id,{},o),()=>addBroadcastSuppression(f.agent,{provider:'whatsapp',remoteId:A,reason:'Synthetic',confirm:true}),
  ])await assert.rejects(attempt(),{status:403});

  const call=(method:'GET'|'POST',path:string[],token:string,body?:unknown,options:{origin?:string;base?:string}={})=>{
    const url=(options.base||origin)+'/api/admin/broadcasts'+(path.length?'/'+path.join('/'):'');
    const request=new Request(url,{method,headers:{cookie:`rrs_staff=${token}`,origin:options.origin||origin,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return (method==='GET'?GET:POST)(request,{params:Promise.resolve({path:path.length?path:undefined})});
  };
  const list=await call('GET',[],f.agent.token);assert.equal(list.status,200);assert.match(list.headers.get('cache-control')!,/no-store/);
  assert.equal((await call('GET',[id],f.agent.token)).status,200);
  assert.equal((await call('GET',['suppressions'],f.agent.token)).status,403);
  assert.equal((await call('POST',[],f.agent.token,{name:'x',provider:'whatsapp'})).status,403);
  assert.equal((await call('POST',[id,'launch'],f.agent.token,{confirm:true,expectedVersion:1,expectedRecipients:2})).status,403);
  assert.equal((await call('POST',[id,'preview'],f.agent.token,{})).status,403);
  assert.equal((await call('POST',[id,'preview'],f.admin.token,{},{origin:'https://foreign.example.invalid'})).status,403);
  assert.equal((await call('GET',[],f.admin.token,undefined,{base:'http://crm.example.invalid'})).status,400);
  assert.equal((await call('GET',[],'')).status,401);
  assert.equal((await call('POST',[id,'unknown'],f.admin.token,{})).status,404);
  const preview=await call('POST',[id,'preview'],f.admin.token,{});assert.equal(preview.status,200);assert.equal((await preview.json()).eligible,2);
  const prior={SOCIAL_CHANNELS_ORG_ID:process.env.SOCIAL_CHANNELS_ORG_ID,WHATSAPP_PHONE_NUMBER_ID:process.env.WHATSAPP_PHONE_NUMBER_ID};
  try{
    process.env.SOCIAL_CHANNELS_ORG_ID=f.org;process.env.WHATSAPP_PHONE_NUMBER_ID=f.wa.accountId;
    const created=await call('POST',[],f.admin.token,{name:'Route draft',provider:'whatsapp',messageText:'Synthetic'});assert.equal(created.status,201);
    const body=await created.json();assert.equal(body.campaign.status,'draft');
    // Route sends stay closed by default even for an Admin.
    assert.equal((await call('POST',[body.campaign.id,'test-send'],f.admin.token,{requestId:randomUUID()})).status,503);
  }finally{for(const [key,value] of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
