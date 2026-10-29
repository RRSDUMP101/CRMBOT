/** Synthetic SQLite + signed payloads only. The transport is injected; never call a real provider. */
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { database, transaction, closeDatabase } from '../src/lib/db';
import { ingestSocialWebhook, enqueueSocialReply, dispatchSocialReply, readSocialConfig, readSocialBody, socialVerificationChallenge,socialConfigFingerprint, type SocialChannelConfig, type SocialProvider } from '../src/lib/social-channels';
import { conversationDetail } from '../src/lib/service';

let org:string,staff:string,otherOrg:string;
const stamp=()=>Date.now()-1000;
const config=(provider:SocialProvider,accountId=provider==='line'?'UfixtureBot':provider==='whatsapp'?'1234567890':'2234567890',orgId=org):SocialChannelConfig=>({provider,orgId,accountId,wabaId:'9988776655',secret:'fixture-signing-secret',verifyToken:'fixture-verify-token',accessToken:'fixture-never-live-token',apiVersion:'v24.0',owner:'crm',inboundEnabled:true,liveEnabled:false});
const signed=(payload:unknown,c:SocialChannelConfig)=>{const bytes=new TextEncoder().encode(JSON.stringify(payload));const signature=createHmac('sha256',c.secret).update(bytes).digest(c.provider==='line'?'base64':'hex');return {bytes,headers:new Headers({[c.provider==='line'?'x-line-signature':'x-hub-signature-256']:c.provider==='line'?signature:'sha256='+signature})};};
const ingest=(payload:unknown,c:SocialChannelConfig)=>{const s=signed(payload,c);return ingestSocialWebhook(c.provider,s.bytes,s.headers,c);};
const line=(remote:string,mid:string,type='text',extra:Record<string,unknown>={})=>({destination:'UfixtureBot',events:[{webhookEventId:'evt-'+mid,type:'message',timestamp:stamp(),source:{type:'user',userId:remote},message:{id:mid,type,text:'ข้อความสังเคราะห์',...extra}}]});
const wa=(remote:string,mid:string,extra:Record<string,unknown>={})=>({object:'whatsapp_business_account',entry:[{id:'9988776655',changes:[{field:'messages',value:{metadata:{phone_number_id:'1234567890'},messages:[{id:mid,from:remote,timestamp:String(Math.floor(stamp()/1000)),type:'text',text:{body:'Synthetic WhatsApp'},...extra}]}}]}]});
const fb=(remote:string,mid:string,extra:Record<string,unknown>={})=>({object:'page',entry:[{id:'2234567890',messaging:[{sender:{id:remote},recipient:{id:'2234567890'},timestamp:stamp(),message:{mid,text:'Synthetic Facebook',...extra}}]}]});
const identity=async(provider:string,remote:string,account?:string,orgId=org)=>(await database.query('SELECT * FROM social_identities WHERE org_id=$1 AND provider=$2 AND remote_id=$3'+(account?' AND account_id=$4':''),account?[orgId,provider,remote,account]:[orgId,provider,remote])).rows[0];
const provenance=async(mid:string)=>(await database.query('SELECT * FROM social_message_provenance WHERE org_id=$1 AND provider_message_id=$2',[org,mid])).rows[0];
async function approvedReply(c:SocialChannelConfig,remote:string) {
  const person=await identity(c.provider,remote,c.accountId),messageId=randomUUID();
  if(c.provider==='whatsapp') await database.query('UPDATE leads SET contact_consent_at=$3,contact_consent_version=$4 WHERE org_id=$1 AND id=$2',[org,person.lead_id,new Date().toISOString(),'synthetic-explicit-consent-v1']);
  await transaction(org,async tx=>{await tx.query("UPDATE conversations SET status='human_active',assignee_id=$3,version=version+1 WHERE org_id=$1 AND id=$2",[org,person.conversation_id,staff]);});
  const command=await transaction(org,async tx=>{
    await tx.query("INSERT INTO messages(id,org_id,conversation_id,role,content) VALUES($1,$2,$3,'agent','Human approved fixture reply')",[messageId,org,person.conversation_id]);
    return enqueueSocialReply(tx,org,person.conversation_id,messageId,'Human approved fixture reply');
  });
  return {commandId:command.commandId!,messageId,conversationId:person.conversation_id};
}
// This suite isolates transport semantics; the separate admin suite verifies the only runtime path to this evidence.
async function enableControl(c:SocialChannelConfig) {await database.query("UPDATE social_channel_controls SET send_enabled=1,emergency_stop=0,send_mode='live',verified_at=$4,verification_fingerprint=$5,verification_expires_at=$6,epoch=epoch+1 WHERE org_id=$1 AND provider=$2 AND account_id=$3",[org,c.provider,c.accountId,new Date().toISOString(),socialConfigFingerprint(c),new Date(Date.now()+86400000).toISOString()]);}

