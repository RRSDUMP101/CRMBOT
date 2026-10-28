import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {before,after,test} from 'node:test';
import {database,closeDatabase} from '../src/lib/db';
import {applyLegacyPlan,canonicalLegacyTimestamp,handleLegacyImport,legacyId,planLegacyImport,type LegacySnapshot} from '../src/lib/legacy-chat-import';
import {readBridgeEvents} from '../src/lib/chat-bridge';
import {inbox,markConversationRead} from '../src/lib/helpdesk';

const org=randomUUID(),other=randomUUID(),time='2025-01-02T03:04:05.123456Z';
const base=(id:string,kind:string,values:Record<string,unknown>={})=>({id,kind,created:time,updated:time,...values});
const domestic=():LegacySnapshot=>({version:1,sourceSystem:'rrs-sale-office',workspace:'domestic',snapshotId:'domestic-snapshot-fixture',revision:17,records:[
  base('company-1','company',{name:'Synthetic Company'}),
  base('contact-1','contact',{companyId:'company-1',name:'Synthetic Customer',whatsapp:'+66800000001',email:'fixture@example.invalid',optOut:true}),
  base('deal-1','deal',{companyId:'company-1',contactId:'contact-1',stage:2}),
  base('channel-1','domChannel',{provider:'line',accountId:'bot-fixture',name:'Synthetic LINE'}),
  base('thread-1','domThread',{customerId:'contact-1',linkedDeal:'deal-1',channelId:'channel-1',remoteId:'U-fixture',optOut:true}),
  base('incoming-1','domMessage',{threadId:'thread-1',author:'customer',text:'Historical hello',occurredAt:time,providerId:'100001',source:'line',status:'received',attachments:['/api/domestic/provider-media?messageId=100001']}),
  base('outgoing-unknown','domMessage',{threadId:'thread-1',author:'employee',text:'Uncertain delivery',occurredAt:time,providerId:'',source:'line',status:'unknown',attachments:[]}),
  base('cancelled-1','domMessage',{threadId:'thread-1',author:'customer',text:'Removed content must not be public',occurredAt:time,providerId:'100003',source:'line',status:'cancelled',attachments:[]}),
  base('manual-1','conversation',{dealId:'deal-1',contactId:'contact-1',channel:'manual',direction:'internal',occurredAt:time,text:'Internal source note',attachments:['/api/rrs/files?id=11111111-1111-4111-8111-111111111111&mode=domestic']}),
],webhooks:[{id:'dom:line:unsend:synthetic-hash',time}]});

before(async()=>{process.env.DEMO_MODE='true';process.env.AI_PROVIDER='disabled';process.env.D1_LOCAL_DIR=`.data/legacy-import-${randomUUID()}`;for(const id of [org,other])await database.query('INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)',[id,id,'Synthetic legacy test']);});
after(closeDatabase);
async function complete(snapshot:LegacySnapshot,options:Record<string,unknown>={},importOrg=org){let cursor=0;for(let round=0;round<100;round++){const result=await handleLegacyImport(importOrg,{snapshot,options,dryRun:false,cursor,limit:2}) as any;cursor=result.progress.cursor;if(result.progress.complete)return result;}throw Error('Import did not finish');}
async function freshOrg(){const id=randomUUID();await database.query('INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)',[id,id,'Synthetic delta fixture']);return id;}

test('pure planner preserves identities/times, restricts unknown/cancelled messages and marks unresolved files',()=>{
  const plan=planLegacyImport(domestic(),org);assert.equal(plan.valid,true);assert.equal(plan.counts.message,4);assert.equal(plan.counts.lead,1);
  const messages=plan.units.filter(u=>u.type==='message');
  assert.equal(messages.find(u=>u.row.content==='Uncertain delivery')!.row.role,'note');
  assert.equal(messages.find(u=>u.row.content==='[ลูกค้ายกเลิกข้อความ]')!.row.role,'note');
  assert.ok(messages.every(u=>u.row.created_at===time));assert.equal(plan.unresolvedFiles.length,2);
  assert.equal(plan.units.find(u=>u.type==='identity')!.row.opt_out,1);
  assert.equal(plan.units.find(u=>u.type==='provenance'&&u.row.delivery_status==='cancelled')!.row.direction,'in');
  assert.equal(plan.units.filter(u=>u.type==='tombstone').length,1);
  const manual=plan.units.find(u=>u.type==='attachment'&&u.row.provider==='legacy')!;assert.equal(JSON.parse(manual.row.metadata).sourceOwnerOnly,true);assert.equal(JSON.parse(manual.row.metadata).sourceScopeUnknown,true);
  assert.equal(planLegacyImport(domestic(),other).units.find(u=>u.type==='lead')!.row.id===plan.units.find(u=>u.type==='lead')!.row.id,false);
});

