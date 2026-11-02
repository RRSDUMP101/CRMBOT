/** Production account resolver and broadcaster; isolated SQLite and injected HTTP only. */
import assert from 'node:assert/strict';
import {createHmac,randomBytes,randomUUID} from 'node:crypto';
import {before,after,test} from 'node:test';
import {database,closeDatabase,getDatabase} from '../src/lib/db';
import type {Staff} from '../src/lib/auth';
import {saveLineAccount,socialAccountAction} from '../src/lib/social-accounts';
import {ingestRegisteredWebhook,resolveSocialConfig} from '../src/lib/social-account-runtime';
import {socialConfigFingerprint} from '../src/lib/social-channels';
import {createBroadcast,getBroadcast,listBroadcasts,previewBroadcast,testSendBroadcast,launchBroadcast,runBroadcasts} from '../src/lib/broadcast';
const saved={...process.env},originalFetch=globalThis.fetch,channelSecret='0123456789abcdef0123456789abcdef';
before(async()=>{
 Object.assign(process.env,{DEMO_MODE:'true',RRS_WORKERS:'false',D1_LOCAL_DIR:'.data/broadcast-runtime-'+randomUUID(),APP_ORIGIN:'https://crm.example.invalid',AI_PROVIDER:'disabled',SOCIAL_ACCOUNTS_ENABLED:'true',SOCIAL_ACCOUNT_RUNTIME_ENABLED:'true',SOCIAL_TOKEN_KEY_CURRENT:'fixture',SOCIAL_TOKEN_KEYS:JSON.stringify({fixture:randomBytes(32).toString('base64')}),SOCIAL_CHANNELS_OWNER:'crm',SOCIAL_INBOUND_ENABLED:'true',SOCIAL_LIVE_ENABLED:'true',DOMESTIC_LIVE_ENABLED:'true',LINE_LIVE_ENABLED:'true',BROADCAST_ENABLED:'true',BROADCAST_RUNNER_ENABLED:'true'});
 delete process.env.FLOWS_ENABLED;globalThis.fetch=(async()=>{throw Error('Real network forbidden');}) as typeof fetch;
});
after(async()=>{await closeDatabase();globalThis.fetch=originalFetch;for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);});
async function fixture(){
 const org=randomUUID(),id=randomUUID(),admin:Staff={id,orgId:org,name:'Admin',email:id+'@example.invalid',role:'Admin'};
 await database.query('INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)',[org,org,'Account-aware broadcast fixture']);
 await database.query("INSERT INTO members(id,org_id,name,email,password_hash,role) VALUES($1,$2,'Admin',$3,'fixture','Admin')",[id,org,admin.email]);process.env.SOCIAL_CHANNELS_ORG_ID=org;
 async function account(n:string){
  const accountId='U'+n.repeat(32),recipient='U'+(n==='1'?'7':'8').repeat(32),token='synthetic-line-token-'+randomUUID();
  const row=await saveLineAccount(admin,{channelId:'123456789',channelSecret,accessToken:token,botUserId:accountId,displayName:n==='1'?'First LINE':'Second LINE'});
  await database.query("UPDATE social_accounts SET auth_readiness='ready',runtime_inbound_enabled=1,runtime_live_enabled=1,runtime_test_recipient=$3 WHERE org_id=$1 AND id=$2",[org,row.id,recipient]);
  const events=[recipient,...(n==='2'?['U'+'9'.repeat(32)]:[])].map(userId=>({webhookEventId:randomUUID(),type:'follow',timestamp:Date.now()-1000,source:{type:'user',userId}}));
  const raw=Buffer.from(JSON.stringify({destination:accountId,events}));await ingestRegisteredWebhook('line',raw,new Headers({'x-line-signature':createHmac('sha256',channelSecret).update(raw).digest('base64')}));
  const config=await resolveSocialConfig(org,'line',accountId),fp=socialConfigFingerprint(config),now=new Date().toISOString();
  await database.query("UPDATE social_channel_controls SET send_enabled=1,emergency_stop=0,send_mode='live',test_recipient=$4,verified_at=$5,verification_fingerprint=$6,verification_expires_at=$7,webhook_fingerprint=$6,webhook_verified_at=$5 WHERE org_id=$1 AND provider=$2 AND account_id=$3",[org,'line',accountId,recipient,now,fp,new Date(Date.now()+3600_000).toISOString()]);
  return {id:row.id,accountId,recipient,token};
 }
 const first=await account('1'),second=await account('2');Object.assign(process.env,{LINE_BOT_USER_ID:first.accountId,LINE_CHANNEL_ACCESS_TOKEN:first.token,LINE_CHANNEL_SECRET:channelSecret,LINE_TEST_RECIPIENT:first.recipient});
 const sent:{authorization:string;to:string}[]=[],transport=(async(input:RequestInfo|URL,init?:RequestInit)=>{assert.equal(String(input),'https://api.line.me/v2/bot/message/push');assert.equal(init?.redirect,'manual');const body=JSON.parse(String(init?.body));sent.push({authorization:new Headers(init?.headers).get('authorization')!,to:body.to});return Response.json({sentMessages:[{id:'fixture-'+randomUUID()}]});}) as typeof fetch;
 return {org,admin,first,second,sent,options:{fetch:transport}};
}
async function draft(f:Awaited<ReturnType<typeof fixture>>){return (await createBroadcast(f.admin,{name:'Second account fixture',provider:'line',accountId:f.second.accountId,messageText:'Synthetic consented notice'},f.options)).campaign.id;}

