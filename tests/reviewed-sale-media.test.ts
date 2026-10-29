/** Isolated real SQLite, signed source capability, provider effects injected. Never uses global fetch. */
import assert from 'node:assert/strict';
import {randomUUID,createHash,createHmac} from 'node:crypto';
import {before,after,test} from 'node:test';
import {database,closeDatabase} from '../src/lib/db';
import {acceptReviewedSale,reviewedSaleStatus,parseReviewedSale,type ReviewedSaleEnvelope} from '../src/lib/reviewed-sale-messages';
import {ingestSocialWebhook,readSocialConfig,socialConfigFingerprint,dispatchSocialReply} from '../src/lib/social-channels';
import {verifyBridgeRequest,signBridgeRequest} from '../src/lib/bridge-protocol';
import {fetchReviewedPrivateBytes,type ReviewedPrivateFile} from '../src/lib/reviewed-sale-media';
import {downloadSocialAttachment} from '../src/lib/social-media';
import {conversationDetail} from '../src/lib/service';
import {getPrivateBucket} from '../src/lib/files';
import {POST as bridgePost} from '../src/app/api/bridge/[...path]/route';
let org:string,actor:string,number=0,receiptNumber=0,proofValid=true,corrupt=false,failAt=0,earlyAt=0,revokeAt=0,oversizedAt=0,fileOwnerOnly=false;
let archiveHook:''|'revoke'|'remove'|'owner'='',archiveHookFired=false;
const sends:any[]=[],uploads:any[]=[],pdf=new TextEncoder().encode('%PDF-1.7\nSynthetic private quote\n%%EOF'),hash=createHash('sha256').update(pdf).digest('hex');
const file:ReviewedPrivateFile={kind:'private-file',fileId:randomUUID(),sourceRecordKind:'quote',sourceRecordId:randomUUID(),sha256:hash,size:pdf.length,mime:'application/pdf',name:'fixture.pdf'};
async function receipt(mid:string,remote:string,status='read',attempt?:string){
 const c=readSocialConfig('whatsapp'),bytes=new TextEncoder().encode(JSON.stringify({object:'whatsapp_business_account',entry:[{id:c.wabaId,changes:[{field:'messages',value:{metadata:{phone_number_id:c.accountId},statuses:[{id:mid,recipient_id:remote,status,timestamp:String(Math.floor(Date.now()/1000)+receiptNumber++),...(attempt?{biz_opaque_callback_data:attempt}:{})}]}}]}]}));
 return ingestSocialWebhook('whatsapp',bytes,new Headers({'x-hub-signature-256':'sha256='+createHmac('sha256',c.secret).update(bytes).digest('hex')}),c);
}
const transport=(async(input,init)=>{
 const u=new URL(String(input));assert.equal(init?.redirect,'manual');
 if(u.origin==='https://sale.test'){
  const {body}=await verifyBridgeRequest(new Request(input,init),{orgId:org,secret:process.env.CRM_BRIDGE_SECRET!}),p=JSON.parse(body);
  if(archiveHook&&!archiveHookFired){const pending=(await database.query("SELECT a.* FROM social_media_archive a JOIN crm_reviewed_sale_parts part ON part.org_id=a.org_id AND part.attempt_id=a.attachment_id JOIN crm_reviewed_sale_commands command ON command.org_id=part.org_id AND command.outbound_command_id=part.outbound_command_id WHERE a.org_id=$1 AND command.command_id=$2 AND a.status='pending'",[org,p.commandId])).rows[0];if(pending&&await(await getPrivateBucket()).get(pending.object_key)){archiveHookFired=true;if(archiveHook==='revoke')proofValid=false;else if(archiveHook==='remove')await database.query("UPDATE social_message_attachments SET removed_at=$3,storage_state='removed' WHERE org_id=$1 AND id=$2",[org,pending.attachment_id,new Date().toISOString()]);else await database.query("UPDATE social_message_attachments SET metadata=json_set(metadata,'$.sourceOwnerOnly',true) WHERE org_id=$1 AND id=$2",[org,pending.attachment_id]);}}
  if(!proofValid)return Response.json({error:'revoked'},{status:409});
  if(u.pathname.endsWith('/validate'))return Response.json({version:1,valid:true,orgId:org,commandId:p.commandId,payloadHash:p.payloadHash,nonce:p.nonce,sourceRevision:1,checkedAt:Date.now()});
  assert.equal(u.pathname,'/api/rrs/crm/reviewed-messages/file');assert.equal(p.fileId,file.fileId);assert.equal(p.sha256,hash);assert.equal(p.partIndex,1);assert.equal(init?.cache,'no-store');
  const bytes=pdf.slice();if(corrupt)bytes[bytes.length-1]^=1;return new Response(bytes,{headers:{'Content-Type':file.mime,'Content-Length':String(bytes.length),'X-File-SHA256':hash,'X-RRS-Source-Owner-Only':String(fileOwnerOnly)}});
 }
 assert.equal(u.origin,'https://graph.facebook.com');assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer synthetic-never-live');
 if(u.pathname.endsWith('/media')){assert.equal(u.pathname,'/v24.0/1234567890/media');const form=init?.body as FormData,blob=form.get('file') as File;assert.equal(form.get('messaging_product'),'whatsapp');assert.equal(blob.name,file.name);assert.deepEqual(new Uint8Array(await blob.arrayBuffer()),pdf);uploads.push(blob.name);return Response.json({id:String(90000+uploads.length)});}
 assert.equal(u.pathname,'/v24.0/1234567890/messages');const body=JSON.parse(String(init?.body));sends.push(body);const id='fixture-part-'+sends.length;
 if(body.type==='document'){assert.ok(/^\d+$/.test(body.document.id));assert.equal(body.document.filename,file.name);assert.equal(body.document.link,undefined);const archived=(await database.query("SELECT archive.* FROM social_media_archive archive JOIN crm_reviewed_sale_parts part ON part.org_id=archive.org_id AND part.attempt_id=archive.attachment_id WHERE part.org_id=$1 AND part.provider_media_id=$2",[org,body.document.id])).rows[0];assert.equal(archived?.status,'ready','original bytes must be durable before the customer media effect');assert.equal(archived?.sha256,hash);}
 if(earlyAt===sends.length)await receipt(id,body.to,'read',body.biz_opaque_callback_data);
 if(revokeAt===sends.length)proofValid=false;
 if(failAt===sends.length)throw Error('Synthetic response lost');
 if(oversizedAt===sends.length)return new Response(' '.repeat(66000));
 await new Promise(r=>setTimeout(r,5));return Response.json({messages:[{id}]});
}) as typeof fetch;
before(async()=>{
 process.env.DEMO_MODE='true';process.env.D1_LOCAL_DIR='.data/reviewed-media-'+randomUUID();org=randomUUID();actor=randomUUID();Object.assign(process.env,{CRM_BRIDGE_ENABLED:'true',CRM_BRIDGE_ORG_ID:org,CRM_BRIDGE_SECRET:'synthetic-bridge-secret-never-live-ever',CRM_REVIEWED_SALE_ENABLED:'true',CRM_REVIEWED_SALE_SOURCE_ORIGIN:'https://sale.test',CRM_BRIDGE_ALLOWED_MEMBER_IDS:JSON.stringify([actor]),SOCIAL_CHANNELS_ORG_ID:org,SOCIAL_CHANNELS_OWNER:'crm',SOCIAL_INBOUND_ENABLED:'true',SOCIAL_LIVE_ENABLED:'true',WHATSAPP_LIVE_ENABLED:'true',WHATSAPP_PHONE_NUMBER_ID:'1234567890',WHATSAPP_WABA_ID:'9988776655',WHATSAPP_ACCESS_TOKEN:'synthetic-never-live',WHATSAPP_APP_SECRET:'synthetic-secret',WHATSAPP_API_VERSION:'v24.0'});
 await database.query('INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)',[org,org,'Multipart synthetic']);await database.query("INSERT INTO members(id,org_id,name,email,password_hash,role) VALUES($1,$2,'Fixture',$3,'not-a-password','Agent')",[actor,org,actor+'@example.invalid']);
});after(closeDatabase);
async function fixture(extraText=false):Promise<ReviewedSaleEnvelope>{
 number++;proofValid=true;corrupt=false;failAt=0;earlyAt=0;revokeAt=0;oversizedAt=0;fileOwnerOnly=false;archiveHook='';archiveHookFired=false;
 const c=readSocialConfig('whatsapp'),remote='6682'+String(number).padStart(7,'0'),bytes=new TextEncoder().encode(JSON.stringify({object:'whatsapp_business_account',entry:[{id:c.wabaId,changes:[{field:'messages',value:{metadata:{phone_number_id:c.accountId},messages:[{id:'inbound-media-'+number,from:remote,timestamp:String(Math.floor(Date.now()/1000)-1),type:'text',text:{body:'Synthetic inbound'}}]}}]}]}));
 await ingestSocialWebhook('whatsapp',bytes,new Headers({'x-hub-signature-256':'sha256='+createHmac('sha256',c.secret).update(bytes).digest('hex')}),c);
 const i=(await database.query('SELECT * FROM social_identities WHERE org_id=$1 AND remote_id=$2',[org,remote])).rows[0];await database.query("UPDATE conversations SET status='human_active',assignee_id=$3,version=version+1 WHERE org_id=$1 AND id=$2",[org,i.conversation_id,actor]);await database.query('UPDATE leads SET contact_consent_at=$3,contact_consent_version=$4 WHERE org_id=$1 AND id=$2',[org,i.lead_id,new Date().toISOString(),'fixture-consent']);
 await database.query("UPDATE social_channel_controls SET send_enabled=1,emergency_stop=0,send_mode='live',verified_at=$4,verification_fingerprint=$5,verification_expires_at=$6 WHERE org_id=$1 AND provider=$2 AND account_id=$3",[org,'whatsapp',c.accountId,new Date().toISOString(),socialConfigFingerprint(c),new Date(Date.now()+86400000).toISOString()]);
 const v=(await database.query('SELECT * FROM conversations WHERE org_id=$1 AND id=$2',[org,i.conversation_id])).rows[0],text='Exact reviewed private quote';
 return {version:1,kind:'reviewed-sale-message',commandId:randomUUID(),conversationId:v.id,expectedVersion:v.version,expectedCustomerSeq:v.customer_message_seq,actorId:actor,provider:'whatsapp',accountId:c.accountId,remoteId:remote,text,template:null,parts:[{kind:'text',text},file,...extraText?[{kind:'text' as const,text:'https://example.invalid/reviewed-link'}]:[]],source:{system:'rrs-sale-office',workspace:'live',messageId:randomUUID(),messageHash:'1'.repeat(64),consentHash:'2'.repeat(64),ruleHash:'3'.repeat(64),reviewedBy:'fixture-owner',mode:'manual',reviewAuditId:''}};
}
async function parts(id:string){return (await database.query('SELECT * FROM crm_reviewed_sale_parts WHERE org_id=$1 AND outbound_command_id=$2 ORDER BY part_index',[org,id])).rows;}
test('actual signed bridge route accepts immutable multipart fields and rejects unsupported additions',async()=>{
 const p=await fixture(),before=sends.length,originalFetch=globalThis.fetch;globalThis.fetch=transport;
 const call=async(payload:unknown)=>{const url='https://crm.test/api/bridge/reviewed-messages',body=JSON.stringify(payload);return bridgePost(new Request(url,{method:'POST',body,headers:await signBridgeRequest(url,{orgId:org,secret:process.env.CRM_BRIDGE_SECRET!,method:'POST',body})}));};
 try{const response=await call(p);assert.equal(response.status,200);assert.match(response.headers.get('cache-control')!,/no-store/);const result=await response.json();assert.equal(result.status,'submitted');assert.equal((await parts(result.outboundCommandId)).length,2);assert.equal(sends.length,before+2);assert.equal((await call(p)).status,200);assert.equal(sends.length,before+2);assert.equal((await call({...p,url:'https://untrusted.invalid'})).status,400);}finally{globalThis.fetch=originalFetch;}
});
test('concurrent acceptance sends each immutable part once and aggregates receipts by the slowest part',async()=>{
 const p=await fixture(),before=sends.length;await Promise.all([acceptReviewedSale(p,{fetch:transport}),acceptReviewedSale(p,{fetch:transport})]);const result=await reviewedSaleStatus(p.commandId),rows=await parts(result.outboundCommandId);assert.equal(result.status,'submitted');assert.equal(sends.length,before+2);assert.equal(rows.length,2);assert.ok(rows.every(r=>r.status==='submitted'&&r.attempt_id));
 await receipt(rows[0].provider_message_id,p.remoteId,'read');assert.equal((await reviewedSaleStatus(p.commandId)).status,'submitted');await receipt(rows[1].provider_message_id,'66829999999','read');assert.equal((await reviewedSaleStatus(p.commandId)).status,'submitted');
 await receipt(rows[1].provider_message_id,p.remoteId,'delivered');assert.equal((await reviewedSaleStatus(p.commandId)).status,'delivered');await receipt(rows[1].provider_message_id,p.remoteId,'sent');assert.equal((await reviewedSaleStatus(p.commandId)).status,'delivered');await receipt(rows[1].provider_message_id,p.remoteId,'read');assert.equal((await reviewedSaleStatus(p.commandId)).status,'read');
 await acceptReviewedSale(p,{fetch:transport});assert.equal(sends.length,before+2);await assert.rejects(database.query("UPDATE crm_reviewed_sale_parts SET payload_json='{}' WHERE org_id=$1 AND outbound_command_id=$2",[org,result.outboundCommandId]),/immutable/);
});
test('source hash corruption or permission revocation stops later parts without exposing a file URL',async()=>{
 const p=await fixture(),before=sends.length,uploadBefore=uploads.length;corrupt=true;const result=await acceptReviewedSale(p,{fetch:transport});assert.equal(result.status,'unknown');assert.equal(result.errorCode,'partial_delivery');assert.equal(sends.length,before+1);assert.equal(uploads.length,uploadBefore);await acceptReviewedSale(p,{fetch:transport});assert.equal(sends.length,before+1);
 const revoked=await fixture(),at=sends.length;revokeAt=at+1;const stopped=await acceptReviewedSale(revoked,{fetch:transport});assert.equal(stopped.status,'unknown');assert.equal(sends.length,at+1);proofValid=true;
});
test('ambiguous media send quarantines the group, cancels unattempted parts and late exact receipts never resend',async()=>{
 const p=await fixture(true),before=sends.length;failAt=before+2;const result=await acceptReviewedSale(p,{fetch:transport}),rows=await parts(result.outboundCommandId);assert.equal(result.status,'unknown');assert.equal(result.errorCode,'partial_delivery');assert.deepEqual(rows.map(r=>r.status),['submitted','unknown','cancelled']);await dispatchSocialReply(org,result.outboundCommandId,{fetch:transport});await acceptReviewedSale(p,{fetch:transport});assert.equal(sends.length,before+2);
 await receipt('late-fixture-'+number,p.remoteId,'delivered',rows[1].attempt_id);assert.equal((await parts(result.outboundCommandId))[1].status,'delivered');assert.equal((await reviewedSaleStatus(p.commandId)).status,'unknown');assert.equal(sends.length,before+2);
 assert.deepEqual(new Uint8Array(await(await downloadSocialAttachment(org,rows[1].attempt_id,async()=>{throw Error('Provider expiry cannot replace the preserved source copy');})).arrayBuffer()),pdf);
});
test('provider callback arriving before response resolves only its part and is never downgraded',async()=>{
 const p=await fixture(),before=sends.length;earlyAt=before+2;const result=await acceptReviewedSale(p,{fetch:transport}),rows=await parts(result.outboundCommandId);assert.deepEqual(rows.map(r=>r.status),['submitted','read']);assert.equal(result.status,'submitted');await receipt(rows[0].provider_message_id,p.remoteId,'read');assert.equal((await reviewedSaleStatus(p.commandId)).status,'read');
});
test('reviewed public links stay text; oversized accepted-provider responses are ambiguous and never retried',async()=>{
 const p=await fixture(true),before=sends.length,result=await acceptReviewedSale(p,{fetch:transport});assert.equal(result.status,'submitted');assert.equal(sends.length,before+3);assert.equal(sends.at(-1).type,'text');assert.equal(sends.at(-1).text.body,'https://example.invalid/reviewed-link');
 const next=await fixture(),at=sends.length;oversizedAt=at+1;const unknown=await acceptReviewedSale(next,{fetch:transport});assert.equal(unknown.status,'unknown');assert.deepEqual((await parts(unknown.outboundCommandId)).map(r=>r.status),['unknown','cancelled']);await acceptReviewedSale(next,{fetch:transport});assert.equal(sends.length,at+1);
});
test('outgoing native attachment preserves status, private archive, exact bytes and owner restrictions',async()=>{
 const p=await fixture();fileOwnerOnly=true;p.parts![1]={...file,ownerOnly:true};const result=await acceptReviewedSale(p,{fetch:transport}),rows=await parts(result.outboundCommandId),attachment=(await database.query('SELECT * FROM social_message_attachments WHERE org_id=$1 AND id=$2',[org,rows[1].attempt_id])).rows[0];
 assert.equal(attachment.provider_ref,rows[1].provider_media_id);assert.equal(attachment.metadata.deliveryStatus,'submitted');assert.equal(attachment.metadata.sha256,hash);assert.equal(attachment.metadata.sourceOwnerOnly,true);
 const provenance=(await database.query('SELECT metadata FROM social_message_provenance WHERE org_id=$1 AND message_id=$2',[org,result.messageId])).rows[0];assert.equal(provenance.metadata.multipart.parts[1].name,undefined);assert.equal(provenance.metadata.multipart.parts[1].sha256,undefined);
 const detail=await conversationDetail(org,p.conversationId,true,true),message=detail.messages.find(m=>m.id===result.messageId) as any;assert.equal(message.attachments[0].name,file.name);assert.equal(message.attachments[0].deliveryStatus,'submitted');assert.equal(message.attachments[0].provider_ref,undefined);
 assert.equal((await conversationDetail(org,p.conversationId,true,false)).messages.find(m=>m.id===result.messageId)?.attachments?.length,0);assert.equal((await conversationDetail(org,p.conversationId,false)).messages.find(m=>m.id===result.messageId)?.attachments,undefined);
 const stored=(await database.query('SELECT * FROM social_media_archive WHERE org_id=$1 AND attachment_id=$2',[org,attachment.id])).rows[0];assert.equal(stored.status,'ready');assert.equal(stored.sha256,hash);assert.equal(stored.size_bytes,pdf.length);assert.equal(attachment.storage_state,'archived');
 let downloads=0;const changed=pdf.slice();changed[changed.length-1]^=1;const download=(async()=>{downloads++;return new Response(changed,{headers:{'Content-Type':file.mime}});}) as typeof fetch;
 await assert.rejects(downloadSocialAttachment(randomUUID(),attachment.id,download,true),{status:404});await assert.rejects(downloadSocialAttachment(org,attachment.id,download,false),{status:403});assert.equal(downloads,0);
 const archived=await downloadSocialAttachment(org,attachment.id,download,true);assert.equal(archived.headers.get('cache-control'),'private, no-store, no-transform');assert.deepEqual(new Uint8Array(await archived.arrayBuffer()),pdf);const count=downloads;
 assert.deepEqual(new Uint8Array(await(await downloadSocialAttachment(org,attachment.id,async()=>{downloads++;return new Response(null,{status:410});},true)).arrayBuffer()),pdf);assert.equal(downloads,0);assert.equal(downloads,count);await assert.rejects(downloadSocialAttachment(org,attachment.id,download,false),{status:403});
 await database.query('UPDATE social_message_provenance SET removed_at=$3 WHERE org_id=$1 AND message_id=$2',[org,result.messageId,new Date().toISOString()]);await receipt(rows[1].provider_message_id,p.remoteId,'read');await assert.rejects(downloadSocialAttachment(org,attachment.id,download,true),{status:404});
});
test('archive quota failure prevents the customer media effect and never resends the partial group',async()=>{
 const p=await fixture(),before=sends.length,previous=process.env.FILE_STORAGE_LIMIT_BYTES;process.env.FILE_STORAGE_LIMIT_BYTES='1';
 try{const result=await acceptReviewedSale(p,{fetch:transport}),rows=await parts(result.outboundCommandId);assert.equal(sends.length,before+1);assert.equal(result.status,'unknown');assert.equal(result.errorCode,'partial_delivery');assert.deepEqual(rows.map(r=>r.status),['submitted','cancelled']);assert.equal((await database.query('SELECT 1 FROM social_media_archive WHERE org_id=$1 AND attachment_id=$2',[org,rows[1].attempt_id])).rows.length,0);await assert.rejects(downloadSocialAttachment(org,rows[1].attempt_id,async()=>{throw Error('Cancelled attachment must remain inaccessible');}),{status:404});await acceptReviewedSale(p,{fetch:transport});assert.equal(sends.length,before+1);}finally{if(previous===undefined)delete process.env.FILE_STORAGE_LIMIT_BYTES;else process.env.FILE_STORAGE_LIMIT_BYTES=previous;}
});
test('review revocation, unsend and tightened owner access during R2 archival stop the customer media effect',async()=>{
 for(const kind of ['revoke','remove','owner'] as const){const p=await fixture(),before=sends.length;archiveHook=kind;const result=await acceptReviewedSale(p,{fetch:transport}),rows=await parts(result.outboundCommandId);assert.equal(archiveHookFired,true);assert.equal(sends.length,before+1);assert.equal(result.status,'unknown');assert.equal(rows[1].status,'cancelled');assert.equal((await database.query('SELECT status FROM social_media_archive WHERE org_id=$1 AND attachment_id=$2',[org,rows[1].attempt_id])).rows[0].status,'pending');await assert.rejects(downloadSocialAttachment(org,rows[1].attempt_id,async()=>{throw Error('Revoked attachment must remain inaccessible');},true),{status:404});proofValid=true;await acceptReviewedSale(p,{fetch:transport});assert.equal(sends.length,before+1);}
});
test('delivery failure after submission makes partial status explicit; expired claims do not retry',async()=>{
 const p=await fixture(),r=await acceptReviewedSale(p,{fetch:transport}),rows=await parts(r.outboundCommandId);await receipt(rows[1].provider_message_id,p.remoteId,'failed');assert.equal((await reviewedSaleStatus(p.commandId)).status,'unknown');assert.equal((await reviewedSaleStatus(p.commandId)).errorCode,'partial_delivery');
 const stale=await fixture(),queued=await acceptReviewedSale(stale,{fetch:transport,dispatch:false}),before=sends.length;await database.query("UPDATE social_outbound_commands SET status='sending',lease_expires_at='2000-01-01' WHERE org_id=$1 AND id=$2",[org,queued.outboundCommandId]);await database.query("UPDATE crm_reviewed_sale_parts SET status='sending',attempt_id=$3 WHERE org_id=$1 AND outbound_command_id=$2 AND part_index=0",[org,queued.outboundCommandId,randomUUID()]);assert.equal((await dispatchSocialReply(org,queued.outboundCommandId,{fetch:transport})).status,'unknown');assert.equal(sends.length,before);assert.deepEqual((await parts(queued.outboundCommandId)).map(r=>r.status),['unknown','cancelled']);
});
test('arbitrary URL/file fields, unapproved formats, redirects, cross-org and size mismatches fail closed',async()=>{
 const p=await fixture();for(const invalid of [{...file,url:'https://private.invalid'}, {...file,mime:'audio/wav'},{...file,size:21*1024*1024},{...file,name:'../secret.pdf'}])assert.throws(()=>parseReviewedSale({...p,parts:[p.parts![0],invalid]}),{status:400});
 const row={org_id:org,command_id:p.commandId,payload_hash:'f'.repeat(64)};await assert.rejects(fetchReviewedPrivateBytes({...row,org_id:randomUUID()},1,file,transport,new AbortController().signal),{status:403});
 await assert.rejects(fetchReviewedPrivateBytes(row,1,file,async()=>new Response(null,{status:302,headers:{Location:'https://private.invalid'}}),new AbortController().signal),{status:409});
 await assert.rejects(fetchReviewedPrivateBytes(row,1,file,async()=>new Response(new Uint8Array(pdf.length+1),{headers:{'Content-Type':file.mime,'X-File-SHA256':hash}}),new AbortController().signal),{status:413});
});
