/** Real SQLite, bounded synthetic provider JSON and signed fixture webhooks. Never uses real credentials. */
import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {createHmac,randomUUID} from 'node:crypto';
import {database,transaction,closeDatabase} from '../src/lib/db';
import {hashToken,type Staff} from '../src/lib/auth';
import {socialChannelAction,socialChannelStatus} from '../src/lib/social-channel-admin';
import {ingestSocialWebhook,enqueueSocialReply,dispatchSocialReply,type SocialProvider,type SocialChannelConfig} from '../src/lib/social-channels';
import {GET,POST} from '../src/app/api/admin/social-channels/[provider]/route';

let admin:Staff,agent:Staff,other:Staff;
const prior={...process.env},originalFetch=globalThis.fetch;
const failFetch=(async()=>{throw Error('Unexpected real transport');}) as typeof fetch;
const config=(provider:SocialProvider,orgId=admin.orgId):SocialChannelConfig=>({provider,orgId,accountId:provider==='line'?'U'+'a'.repeat(32):provider==='whatsapp'?'1234567890':'2234567890',appId:'4567890',wabaId:'9988776655',secret:'fixture-app-secret-private',accessToken:'fixture-provider-token-private',verifyToken:'fixture-verify-token-private',apiVersion:'v24.0',webhookUrl:'https://crm.example.invalid/api/channels/'+provider,testRecipient:provider==='line'?'U'+'b'.repeat(32):provider==='whatsapp'?'66810000000':'3344556677',owner:'crm',inboundEnabled:true,liveEnabled:true});
async function providerFetch(c:SocialChannelConfig,input:URL|RequestInfo,init?:RequestInit){
  const u=new URL(String(input));assert.equal(init?.method,'GET');assert.equal(init?.redirect,'manual');assert.ok(['api.line.me','graph.facebook.com'].includes(u.hostname));
  const bearer=new Headers(init?.headers).get('authorization');assert.ok([`Bearer ${c.accessToken}`,`Bearer ${c.appId}|${c.secret}`].includes(bearer!));
  if(u.pathname==='/v2/bot/info')return Response.json({userId:c.accountId,displayName:'Fixture bot'});
  if(u.pathname==='/v2/bot/channel/webhook/endpoint')return Response.json({active:true,endpoint:c.webhookUrl});
  if(u.pathname.endsWith('/debug_token')){assert.equal(u.searchParams.get('input_token'),c.accessToken);return Response.json({data:{is_valid:true,app_id:c.appId,scopes:['whatsapp_business_messaging','whatsapp_business_management'],expires_at:Math.floor(Date.now()/1000)+7200}});}
  if(u.pathname.endsWith('/phone_numbers'))return Response.json({data:[{id:c.accountId,display_phone_number:'+66 81 544 1815',verified_name:'Fixture RRS'}]});
  if(u.pathname.endsWith('/subscribed_apps'))return Response.json({data:[{whatsapp_business_api_data:{id:c.appId},override_callback_uri:c.webhookUrl}]});
  if(u.pathname.endsWith('/subscriptions'))return Response.json({data:[{object:'whatsapp_business_account',active:true,callback_url:c.webhookUrl,fields:[{name:'messages'}]}]});
  return Response.json({id:c.accountId,name:'Fixture page',display_phone_number:'+66 81 544 1815',status:'CONNECTED',platform_type:'CLOUD_API',access_token:'must-never-persist'});
}
const transport=(c:SocialChannelConfig)=>((input,init)=>providerFetch(c,input,init)) as typeof fetch;
async function signed(c:SocialChannelConfig,payload:unknown){const raw=new TextEncoder().encode(JSON.stringify(payload)),signature=createHmac('sha256',c.secret).update(raw).digest(c.provider==='line'?'base64':'hex');return ingestSocialWebhook(c.provider,raw,new Headers({[c.provider==='line'?'x-line-signature':'x-hub-signature-256']:c.provider==='line'?signature:'sha256='+signature}),c);}
async function probe(c:SocialChannelConfig){return signed(c,c.provider==='line'?{destination:c.accountId,events:[]}:c.provider==='whatsapp'?{object:'whatsapp_business_account',entry:[{id:c.wabaId,changes:[]}]}:{object:'page',entry:[{id:c.accountId,messaging:[]}]});}
async function incoming(c:SocialChannelConfig,remote=c.testRecipient!){
  const mid=randomUUID(),time=Date.now()-1000;
  await signed(c,c.provider==='line'?{destination:c.accountId,events:[{webhookEventId:'event-'+mid,type:'message',timestamp:time,source:{type:'user',userId:remote},message:{id:mid,type:'text',text:'Synthetic controlled test'}}]}:c.provider==='whatsapp'?{object:'whatsapp_business_account',entry:[{id:c.wabaId,changes:[{value:{metadata:{phone_number_id:c.accountId},messages:[{id:mid,from:remote,timestamp:String(Math.floor(time/1000)),type:'text',text:{body:'Synthetic controlled test'}}]}}]}]}:{object:'page',entry:[{id:c.accountId,messaging:[{sender:{id:remote},recipient:{id:c.accountId},timestamp:time,message:{mid,text:'Synthetic controlled test'}}]}]});
  return (await database.query('SELECT * FROM social_identities WHERE org_id=$1 AND provider=$2 AND account_id=$3 AND remote_id=$4',[c.orgId,c.provider,c.accountId,remote])).rows[0];
}
async function queued(c:SocialChannelConfig,remote=c.testRecipient!){
  const identity=await incoming(c,remote),mid=randomUUID();
  await transaction(c.orgId,async tx=>{
    await tx.query("UPDATE conversations SET status='human_active',assignee_id=$3,version=version+1 WHERE org_id=$1 AND id=$2",[c.orgId,identity.conversation_id,admin.id]);
    if(c.provider==='whatsapp')await tx.query('UPDATE leads SET contact_consent_at=$3,contact_consent_version=$4 WHERE org_id=$1 AND id=$2',[c.orgId,identity.lead_id,new Date().toISOString(),'explicit-synthetic-consent']);
  });
  return transaction(c.orgId,async tx=>{await tx.query("INSERT INTO messages(id,org_id,conversation_id,role,content) VALUES($1,$2,$3,'agent','Approved synthetic test')",[mid,c.orgId,identity.conversation_id]);return enqueueSocialReply(tx,c.orgId,identity.conversation_id,mid,'Approved synthetic test');});
}
async function createStaff(orgId:string,role:'Admin'|'Agent'):Promise<Staff>{const id=randomUUID();await database.query('INSERT INTO members(id,org_id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5,$6)',[id,orgId,'Fixture '+role,id+'@example.invalid','not-a-password',role]);return {id,orgId,name:'Fixture '+role,email:id+'@example.invalid',role};}
before(async()=>{
  process.env.DEMO_MODE='true';process.env.D1_LOCAL_DIR='.data/social-admin-'+randomUUID();delete process.env.RRS_WORKERS;globalThis.fetch=failFetch;
  for(const orgId of [randomUUID(),randomUUID()]){await database.query('INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)',[orgId,orgId,'Synthetic admin fixture']);if(!admin){admin=await createStaff(orgId,'Admin');agent=await createStaff(orgId,'Agent');}else other=await createStaff(orgId,'Admin');}
});
after(async()=>{await closeDatabase();globalThis.fetch=originalFetch;for(const key of Object.keys(process.env))if(!(key in prior))delete process.env[key];Object.assign(process.env,prior);});