test('production broadcast resolver selects the second LINE account through test, launch and scheduled send',async()=>{
 const f=await fixture();assert.equal('configs'in f.options,false);
 await assert.rejects(createBroadcast(f.admin,{name:'Ambiguous',provider:'line',messageText:'Fixture'},f.options),{status:422});
 const id=await draft(f),preview=await previewBroadcast(f.admin,id,f.options);assert.equal(preview.accountId,f.second.accountId);assert.equal(preview.eligible,2);
 const tested=await testSendBroadcast(f.admin,id,{requestId:randomUUID()},f.options);assert.equal(tested.passed,true);assert.deepEqual(f.sent,[{authorization:'Bearer '+f.second.token,to:f.second.recipient}]);
 await launchBroadcast(f.admin,id,{confirm:true,expectedVersion:preview.version,expectedRecipients:preview.eligible},f.options);
 const result=await runBroadcasts(await getDatabase(),process.env,{...f.options,orgId:f.org});assert.equal(result.dispatched,2);assert.equal(f.sent.length,3);
 assert.ok(f.sent.every(row=>row.authorization==='Bearer '+f.second.token&&row.to!==f.first.recipient));assert.equal((await getBroadcast(f.admin,id,f.options)).campaign.status,'completed');
 await runBroadcasts(await getDatabase(),process.env,{...f.options,orgId:f.org});assert.equal(f.sent.length,3);
 const commands=(await database.query('SELECT DISTINCT account_id FROM social_outbound_commands WHERE org_id=$1',[f.org])).rows;assert.deepEqual(commands.map(row=>row.account_id),[f.second.accountId]);
});

test('paused selected account remains identifiable in UI gates while sibling LINE account stays available',async()=>{
 const f=await fixture(),id=await draft(f);await socialAccountAction(f.admin,f.second.id,{action:'pause'});
 const list=await listBroadcasts(f.admin,f.options),second=list.gates.accounts.find(row=>row.accountId===f.second.accountId)!;
 assert.ok(second);assert.equal(second.displayName,'Second LINE');assert.equal(second.live,false);assert.equal(second.testReady,false);assert.equal(second.emergencyStop,true);
 assert.equal(list.gates.accounts.find(row=>row.accountId===f.first.accountId)!.live,true);
 const detail=await getBroadcast(f.admin,id,f.options);assert.equal(detail.campaign.accountId,f.second.accountId);assert.equal(detail.gates.accounts.find(row=>row.provider==='line')!.accountId,f.second.accountId);
 assert.equal((detail.gates.channels.line as {live:boolean}).live,false);await assert.rejects(testSendBroadcast(f.admin,id,{requestId:randomUUID()},f.options),{status:503});assert.equal(f.sent.length,0);
 assert.ok(!JSON.stringify({list,detail}).includes(f.second.token));
});

for(const change of ['pause','rotate'] as const)test(`registered ${change} during post-claim decryption fences broadcast before provider POST`,async()=>{
 const f=await fixture(),id=await draft(f),decrypt=crypto.subtle.decrypt;let changed=false;
 crypto.subtle.decrypt=async function(...args:Parameters<SubtleCrypto['decrypt']>){
  const value=await decrypt.apply(this,args);
  if(!changed&&(await database.query("SELECT 1 FROM social_outbound_commands WHERE org_id=$1 AND status='sending'",[f.org])).rows.length){
   changed=true;
   if(change==='pause')await socialAccountAction(f.admin,f.second.id,{action:'pause'});
   else await saveLineAccount(f.admin,{channelId:'123456789',channelSecret,accessToken:'rotated-synthetic-token-'+randomUUID(),botUserId:f.second.accountId,displayName:'Second LINE'});
  }
  return value;
 };
 try{const result=await testSendBroadcast(f.admin,id,{requestId:randomUUID()},f.options);assert.equal(changed,true);assert.equal(result.passed,false);assert.equal(result.status,'cancelled');assert.equal(f.sent.length,0);assert.equal((await database.query('SELECT status FROM social_outbound_commands WHERE org_id=$1',[f.org])).rows[0].status,'cancelled');}
 finally{crypto.subtle.decrypt=decrypt;}
});