test('WhatsApp assigned/inbound aliases become one logical message, ambiguity never merges by name',()=>{
  const common=[base('co','company',{name:'Fixture'}),base('c','contact',{companyId:'co',name:'Fixture',whatsapp:'+66800000002'}),base('d','deal',{companyId:'co',contactId:'c'})];
  const snapshot:LegacySnapshot={version:1,sourceSystem:'rrs-sale-office',workspace:'live',snapshotId:'wa-fixture',revision:2,records:[...common,
    base('in','inbound',{phone:'66800000002',text:'Same message',providerId:'wamid.fixture',received:time,assignedDeal:'d',mediaId:'',mediaType:'text'}),
    base('msg','message',{dealId:'d',contactId:'c',direction:'in',text:'Same message',status:'received',source:'whatsapp',providerId:'wamid.fixture',mediaIds:[],quoteId:''})],webhooks:[]};
  assert.ok(planLegacyImport(snapshot,org).issues.some(e=>e.code==='WHATSAPP_ACCOUNT_REQUIRED'));
  const plan=planLegacyImport(snapshot,org,{whatsappAccountId:'phone-account-fixture'});assert.equal(plan.valid,true);assert.equal(plan.counts.message,1);
  const mappings=plan.units.filter(u=>u.type==='archive'&&['in','msg'].includes(u.row.record.id));assert.equal(mappings[0].row.target_id,mappings[1].row.target_id);
  const ambiguous=structuredClone(snapshot);ambiguous.records.push(base('c2','contact',{companyId:'co',name:'Fixture',whatsapp:'+66800000002'}));ambiguous.records.find(r=>r.id==='in')!.assignedDeal='';
  assert.ok(planLegacyImport(ambiguous,org,{whatsappAccountId:'phone-account-fixture'}).issues.some(e=>e.code==='AMBIGUOUS_CONTACT'));
  assert.equal(planLegacyImport(ambiguous,org,{whatsappAccountId:'phone-account-fixture',phoneContactMap:{'66800000002':'c'}}).valid,true);
});

test('bounded apply survives replay, preserves immutable source rows, and never queues sends',async()=>{
  const snapshot=domestic(),plan=planLegacyImport(snapshot,org);
  const first=await applyLegacyPlan(org,plan,0,2);assert.equal(first.cursor,2);
  assert.equal((await applyLegacyPlan(org,plan,0,2)).replayed,true);
  const result=await complete(snapshot);assert.equal(result.progress.complete,true);assert.equal(result.verification.matched,true);assert.equal(result.verification.attachmentBytesVerified,false);
  assert.equal((await database.query('SELECT count(*) AS n FROM crm_legacy_records WHERE org_id=$1',[org])).rows[0].n,snapshot.records.length);
  assert.equal((await database.query('SELECT count(*) AS n FROM crm_legacy_webhooks WHERE org_id=$1',[org])).rows[0].n,1);
  assert.equal((await database.query('SELECT count(*) AS n FROM messages WHERE org_id=$1',[org])).rows[0].n,4);
  assert.equal((await database.query('SELECT count(*) AS n FROM social_outbound_commands WHERE org_id=$1',[org])).rows[0].n,0);
  assert.equal((await database.query('SELECT count(*) AS n FROM tasks WHERE org_id=$1',[org])).rows[0].n,0);
  assert.equal((await database.query('SELECT count(*) AS n FROM social_tombstones WHERE org_id=$1',[org])).rows[0].n,1);
  assert.equal((await database.query('SELECT created_at FROM messages WHERE org_id=$1 LIMIT 1',[org])).rows[0].created_at,time);
  await complete(snapshot);assert.equal((await database.query('SELECT count(*) AS n FROM messages WHERE org_id=$1',[org])).rows[0].n,4);
  await assert.rejects(database.query('UPDATE crm_legacy_records SET raw_json=$2 WHERE org_id=$1',[org,'{}']),/immutable/);
  assert.ok((await readBridgeEvents(org)).events.some(e=>e.entity==='message'));
});