before(async()=>{
  process.env.DEMO_MODE='true';process.env.D1_LOCAL_DIR=`.data/social-${randomUUID()}`;
  await database.query('SELECT 1');org=randomUUID();staff=randomUUID();otherOrg=randomUUID();
  for(const id of [org,otherOrg]) await database.query('INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)',[id,id,'Synthetic social fixture']);
  await database.query("INSERT INTO members(id,org_id,name,email,password_hash,role) VALUES($1,$2,'Fixture staff',$3,'not-a-real-password','Admin')",[staff,org,staff+'@example.invalid']);
});
after(closeDatabase);

test('default ownership/live configuration is closed and verification requires exact secret',()=>{
  const defaults=readSocialConfig('whatsapp',{});assert.equal(defaults.liveEnabled,false);assert.equal(defaults.inboundEnabled,false);
  assert.equal(readSocialConfig('line',{SOCIAL_LIVE_ENABLED:'true',LINE_LIVE_ENABLED:'true'}).liveEnabled,false);
  assert.equal(readSocialConfig('line',{SOCIAL_LIVE_ENABLED:'true',LINE_LIVE_ENABLED:'true',DOMESTIC_LIVE_ENABLED:'true'}).liveEnabled,true);
  const c=config('whatsapp');
  assert.equal(socialVerificationChallenge(new Request('https://crm.example.invalid/api/channels/whatsapp?hub.mode=subscribe&hub.challenge=123&hub.verify_token=fixture-verify-token'),c),'123');
  assert.throws(()=>socialVerificationChallenge(new Request('https://crm.example.invalid/?hub.mode=subscribe&hub.challenge=123&hub.verify_token=wrong'),c),{status:403});
});
test('signature tampering and whole-payload account mismatch write nothing',async()=>{
  const c=config('whatsapp'),payload=wa('66811111111','invalid-scope');const s=signed(payload,c);s.bytes[s.bytes.length-2]^=1;
  await assert.rejects(ingestSocialWebhook('whatsapp',s.bytes,s.headers,c),{status:403});
  const mixed=wa('66811111111','mixed-scope');mixed.entry.push({...mixed.entry[0],id:'wrong-account'});
  await assert.rejects(ingest(mixed,c),{status:403});
  assert.equal((await database.query('SELECT count(*) AS n FROM social_events WHERE org_id=$1',[org])).rows[0].n,0);
  await assert.rejects(ingest({...line('Uone','bad-destination'),destination:'OtherBot'},config('line')),{status:403});
});
test('bounded streaming request body rejects more than 1 MB',async()=>{
  const body=new Uint8Array(1_000_001);
  await assert.rejects(readSocialBody(new Request('https://crm.example.invalid',{method:'POST',body})),{status:413});
});
test('signed concurrent duplicates commit one native message and a durable identity',async()=>{
  const c=config('line'),payload=line('Uduplicate','line-duplicate');
  const results=await Promise.all([ingest(payload,c),ingest(payload,c)]);
  assert.equal(results.reduce((n,r)=>n+r.accepted,0),1);assert.equal(results.reduce((n,r)=>n+r.duplicates,0),1);
  const i=await identity('line','Uduplicate');assert.ok(i);
  const messages=(await database.query('SELECT * FROM messages WHERE org_id=$1 AND conversation_id=$2',[org,i.conversation_id])).rows;
  assert.equal(messages.length,1);assert.equal(messages[0].customer_seq,1);assert.equal(messages[0].status,'complete');
  assert.match(messages[0].created_at,/\.\d{6}Z$/);
  const conv=(await database.query('SELECT * FROM conversations WHERE id=$1',[i.conversation_id])).rows[0];assert.equal(conv.status,'waiting_human');
  assert.equal((await database.query('SELECT count(*) AS n FROM social_outbound_commands WHERE org_id=$1',[org])).rows[0].n,0);
});
test('identity isolates tenant, provider and configured account without name matching',async()=>{
  const a=config('line'),b=config('line','UanotherBot'),other=config('line','UfixtureBot',otherOrg);
  await ingest(line('UsameName','identity-a'),a);
  await ingest({...line('UsameName','identity-b'),destination:b.accountId},b);
  await ingest(line('UsameName','identity-c'),other);
  await ingest(fb('UsameName','identity-fb'),config('facebook'));
  const values=[await identity('line','UsameName',a.accountId),await identity('line','UsameName',b.accountId),await identity('line','UsameName',a.accountId,otherOrg),await identity('facebook','UsameName')];
  assert.equal(new Set(values.map(i=>i.lead_id)).size,4);assert.equal(new Set(values.map(i=>i.conversation_id)).size,4);
});
test('provider-specific message types, media metadata and private references survive without a media fetch',async()=>{
  const l=config('line');await ingest(line('Umedia','line-file','file',{text:undefined,fileName:'synthetic.pdf',fileSize:34,contentProvider:{type:'line'}}),l);
  await ingest(wa('66812222222','wa-image',{type:'image',text:undefined,image:{id:'fixture-media-id',mime_type:'image/png',sha256:'fixture-hash',caption:'ภาพสังเคราะห์'}}),config('whatsapp'));
  await ingest(fb('fbmedia','fb-attachment',{text:undefined,attachments:[{type:'image',payload:{url:'https://127.0.0.1/private-target'}}]}),config('facebook'));
  for(const mid of ['line-file','wa-image','fb-attachment']) {
    const p=await provenance(mid);assert.ok(p);assert.equal(p.delivery_status,'received');
    const attachments=(await database.query('SELECT * FROM social_message_attachments WHERE org_id=$1 AND message_id=$2',[org,p.message_id])).rows;
    assert.equal(attachments.length,1);assert.equal(attachments[0].storage_state,'provider_reference');assert.equal(attachments[0].object_key,null);
  }
  const p=await provenance('wa-image');assert.equal(p.metadata.image.mime_type,'image/png');
});
test('unsend before delivery is a durable tombstone; unsend after delivery redacts content and references',async()=>{
  const c=config('line'),unsend=(mid:string)=>({destination:c.accountId,events:[{webhookEventId:'unsend-'+mid,type:'unsend',timestamp:stamp(),source:{type:'user',userId:'Uunsend'},unsend:{messageId:mid}}]});
  await ingest(unsend('before-message'),c);await ingest(line('Uunsend','before-message'),c);assert.equal(await provenance('before-message'),undefined);
  await ingest(line('Uunsend','after-message','image',{contentProvider:{type:'line'}}),c);const p=await provenance('after-message');
  await ingest(unsend('after-message'),c);await ingest(line('Uunsend','after-message'),c);
  assert.equal((await database.query('SELECT content FROM messages WHERE id=$1',[p.message_id])).rows[0].content,'[ลูกค้ายกเลิกข้อความ]');
  assert.equal((await provenance('after-message')).delivery_status,'cancelled');
  const attachment=(await database.query('SELECT * FROM social_message_attachments WHERE message_id=$1',[p.message_id])).rows[0];assert.equal(attachment.provider_ref,'');assert.equal(attachment.storage_state,'removed');
});
test('imported legacy LINE unsend tombstones suppress a delayed provider message',async()=>{
  const c=config('line'),remote='UlegacyUnsend',mid='legacy-unsent-mid',snapshot=randomUUID();
  const id='dom:line:unsend:'+createHash('sha256').update(c.accountId+':'+remote+':'+mid).digest('hex');
  await database.query("INSERT INTO crm_legacy_snapshots(org_id,source_system,workspace,snapshot_id,revision,snapshot_hash,plan_hash,total_units,source_record_count,source_webhook_count) VALUES($1,'sale-office','domestic',$2,1,'fixture','fixture',1,0,1)",[org,snapshot]);
  await database.query("INSERT INTO crm_legacy_webhooks(org_id,workspace,snapshot_id,id,time) VALUES($1,'domestic',$2,$3,$4)",[org,snapshot,id,new Date().toISOString()]);
  await ingest(line(remote,mid),c);assert.equal(await provenance(mid),undefined);assert.equal(await identity('line',remote),undefined);
});
test('outgoing text is queued atomically but default flags and durable stop prohibit transport',async()=>{
  const c=config('line');await ingest(line('UdefaultClosed','default-closed'),c);const command=await approvedReply(c,'UdefaultClosed');let calls=0;
  const transport=(async()=>{calls++;return Response.json({});}) as typeof fetch;
  await assert.rejects(dispatchSocialReply(org,command.commandId,{config:c,fetch:transport}),{status:503});
  await assert.rejects(dispatchSocialReply(org,command.commandId,{config:{...c,liveEnabled:true},fetch:transport}),{status:503});
  assert.equal(calls,0);assert.equal((await database.query('SELECT status FROM social_outbound_commands WHERE id=$1',[command.commandId])).rows[0].status,'queued');
});
test('one durable claim sends once under concurrency, remains submitted until provider evidence',async()=>{
  const c={...config('whatsapp'),liveEnabled:true};await ingest(wa('66813333333','wa-outgoing'),c);await enableControl(c);
  const command=await approvedReply(c,'66813333333');let calls=0;
  const transport=(async(input,init)=>{calls++;assert.equal(String(input),'https://graph.facebook.com/v24.0/1234567890/messages');assert.equal(init?.redirect,'manual');const body=JSON.parse(String(init?.body));assert.equal(body.to,'66813333333');assert.ok(body.biz_opaque_callback_data);await new Promise(resolve=>setTimeout(resolve,15));return Response.json({messages:[{id:'provider-outgoing-mid'}]});}) as typeof fetch;
  await Promise.all([dispatchSocialReply(org,command.commandId,{config:c,fetch:transport}),dispatchSocialReply(org,command.commandId,{config:c,fetch:transport})]);assert.equal(calls,1);
  assert.equal((await database.query('SELECT status FROM social_outbound_commands WHERE id=$1',[command.commandId])).rows[0].status,'submitted');
  const receipt=(status:string)=>({object:'whatsapp_business_account',entry:[{id:c.wabaId,changes:[{value:{metadata:{phone_number_id:c.accountId},statuses:[{id:'provider-outgoing-mid',recipient_id:'66813333333',status,timestamp:String(Math.floor(stamp()/1000))}]}}]}]});
  await ingest(receipt('read'),c);await ingest(receipt('sent'),c);await ingest(receipt('failed'),c);
  assert.equal((await provenance('provider-outgoing-mid')).delivery_status,'read');
  assert.equal((await database.query('SELECT status FROM messages WHERE id=$1',[command.messageId])).rows[0].status,'complete','delivery status is separate from AI/native status');
});
test('receipt before send response is retained and applied when provider ID is linked',async()=>{
  const c={...config('whatsapp'),liveEnabled:true};await ingest(wa('66814444444','wa-fast'),c);const command=await approvedReply(c,'66814444444');
  const transport=(async()=>{
    await ingest({object:'whatsapp_business_account',entry:[{id:c.wabaId,changes:[{value:{metadata:{phone_number_id:c.accountId},statuses:[{id:'fast-mid',recipient_id:'66814444444',status:'delivered',timestamp:String(Math.floor(stamp()/1000))}]}}]}]},c);
    return Response.json({messages:[{id:'fast-mid'}]});
  }) as typeof fetch;
  assert.equal((await dispatchSocialReply(org,command.commandId,{config:c,fetch:transport})).status,'delivered');
});

