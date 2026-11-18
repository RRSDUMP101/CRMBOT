import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import {after,before,test} from 'node:test';
import {database,closeDatabase,transaction} from '../src/lib/db';
import type {Staff} from '../src/lib/auth';
import {ingestSocialWebhook,type SocialChannelConfig} from '../src/lib/social-channels';
import {assertTriageEligible,configureSpam,reviewSpam,spamQueue} from '../src/lib/whatsapp-triage';
import {downloadSocialAttachment} from '../src/lib/social-media';
import {claimSemanticSpam,finishSemanticSpam} from '../src/lib/semantic-spam';

let staff:Staff, config:SocialChannelConfig;
before(async()=>{
  process.env.DEMO_MODE='true';process.env.D1_LOCAL_DIR='.data/triage-'+randomUUID();
  process.env.RRS_SALES_KNOWLEDGE_ENABLED='true';
  const orgId=randomUUID(),id=randomUUID();
  await database.query("INSERT INTO organizations(id,slug,name) VALUES($1,$1,'synthetic')",[orgId]);
  await database.query("INSERT INTO members(id,org_id,name,email,password_hash,role) VALUES($1,$2,'Fixture',$3,'disabled','Admin')",[id,orgId,id+'@example.invalid']);
  staff={id,orgId,role:'Admin',name:'Fixture',email:id+'@example.invalid'};
  config={orgId,provider:'whatsapp',accountId:'1234567890',wabaId:'9988776655',secret:'local-only',owner:'crm',inboundEnabled:true,liveEnabled:false};
});
test('semantic advice is limited to ambiguous input, leased once, checked against source and never changes eligibility',async()=>{
  process.env.RRS_SALES_SEMANTIC_SPAM_ENABLED='true';
  const text='Affiliate opportunity https://fixture.invalid',r=await send('66800000019',text);
  const [a,b]=await Promise.all([claimSemanticSpam(staff.orgId),claimSemanticSpam(staff.orgId)]);
  const claims=[a.candidate,b.candidate].filter(c=>c!==null);assert.equal(claims.length,1);
  const claim=claims[0]!,proof={messageId:r.message_id,token:claim.token};
  const suggestion={category:'suspected_spam',summary:'เสนอให้ตรวจสอบก่อนตอบ',quote:text,confidence:0.7,action:'HUMAN_REVIEW',model:'fixture-model',runId:randomUUID(),evaluationId:randomUUID()};
  await assert.rejects(finishSemanticSpam(staff.orgId,{...proof,suggestion:{...suggestion,quote:'absent words'}}),{status:422});
  assert.equal((await finishSemanticSpam(staff.orgId,{...proof,suggestion})).state,'suggested');
  const q=(await spamQueue(staff)).items.find(i=>i.message_id===r.message_id);
  assert.equal(q?.model_summary,suggestion.summary);assert.equal(q?.review_state,'pending');assert.equal(q?.semantic_token,undefined);
  const next=await send('66800000020',text),candidate=(await claimSemanticSpam(staff.orgId)).candidate!;
  await send('66800000020','New evidence');assert.equal((await finishSemanticSpam(staff.orgId,{messageId:next.message_id,token:candidate.token,suggestion})).state,'stale');
});
after(closeDatabase);
const send=async(remote:string,body:string,extra:Record<string,unknown>={},id=randomUUID())=>{
  const msg={from:remote,id,timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body},...extra};
  const payload={object:'whatsapp_business_account',entry:[{id:config.wabaId,changes:[{value:{metadata:{phone_number_id:config.accountId},messages:[msg]}}]}]};
  const bytes=new TextEncoder().encode(JSON.stringify(payload));
  const result=await ingestSocialWebhook('whatsapp',bytes,new Headers({'x-hub-signature-256':'sha256='+createHmac('sha256',config.secret).update(bytes).digest('hex')}),config);
  type Inbound={message_id:string;conversation_id:string;metadata:{rrsSales:Record<string,unknown>};eligible:number;revision:number;category:string};
  const row=(await database.query<Inbound>('SELECT t.*,p.metadata FROM whatsapp_triage t JOIN social_message_provenance p ON p.org_id=t.org_id AND p.message_id=t.message_id WHERE t.org_id=$1 AND p.provider_message_id=$2',[staff.orgId,id])).rows[0];
  return {...row,result};
};
test('initial outbox includes authoritative eligibility, records facts once on redelivery',async()=>{
  const id=randomUUID(),body='Please quote 3 kits for Hilux';
  const a=await send('66800000011',body,{rrsSales:{eligible:false}},id);
  assert.equal(a.metadata.rrsSales.eligible,true);assert.equal(a.metadata.rrsSales.quotationRequested,true);
  const b=await send('66800000011',body,{rrsSales:{eligible:false}},id);
  assert.equal(b.result.duplicates,1);
  const snapshots=(await database.query("SELECT record_json FROM crm_bridge_events WHERE org_id=$1 AND entity='messageProvenance' AND record_id=$2 ORDER BY sequence",[staff.orgId,a.message_id])).rows;
  assert.deepEqual(JSON.parse(JSON.parse(snapshots[0].record_json).metadata).rrsSales,a.metadata.rrsSales);
  const facts=(await database.query('SELECT fact_key,value,state FROM sales_customer_facts WHERE org_id=$1 AND source_message_id=$2 ORDER BY fact_key',[staff.orgId,a.message_id])).rows;
  assert.equal(facts.find(f=>f.fact_key==='quantity')?.value,'3');assert.ok(facts.every(f=>f.state==='customer_reported'));
});
test('image sequences, multilingual text and complaints stay distinct from spam; executable file never fetched',async()=>{
  for(let i=0;i<6;i++)assert.equal((await send('66800000012','',{type:'image',image:{id:'image'+i,mime_type:'image/jpeg'}})).category,'legitimate');
  assert.equal((await send('66800000012','您好')).eligible,1);
  assert.equal((await send('66800000012','ร้องเรียน สินค้าเสียหาย')).category,'complaint_or_support');
  const r=await send('66800000012','',{type:'document',document:{id:'held',filename:'fixture.exe',mime_type:'application/pdf'}});
  assert.equal(r.category,'unsafe_attachment_or_link');assert.equal(r.eligible,0);
  const a=(await database.query('SELECT id FROM social_message_attachments WHERE org_id=$1 AND message_id=$2',[staff.orgId,r.message_id])).rows[0];
  assert.equal((await database.query('SELECT 1 FROM social_media_archive_jobs WHERE org_id=$1 AND attachment_id=$2',[staff.orgId,a.id])).rows.length,0);
  let called=false;await assert.rejects(downloadSocialAttachment(staff.orgId,a.id,async()=>{called=true;throw Error('unexpected fetch');}),{status:415});assert.equal(called,false);
});
test('shadow/enforce, identity isolation, CAS decisions and release checkpoint',async()=>{
  const remote='66800000013',body='Please quote 4 kits';
  for(let i=1;i<=5;i++){const m=await send(remote,body);if(i===5){assert.equal(m.category,'flood');assert.equal(m.eligible,1);}}
  await assert.rejects(configureSpam({...staff,role:'Agent'},{mode:'enforce',repeatLimit:2,windowSeconds:60,expectedRevision:0}),{status:403});
  await configureSpam(staff,{mode:'enforce',repeatLimit:2,windowSeconds:60,expectedRevision:0});
  const m=await send(remote,body);assert.equal(m.eligible,0);
  assert.equal((await send('66800000014',body)).eligible,1);
  await assert.rejects(transaction(staff.orgId,c=>assertTriageEligible(c,staff.orgId,m.conversation_id)),{status:409});
  const input={messageId:m.message_id,expectedRevision:m.revision,decision:'release',note:'verified inquiry'};
  const results=await Promise.allSettled([reviewSpam(staff,input),reviewSpam(staff,input)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const p=(await database.query('SELECT metadata FROM social_message_provenance WHERE org_id=$1 AND message_id=$2',[staff.orgId,m.message_id])).rows[0];
  assert.equal(p.metadata.rrsSales.eligible,true);assert.equal(p.metadata.rrsSales.quotationRequested,true);
  assert.equal((await database.query("SELECT COUNT(*) AS n FROM audit_events WHERE org_id=$1 AND entity_id=$2 AND action='wa_triage.release'",[staff.orgId,m.message_id])).rows[0].n,1);
  const stale=await send(remote,body);await send(remote,'new specification');
  assert.equal((await reviewSpam(staff,{...input,messageId:stale.message_id})).resumed,false);
  const latest=await send(remote,body);await database.query("UPDATE conversations SET status='human_active',version=version+1 WHERE org_id=$1 AND id=$2",[staff.orgId,latest.conversation_id]);
  assert.equal((await reviewSpam(staff,{...input,messageId:latest.message_id})).resumed,false);
  assert.ok((await spamQueue(staff,'released')).items.length>=3);
  assert.equal((await database.query('SELECT COUNT(*) AS n FROM social_outbound_commands WHERE org_id=$1',[staff.orgId])).rows[0].n,0);
});