test('changed snapshot and changed historic rows fail without overwriting CRM history',async()=>{
  const changed=domestic();changed.records.find(r=>r.id==='incoming-1')!.text='Changed after snapshot';
  await assert.rejects(handleLegacyImport(org,{snapshot:changed,dryRun:false}),error=>[409,422].includes((error as {status:number}).status));
  changed.snapshotId='new-snapshot-same-changed-source';
  await assert.rejects(handleLegacyImport(org,{snapshot:changed,dryRun:false}),error=>[409,422].includes((error as {status:number}).status));
  const native=(await database.query("SELECT content FROM messages WHERE org_id=$1 AND content='Historical hello'",[org])).rows;assert.equal(native.length,1);
  assert.equal((await database.query('SELECT count(*) AS n FROM crm_legacy_snapshots WHERE org_id=$1',[org])).rows[0].n,1);
});

test('invalid references and cross-tenant explicit leads cannot be imported',async()=>{
  const invalid=domestic();invalid.records.find(r=>r.id==='contact-1')!.companyId='missing';const plan=planLegacyImport(invalid,org);assert.equal(plan.valid,false);await assert.rejects(applyLegacyPlan(org,plan),{status:422});
  assert.throws(()=>planLegacyImport(domestic(),org,{contactLeadMap:{'contact-1':'not-a-uuid'}}),{status:400});
  await assert.rejects(applyLegacyPlan(other,planLegacyImport(domestic(),org)),{status:403});
  const foreign=randomUUID();await database.query('INSERT INTO leads(id,org_id,name) VALUES($1,$2,$3)',[foreign,other,'Foreign synthetic lead']);
  await assert.rejects(handleLegacyImport(org,{snapshot:domestic(),options:{contactLeadMap:{'contact-1':foreign}},dryRun:true}),{status:403});
});

test('exact channel identities map history to an existing CRM conversation without overwriting lead fields',async()=>{
  const lead=randomUUID(),conversation=randomUUID(),identity=randomUUID();
  await database.query('INSERT INTO leads(id,org_id,name,stage) VALUES($1,$2,$3,$4)',[lead,org,'Current CRM sales name','Won']);
  await database.query("INSERT INTO conversations(id,org_id,lead_id,status) VALUES($1,$2,$3,'human_active')",[conversation,org,lead]);
  await database.query("INSERT INTO social_identities(id,org_id,provider,account_id,remote_id,lead_id,conversation_id,created_at,updated_at) VALUES($1,$2,'line',$3,$4,$5,$6,$7,$7)",[identity,org,'other-bot','other-user',lead,conversation,time]);
  const s=domestic();s.snapshotId='other-customer';for(const r of s.records){r.id='other-'+r.id;for(const f of ['companyId','contactId','dealId','customerId','linkedDeal','channelId','threadId'])if(r[f])r[f]='other-'+r[f];}s.records.find(r=>r.kind==='domChannel')!.accountId='other-bot';s.records.find(r=>r.kind==='domThread')!.remoteId='other-user';
  s.records.push(...domestic().records);s.revision=18;await complete(s);
  const actual=(await database.query('SELECT name,stage FROM leads WHERE org_id=$1 AND id=$2',[org,lead])).rows[0];assert.equal(actual.name,'Current CRM sales name');assert.equal(actual.stage,'Won');
  assert.equal((await database.query('SELECT status FROM conversations WHERE org_id=$1 AND id=$2',[org,conversation])).rows[0].status,'human_active');
  assert.equal((await database.query('SELECT target_id FROM crm_bridge_import_mappings WHERE org_id=$1 AND source_id=$2',[org,'other-thread-1'])).rows[0].target_id,conversation);
  assert.equal(legacyId(org,'domestic','contact','contact-1'),legacyId(org,'domestic','contact','contact-1'));
});