test('Facebook echo before response becomes one visible reply with preserved audit and projection tombstone',async()=>{
  const c={...config('facebook'),liveEnabled:true},remote='fb-early-echo',mid='fb-early-echo-output';
  await ingest(fb(remote,'fb-early-echo-input'),c);await enableControl(c);const command=await approvedReply(c,remote);
  const payload={object:'page',entry:[{id:c.accountId,messaging:[{sender:{id:c.accountId},recipient:{id:remote},timestamp:stamp(),message:{mid,is_echo:true,text:'Provider echo text retained as evidence',attachments:[{type:'image',payload:{attachment_id:'synthetic-echo-attachment'}}]}}]}]};
  let echoId='',calls=0;
  const transport=(async()=>{calls++;await ingest(payload,c);echoId=(await provenance(mid)).message_id;assert.notEqual(echoId,command.messageId);return Response.json({message_id:mid});}) as typeof fetch;
  assert.equal((await dispatchSocialReply(org,command.commandId,{config:c,fetch:transport})).status,'sent');
  assert.equal((await provenance(mid)).message_id,command.messageId);
  const duplicate=(await database.query('SELECT m.*,p.metadata,p.removed_at FROM messages m JOIN social_message_provenance p ON p.org_id=m.org_id AND p.message_id=m.id WHERE m.org_id=$1 AND m.id=$2',[org,echoId])).rows[0];
  assert.equal(duplicate.role,'note');assert.equal(duplicate.source_owner_only,1);assert.ok(duplicate.removed_at);assert.equal(duplicate.metadata.reconciledIntoMessageId,command.messageId);assert.equal(duplicate.metadata.originalProviderMessageId,mid);
  const customer=await conversationDetail(org,command.conversationId),owner=await conversationDetail(org,command.conversationId,true,true);
  assert.deepEqual(customer.messages.filter(m=>m.role==='agent').map(m=>m.id),[command.messageId]);assert.ok(!customer.messages.some(m=>m.id===echoId));
  assert.equal(owner.messages.find(m=>m.id===echoId)?.content,'[หลักฐาน Facebook echo รวมกับข้อความที่อนุมัติแล้ว]');
  const audit=(await database.query("SELECT metadata FROM audit_events WHERE org_id=$1 AND action='social.facebook_echo_reconciled' AND entity_id=$2",[org,command.messageId])).rows;
  assert.equal(audit.length,1);assert.equal(audit[0].metadata.echo.content,'Provider echo text retained as evidence');assert.equal(audit[0].metadata.echo.metadata.is_echo,true);
  const attachment=(await database.query('SELECT * FROM social_message_attachments WHERE org_id=$1 AND message_id=$2',[org,command.messageId])).rows[0];assert.equal(attachment.provider_ref,'synthetic-echo-attachment');
  const history=(await database.query('SELECT entity,record_id,record_json FROM crm_bridge_events WHERE org_id=$1 ORDER BY sequence',[org])).rows;
  const projection=new Map<string,Record<string,any>>();for(const event of history)projection.set(event.entity+':'+event.record_id,JSON.parse(event.record_json));
  assert.ok(history.some(e=>e.entity==='message'&&e.record_id===echoId&&JSON.parse(e.record_json).content==='Provider echo text retained as evidence'));
  const active=[...projection.entries()].filter(([key,m])=>key.startsWith('message:')&&m.conversation_id===command.conversationId&&m.role==='agent'&&!m.source_owner_only&&!projection.get('messageProvenance:'+m.id)?.removed_at);
  assert.deepEqual(active.map(([,m])=>m.id),[command.messageId]);assert.equal(projection.get('message:'+echoId)?.role,'note');assert.equal(projection.get('messageProvenance:'+echoId)?.metadata.includes(command.messageId),true);
  assert.equal((await ingest(payload,c)).duplicates,1);await dispatchSocialReply(org,command.commandId,{config:c,fetch:transport});assert.equal(calls,1);
  await ingest({object:'page',entry:[{id:c.accountId,messaging:[{sender:{id:remote},recipient:{id:c.accountId},timestamp:stamp(),delivery:{mids:[mid]}}]}]},c);assert.equal((await provenance(mid)).delivery_status,'delivered');
});

