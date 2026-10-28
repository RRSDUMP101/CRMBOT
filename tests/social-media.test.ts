/** Isolated SQLite/local bucket and injected transports only. No real provider or source calls. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {before,after,test} from 'node:test';
import {database,closeDatabase} from '../src/lib/db';
import {downloadSocialAttachment} from '../src/lib/social-media';
import {getPrivateBucket} from '../src/lib/files';
import {verifyBridgeRequest} from '../src/lib/bridge-protocol';

type Scope={orgId:string;leadId:string;conversationId:string;staffId:string};
const fixtureBytes=Buffer.from('%PDF-1.7\nSynthetic private fixture only.');
const checksum=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
const bridgeSecret='fixture-only-migration-signature-secret-32-characters';
const account=(provider:string)=>provider==='line'?'UfixtureMediaBot':provider==='whatsapp'?'1234567890':provider==='facebook'?'2234567890':'legacy-source';
let scope:Scope,other:Scope;
const savedEnvironment={...process.env},originalFetch=globalThis.fetch;
async function newScope():Promise<Scope>{
  const orgId=randomUUID(),leadId=randomUUID(),conversationId=randomUUID(),staffId=randomUUID();
  await database.query('INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)',[orgId,orgId,'Synthetic media fixtures']);
  await database.query("INSERT INTO members(id,org_id,name,email,password_hash,role) VALUES($1,$2,'Fixture admin',$3,'not-a-password','Admin')",[staffId,orgId,staffId+'@example.invalid']);
  await database.query("INSERT INTO leads(id,org_id,name,source,market) VALUES($1,$2,'Synthetic media customer','line','domestic')",[leadId,orgId]);
  await database.query("INSERT INTO conversations(id,org_id,lead_id,status) VALUES($1,$2,$3,'waiting_human')",[conversationId,orgId,leadId]);
  return {orgId,leadId,conversationId,staffId};
}
function configure(orgId=scope.orgId){
  Object.assign(process.env,{SOCIAL_CHANNELS_ORG_ID:orgId,LINE_BOT_USER_ID:account('line'),LINE_CHANNEL_ACCESS_TOKEN:'fixture-line-token',WHATSAPP_PHONE_NUMBER_ID:account('whatsapp'),WHATSAPP_ACCESS_TOKEN:'fixture-whatsapp-token',WHATSAPP_API_VERSION:'v24.0',META_PAGE_ID:account('facebook'),META_PAGE_ACCESS_TOKEN:'fixture-facebook-token',META_API_VERSION:'v24.0',CRM_BRIDGE_ORG_ID:orgId,CRM_BRIDGE_SECRET:bridgeSecret,CRM_LEGACY_SOURCE_ORIGIN:'https://source.example.invalid',FILE_STORAGE_LIMIT_BYTES:'104857600'});
}
async function attachment(provider='line',ref='fixture-message-id',metadata:Record<string,unknown>={},target=scope){
  const id=randomUUID(),messageId=randomUUID();
  await database.query("INSERT INTO messages(id,org_id,conversation_id,role,content) VALUES($1,$2,$3,'user','[synthetic attachment]')",[messageId,target.orgId,target.conversationId]);
  await database.query("INSERT INTO social_message_provenance(org_id,message_id,provider,account_id,remote_id,provider_type,direction,delivery_status,provider_timestamp) VALUES($1,$2,$3,$4,'synthetic-remote','file','in','received',$5)",[target.orgId,messageId,provider,account(provider),new Date().toISOString()]);
  await database.query("INSERT INTO social_message_attachments(id,org_id,message_id,provider,account_id,media_type,provider_ref,metadata) VALUES($1,$2,$3,$4,$5,'file',$6,$7)",[id,target.orgId,messageId,provider,account(provider),ref,JSON.stringify(metadata)]);
  return {id,messageId};
}
const fileResponse=(value:Uint8Array=fixtureBytes,headers:Record<string,string>={})=>new Response(new Uint8Array(value).buffer,{headers:{'Content-Type':'application/pdf','Content-Length':String(value.byteLength),...headers}});
const failTransport=(async()=>{throw new Error('Unexpected transport call');}) as typeof fetch;
const archived=async(orgId:string,id:string)=>(await database.query('SELECT * FROM social_media_archive WHERE org_id=$1 AND attachment_id=$2',[orgId,id])).rows[0];
async function assertPrivate(response:Response,expected:Uint8Array=fixtureBytes){
  assert.equal(response.headers.get('cache-control'),'private, no-store, no-transform');
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  assert.equal(response.headers.get('content-security-policy'),"default-src 'none'; sandbox");
  assert.match(response.headers.get('content-disposition')!,/^attachment;/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),Buffer.from(expected));
}

before(async()=>{
  process.env.DEMO_MODE='true';process.env.D1_LOCAL_DIR=`.data/social-media-${randomUUID()}`;delete process.env.RRS_WORKERS;
  globalThis.fetch=failTransport;
  await database.query('SELECT 1');scope=await newScope();other=await newScope();configure();
});
after(async()=>{await closeDatabase();globalThis.fetch=originalFetch;for(const key of Object.keys(process.env))if(!(key in savedEnvironment))delete process.env[key];Object.assign(process.env,savedEnvironment);});

test('LINE fixed-host fetch archives private bytes and future reads use only the local archive',async()=>{
  configure();const a=await attachment('line','/api/domestic/provider-media?messageId=fixture-line-media');let calls=0;
  const transport=(async(input,init)=>{calls++;assert.equal(String(input),'https://api-data.line.me/v2/bot/message/fixture-line-media/content');assert.equal(init?.redirect,'manual');assert.equal(new Headers(init?.headers).get('authorization'),'Bearer fixture-line-token');return fileResponse();}) as typeof fetch;
  await assertPrivate(await downloadSocialAttachment(scope.orgId,a.id,transport));
  const row=await archived(scope.orgId,a.id);assert.equal(row.status,'ready');assert.equal(row.sha256,checksum(fixtureBytes));assert.equal(row.size_bytes,fixtureBytes.length);
  assert.ok(await(await getPrivateBucket()).get(row.object_key));
  await assertPrivate(await downloadSocialAttachment(scope.orgId,a.id,failTransport));assert.equal(calls,1);
});

test('WhatsApp resolves media metadata on fixed Graph host and archives only an allowed CDN URL',async()=>{
  configure();const a=await attachment('whatsapp','provider:whatsapp:fixture-wa-media');const seen:string[]=[];
  const transport=(async(input,init)=>{seen.push(String(input));assert.equal(init?.redirect,'manual');assert.equal(new Headers(init?.headers).get('authorization'),'Bearer fixture-whatsapp-token');return seen.length===1?Response.json({url:'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=fixture'}):fileResponse();}) as typeof fetch;
  await assertPrivate(await downloadSocialAttachment(scope.orgId,a.id,transport));
  assert.deepEqual(seen,['https://graph.facebook.com/v24.0/fixture-wa-media','https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=fixture']);
  await assertPrivate(await downloadSocialAttachment(scope.orgId,a.id,failTransport));
});

test('Facebook signed CDN URL receives no access token and roundtrips from private storage',async()=>{
  configure();const a=await attachment('facebook','https://scontent.fixture.fbcdn.net/private/file?signature=fixture');let calls=0;
  const transport=(async(input,init)=>{calls++;assert.equal(String(input),'https://scontent.fixture.fbcdn.net/private/file?signature=fixture');assert.equal(new Headers(init?.headers).get('authorization'),null);assert.equal(init?.redirect,'manual');return fileResponse();}) as typeof fetch;
  await assertPrivate(await downloadSocialAttachment(scope.orgId,a.id,transport));
  await assertPrivate(await downloadSocialAttachment(scope.orgId,a.id,failTransport));assert.equal(calls,1);
});

test('cross-organization, missing and removed attachment requests fail before any transport',async()=>{
  configure();const a=await attachment();
  await assert.rejects(downloadSocialAttachment(other.orgId,a.id,failTransport),{status:404});
  await assert.rejects(downloadSocialAttachment(scope.orgId,randomUUID(),failTransport),{status:404});
  await database.query("UPDATE social_message_attachments SET storage_state='removed',removed_at=$3 WHERE org_id=$1 AND id=$2",[scope.orgId,a.id,new Date().toISOString()]);
  await assert.rejects(downloadSocialAttachment(scope.orgId,a.id,failTransport),{status:404});assert.equal(await archived(scope.orgId,a.id),undefined);
});

test('wrong configured organization or account cannot retrieve provider media',async()=>{
  configure();const a=await attachment();
  process.env.LINE_BOT_USER_ID='UwrongBot';await assert.rejects(downloadSocialAttachment(scope.orgId,a.id,failTransport),{status:503});
  configure(other.orgId);await assert.rejects(downloadSocialAttachment(scope.orgId,a.id,failTransport),{status:503});configure();
});

test('redirects, arbitrary hosts, credential URLs and provider-reference injection never get followed',async()=>{
  configure();const line=await attachment();let calls=0;
  const redirect=(async(_url,init)=>{calls++;assert.equal(init?.redirect,'manual');return new Response(null,{status:302,headers:{Location:'http://127.0.0.1/private'}});}) as typeof fetch;
  await assert.rejects(downloadSocialAttachment(scope.orgId,line.id,redirect),{status:502});assert.equal(calls,1);
  for(const ref of ['https://127.0.0.1/private','http://lookaside.fbsbx.com/file','https://lookaside.fbsbx.com.evil.invalid/file','https://lookaside.fbsbx.com:444/file','https://user:password@lookaside.fbsbx.com/file','https://lookaside.fbsbx.com/file#fragment']){
    const a=await attachment('facebook',ref);await assert.rejects(downloadSocialAttachment(scope.orgId,a.id,failTransport));assert.equal(await archived(scope.orgId,a.id),undefined);
  }
  const wa=await attachment('whatsapp','fixture-ssrf');let infoCalls=0;
  await assert.rejects(downloadSocialAttachment(scope.orgId,wa.id,(async()=>{infoCalls++;return Response.json({url:'https://169.254.169.254/metadata'});}) as typeof fetch),{status:502});assert.equal(infoCalls,1);
  const injected=await attachment('line','../private?token=anything');await assert.rejects(downloadSocialAttachment(scope.orgId,injected.id,failTransport),{status:409});
});

test('oversized provider content is rejected before reserving private storage',async()=>{
  configure();const a=await attachment();
  await assert.rejects(downloadSocialAttachment(scope.orgId,a.id,(async()=>fileResponse(fixtureBytes,{'Content-Length':String(25*1024*1024+1)})) as typeof fetch),{status:413});
  assert.equal(await archived(scope.orgId,a.id),undefined);assert.equal(await(await getPrivateBucket()).get(`${scope.orgId}/${a.id}`),null);
});

test('pending social reservations and native uploads consume the shared organization quota',async()=>{
  const quota=await newScope();configure(quota.orgId);process.env.FILE_STORAGE_LIMIT_BYTES='10';
  const pending=await attachment('line','quota-reserved',{},quota),denied=await attachment('line','quota-denied',{},quota);
  await database.query("INSERT INTO social_media_archive(org_id,attachment_id,object_key,size_bytes,content_type,sha256,status,created_at) VALUES($1,$2,$3,6,'application/pdf','fixture','pending',$4)",[quota.orgId,pending.id,`${quota.orgId}/${pending.id}`,new Date().toISOString()]);
  await assert.rejects(downloadSocialAttachment(quota.orgId,denied.id,(async()=>fileResponse(Buffer.from('12345'))) as typeof fetch),{status:409});
  assert.equal(await archived(quota.orgId,denied.id),undefined);assert.equal(await(await getPrivateBucket()).get(`${quota.orgId}/${denied.id}`),null);
  const native=await newScope();configure(native.orgId);process.env.FILE_STORAGE_LIMIT_BYTES='10';const a=await attachment('line','native-quota',{},native),nativeId=randomUUID();
  await database.query("INSERT INTO attachments(id,org_id,lead_id,uploaded_by,object_key,filename,content_type,size_bytes) VALUES($1,$2,$3,$4,$5,'fixture.pdf','application/pdf',6)",[nativeId,native.orgId,native.leadId,native.staffId,`${native.orgId}/${nativeId}`]);
  await assert.rejects(downloadSocialAttachment(native.orgId,a.id,(async()=>fileResponse(Buffer.from('12345'))) as typeof fetch),{status:409});configure();
});

test('concurrent archives cannot overcommit quota',async()=>{
  const quota=await newScope();configure(quota.orgId);process.env.FILE_STORAGE_LIMIT_BYTES='8';
  const first=await attachment('line','quota-one',{},quota),second=await attachment('line','quota-two',{},quota);
  const transport=(async()=>fileResponse(Buffer.from('12345'))) as typeof fetch;
  const results=await Promise.allSettled([downloadSocialAttachment(quota.orgId,first.id,transport),downloadSocialAttachment(quota.orgId,second.id,transport)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.status===409).length,1);
  for(const result of results)if(result.status==='fulfilled')await assertPrivate(result.value,Buffer.from('12345'));
  assert.equal((await database.query('SELECT SUM(size_bytes) AS total FROM social_media_archive WHERE org_id=$1',[quota.orgId])).rows[0].total,5);configure();
});

test('sourceOwnerOnly and sourceScopeUnknown remain restricted even after administrator archival',async()=>{
  configure();for(const property of ['sourceOwnerOnly','sourceScopeUnknown']){
    const a=await attachment('line','restricted-'+property,{[property]:true});let calls=0;
    const transport=(async()=>{calls++;return fileResponse();}) as typeof fetch;
    await assert.rejects(downloadSocialAttachment(scope.orgId,a.id,transport),{status:403});assert.equal(calls,0);
    await assertPrivate(await downloadSocialAttachment(scope.orgId,a.id,transport,true));assert.equal(calls,1);
    await assert.rejects(downloadSocialAttachment(scope.orgId,a.id,failTransport),{status:403});
  }
});

test('legacy file request uses exact signed workspace scope and verifies source checksum',async()=>{
  configure();const a=await attachment('legacy','legacy-ref',{sourceWorkspace:'domestic',originalRef:'/api/rrs/files?id=fixture-file'});let calls=0;
  const transport=(async(input,init)=>{
    calls++;assert.equal(String(input),'https://source.example.invalid/api/rrs/chat-migration/files?workspace=domestic&id=fixture-file');assert.equal(init?.redirect,'manual');assert.equal(new Headers(init?.headers).get('authorization'),null);
    await verifyBridgeRequest(new Request(String(input),init),{secret:bridgeSecret,orgId:scope.orgId});
    return fileResponse(fixtureBytes,{'x-file-sha256':checksum(fixtureBytes),'x-rrs-source-owner-only':'false'});
  }) as typeof fetch;
  await assertPrivate(await downloadSocialAttachment(scope.orgId,a.id,transport));await assertPrivate(await downloadSocialAttachment(scope.orgId,a.id,failTransport));assert.equal(calls,1);
  const bad=await attachment('legacy','bad-legacy-ref',{sourceWorkspace:'live',originalRef:'/api/rrs/files?id=bad-checksum'});
  await assert.rejects(downloadSocialAttachment(scope.orgId,bad.id,(async()=>fileResponse(fixtureBytes,{'x-file-sha256':'0'.repeat(64)})) as typeof fetch),{status:502});assert.equal(await archived(scope.orgId,bad.id),undefined);
  const missing=await attachment('legacy','missing-checksum',{sourceWorkspace:'live',originalRef:'/api/rrs/files?id=missing-checksum'});
  await assert.rejects(downloadSocialAttachment(scope.orgId,missing.id,(async()=>fileResponse()) as typeof fetch),{status:502});assert.equal(await archived(scope.orgId,missing.id),undefined);
});

test('legacy source permissions and unsafe configured origins fail closed',async()=>{
  configure();const a=await attachment('legacy','legacy-permission',{sourceWorkspace:'live',originalRef:'/api/rrs/files?id=owner-only'});
  await assert.rejects(downloadSocialAttachment(scope.orgId,a.id,(async()=>fileResponse(fixtureBytes,{'x-file-sha256':checksum(fixtureBytes),'x-rrs-source-owner-only':'true'})) as typeof fetch),{status:403});assert.equal(await archived(scope.orgId,a.id),undefined);
  for(const origin of ['http://source.example.invalid','https://source.example.invalid/path','https://user:password@source.example.invalid']){
    process.env.CRM_LEGACY_SOURCE_ORIGIN=origin;await assert.rejects(downloadSocialAttachment(scope.orgId,a.id,failTransport),{status:503});
  }
  configure(other.orgId);await assert.rejects(downloadSocialAttachment(scope.orgId,a.id,failTransport),{status:503});configure();
});

test('a changed provider payload cannot replace a reserved object and missing archive bytes fail closed',async()=>{
  configure();const reserved=await attachment('line','fixture-changed');
  await database.query("INSERT INTO social_media_archive(org_id,attachment_id,object_key,size_bytes,content_type,sha256,status,created_at) VALUES($1,$2,$3,5,'application/pdf',$4,'pending',$5)",[scope.orgId,reserved.id,`${scope.orgId}/${reserved.id}`,checksum(Buffer.from('prior')),new Date().toISOString()]);
  await assert.rejects(downloadSocialAttachment(scope.orgId,reserved.id,(async()=>fileResponse()) as typeof fetch),{status:409});
  assert.equal((await archived(scope.orgId,reserved.id)).status,'pending');assert.equal(await(await getPrivateBucket()).get(`${scope.orgId}/${reserved.id}`),null);
  const missing=await attachment('line','fixture-missing-object');
  await database.query("INSERT INTO social_media_archive(org_id,attachment_id,object_key,size_bytes,content_type,sha256,status,created_at) VALUES($1,$2,$3,$4,'application/pdf',$5,'ready',$6)",[scope.orgId,missing.id,`${scope.orgId}/${missing.id}`,fixtureBytes.length,checksum(fixtureBytes),new Date().toISOString()]);
  await assert.rejects(downloadSocialAttachment(scope.orgId,missing.id,failTransport),{status:503});
});

test('source-derived owner restriction is persisted so cached bytes cannot bypass it',async()=>{
  configure();const a=await attachment('legacy','legacy-restricted',{sourceWorkspace:'live',originalRef:'/api/rrs/files?id=owner-restricted'});
  const transport=(async(input)=>{assert.match(String(input),/&owner=true$/);return fileResponse(fixtureBytes,{'x-file-sha256':checksum(fixtureBytes),'x-rrs-source-owner-only':'true'});}) as typeof fetch;
  await assertPrivate(await downloadSocialAttachment(scope.orgId,a.id,transport,true));
  await assert.rejects(downloadSocialAttachment(scope.orgId,a.id,failTransport),{status:403});
});

test('permissions tightened during a fetch are rechecked before returning archived bytes',async()=>{
  configure();const a=await attachment();
  const transport=(async()=>{await database.query('UPDATE social_message_attachments SET metadata=$3 WHERE org_id=$1 AND id=$2',[scope.orgId,a.id,JSON.stringify({sourceOwnerOnly:true})]);return fileResponse();}) as typeof fetch;
  await assert.rejects(downloadSocialAttachment(scope.orgId,a.id,transport),{status:403});
});

test('unsend during provider fetch leaves no downloadable archive and later reads stay denied',async()=>{
  configure();const a=await attachment();
  const transport=(async()=>{await database.query("UPDATE social_message_attachments SET provider_ref='',removed_at=$3,storage_state='removed' WHERE org_id=$1 AND id=$2",[scope.orgId,a.id,new Date().toISOString()]);return fileResponse();}) as typeof fetch;
  await assert.rejects(downloadSocialAttachment(scope.orgId,a.id,transport),{status:404});
  assert.equal(await archived(scope.orgId,a.id),undefined);assert.equal(await(await getPrivateBucket()).get(`${scope.orgId}/${a.id}`),null);
  await assert.rejects(downloadSocialAttachment(scope.orgId,a.id,failTransport),{status:404});
});