test('explicit newer delta reconciles a late receipt and confirmed profile without resetting CRM fields',async()=>{
  const tenant=await freshOrg(),initial=domestic();initial.snapshotId='delta-base';initial.revision=100;await complete(initial,{},tenant);
  const sourceMap=(await database.query("SELECT source_id,target_id FROM crm_bridge_import_mappings WHERE org_id=$1",[tenant])).rows;
  const target=(source:string)=>sourceMap.find(row=>row.source_id===source)!.target_id;
  const conversation=target('thread-1');
  await database.query("UPDATE leads SET stage='Won' WHERE org_id=$1 AND id=$2",[tenant,target('contact-1')]);
  await database.query("UPDATE conversations SET status='human_active',version=8,generating_client_id='crm-current-generation' WHERE org_id=$1 AND id=$2",[tenant,conversation]);
  const before=(await database.query('SELECT customer_message_seq FROM conversations WHERE org_id=$1 AND id=$2',[tenant,conversation])).rows[0].customer_message_seq;
  const newer=structuredClone(initial);newer.snapshotId='delta-receipt';newer.revision=101;
  Object.assign(newer.records.find(row=>row.id==='outgoing-unknown')!,{providerId:'100004',status:'delivered',updated:'2025-01-03T00:00:00Z'});
  Object.assign(newer.records.find(row=>row.id==='contact-1')!,{name:'Confirmed source profile',updated:'2025-01-03T00:00:00Z'});
  await assert.rejects(handleLegacyImport(tenant,{snapshot:newer,dryRun:false}),{status:409});
  const result=await complete(newer,{allowSourceUpdates:true},tenant);assert.equal(result.verification.matched,true);
  const row=(await database.query('SELECT * FROM messages WHERE org_id=$1 AND id=$2',[tenant,target('outgoing-unknown')])).rows[0];assert.equal(row.role,'agent');assert.equal(row.created_at,time);
  const receipt=(await database.query('SELECT delivery_status,provider_message_id FROM social_message_provenance WHERE org_id=$1 AND message_id=$2',[tenant,row.id])).rows[0];assert.equal(receipt.delivery_status,'delivered');assert.equal(receipt.provider_message_id,'100004');
  const lead=(await database.query('SELECT name,stage FROM leads WHERE org_id=$1 AND id=$2',[tenant,target('contact-1')])).rows[0];assert.equal(lead.name,'Confirmed source profile');assert.equal(lead.stage,'Won');
  const state=(await database.query('SELECT status,version,generating_client_id,customer_message_seq FROM conversations WHERE org_id=$1 AND id=$2',[tenant,conversation])).rows[0];assert.equal(state.status,'human_active');assert.equal(state.version,8);assert.equal(state.generating_client_id,'crm-current-generation');assert.equal(state.customer_message_seq,before);
  assert.equal((await database.query('SELECT count(*) AS n FROM messages WHERE org_id=$1',[tenant])).rows[0].n,4);
  assert.equal((await database.query('SELECT count(*) AS n FROM social_outbound_commands WHERE org_id=$1',[tenant])).rows[0].n,0);
  assert.equal((await database.query("SELECT raw_json FROM crm_legacy_records WHERE org_id=$1 AND snapshot_id='delta-base' AND source_id='outgoing-unknown'",[tenant])).rows[0].raw_json.includes('"status":"unknown"'),true);
  const stale=structuredClone(initial);stale.snapshotId='stale-replay';await assert.rejects(handleLegacyImport(tenant,{snapshot:stale,options:{allowSourceUpdates:true},dryRun:false}),{status:409});
});