test('Facebook reconciliation isolates org/account and never joins equal message text',async()=>{
  const c={...config('facebook'),liveEnabled:true},remote='fb-echo-scope',mid='fb-echo-shared-id';
  await ingest(fb(remote,'fb-echo-scope-input'),c);await enableControl(c);const command=await approvedReply(c,remote);
  const scopes=[config('facebook','3344556677'),config('facebook',c.accountId,otherOrg)];
  const echoPayload=(scope:SocialChannelConfig,id:string)=>({object:'page',entry:[{id:scope.accountId,messaging:[{sender:{id:scope.accountId},recipient:{id:remote},timestamp:stamp(),message:{mid:id,is_echo:true,text:'Human approved fixture reply'}}]}]});
  for(const scope of scopes)await ingest(echoPayload(scope,mid),scope);
  const transport=(async()=>{await ingest(echoPayload(c,'fb-different-provider-id'),c);return Response.json({message_id:mid});}) as typeof fetch;
  assert.equal((await dispatchSocialReply(org,command.commandId,{config:c,fetch:transport})).status,'submitted');
  for(const scope of [...scopes,c]){const p=(await database.query('SELECT * FROM social_message_provenance WHERE org_id=$1 AND provider=$2 AND account_id=$3 AND provider_message_id=$4',[scope.orgId,'facebook',scope.accountId,scope===c?'fb-different-provider-id':mid])).rows[0];assert.ok(p);assert.equal(p.removed_at,null);assert.equal(p.delivery_status,'sent');}
  assert.equal((await database.query("SELECT count(*) AS n FROM audit_events WHERE org_id=$1 AND action='social.facebook_echo_reconciled' AND entity_id=$2",[org,command.messageId])).rows[0].n,0);
});

