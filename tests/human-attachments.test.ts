import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {createHmac,randomUUID} from 'node:crypto';
import {database,closeDatabase} from '../src/lib/db';
import {ingestSocialWebhook,dispatchSocialReply,socialConfigFingerprint,type SocialChannelConfig,type SocialProvider} from '../src/lib/social-channels';
import {approveHumanAttachment,downloadHumanAttachment,uploadHumanAttachment,listHumanAttachments,downloadHumanAttachmentGrant,sweepExpiredHumanAttachments} from '../src/lib/human-attachments';
import {downloadSocialAttachment} from '../src/lib/social-media';
import {getPrivateBucket} from '../src/lib/files';
import {hashToken,type Staff} from '../src/lib/auth';
import {GET,POST} from '../src/app/api/admin/conversations/[id]/attachments/[[...path]]/route';

const old={...process.env},originalFetch=globalThis.fetch,pdf=Buffer.from('%PDF-1.7\nSynthetic private quote\n%%EOF');
before(async()=>{Object.assign(process.env,{DEMO_MODE:'true',RRS_WORKERS:'false',AI_PROVIDER:'disabled',D1_LOCAL_DIR:'.data/human-files-'+randomUUID(),CRM_HUMAN_ATTACHMENTS_ENABLED:'true',APP_ORIGIN:'http://localhost:3000'});delete process.env.FLOWS_ENABLED;globalThis.fetch=(async()=>{throw Error('Real network forbidden');}) as typeof fetch;await database.query('SELECT 1');});
after(async()=>{await closeDatabase();globalThis.fetch=originalFetch;for(const k of Object.keys(process.env))if(!(k in old))delete process.env[k];Object.assign(process.env,old);});
async function fixture(provider:SocialProvider='whatsapp'){
  const org=randomUUID(),member=randomUUID(),other=randomUUID();await database.query('INSERT INTO organizations(id,slug,name) VALUES($1,$1,$2)',[org,'Synthetic']);
  for(const id of [member,other])await database.query("INSERT INTO members(id,org_id,name,email,password_hash,role) VALUES($1,$2,'Synthetic',$3,'no-login','Admin')",[id,org,id+'@example.invalid']);
  const staff:Staff={id:member,orgId:org,name:'Synthetic',role:'Admin',email:member+'@example.invalid'};
  const config:SocialChannelConfig={orgId:org,provider,accountId:provider==='line'?'U'+'a'.repeat(32):'1234567890',linkedPageId:'99887766',wabaId:'9876543210',secret:'synthetic',accessToken:'synthetic',apiVersion:'v24.0',owner:'crm',liveEnabled:true,inboundEnabled:true};
  const payload=provider==='whatsapp'?{object:'whatsapp_business_account',entry:[{id:config.wabaId,changes:[{field:'messages',value:{metadata:{phone_number_id:config.accountId},messages:[{id:randomUUID(),from:'66812345678',timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body:'Synthetic inbound'}}]}}]}]}:provider==='line'?{destination:config.accountId,events:[{webhookEventId:randomUUID(),type:'message',timestamp:Date.now(),source:{type:'user',userId:'U'+'b'.repeat(32)},message:{id:randomUUID(),type:'text',text:'Synthetic inbound'}}]}:{object:provider==='instagram'?'instagram':'page',entry:[{id:config.accountId,messaging:[{sender:{id:'66812345678'},recipient:{id:config.accountId},timestamp:Date.now(),message:{mid:randomUUID(),text:'Synthetic inbound'}}]}]};
  const raw=Buffer.from(JSON.stringify(payload));const signature=createHmac('sha256',config.secret).update(raw).digest(provider==='line'?'base64':'hex');
  await ingestSocialWebhook(provider,raw,new Headers(provider==='line'?{'x-line-signature':signature}:{'x-hub-signature-256':'sha256='+signature}),config);
  const identity=(await database.query('SELECT * FROM social_identities WHERE org_id=$1',[org])).rows[0],chat=identity.conversation_id;
  await database.query("UPDATE conversations SET status='human_active',assignee_id=$3 WHERE org_id=$1 AND id=$2",[org,chat,member]);
  await database.query("UPDATE leads SET contact_consent_at=$3,contact_consent_version='synthetic' WHERE org_id=$1 AND id=$2",[org,identity.lead_id,new Date().toISOString()]);
  const fp=socialConfigFingerprint(config);await database.query("UPDATE social_channel_controls SET send_enabled=1,emergency_stop=0,send_mode='live',verified_at=$2,verification_fingerprint=$3,verification_expires_at=$4,webhook_fingerprint=$3 WHERE org_id=$1",[org,new Date().toISOString(),fp,new Date(Date.now()+3600000).toISOString()]);
  const version=(await database.query('SELECT version FROM conversations WHERE id=$1',[chat])).rows[0].version;
  return {org,staff,other:{...staff,id:other},config,chat,version};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const upload=(f:Fixture,bytes=pdf,type='application/pdf',staff=f.staff)=>uploadHumanAttachment(staff,f.chat,new Request('http://localhost:3000/upload',{method:'POST',headers:{'Content-Type':type,'X-File-Name':encodeURIComponent('synthetic.pdf'),'X-Conversation-Version':String(f.version)},body:bytes}));
