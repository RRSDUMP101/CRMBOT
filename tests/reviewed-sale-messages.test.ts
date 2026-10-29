/** Real SQLite, production command/dispatch code, signed simulated source and provider only. */
import assert from 'node:assert/strict';
import {randomUUID,createHmac} from 'node:crypto';
import {before,after,test} from 'node:test';
import {database,closeDatabase} from '../src/lib/db';
import {acceptReviewedSale,parseReviewedSale,reviewedSaleStatus,type ReviewedSaleEnvelope} from '../src/lib/reviewed-sale-messages';
import {ingestSocialWebhook,readSocialConfig,socialConfigFingerprint,dispatchSocialReply} from '../src/lib/social-channels';
import {verifyBridgeRequest} from '../src/lib/bridge-protocol';
let org:string,actor:string,number=0,sendCount=0,proofCount=0,proofValid=true,templateValid=true,outcome=200;
const transport=(async(input,init)=>{
 const u=new URL(String(input));if(u.origin==='https://sale.test'){
  assert.equal(u.pathname,'/api/rrs/crm/reviewed-messages/validate');const {body}=await verifyBridgeRequest(new Request(input,init),{orgId:org,secret:process.env.CRM_BRIDGE_SECRET!});proofCount++;if(!proofValid)return Response.json({error:'revoked'},{status:409});const p=JSON.parse(body);return Response.json({version:1,valid:true,orgId:org,commandId:p.commandId,payloadHash:p.payloadHash,nonce:p.nonce,sourceRevision:1,checkedAt:Date.now()});
 }
 assert.equal(u.origin,'https://graph.facebook.com');assert.equal(init?.redirect,'manual');
 if(u.pathname.endsWith('/message_templates'))return Response.json({data:[{name:'approved_fixture',status:templateValid?'APPROVED':'REJECTED',language:'en_US',components:[{type:'BODY',text:'Exact approved fixture body'}]}]});
 assert.equal(u.pathname,'/v24.0/1234567890/messages');sendCount++;const body=JSON.parse(String(init?.body));assert.ok(body.biz_opaque_callback_data);assert.ok(['text','template'].includes(body.type));if(body.type==='template')assert.deepEqual(body.template,{name:'approved_fixture',language:{code:'en_US'}});await new Promise(r=>setTimeout(r,5));return outcome===200?Response.json({messages:[{id:'fixture-receipt-'+sendCount}]}):Response.json({error:'synthetic'},{status:outcome});
}) as typeof fetch;
before(async()=>{
 process.env.DEMO_MODE='true';process.env.D1_LOCAL_DIR='.data/reviewed-'+randomUUID();org=randomUUID();actor=randomUUID();Object.assign(process.env,{CRM_BRIDGE_ENABLED:'true',CRM_BRIDGE_ORG_ID:org,CRM_BRIDGE_SECRET:'synthetic-bridge-secret-never-live-ever',CRM_REVIEWED_SALE_ENABLED:'true',CRM_REVIEWED_SALE_SOURCE_ORIGIN:'https://sale.test',CRM_BRIDGE_ALLOWED_MEMBER_IDS:JSON.stringify([actor]),SOCIAL_CHANNELS_ORG_ID:org,SOCIAL_CHANNELS_OWNER:'crm',SOCIAL_INBOUND_ENABLED:'true',SOCIAL_LIVE_ENABLED:'true',WHATSAPP_LIVE_ENABLED:'true',WHATSAPP_PHONE_NUMBER_ID:'1234567890',WHATSAPP_WABA_ID:'9988776655',WHATSAPP_ACCESS_TOKEN:'synthetic-no-live-token',WHATSAPP_APP_SECRET:'synthetic-secret',WHATSAPP_API_VERSION:'v24.0'});
 await database.query('INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)',[org,org,'Reviewed synthetic']);await database.query("INSERT INTO members(id,org_id,name,email,password_hash,role) VALUES($1,$2,'Fixture',$3,'not-a-password','Agent')",[actor,org,actor+'@example.invalid']);
});after(closeDatabase);
async function fixture(template=false):Promise<ReviewedSaleEnvelope>{
 number++;const config=readSocialConfig('whatsapp'),remote='6681'+String(number).padStart(7,'0'),body=JSON.stringify({object:'whatsapp_business_account',entry:[{id:config.wabaId,changes:[{field:'messages',value:{metadata:{phone_number_id:config.accountId},messages:[{id:'inbound-fixture-'+number,from:remote,timestamp:String(Math.floor(Date.now()/1000)-(template?172800:1)),type:'text',text:{body:'Customer synthetic inbound'}}]}}]}]}),bytes=new TextEncoder().encode(body);
 await ingestSocialWebhook('whatsapp',bytes,new Headers({'x-hub-signature-256':'sha256='+createHmac('sha256',config.secret).update(bytes).digest('hex')}),config);
 const identity=(await database.query('SELECT * FROM social_identities WHERE org_id=$1 AND remote_id=$2',[org,remote])).rows[0];await database.query("UPDATE conversations SET status='human_active',assignee_id=$3,version=version+1 WHERE org_id=$1 AND id=$2",[org,identity.conversation_id,actor]);await database.query('UPDATE leads SET contact_consent_at=$3,contact_consent_version=$4 WHERE org_id=$1 AND id=$2',[org,identity.lead_id,new Date().toISOString(),'fixture-consent']);
 await database.query("UPDATE social_channel_controls SET send_enabled=1,emergency_stop=0,send_mode='live',verified_at=$4,verification_fingerprint=$5,verification_expires_at=$6 WHERE org_id=$1 AND provider=$2 AND account_id=$3",[org,'whatsapp',config.accountId,new Date().toISOString(),socialConfigFingerprint(config),new Date(Date.now()+86400000).toISOString()]);
 const conversation=(await database.query('SELECT * FROM conversations WHERE org_id=$1 AND id=$2',[org,identity.conversation_id])).rows[0];
 return {version:1,kind:'reviewed-sale-message',commandId:randomUUID(),conversationId:conversation.id,expectedVersion:conversation.version,expectedCustomerSeq:conversation.customer_message_seq,actorId:actor,provider:'whatsapp',accountId:config.accountId,remoteId:remote,text:template?'Exact approved fixture body':'Human reviewed fixture',template:template?{name:'approved_fixture',language:'en_US'}:null,source:{system:'rrs-sale-office',workspace:'live',messageId:randomUUID(),messageHash:'1'.repeat(64),consentHash:'2'.repeat(64),ruleHash:'3'.repeat(64),reviewedBy:'fixture-owner',mode:'manual',reviewAuditId:''}};
}
test('reviewed exact text sends once under duplicate concurrent acceptance and retains native history',async()=>{
 const p=await fixture(),before=sendCount;await Promise.all([acceptReviewedSale(p,{fetch:transport}),acceptReviewedSale(p,{fetch:transport})]);const status=await reviewedSaleStatus(p.commandId);assert.equal(status.status,'submitted');assert.equal(sendCount,before+1);assert.equal((await database.query("SELECT count(*) AS n FROM messages WHERE org_id=$1 AND conversation_id=$2 AND role='agent'",[org,p.conversationId])).rows[0].n,1);await acceptReviewedSale(p,{fetch:transport});assert.equal(sendCount,before+1);await assert.rejects(acceptReviewedSale({...p,text:'Different body'},{fetch:transport}),{status:409});
});
test('BODY-only template works outside 24 hours and fresh provider approval is mandatory',async()=>{
 const p=await fixture(true),before=sendCount;await acceptReviewedSale(p,{fetch:transport});assert.equal(sendCount,before+1);assert.equal((await reviewedSaleStatus(p.commandId)).status,'submitted');
 const bad=await fixture(true);templateValid=false;await assert.rejects(acceptReviewedSale(bad,{fetch:transport}),{status:409});templateValid=true;assert.equal(sendCount,before+1);
 const stale=await fixture(true),accepted=await acceptReviewedSale(stale,{fetch:transport,dispatch:false});templateValid=false;await assert.rejects(dispatchSocialReply(org,accepted.outboundCommandId,{fetch:transport}),{status:409});templateValid=true;assert.equal(sendCount,before+1);
});
test('ordinary text outside window, stale assignment/customer generation and revoked source never send',async()=>{
 const expired={...await fixture(true),template:null};const queued=await acceptReviewedSale(expired,{fetch:transport,dispatch:false}),before=sendCount;await assert.rejects(dispatchSocialReply(org,queued.outboundCommandId,{fetch:transport}),{status:409});
 const p=await fixture(),accepted=await acceptReviewedSale(p,{fetch:transport,dispatch:false});await database.query('UPDATE conversations SET customer_message_seq=customer_message_seq+1 WHERE org_id=$1 AND id=$2',[org,p.conversationId]);await assert.rejects(dispatchSocialReply(org,accepted.outboundCommandId,{fetch:transport}),{status:409});
 const revoked=await fixture(),r=await acceptReviewedSale(revoked,{fetch:transport,dispatch:false});proofValid=false;await assert.rejects(dispatchSocialReply(org,r.outboundCommandId,{fetch:transport}),{status:409});proofValid=true;
 process.env.CRM_BRIDGE_ALLOWED_MEMBER_IDS='[]';await assert.rejects(dispatchSocialReply(org,r.outboundCommandId,{fetch:transport}),{status:403});process.env.CRM_BRIDGE_ALLOWED_MEMBER_IDS=JSON.stringify([actor]);assert.equal(sendCount,before);
});
test('provider ambiguity is quarantined and durable command retry cannot send again',async()=>{
 const p=await fixture(),before=sendCount;outcome=503;const accepted=await acceptReviewedSale(p,{fetch:transport});assert.equal(accepted.status,'unknown');await acceptReviewedSale(p,{fetch:transport});await dispatchSocialReply(org,accepted.outboundCommandId,{fetch:transport});assert.equal(sendCount,before+1);outcome=200;
});