test('Facebook provider ID collision for another remote is quarantined without merging or retry',async()=>{
  const c={...config('facebook'),liveEnabled:true},remote='fb-echo-conflict',mid='fb-conflicting-provider-id';
  await ingest(fb(remote,'fb-echo-conflict-input'),c);await enableControl(c);const command=await approvedReply(c,remote);let calls=0;
  const transport=(async()=>{calls++;await ingest({object:'page',entry:[{id:c.accountId,messaging:[{sender:{id:c.accountId},recipient:{id:'different-customer'},timestamp:stamp(),message:{mid,is_echo:true,text:'Human approved fixture reply'}}]}]},c);return Response.json({message_id:mid});}) as typeof fetch;
  assert.equal((await dispatchSocialReply(org,command.commandId,{config:c,fetch:transport})).status,'unknown');
  const p=await provenance(mid);assert.equal(p.remote_id,'different-customer');assert.equal(p.removed_at,null);assert.equal(p.delivery_status,'sent');
  const own=(await database.query('SELECT provider_message_id,error_code FROM social_outbound_commands WHERE org_id=$1 AND id=$2',[org,command.commandId])).rows[0];assert.equal(own.provider_message_id,null);assert.equal(own.error_code,'provider_message_id_conflict');
  assert.equal((await dispatchSocialReply(org,command.commandId,{config:c,fetch:transport})).status,'unknown');assert.equal(calls,1);
  assert.equal((await database.query("SELECT count(*) AS n FROM audit_events WHERE org_id=$1 AND action='social.provider_identity_conflict' AND entity_id=$2",[org,command.messageId])).rows[0].n,1);
});