test('unsend atomically revokes original archived attachment while keeping CRM-added messages and generation state',async()=>{
  const tenant=await freshOrg(),initial=domestic();initial.snapshotId='unsend-base';initial.revision=200;await complete(initial,{},tenant);
  const message=(await database.query("SELECT target_id FROM crm_bridge_import_mappings WHERE org_id=$1 AND source_id='incoming-1'",[tenant])).rows[0].target_id;
  const original=(await database.query('SELECT conversation_id,customer_seq FROM messages WHERE org_id=$1 AND id=$2',[tenant,message])).rows[0];
  await database.query("UPDATE social_message_attachments SET storage_state='archived',object_key='synthetic/preserved-object',metadata=json_set(metadata,'$.verifiedByArchive',1) WHERE org_id=$1 AND message_id=$2",[tenant,message]);
  const extra=randomUUID();await database.query("INSERT INTO messages(id,org_id,conversation_id,role,content) VALUES($1,$2,$3,'agent','New CRM message while source import runs')",[extra,tenant,original.conversation_id]);
  const newer=structuredClone(initial);newer.snapshotId='unsend-final';newer.revision=201;
  Object.assign(newer.records.find(row=>row.id==='incoming-1')!,{text:'[ลูกค้ายกเลิกข้อความ]',status:'cancelled',attachments:[],updated:'2025-01-04T00:00:00Z'});
  const result=await complete(newer,{allowSourceUpdates:true},tenant);assert.equal(result.verification.matched,true);
  const revoked=(await database.query('SELECT role,content,customer_seq FROM messages WHERE org_id=$1 AND id=$2',[tenant,message])).rows[0];assert.equal(revoked.role,'note');assert.equal(revoked.content,'[ลูกค้ายกเลิกข้อความ]');assert.equal(revoked.customer_seq,original.customer_seq);
  const attachment=(await database.query('SELECT storage_state,object_key,removed_at,metadata FROM social_message_attachments WHERE org_id=$1 AND message_id=$2',[tenant,message])).rows[0];assert.equal(attachment.storage_state,'removed');assert.equal(attachment.object_key,'synthetic/preserved-object');assert.ok(attachment.removed_at);assert.equal(attachment.metadata.verifiedByArchive,1);
  assert.equal((await database.query('SELECT content FROM messages WHERE org_id=$1 AND id=$2',[tenant,extra])).rows[0].content,'New CRM message while source import runs');
  assert.equal((await database.query("SELECT count(*) AS n FROM social_tombstones WHERE org_id=$1 AND provider_message_id='100001'",[tenant])).rows[0].n,1);
});

test('concurrent CRM edit rejects delta before archive/projection writes and a higher source revision cannot bypass it',async()=>{
  const tenant=await freshOrg(),initial=domestic();initial.snapshotId='conflict-base';initial.revision=300;await complete(initial,{},tenant);
  const message=(await database.query("SELECT target_id FROM crm_bridge_import_mappings WHERE org_id=$1 AND source_id='incoming-1'",[tenant])).rows[0].target_id;
  await database.query("UPDATE messages SET content='CRM user edited this historical message' WHERE org_id=$1 AND id=$2",[tenant,message]);
  const newer=structuredClone(initial);newer.snapshotId='conflicting-final';newer.revision=301;Object.assign(newer.records.find(row=>row.id==='incoming-1')!,{text:'Different source edit',updated:'2025-01-05T00:00:00Z'});
  const before=(await readBridgeEvents(tenant)).headSequence;
  const preview=await handleLegacyImport(tenant,{snapshot:newer,options:{allowSourceUpdates:true},dryRun:true}) as any;assert.equal(preview.valid,false);assert.ok(preview.issues.some((e:any)=>e.code==='TARGET_RECONCILIATION_CONFLICT'));
  await assert.rejects(handleLegacyImport(tenant,{snapshot:newer,options:{allowSourceUpdates:true},dryRun:false}),{status:409});
  assert.equal((await database.query('SELECT count(*) AS n FROM crm_legacy_snapshots WHERE org_id=$1',[tenant])).rows[0].n,1);
  assert.equal((await database.query('SELECT content FROM messages WHERE org_id=$1 AND id=$2',[tenant,message])).rows[0].content,'CRM user edited this historical message');
  assert.equal((await readBridgeEvents(tenant)).headSequence,before);
});