const approve=(f:Fixture,id:string,clientId=randomUUID())=>approveHumanAttachment(f.staff,f.chat,{attachmentId:id,clientId,expectedVersion:f.version},{dispatch:false});
test('private uploads enforce actor, tenant, exact bytes, quota and default-off',async()=>{
  const f=await fixture();delete process.env.CRM_HUMAN_ATTACHMENTS_ENABLED;await assert.rejects(upload(f),{status:503});process.env.CRM_HUMAN_ATTACHMENTS_ENABLED='true';
  await assert.rejects(upload(f,pdf,'application/pdf',f.other),{status:409});await assert.rejects(upload(f,Buffer.from('<html/>')),{status:415});await assert.rejects(upload(f,pdf,'text/html'),{status:415});
  const saved=await upload(f),download=await downloadHumanAttachment(f.staff,f.chat,saved.id);assert.equal(download.headers.get('cache-control'),'private, no-store');assert.deepEqual(Buffer.from(await download.arrayBuffer()),pdf);
  await assert.rejects(downloadHumanAttachment(f.other,f.chat,saved.id),{status:404});await assert.rejects(downloadHumanAttachment({...f.staff,orgId:randomUUID()},f.chat,saved.id),{status:404});
  process.env.HUMAN_ATTACHMENT_STORAGE_LIMIT_BYTES=String(pdf.length);await assert.rejects(upload(f),{status:409});delete process.env.HUMAN_ATTACHMENT_STORAGE_LIMIT_BYTES;
});
test('new customer generation, expiry and edited stored bytes prevent an approved send',async()=>{
  const f=await fixture(),saved=await upload(f);await database.query('UPDATE conversations SET customer_message_seq=customer_message_seq+1 WHERE id=$1',[f.chat]);await assert.rejects(approve(f,saved.id),{status:409});
  const g=await fixture(),expired=await upload(g);await database.query("UPDATE human_attachments SET expires_at='2000-01-01' WHERE id=$1",[expired.id]);await assert.rejects(approve(g,expired.id),{status:409});
  const h=await fixture(),edited=await upload(h),command=await approve(h,edited.id);const key=h.org+'/'+randomUUID();await(await getPrivateBucket()).put(key,Buffer.from('%PDF-tampered'));await database.query('UPDATE human_attachments SET object_key=$2 WHERE id=$1',[edited.id,key]);let calls=0;
  assert.equal((await dispatchSocialReply(h.org,command.commandId,{config:h.config,fetch:(async()=>{calls++;throw Error('must not send');}) as typeof fetch})).status,'unknown');assert.equal(calls,0);
});
test('simultaneous approval retries create one canonical attachment and one existing dispatcher command',async()=>{
  const f=await fixture(),saved=await upload(f),client=randomUUID();const results=await Promise.all([approve(f,saved.id,client),approve(f,saved.id,client)]);assert.equal(results[0].commandId,results[1].commandId);
  assert.equal((await database.query("SELECT count(*) AS n FROM messages WHERE org_id=$1 AND role='agent'",[f.org])).rows[0].n,1);
  const bytes=await downloadSocialAttachment(f.org,saved.id);assert.deepEqual(Buffer.from(await bytes.arrayBuffer()),pdf);
  await assert.rejects(approveHumanAttachment(f.other,f.chat,{attachmentId:saved.id,clientId:client,expectedVersion:f.version},{dispatch:false}),{status:409});
});
test('WhatsApp uploads verified private bytes then sends one provider media ID without exposing a URL',async()=>{
  const f=await fixture(),saved=await upload(f),command=await approve(f,saved.id);const calls:string[]=[];
  const transport=(async(url,init)=>{calls.push(String(url));assert.equal(init?.redirect,'manual');assert.equal(new Headers(init?.headers).get('authorization'),'Bearer synthetic');if(String(url).endsWith('/media')){const form=init?.body as FormData;assert.equal(form.get('messaging_product'),'whatsapp');assert.deepEqual(Buffer.from(await(form.get('file') as File).arrayBuffer()),pdf);return Response.json({id:'123456789'});}const body=JSON.parse(String(init?.body));assert.equal(body.type,'document');assert.deepEqual(body.document,{id:'123456789',filename:'synthetic.pdf'});assert.equal(body.to,'66812345678');assert.ok(!String(init?.body).includes('https://'));return Response.json({messages:[{id:'wamid.human'}]});}) as typeof fetch;
  assert.equal((await dispatchSocialReply(f.org,command.commandId,{config:f.config,fetch:transport})).status,'submitted');await dispatchSocialReply(f.org,command.commandId,{config:f.config,fetch:transport});assert.equal(calls.length,2);
});
test('takeover after upload stops customer send, redirect/timeout stay unknown and are never retried',async()=>{
  for(const mode of ['takeover','redirect','timeout']){
    const f=await fixture(),saved=await upload(f),command=await approve(f,saved.id);let uploads=0,sends=0;
    const transport=(async(url)=>{if(String(url).endsWith('/media')){uploads++;if(mode==='takeover')await database.query('UPDATE conversations SET version=version+1 WHERE id=$1',[f.chat]);return Response.json({id:'987654321'});}sends++;if(mode==='redirect')return new Response(null,{status:302,headers:{location:'https://evil.invalid'}});throw Error('synthetic timeout');}) as typeof fetch;
    assert.equal((await dispatchSocialReply(f.org,command.commandId,{config:f.config,fetch:transport})).status,'unknown');await dispatchSocialReply(f.org,command.commandId,{config:f.config,fetch:transport});assert.equal(uploads,1);assert.equal(sends,mode==='takeover'?0:1);
  }
});
test('disabled flag after approval blocks transport and route session/origin checks protect raw uploads',async()=>{
  const f=await fixture(),saved=await upload(f),command=await approve(f,saved.id);delete process.env.CRM_HUMAN_ATTACHMENTS_ENABLED;await assert.rejects(dispatchSocialReply(f.org,command.commandId,{config:f.config}),{status:503});process.env.CRM_HUMAN_ATTACHMENTS_ENABLED='true';
  const ctx={params:Promise.resolve({id:f.chat})};assert.equal((await GET(new Request('http://localhost:3000/api/admin/conversations/'+f.chat+'/attachments'),ctx)).status,401);
  const token=randomUUID();await database.query('INSERT INTO staff_sessions(token_hash,org_id,member_id,expires_at) VALUES($1,$2,$3,$4)',[hashToken(token),f.org,f.staff.id,'2099-01-01']);
  const req=new Request('http://localhost:3000/api/admin/conversations/'+f.chat+'/attachments',{method:'POST',headers:{cookie:'rrs_staff='+token,origin:'https://evil.invalid'},body:pdf});assert.equal((await POST(req,ctx)).status,403);
  assert.equal((await listHumanAttachments(f.staff,f.chat)).items.length,0);
});

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
const image=()=>Buffer.from(png);
test('LINE, FB and IG image payloads use a scoped expiring provider-fetch grant without exposing bucket keys',async()=>{
  const previousOrigin=process.env.APP_ORIGIN;process.env.APP_ORIGIN='https://crm.example.invalid';
  try{for(const provider of ['line','facebook','instagram'] as const){
    const f=await fixture(provider),saved=await upload(f,image(),'image/png'),command=await approve(f,saved.id);let calls=0,grant='';
    assert.deepEqual((await listHumanAttachments(f.staff,f.chat)).accept,['image/jpeg','image/png']);await assert.rejects(upload(f),{status:415});
    const transport=(async(url,init)=>{calls++;const payload=JSON.parse(String(init?.body));const uri=provider==='line'?payload.messages[0].originalContentUrl:payload.message.attachment.payload.url;
      assert.equal(new URL(uri).origin,'https://crm.example.invalid');grant=new URL(uri).pathname.split('/').at(-1)!;assert.match(grant,/^[A-Za-z0-9_-]{43}$/);assert.ok(!uri.includes(f.org));assert.ok(!uri.includes(saved.id));
      if(provider==='line'){assert.equal(url,'https://api.line.me/v2/bot/message/push');assert.equal(payload.messages[0].previewImageUrl,uri);assert.equal(payload.messages[0].type,'image');}
      else{assert.equal(payload.message.attachment.type,'image');assert.equal(new URL(String(url)).pathname,provider==='instagram'?'/v24.0/me/messages':'/v24.0/1234567890/messages');}
      const read=await downloadHumanAttachmentGrant(grant,{readConfig:async()=>f.config});assert.deepEqual(Buffer.from(await read.arrayBuffer()),image());assert.equal(read.headers.get('cache-control'),'private, no-store');
      return Response.json(provider==='line'?{sentMessages:[{id:'line.image'}]}:{message_id:provider+'.image'});
    }) as typeof fetch;
    assert.equal((await dispatchSocialReply(f.org,command.commandId,{config:f.config,fetch:transport})).status,'submitted');assert.equal(calls,1);
    const stored=(await database.query('SELECT * FROM human_attachments WHERE id=$1',[saved.id])).rows[0];assert.ok(!JSON.stringify(stored).includes(grant));assert.equal(stored.grant_hash.length,64);
    const api=await listHumanAttachments(f.staff,f.chat);assert.ok(!JSON.stringify(api).includes('grant'));
    await assert.rejects(downloadHumanAttachmentGrant('x'.repeat(43),{readConfig:async()=>f.config}),{status:404});
    await assert.rejects(downloadHumanAttachmentGrant(grant,{readConfig:async()=>({...f.config,accountId:'wrong'})}),{status:404});
    await database.query('UPDATE conversations SET version=version+1 WHERE id=$1',[f.chat]);await assert.rejects(downloadHumanAttachmentGrant(grant,{readConfig:async()=>f.config}));
  }}finally{process.env.APP_ORIGIN=previousOrigin;}
});
test('provider fetch grant expires, stops on emergency control, and never serves a failed attempt',async()=>{
  const previousOrigin=process.env.APP_ORIGIN;process.env.APP_ORIGIN='https://crm.example.invalid';
  try{for(const mode of ['expired','stopped','failed','limit']){
    const f=await fixture('line'),saved=await upload(f,image(),'image/png'),command=await approve(f,saved.id);let token='';
    await dispatchSocialReply(f.org,command.commandId,{config:f.config,fetch:(async(_url,init)=>{token=JSON.parse(String(init?.body)).messages[0].originalContentUrl.split('/').at(-1);return Response.json({sentMessages:[{id:'test.'+mode}]});}) as typeof fetch});
    if(mode==='expired')await database.query("UPDATE human_attachments SET grant_expires_at='2000-01-01' WHERE id=$1",[saved.id]);
    if(mode==='stopped')await database.query('UPDATE social_channel_controls SET emergency_stop=1,epoch=epoch+1 WHERE org_id=$1',[f.org]);
    if(mode==='failed')await database.query("UPDATE social_outbound_commands SET status='failed' WHERE id=$1",[command.commandId]);
    if(mode==='limit')await database.query('UPDATE human_attachments SET grant_reads=16 WHERE id=$1',[saved.id]);
    await assert.rejects(downloadHumanAttachmentGrant(token,{readConfig:async()=>f.config}));
  }}finally{process.env.APP_ORIGIN=previousOrigin;}
});