test('Facebook read watermark applies to a sent attempt, never an earlier queued draft',async()=>{
  const c={...config('facebook'),liveEnabled:true};await ingest(fb('fbwatermark','fb-watermark-input'),c);await enableControl(c);
  const command=await approvedReply(c,'fbwatermark');
  await database.query("UPDATE social_message_provenance SET provider_timestamp='2000-01-01T00:00:00Z' WHERE org_id=$1 AND message_id=$2",[org,command.messageId]);
  const event={object:'page',entry:[{id:c.accountId,messaging:[{sender:{id:'fbwatermark'},recipient:{id:c.accountId},timestamp:stamp(),read:{watermark:stamp()}}]}]};
  await ingest(event,c);
  const transport=(async()=>Response.json({message_id:'fb-watermark-output'})) as typeof fetch;
  assert.equal((await dispatchSocialReply(org,command.commandId,{config:c,fetch:transport})).status,'submitted');
  const sent=await provenance('fb-watermark-output');assert.ok(Date.parse(sent.provider_timestamp)>Date.parse('2000-01-01T00:00:00Z'));
  event.entry[0].messaging[0].timestamp=Date.now();event.entry[0].messaging[0].read.watermark=Date.now();
  await ingest(event,c);assert.equal((await provenance('fb-watermark-output')).delivery_status,'read');
});
test('network ambiguity, 5xx and expired claims are quarantined and never blindly retried',async()=>{
  const c={...config('line'),liveEnabled:true};await enableControl(c);
  for(const [remote,mode] of [['Utimeout','timeout'],['Userver','server'],['Uexpired','expired']]) {
    await ingest(line(remote,'incoming-'+mode),c);const command=await approvedReply(c,remote);let calls=0;
    const transport=(async()=>{calls++;if(mode==='timeout') throw new Error('synthetic timeout');return new Response('',{status:503});}) as typeof fetch;
    if(mode==='expired') await database.query("UPDATE social_outbound_commands SET status='sending',attempt_id='fixture',lease_expires_at='2000-01-01T00:00:00Z' WHERE id=$1",[command.commandId]);
    assert.equal((await dispatchSocialReply(org,command.commandId,{config:c,fetch:transport})).status,'unknown');
    assert.equal((await dispatchSocialReply(org,command.commandId,{config:c,fetch:transport})).status,'unknown');assert.equal(calls,mode==='expired'?0:1);
  }
});
test('takeover generation, opt-out and account changes prevent any send',async()=>{
  const c={...config('line'),liveEnabled:true};let calls=0;const transport=(async()=>{calls++;return Response.json({});}) as typeof fetch;
  await ingest(line('Uguard','guard-input'),c);const command=await approvedReply(c,'Uguard');
  await database.query('UPDATE conversations SET version=version+1 WHERE id=$1',[command.conversationId]);
  await assert.rejects(dispatchSocialReply(org,command.commandId,{config:c,fetch:transport}),{status:409});
  await ingest(line('Uoptout','optout-input'),c);const opt=await approvedReply(c,'Uoptout');
  await ingest({destination:c.accountId,events:[{webhookEventId:'unfollow-1',type:'unfollow',timestamp:stamp(),source:{type:'user',userId:'Uoptout'}}]},c);
  assert.equal((await dispatchSocialReply(org,opt.commandId,{config:c,fetch:transport})).status,'cancelled');
  await ingest(line('Uaccount','account-input'),c);const account=await approvedReply(c,'Uaccount');
  await assert.rejects(dispatchSocialReply(org,account.commandId,{config:{...c,accountId:'Uchanged'},fetch:transport}),{status:409});
  assert.equal(calls,0);
});
test('WhatsApp consent and provider reply windows fail closed without making a request',async()=>{
  let calls=0;const transport=(async()=>{calls++;return Response.json({messages:[{id:'must-not-send'}]});}) as typeof fetch;
  const c={...config('whatsapp'),liveEnabled:true};await ingest(wa('66815555555','wa-expired'),c);const expired=await approvedReply(c,'66815555555');
  await database.query("UPDATE social_message_provenance SET provider_timestamp='2000-01-01T00:00:00Z' WHERE org_id=$1 AND provider_message_id='wa-expired'",[org]);
  await assert.rejects(dispatchSocialReply(org,expired.commandId,{config:c,fetch:transport}),/24 hour/);
  await ingest(wa('66816666666','wa-consent'),c);const consent=await approvedReply(c,'66816666666'),i=await identity('whatsapp','66816666666');
  await database.query('UPDATE leads SET contact_consent_at=NULL,contact_consent_version=NULL WHERE id=$1',[i.lead_id]);
  await assert.rejects(dispatchSocialReply(org,consent.commandId,{config:c,fetch:transport}),/consent/);
  const f={...config('facebook'),liveEnabled:true};await ingest(fb('fbexpired','fb-expired'),f);await enableControl(f);const messenger=await approvedReply(f,'fbexpired');
  await database.query("UPDATE social_message_provenance SET provider_timestamp='2000-01-01T00:00:00Z' WHERE org_id=$1 AND provider_message_id='fb-expired'",[org]);
  await assert.rejects(dispatchSocialReply(org,messenger.commandId,{config:f,fetch:transport}),/24 hour/);assert.equal(calls,0);
});
test('emergency stop during an in-flight request aborts and quarantines the uncertain attempt',async()=>{
  const c={...config('line'),liveEnabled:true};await enableControl(c);await ingest(line('Ustop','stop-input'),c);const command=await approvedReply(c,'Ustop');let calls=0;
  const transport=(async(_input,init)=>{
    calls++;await database.query("UPDATE social_channel_controls SET emergency_stop=1,epoch=epoch+1 WHERE org_id=$1 AND provider='line' AND account_id=$2",[org,c.accountId]);
    return new Promise<Response>((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(new Error('Synthetic abort')),{once:true}));
  }) as typeof fetch;
  assert.equal((await dispatchSocialReply(org,command.commandId,{config:c,fetch:transport})).status,'unknown');
  assert.equal((await dispatchSocialReply(org,command.commandId,{config:c,fetch:transport})).status,'unknown');assert.equal(calls,1);
});
test('social snapshots and explicit bootstrap use contiguous tenant-scoped bridge sequence',async()=>{
  const events=(await database.query('SELECT * FROM crm_bridge_events WHERE org_id=$1 ORDER BY sequence',[org])).rows;
  assert.deepEqual(events.map(e=>e.sequence),events.map((_,i)=>i+1));
  for(const entity of ['socialIdentity','messageProvenance','attachment']) assert.ok(events.some(e=>e.entity===entity));
  const p=await provenance('wa-image');const item=events.find(e=>e.entity==='messageProvenance' && e.record_id===p.message_id);assert.ok(item);assert.equal(JSON.parse(item.record_json).id,p.message_id);
  const before=(await database.query('SELECT sequence FROM crm_bridge_state WHERE org_id=$1',[org])).rows[0].sequence;
  await database.query("INSERT OR IGNORE INTO crm_bridge_bootstrap_items(org_id,entity,record_id) VALUES($1,'messageProvenance',$2)",[org,p.message_id]);
  await database.query("INSERT OR IGNORE INTO crm_bridge_bootstrap_items(org_id,entity,record_id) VALUES($1,'messageProvenance',$2)",[org,p.message_id]);
  assert.equal((await database.query('SELECT sequence FROM crm_bridge_state WHERE org_id=$1',[org])).rows[0].sequence,before);
});
