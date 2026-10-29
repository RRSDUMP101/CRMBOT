/** Real SQLite with signed fake Sale proofs and fake provider transport only. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {before,after,test} from 'node:test';
import {database,transaction,closeDatabase} from '../src/lib/db';
import {acceptApprovedAi,approvedAiStatus,type ApprovedAiEnvelope} from '../src/lib/approved-ai';
import {bridgePayloadHash,verifyBridgeRequest} from '../src/lib/bridge-protocol';
import {dispatchSocialReply,socialConfigFingerprint,type SocialChannelConfig} from '../src/lib/social-channels';
import {readBridgeEvents} from '../src/lib/chat-bridge';

const secret='synthetic-approved-AI-bridge-key-at-least-32-characters';
before(()=>{Object.assign(process.env,{DEMO_MODE:'true',RRS_WORKERS:'false',AI_PROVIDER:'disabled',D1_LOCAL_DIR:'.data/approved-ai-'+randomUUID(),CRM_BRIDGE_ENABLED:'true',CRM_APPROVED_AI_ENABLED:'true',CRM_BRIDGE_SECRET:secret,CRM_APPROVED_AI_SOURCE_ORIGIN:'https://sale.example.invalid'});});
after(closeDatabase);
async function fixture(){
 const org=randomUUID(),actor=randomUUID(),lead=randomUUID(),conversation=randomUUID(),identity=randomUUID(),inbound=randomUUID(),time=new Date().toISOString();
 await database.query('INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)',[org,org,'Synthetic AI tenant']);
 await database.query("INSERT INTO members(id,org_id,name,email,password_hash,role) VALUES($1,$2,'Fixture Admin',$3,'not-a-password','Admin')",[actor,org,actor+'@example.invalid']);
 await database.query("INSERT INTO leads(id,org_id,contact_consent_at,contact_consent_version) VALUES($1,$2,$3,'fixture-evidence')",[lead,org,time]);
 await database.query("INSERT INTO conversations(id,org_id,lead_id,status,assignee_id) VALUES($1,$2,$3,'human_active',$4)",[conversation,org,lead,actor]);
 await database.query("INSERT INTO social_identities(id,org_id,provider,account_id,remote_id,lead_id,conversation_id,created_at,updated_at) VALUES($1,$2,'whatsapp','1234567890','66800000001',$3,$4,$5,$5)",[identity,org,lead,conversation,time]);
 await database.query("INSERT INTO messages(id,org_id,conversation_id,role,content) VALUES($1,$2,$3,'user','Synthetic verified inbound')",[inbound,org,conversation]);
 await database.query("INSERT INTO social_message_provenance(org_id,message_id,provider,account_id,remote_id,provider_message_id,provider_type,direction,delivery_status,provider_timestamp) VALUES($1,$2,'whatsapp','1234567890','66800000001',$3,'text','in','received',$4)",[org,inbound,'fixture-inbound-'+inbound,time]);
 const config:SocialChannelConfig={provider:'whatsapp',orgId:org,accountId:'1234567890',wabaId:'9988776655',secret:'fixture-provider-secret',accessToken:'fixture-no-real-token',apiVersion:'v99.0',owner:'crm',inboundEnabled:true,liveEnabled:true};
 const fp=socialConfigFingerprint(config);
 await database.query("INSERT INTO social_channel_controls(org_id,provider,account_id,send_enabled,emergency_stop,verified_at,epoch,updated_at,verification_fingerprint,verification_expires_at,webhook_fingerprint,webhook_verified_at,send_mode) VALUES($1,'whatsapp',$2,1,0,$3,1,$3,$4,$5,$4,$3,'live')",[org,config.accountId,time,fp,new Date(Date.now()+86400000).toISOString()]);
 Object.assign(process.env,{CRM_BRIDGE_ORG_ID:org,CRM_BRIDGE_ALLOWED_MEMBER_IDS:JSON.stringify([actor]),CRM_APPROVED_AI_ENABLED:'true'});
 const resultPayload=JSON.stringify({summary:'Synthetic internal review',customer_reply:{text:'Hello.',language:'en',claims:[],missing_information:[],required_source:[]}}),commandId=randomUUID();
 const payload:ApprovedAiEnvelope={version:1,kind:'approved-ai-text',commandId,conversationId:conversation,expectedVersion:1,actorId:actor,provider:'whatsapp',accountId:config.accountId,remoteId:'66800000001',text:'Hello.',source:{system:'rrs-sale-office',workspace:'live',outboxId:commandId,jobId:randomUUID(),jobVersion:2,resultId:randomUUID(),resultHash:await bridgePayloadHash(resultPayload),resultPayload,sourceHash:'a'.repeat(64),sourceRevision:10,approvalId:randomUUID(),approvedBy:'synthetic-owner',approvedAt:time}};
 let proofMode='valid',providerMode='success',proofCalls=0,sends=0;
 const transport:typeof fetch=async(input,init)=>{
  const request=new Request(input,init);
  if(request.url==='https://sale.example.invalid/api/rrs/crm/approved-ai/validate'){
   const {body}=await verifyBridgeRequest(request,{orgId:org,secret},4096),p=JSON.parse(body);proofCalls++;
   if(proofMode==='deny'||proofMode==='deny-second'&&proofCalls>=3)return Response.json({error:'source changed'},{status:409});
   if(proofMode==='redirect')return new Response(null,{status:302,headers:{location:'https://foreign.example.invalid'}});
   return Response.json({version:1,valid:true,orgId:org,commandId:p.commandId,payloadHash:p.payloadHash,nonce:proofMode==='nonce'?randomUUID():p.nonce,sourceRevision:10,checkedAt:Date.now()});
  }
  assert.ok(request.url.startsWith('https://graph.facebook.com/v99.0/1234567890/messages'));sends++;
  assert.equal(JSON.parse(await request.text()).text.body,payload.text);
  if(providerMode==='unknown')throw Error('Synthetic lost provider response');
  if(providerMode==='revoke-during-send'){
   proofMode='deny';await new Promise<void>((resolve,reject)=>{if(request.signal.aborted)return reject(Error('aborted'));request.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});setTimeout(resolve,2500);});
  }
  return Response.json({messages:[{id:'wamid.synthetic.'+sends}]});
 };
 return {org,actor,lead,conversation,payload,config,transport,counts:()=>({proofCalls,sends}),proof:(value:string)=>{proofMode=value;},provider:(value:string)=>{providerMode=value;}};
}
async function effects(org:string){return (await database.query('SELECT (SELECT COUNT(*) FROM crm_approved_ai_commands WHERE org_id=$1) AS approvals,(SELECT COUNT(*) FROM social_outbound_commands WHERE org_id=$1) AS intents,(SELECT COUNT(*) FROM messages WHERE org_id=$1 AND role=\'agent\') AS replies',[org])).rows[0];}

test('concurrent same approval and lost-reply replay produce one immutable approval/message/intent',async()=>{
 const f=await fixture();const results=await Promise.all([acceptApprovedAi(f.payload,{fetch:f.transport,dispatch:false}),acceptApprovedAi(f.payload,{fetch:f.transport,dispatch:false})]);
 assert.equal(results[0].messageId,results[1].messageId);assert.deepEqual(await effects(f.org),{approvals:1,intents:1,replies:1});
 assert.equal((await acceptApprovedAi(f.payload,{fetch:f.transport,dispatch:false})).messageId,results[0].messageId);
 const changed=structuredClone(f.payload);changed.source.sourceHash='b'.repeat(64);await assert.rejects(acceptApprovedAi(changed,{fetch:f.transport,dispatch:false}),{status:409});
 await assert.rejects(database.query('UPDATE crm_approved_ai_commands SET payload_hash=$3 WHERE org_id=$1 AND command_id=$2',[f.org,f.payload.commandId,'c'.repeat(64)]),/immutable/);
 const rows=(await readBridgeEvents(f.org)).events;assert.ok(!JSON.stringify(rows).includes('Synthetic internal review'));assert.ok(rows.some(e=>e.entity==='messageProvenance'&&String(e.record.metadata).includes('approved_ai')));
});
test('source nonce, redirects, changed evidence and original result tampering fail before native writes',async()=>{
 for(const mode of ['nonce','redirect','deny']){const f=await fixture();f.proof(mode);await assert.rejects(acceptApprovedAi(f.payload,{fetch:f.transport,dispatch:false}));assert.deepEqual(await effects(f.org),{approvals:0,intents:0,replies:0});assert.equal(f.counts().sends,0);}
 const f=await fixture(),tampered=structuredClone(f.payload);tampered.source.resultPayload+=' ';await assert.rejects(acceptApprovedAi(tampered,{fetch:f.transport,dispatch:false}),{status:409});assert.equal(f.counts().proofCalls,0);
});
test('approval receipt constraint failure rolls back native intent and every bridge event',async()=>{
 const f=await fixture(),head=(await readBridgeEvents(f.org)).headSequence;
 await database.query("CREATE TRIGGER fixture_ai_failure BEFORE INSERT ON crm_approved_ai_commands BEGIN SELECT RAISE(ABORT,'fixture_ai_atomic_failure'); END");
 try{await assert.rejects(acceptApprovedAi(f.payload,{fetch:f.transport,dispatch:false}),/fixture_ai_atomic_failure/);}finally{await database.query('DROP TRIGGER fixture_ai_failure');}
 assert.deepEqual(await effects(f.org),{approvals:0,intents:0,replies:0});assert.equal((await readBridgeEvents(f.org)).headSequence,head);
});
test('scope, Admin assignment, consent and generation are independent of source approval',async()=>{
 const f=await fixture();for(const patch of [{conversationId:randomUUID()},{actorId:randomUUID()},{expectedVersion:2},{remoteId:'66800000002'}])await assert.rejects(acceptApprovedAi({...f.payload,...patch},{fetch:f.transport,dispatch:false}));
 await database.query('UPDATE leads SET contact_consent_at=NULL WHERE id=$1',[f.lead]);await assert.rejects(acceptApprovedAi(f.payload,{fetch:f.transport,dispatch:false}),{status:409});assert.deepEqual(await effects(f.org),{approvals:0,intents:0,replies:0});
});
test('recovery revalidates source after enqueue and immediately before the external effect',async()=>{
 const f=await fixture(),accepted=await acceptApprovedAi(f.payload,{fetch:f.transport,dispatch:false});f.proof('deny');
 await assert.rejects(dispatchSocialReply(f.org,accepted.outboundCommandId,{config:f.config,fetch:f.transport}),{status:409});assert.equal(f.counts().sends,0);
 f.proof('valid');process.env.CRM_BRIDGE_ALLOWED_MEMBER_IDS='[]';await assert.rejects(dispatchSocialReply(f.org,accepted.outboundCommandId,{config:f.config,fetch:f.transport}),{status:409});assert.equal(f.counts().sends,0);
 process.env.CRM_BRIDGE_ALLOWED_MEMBER_IDS=JSON.stringify([f.actor]);await database.query("UPDATE members SET role='Agent' WHERE id=$1",[f.actor]);await assert.rejects(dispatchSocialReply(f.org,accepted.outboundCommandId,{config:f.config,fetch:f.transport}),{status:409});
 const g=await fixture(),gAccepted=await acceptApprovedAi(g.payload,{fetch:g.transport,dispatch:false});g.proof('deny-second');assert.equal((await dispatchSocialReply(g.org,gAccepted.outboundCommandId,{config:g.config,fetch:g.transport})).status,'cancelled');assert.equal(g.counts().sends,0);
});
test('unknown provider result never resends even when the signed handoff is retried',async()=>{
 const f=await fixture(),accepted=await acceptApprovedAi(f.payload,{fetch:f.transport,dispatch:false});f.provider('unknown');
 assert.equal((await dispatchSocialReply(f.org,accepted.outboundCommandId,{config:f.config,fetch:f.transport})).status,'unknown');
 await acceptApprovedAi(f.payload,{fetch:f.transport,dispatch:false});await dispatchSocialReply(f.org,accepted.outboundCommandId,{config:f.config,fetch:f.transport});assert.equal(f.counts().sends,1);
 process.env.CRM_APPROVED_AI_ENABLED='false';assert.equal((await approvedAiStatus(f.payload.commandId)).status,'unknown');
});
test('source kill switch or approval revocation during a slow send aborts and quarantines outcome',async()=>{
 const f=await fixture(),accepted=await acceptApprovedAi(f.payload,{fetch:f.transport,dispatch:false});f.provider('revoke-during-send');
 assert.equal((await dispatchSocialReply(f.org,accepted.outboundCommandId,{config:f.config,fetch:f.transport})).status,'unknown');assert.equal(f.counts().sends,1);assert.ok(f.counts().proofCalls>=4);
});