test('new source message in a later snapshot adds once and source deletion/stale timestamp are rejected',async()=>{
  const tenant=await freshOrg(),initial=domestic();initial.snapshotId='addition-base';initial.revision=400;await complete(initial,{},tenant);
  const next=structuredClone(initial);next.snapshotId='addition-final';next.revision=401;
  next.records.push(base('new-incoming','domMessage',{threadId:'thread-1',author:'customer',text:'Arrived while history was imported',occurredAt:'2025-01-06T00:00:00Z',providerId:'100099',source:'line',status:'received',attachments:[],updated:'2025-01-06T00:00:00Z'}));
  await complete(next,{allowSourceUpdates:true},tenant);await complete(next,{allowSourceUpdates:true},tenant);
  assert.equal((await database.query("SELECT count(*) AS n FROM messages WHERE org_id=$1 AND content='Arrived while history was imported'",[tenant])).rows[0].n,1);
  const deleted=structuredClone(next);deleted.snapshotId='missing-row';deleted.revision=402;deleted.records=deleted.records.filter(r=>r.id!=='new-incoming');await assert.rejects(handleLegacyImport(tenant,{snapshot:deleted,options:{allowSourceUpdates:true},dryRun:false}),{status:409});
  const backwards=structuredClone(next);backwards.snapshotId='backwards-time';backwards.revision=402;Object.assign(backwards.records.find(r=>r.id==='new-incoming')!,{text:'Changed',updated:'2024-01-01T00:00:00Z'});await assert.rejects(handleLegacyImport(tenant,{snapshot:backwards,options:{allowSourceUpdates:true},dryRun:false}),{status:409});
});

test('failed attachment revocation rolls back the message, provenance and outbox in the same delta batch',async()=>{
  const tenant=await freshOrg(),initial=domestic();initial.snapshotId='atomic-base';initial.revision=500;await complete(initial,{},tenant);
  const message=(await database.query("SELECT target_id FROM crm_bridge_import_mappings WHERE org_id=$1 AND source_id='incoming-1'",[tenant])).rows[0].target_id;
  await database.query(`CREATE TRIGGER synthetic_revoke_failure BEFORE UPDATE OF storage_state ON social_message_attachments WHEN NEW.org_id='${tenant}' AND NEW.storage_state='removed' BEGIN SELECT RAISE(ABORT,'synthetic attachment revocation failure'); END`);
  const next=structuredClone(initial);next.snapshotId='atomic-final';next.revision=501;Object.assign(next.records.find(r=>r.id==='incoming-1')!,{status:'cancelled',text:'[ลูกค้ายกเลิกข้อความ]',attachments:[],updated:'2025-01-07T00:00:00Z'});
  let cursor=0,failed=false;
  for(let n=0;n<100;n++){
    const head=(await readBridgeEvents(tenant)).headSequence;
    try{const result=await handleLegacyImport(tenant,{snapshot:next,options:{allowSourceUpdates:true},dryRun:false,cursor,limit:1}) as any;cursor=result.progress.cursor;if(result.progress.complete)break;}
    catch(error){assert.match(String(error),/synthetic attachment revocation failure/);failed=true;assert.equal((await readBridgeEvents(tenant)).headSequence,head);break;}
  }
  assert.equal(failed,true);
  assert.equal((await database.query('SELECT content FROM messages WHERE org_id=$1 AND id=$2',[tenant,message])).rows[0].content,'Historical hello');
  assert.equal((await database.query('SELECT delivery_status FROM social_message_provenance WHERE org_id=$1 AND message_id=$2',[tenant,message])).rows[0].delivery_status,'received');
  assert.equal((await database.query('SELECT storage_state FROM social_message_attachments WHERE org_id=$1 AND message_id=$2',[tenant,message])).rows[0].storage_state,'provider_reference');
  assert.equal((await database.query("SELECT cursor FROM crm_legacy_snapshots WHERE org_id=$1 AND snapshot_id='atomic-final'",[tenant])).rows[0].cursor,cursor);
  await database.query('DROP TRIGGER synthetic_revoke_failure');
  await complete(next,{allowSourceUpdates:true},tenant);
  assert.equal((await database.query('SELECT storage_state FROM social_message_attachments WHERE org_id=$1 AND message_id=$2',[tenant,message])).rows[0].storage_state,'removed');
});