test('only an active Admin from the configured organization can verify; unauthorized callers make no request',async()=>{
  const c=config('line');await assert.rejects(socialChannelAction(agent,'line',{action:'verify'},{config:c,fetch:failFetch}),{status:403});
  await assert.rejects(socialChannelAction(other,'line',{action:'verify'},{config:c,fetch:failFetch}),{status:403});
  const revoked=await createStaff(admin.orgId,'Admin');await database.query('UPDATE members SET active=0 WHERE id=$1',[revoked.id]);
  await assert.rejects(socialChannelAction(revoked,'line',{action:'verify'},{config:c,fetch:failFetch}),{status:403});
});

test('fixed-host LINE, Facebook and WhatsApp account checks persist sanitized evidence and remain disabled',async()=>{
  for(const provider of ['line','facebook','whatsapp'] as const){const c=config(provider),status=await socialChannelAction(admin,provider,{action:'verify'},{config:c,fetch:transport(c)});
    assert.equal(status.verified,true);assert.equal(status.sendMode,'disabled');assert.equal(status.emergencyStop,true);assert.equal(status.webhookVerified,false);
    const stored=JSON.stringify((await database.query('SELECT * FROM social_channel_controls WHERE org_id=$1 AND provider=$2',[admin.orgId,provider])).rows);
    const response=JSON.stringify(status);for(const secret of [c.secret,c.accessToken!,c.verifyToken!,'must-never-persist']){assert.ok(!stored.includes(secret));assert.ok(!response.includes(secret));}
  }
});