test('unknown send outcome permits only the original unexpired fetch and never starts another send',async()=>{
  const origin=process.env.APP_ORIGIN;process.env.APP_ORIGIN='https://crm.example.invalid';
  try{const f=await fixture('line'),saved=await upload(f,image(),'image/png'),command=await approve(f,saved.id);let token='',calls=0;
    const transport=(async(_url,init)=>{calls++;token=JSON.parse(String(init?.body)).messages[0].originalContentUrl.split('/').at(-1);throw Error('Provider may have accepted before timeout');}) as typeof fetch;
    assert.equal((await dispatchSocialReply(f.org,command.commandId,{config:f.config,fetch:transport})).status,'unknown');
    const grant=await downloadHumanAttachmentGrant(token,{readConfig:async()=>f.config});assert.deepEqual(Buffer.from(await grant.arrayBuffer()),image());
    assert.equal((await dispatchSocialReply(f.org,command.commandId,{config:f.config,fetch:transport})).status,'unknown');assert.equal(calls,1);
    await database.query("UPDATE human_attachments SET grant_expires_at='2000-01-01' WHERE id=$1",[saved.id]);await assert.rejects(downloadHumanAttachmentGrant(token,{readConfig:async()=>f.config}));
  }finally{process.env.APP_ORIGIN=origin;}
});
test('bounded cleanup removes only expired unapproved uploads, retries failed R2 deletion and releases quota',async()=>{
  const f=await fixture(),approved=await upload(f);await approve(f,approved.id);const first=await upload(f),second=await upload(f);
  await database.query("UPDATE human_attachments SET expires_at='2000-01-01' WHERE org_id=$1",[f.org]);
  const storage=await getPrivateBucket(),failed={...storage,delete:async()=>{throw Error('Synthetic R2 unavailable');}};
  assert.equal((await sweepExpiredHumanAttachments(f.org,1,failed)).removed,0);
  assert.equal((await database.query("SELECT count(*) AS n FROM human_attachments WHERE org_id=$1 AND status='deleting'",[f.org])).rows[0].n,1);
  assert.equal((await sweepExpiredHumanAttachments(f.org,1)).removed,1);assert.equal((await database.query('SELECT count(*) AS n FROM human_attachments WHERE org_id=$1',[f.org])).rows[0].n,2);
  // The upload sweep reclaims the remaining expired reservation before quota.
  process.env.HUMAN_ATTACHMENT_STORAGE_LIMIT_BYTES=String(pdf.length*2);await upload(f);delete process.env.HUMAN_ATTACHMENT_STORAGE_LIMIT_BYTES;
  assert.equal(await storage.get(f.org+'/'+first.id),null);assert.equal(await storage.get(f.org+'/'+second.id),null);
  const retained=await storage.get(f.org+'/'+approved.id);assert.ok(retained);await retained.body.cancel();
  assert.equal((await database.query('SELECT status FROM human_attachments WHERE id=$1',[approved.id])).rows[0].status,'approved');
});

test('late private upload completion after cleanup cannot resurrect a file or ready reservation',async()=>{
  const f=await fixture(),storage=await getPrivateBucket();let written='';
  const wrapped={...storage,put:async(key:string,value:Uint8Array,metadata?:unknown)=>{written=key;await database.query("UPDATE human_attachments SET expires_at='2000-01-01' WHERE org_id=$1 AND object_key=$2",[f.org,key]);assert.equal((await sweepExpiredHumanAttachments(f.org,10,storage)).removed,1);await storage.put(key,value,metadata);}};
  await assert.rejects(uploadHumanAttachment(f.staff,f.chat,new Request('http://localhost:3000/upload',{method:'POST',headers:{'Content-Type':'application/pdf','X-File-Name':'late.pdf','X-Conversation-Version':String(f.version)},body:pdf}),{storage:wrapped}),{status:409});
  assert.equal(await storage.get(written),null);assert.equal((await database.query('SELECT count(*) AS n FROM human_attachments WHERE org_id=$1',[f.org])).rows[0].n,0);
});