test('auxiliary evidence is immutable and cached WhatsApp media replaces expired provider refs without replaying work',async()=>{
  const tenant=await freshOrg();
  const initial:LegacySnapshot={version:1,sourceSystem:'rrs-sale-office',workspace:'live',snapshotId:'auxiliary-base',revision:600,tailSequence:100,records:[
    base('aux-company','company',{name:'Synthetic'}),base('aux-contact','contact',{companyId:'aux-company',name:'Synthetic',whatsapp:'+66800000008'}),base('aux-deal','deal',{companyId:'aux-company',contactId:'aux-contact'}),
    base('aux-inbound','inbound',{phone:'66800000008',text:'[image]',providerId:'wamid.auxiliary',received:time,assignedDeal:'aux-deal',mediaType:'image',mediaId:'80001'}),
  ],webhooks:[],auxiliary:[{table:'rrs_communication_queue',id:'wamid.auxiliary',record:{id:'wamid.auxiliary',workspace:'live',inbound_id:'aux-inbound',file_id:'',status:'Queued'}},{table:'rrs_communication_outbox',id:'unresolved-send',record:{id:'unresolved-send',workspace:'live',status:'Unknown',attempt:1}},{table:'ai_revisions',id:'revision-fixture',record:{id:'revision-fixture',workspace:'live',reason:'Synthetic approval revision'}},{table:'ai_job_steps',id:'step-fixture',record:{id:'step-fixture',workspace:'live',status:'Completed'}}]};
  const options={whatsappAccountId:'synthetic-phone-account'};
  await complete(initial,options,tenant);
  const next=structuredClone(initial);next.snapshotId='auxiliary-cached';next.tailSequence=101;
  next.auxiliary![0].record.file_id='wa-aux-inbound';next.auxiliary![0].record.updated_at='2025-01-08T00:00:00Z';
  next.auxiliary!.push({table:'rrs_uploads',id:'wa-aux-inbound',record:{id:'wa-aux-inbound',workspace:'live',mime:'image/png',size:123}});
  const preview=await handleLegacyImport(tenant,{snapshot:next,options:{...options,allowSourceUpdates:true},dryRun:true}) as any;assert.equal(preview.valid,true);assert.ok(preview.unresolvedFiles.some((file:any)=>file.reference==='/api/rrs/files?id=wa-aux-inbound&mode=live'));
  const final=await complete(next,{...options,allowSourceUpdates:true},tenant);assert.equal(final.verification.matched,true);assert.equal(final.verification.counts.auxiliary,5);
  const attachments=(await database.query('SELECT provider_ref,storage_state FROM social_message_attachments WHERE org_id=$1',[tenant])).rows;
  assert.equal(attachments.find(row=>row.provider_ref==='provider:whatsapp:80001')!.storage_state,'removed');
  assert.equal(attachments.find(row=>row.provider_ref==='/api/rrs/files?id=wa-aux-inbound&mode=live')!.storage_state,'provider_reference');
  assert.equal((await database.query('SELECT count(*) AS n FROM social_outbound_commands WHERE org_id=$1',[tenant])).rows[0].n,0);
  await assert.rejects(database.query('UPDATE crm_legacy_auxiliary SET raw_json=$2 WHERE org_id=$1',[tenant,'{}']),/immutable/);
  const stale=structuredClone(next);stale.snapshotId='stale-auxiliary';stale.tailSequence=100;await assert.rejects(handleLegacyImport(tenant,{snapshot:stale,options:{...options,allowSourceUpdates:true},dryRun:false}),{status:409});
});