test('enable requires confirmation, environment flags and exact signed callback evidence',async()=>{
  const c=config('line'),options={config:c,fetch:failFetch};
  await assert.rejects(socialChannelAction(admin,'line',{action:'enable-test'},options),{status:422});
  await assert.rejects(socialChannelAction(admin,'line',{action:'enable-test',confirm:true},options),/signed_webhook/);
  await probe(c);assert.equal((await socialChannelStatus(admin,'line',options)).webhookVerified,true);
  await assert.rejects(socialChannelAction(admin,'line',{action:'enable-test',confirm:true},{config:{...c,liveEnabled:false},fetch:failFetch}),/environment_sender_disabled/);
  assert.equal((await socialChannelAction(admin,'line',{action:'enable-test',confirm:true},options)).sendMode,'test');
  await assert.rejects(socialChannelAction(admin,'line',{action:'enable',confirm:true},options),/controlled_test_delivery_required/);
});

test('test mode restricts recipients; LINE submission of the human-approved controlled reply permits explicit live enable',async()=>{
  const c=config('line'),wrong=await queued(c,'U'+'c'.repeat(32));
  await assert.rejects(dispatchSocialReply(c.orgId,wrong.commandId!,{config:c,fetch:failFetch}),/configured test recipient/);
  const testReply=await queued(c);let requests=0;
  const result=await dispatchSocialReply(c.orgId,testReply.commandId!,{config:c,fetch:(async(_url,init)=>{requests++;assert.equal(JSON.parse(String(init?.body)).to,c.testRecipient);return Response.json({sentMessages:[{id:'controlled-line-output'}]});}) as typeof fetch});
  assert.equal(result.status,'submitted');assert.equal(requests,1);
  assert.equal((await socialChannelStatus(admin,'line',{config:c})).testPassed,true);
  assert.equal((await socialChannelAction(admin,'line',{action:'enable',confirm:true},{config:c})).sendMode,'live');
});

test('WhatsApp requires exact business sender, app, scopes, connected phone and matching callback',async()=>{
  const c=config('whatsapp');
  for(const field of ['app','scopes','sender','phone','callback']){
    const mock=(async(input,init)=>{
      const normal=await providerFetch(c,input,init),body=await normal.json(),u=new URL(String(input));
      if(field==='app'&&u.pathname.endsWith('/debug_token'))body.data.app_id='wrong';
      if(field==='scopes'&&u.pathname.endsWith('/debug_token'))body.data.scopes=[];
      if(field==='sender'&&u.pathname.endsWith('/phone_numbers'))body.data[0].display_phone_number='+66819999999';
      if(field==='phone'&&u.searchParams.get('fields')?.includes('platform_type'))body.status='DISCONNECTED';
      if(field==='callback'&&u.pathname.endsWith('/subscribed_apps'))body.data[0].override_callback_uri='https://old.example.invalid/webhook';
      return Response.json(body);
    }) as typeof fetch;
    await assert.rejects(socialChannelAction(admin,'whatsapp',{action:'verify'},{config:c,fetch:mock}));
    const status=await socialChannelStatus(admin,'whatsapp',{config:c});assert.equal(status.verified,false);assert.equal(status.sendMode,'disabled');
  }
});

test('WhatsApp provider acceptance alone does not prove delivery to the controlled recipient',async()=>{
  const c=config('whatsapp');await socialChannelAction(admin,'whatsapp',{action:'verify'},{config:c,fetch:transport(c)});await probe(c);await socialChannelAction(admin,'whatsapp',{action:'enable-test',confirm:true},{config:c});
  const command=await queued(c);await dispatchSocialReply(c.orgId,command.commandId!,{config:c,fetch:(async()=>Response.json({messages:[{id:'wa-controlled-output'}]})) as typeof fetch});
  assert.equal((await socialChannelStatus(admin,'whatsapp',{config:c})).testPassed,false);
  await signed(c,{object:'whatsapp_business_account',entry:[{id:c.wabaId,changes:[{value:{metadata:{phone_number_id:c.accountId},statuses:[{id:'wa-controlled-output',recipient_id:c.testRecipient,status:'delivered',timestamp:String(Math.floor(Date.now()/1000))}]}}]}]});
  assert.equal((await socialChannelStatus(admin,'whatsapp',{config:c})).testPassed,true);
});