test('a queued reviewed reply loses authority after the CRM actor is deactivated',async()=>{
 const p=await fixture(),accepted=await acceptReviewedSale(p,{fetch:transport,dispatch:false}),before=sendCount;
 await database.query("UPDATE members SET active=0 WHERE org_id=$1 AND id=$2",[org,actor]);
 try{await assert.rejects(dispatchSocialReply(org,accepted.outboundCommandId,{fetch:transport}),{status:403});assert.equal(sendCount,before);}
 finally{await database.query("UPDATE members SET active=1 WHERE org_id=$1 AND id=$2",[org,actor]);}
});

test('review revocation aborts an in-flight request and keeps its uncertain outcome quarantined',async()=>{
 const p=await fixture(),accepted=await acceptReviewedSale(p,{fetch:transport,dispatch:false}),before=sendCount;
 let observedAbort=false;
 const delayed=(async(input,init)=>{
  if(new URL(String(input)).pathname.endsWith('/messages')){
   sendCount++;proofValid=false;
   return new Promise<Response>((_resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('monitor did not abort')),3000);
    init?.signal?.addEventListener('abort',()=>{observedAbort=true;clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));},{once:true});
   });
  }
  return transport(input,init);
 }) as typeof fetch;
 try{const result=await dispatchSocialReply(org,accepted.outboundCommandId,{fetch:delayed});assert.equal(observedAbort,true);assert.equal(result.status,'unknown');assert.equal(sendCount,before+1);}
 finally{proofValid=true;}
 await dispatchSocialReply(org,accepted.outboundCommandId,{fetch:transport});assert.equal(sendCount,before+1);
});
test('cross-account, unsupported template fields/media and disabled feature fail closed',async()=>{
 const p=await fixture();await assert.rejects(acceptReviewedSale({...p,accountId:'5555555555'},{fetch:transport}),{status:409});assert.throws(()=>parseReviewedSale({...p,parts:[{url:'https://internal.invalid'}]}),{status:400});assert.throws(()=>parseReviewedSale({...p,template:{name:'approved_fixture',language:'en_US',components:[]}}),{status:400});process.env.CRM_REVIEWED_SALE_ENABLED='false';await assert.rejects(acceptReviewedSale(p,{fetch:transport}),{status:503});process.env.CRM_REVIEWED_SALE_ENABLED='true';assert.ok(proofCount>0);
});