test('imported offset/millisecond timestamps paginate through the real inbox without losing source precision',async()=>{
  const tenant=await freshOrg(),snapshot=domestic(),member=randomUUID();snapshot.snapshotId='canonical-time';snapshot.revision=700;
  for(const row of snapshot.records){row.created='2025-01-02T10:04:05.123+07:00';row.updated='2025-01-02T03:04:05.123Z';}
  await complete(snapshot,{},tenant);
  await database.query("INSERT INTO members(id,org_id,name,email,password_hash,role) VALUES($1,$2,'Time fixture',$3,'no-login','Admin')",[member,tenant,member+'@example.invalid']);
  const staff={id:member,orgId:tenant,name:'Time fixture',email:member+'@example.invalid',role:'Admin' as const};
  let cursor:string|null=null;const ids:string[]=[];
  do{const url=new URL('http://localhost/api/admin/inbox?limit=1');if(cursor)url.searchParams.set('cursor',cursor);const page=await inbox(staff,url);ids.push(...page.items.map(item=>item.id));cursor=page.nextCursor;assert.ok(ids.length<=2);if(cursor)assert.match(JSON.parse(Buffer.from(cursor,'base64url').toString('utf8')).updatedAt,/\.\d{6}Z$/);}while(cursor);
  assert.equal(new Set(ids).size,2);
  assert.equal(canonicalLegacyTimestamp('2025-01-02T10:04:05.123456+07:00'),'2025-01-02T03:04:05.123456Z');
  assert.equal(canonicalLegacyTimestamp('2025-01-02T03:04:05Z'),'2025-01-02T03:04:05.000000Z');
  assert.throws(()=>canonicalLegacyTimestamp('2025-01-02T03:04:05'),/timezone/);
  const archived=(await database.query("SELECT raw_json FROM crm_legacy_records WHERE org_id=$1 AND source_id='contact-1'",[tenant])).rows[0];assert.equal(JSON.parse(archived.raw_json).created,'2025-01-02T10:04:05.123+07:00');
  const provenance=(await database.query("SELECT metadata FROM social_message_provenance WHERE org_id=$1 LIMIT 1",[tenant])).rows[0];assert.equal(provenance.metadata.originalCreated,'2025-01-02T10:04:05.123+07:00');
});

test('non-admin inbox never searches, previews or marks an owner-only user message read',async()=>{
  const tenant=await freshOrg(),snapshot=domestic();snapshot.snapshotId='inbox-privacy';snapshot.revision=800;await complete(snapshot,{},tenant);
  const conversation=(await database.query("SELECT target_id FROM crm_bridge_import_mappings WHERE org_id=$1 AND source_id='thread-1'",[tenant])).rows[0].target_id;
  const seq=Number((await database.query('SELECT customer_message_seq FROM conversations WHERE org_id=$1 AND id=$2',[tenant,conversation])).rows[0].customer_message_seq)+1;
  const hidden=randomUUID();await database.query("INSERT INTO messages(id,org_id,conversation_id,role,content,source_owner_only,customer_seq,created_at) VALUES($1,$2,$3,'user','RestrictedLegacyFixture',1,$4,'2026-01-01T00:00:00.000000Z')",[hidden,tenant,conversation,seq]);await database.query('UPDATE conversations SET customer_message_seq=$3 WHERE org_id=$1 AND id=$2',[tenant,conversation,seq]);
  const agents=[];
  for(const role of ['Admin','Agent'] as const){const id=randomUUID();await database.query('INSERT INTO members(id,org_id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5,$6)',[id,tenant,role,id+'@example.invalid','no-login',role]);agents.push({id,orgId:tenant,name:role,email:id+'@example.invalid',role});}
  const [admin,agent]=agents;
  const query=new URL('http://localhost/api/admin/inbox?q=RestrictedLegacyFixture');assert.equal((await inbox(agent,query)).total,0);assert.equal((await inbox(admin,query)).total,1);
  const item=(await inbox(agent,new URL('http://localhost/api/admin/inbox'))).items.find(row=>row.id===conversation)!;assert.notEqual(item.lastCustomerMessageId,hidden);assert.notEqual(item.lastMessage,'RestrictedLegacyFixture');assert.equal(item.unreadCount,1);
  await assert.rejects(markConversationRead(agent,conversation,{throughMessageId:hidden}),{status:404});
});

test('operator CLI explicitly exposes source updates while defaulting to an offline plan',async()=>{
  const file=path.join(process.env.D1_LOCAL_DIR!,'synthetic-operator-snapshot.json');await writeFile(file,JSON.stringify(domestic()));
  const result=spawnSync(process.execPath,['--import','tsx','scripts/import-legacy-chat.ts','--snapshot',file,'--allow-source-updates'],{cwd:process.cwd(),env:{...process.env,CRM_BRIDGE_ORG_ID:org,CRM_BRIDGE_SECRET:'',CRM_BRIDGE_ORIGIN:''},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);const summary=JSON.parse(result.stdout);assert.equal(summary.valid,true);assert.equal(summary.allowSourceUpdates,true);assert.equal(summary.cutoverReady,false);
});