test('disable cancels queued commands and prevents any transport while keeping past delivery evidence',async()=>{
  const c=config('line'),command=await queued(c);
  const old=(await database.query("SELECT epoch FROM social_channel_controls WHERE org_id=$1 AND provider='line'",[c.orgId])).rows[0].epoch;
  const status=await socialChannelAction(admin,'line',{action:'disable'},{config:c,fetch:failFetch});assert.equal(status.emergencyStop,true);assert.equal(status.sendMode,'disabled');
  assert.equal((await dispatchSocialReply(c.orgId,command.commandId!,{config:c,fetch:failFetch})).status,'cancelled');
  assert.ok((await database.query("SELECT epoch FROM social_channel_controls WHERE org_id=$1 AND provider='line'",[c.orgId])).rows[0].epoch>old);
});

test('credential rotation and verification expiry invalidate evidence without making a request',async()=>{
  const c=config('line');assert.equal((await socialChannelStatus(admin,'line',{config:{...c,accessToken:'rotated-fixture-token'}})).verified,false);
  await assert.rejects(socialChannelAction(admin,'line',{action:'enable-test',confirm:true},{config:{...c,accessToken:'rotated-fixture-token'},fetch:failFetch}),/verification_required/);
  await database.query("UPDATE social_channel_controls SET verification_expires_at='2000-01-01T00:00:00.000000Z' WHERE org_id=$1 AND provider='line'",[c.orgId]);
  assert.equal((await socialChannelStatus(admin,'line',{config:c})).verified,false);
});

test('concurrent disable or Admin revocation cannot be undone by a slow verification',async()=>{
  const c=config('line');let disabled=false;
  await assert.rejects(socialChannelAction(admin,'line',{action:'verify'},{config:c,fetch:(async(input,init)=>{if(!disabled){disabled=true;await socialChannelAction(admin,'line',{action:'disable'},{config:c});}return providerFetch(c,input,init);}) as typeof fetch}),/verification_cancelled/);
  assert.equal((await socialChannelStatus(admin,'line',{config:c})).sendMode,'disabled');
  const temporary=await createStaff(admin.orgId,'Admin');let revoked=false;
  await assert.rejects(socialChannelAction(temporary,'line',{action:'verify'},{config:c,fetch:(async(input,init)=>{if(!revoked){revoked=true;await database.query('UPDATE members SET active=0 WHERE id=$1',[temporary.id]);}return providerFetch(c,input,init);}) as typeof fetch}),{status:403});
  assert.equal((await socialChannelStatus(admin,'line',{config:c})).verified,false);
});

test('redirects and oversized upstream responses leave the sender disabled and leak no provider error content',async()=>{
  const c=config('line');
  await assert.rejects(socialChannelAction(admin,'line',{action:'verify'},{config:c,fetch:(async()=>new Response(null,{status:302,headers:{Location:'https://evil.example.invalid/token'}})) as typeof fetch}),/provider_redirect_rejected/);
  await assert.rejects(socialChannelAction(admin,'line',{action:'verify'},{config:c,fetch:(async()=>new Response('private raw upstream error '+c.accessToken,{status:403})) as typeof fetch}),/provider_permission_denied/);
  await assert.rejects(socialChannelAction(admin,'line',{action:'verify'},{config:c,fetch:(async()=>new Response('{}',{headers:{'Content-Length':'128001'}})) as typeof fetch}),/provider_response_invalid/);
  assert.equal((await socialChannelStatus(admin,'line',{config:c})).sendMode,'disabled');
});

test('Admin route requires HTTPS, authenticated Admin and same-origin POST',async()=>{
  const context={params:Promise.resolve({provider:'line'})};
  assert.equal((await GET(new Request('https://crm.example.invalid/api/admin/social-channels/line'),context)).status,401);
  for(const staff of [admin,agent]){
    const token=randomUUID();await database.query("INSERT INTO staff_sessions(token_hash,org_id,member_id,expires_at) VALUES($1,$2,$3,$4)",[hashToken(token),staff.orgId,staff.id,new Date(Date.now()+3600000).toISOString()]);
    const headers={Cookie:'rrs_staff='+token,'Content-Type':'application/json'};
    assert.equal((await GET(new Request('http://crm.example.invalid/api/admin/social-channels/line',{headers}),context)).status,400);
    if(staff.role==='Agent')assert.equal((await GET(new Request('https://crm.example.invalid/api/admin/social-channels/line',{headers}),context)).status,403);
    assert.equal((await POST(new Request('https://crm.example.invalid/api/admin/social-channels/line',{method:'POST',headers:{...headers,Origin:'https://attacker.example.invalid'},body:JSON.stringify({action:'disable'})}),context)).status,403);
  }
});
