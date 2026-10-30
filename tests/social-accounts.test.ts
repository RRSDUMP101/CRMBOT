/** Multi-account registry + connection wizard. Real local SQLite, synthetic fixtures and injected transports only. */
import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {database,transaction,closeDatabase} from '../src/lib/db';
import {hashToken,type Staff} from '../src/lib/auth';
import * as registry from '../src/lib/social-accounts';
import {readSocialConfig,ingestSocialWebhook,enqueueSocialReply,dispatchSocialReply,type SocialChannelConfig} from '../src/lib/social-channels';
import {socialChannelAction,socialChannelStatus} from '../src/lib/social-channel-admin';
import {GET,POST} from '../src/app/api/admin/social-accounts/[[...path]]/route';
import {GET as channelGET} from '../src/app/api/admin/social-channels/[provider]/route';

const ORIGIN='https://crm.example.invalid',REDIRECT=ORIGIN+'/api/admin/social-accounts/oauth/callback';
const APP_ID='4567890',APP_SECRET='fixture-meta-app-secret-private';
const CODE='fixture-oauth-code-private',SHORT='fixture-short-user-token-private-0001',USER='fixture-long-user-token-private-0002';
const pageToken=(id:string)=>'fixture-page-token-private-'+id;
const K1=randomBytes(32).toString('base64'),K2=randomBytes(32).toString('base64');
const LINE_BOT='U'+'a'.repeat(32),LINE_SECRET='0123456789abcdef0123456789abcdef',LINE_TOKEN='fixtureLineTokenPrivate+/=0001',LINE_TEST='U'+'b'.repeat(32);
const secrets=[APP_SECRET,CODE,SHORT,USER,LINE_SECRET,LINE_TOKEN,K1,K2,'fixture-verify-private'];
const failFetch=(async()=>{throw Error('Unexpected real transport');}) as typeof fetch;
const prior={...process.env},originalFetch=globalThis.fetch;
let admin:Staff,admin2:Staff,agent:Staff,outsider:Staff;
const session=()=>hashToken(randomUUID());
let adminSession:string;

function env(extra:Record<string,string|undefined>={}):Record<string,string|undefined>{
  return {SOCIAL_ACCOUNTS_ENABLED:'true',SOCIAL_TOKEN_KEYS:JSON.stringify({'1':K1}),SOCIAL_TOKEN_KEY_CURRENT:'1',APP_ORIGIN:ORIGIN,
    META_APP_ID:APP_ID,META_APP_SECRET:APP_SECRET,META_GRAPH_VERSION:'v24.0',META_OAUTH_REDIRECT_URI:REDIRECT,
    META_OAUTH_SCOPES:JSON.stringify({facebook:'pages_show_list,pages_messaging',instagram:['instagram_basic','instagram_manage_messages','pages_show_list'],whatsapp:'whatsapp_business_management,whatsapp_business_messaging'}),
    META_VERIFY_TOKEN:'fixture-verify-private',WHATSAPP_VERIFY_TOKEN:'fixture-verify-private',SOCIAL_CHANNELS_ORG_ID:admin.orgId,...extra};
}
/** The env-based LINE sender of the existing path, pointed at the same synthetic bot. */
function lineEnv(extra:Record<string,string|undefined>={}){
  return env({SOCIAL_CHANNELS_OWNER:'crm',SOCIAL_INBOUND_ENABLED:'true',SOCIAL_LIVE_ENABLED:'true',LINE_LIVE_ENABLED:'true',DOMESTIC_LIVE_ENABLED:'true',
    LINE_BOT_USER_ID:LINE_BOT,LINE_CHANNEL_SECRET:LINE_SECRET,LINE_CHANNEL_ACCESS_TOKEN:LINE_TOKEN,LINE_TEST_RECIPIENT:LINE_TEST,...extra});
}

type World={pages:{id:string;name:string;ig?:{id:string;username:string}}[];wabas:Record<string,{id:string;display:string;name:string}[]>;scopes:string[];
  exchange?:()=>Response;listingStatus?:number;challenge?:string;calls:{url:URL;init:RequestInit}[]};
const world=(partial:Partial<World>={}):World=>({pages:[],wabas:{},scopes:['pages_show_list','pages_messaging','instagram_basic','instagram_manage_messages','whatsapp_business_management','whatsapp_business_messaging'],calls:[],...partial});
function meta(w:World):typeof fetch{
  return (async(input:URL|RequestInfo,init?:RequestInit)=>{
    const url=new URL(String(input));w.calls.push({url,init:init||{}});
    assert.equal(init?.redirect,'manual');assert.equal(url.protocol,'https:');assert.equal(url.hostname,'graph.facebook.com');
    assert.ok(url.pathname.startsWith('/v24.0/'),'Graph version comes only from configuration');
    const path=url.pathname.slice(7),method=init?.method||'GET',bearer=(new Headers(init?.headers).get('authorization')||'').replace(/^Bearer /,'');
    const fieldList=url.searchParams.get('fields')||'',seconds=Math.floor(Date.now()/1000);
    if(path==='oauth/access_token'){
      assert.equal(method,'GET');assert.equal(bearer,'');assert.equal(url.searchParams.get('client_id'),APP_ID);assert.equal(url.searchParams.get('client_secret'),APP_SECRET);
      if(url.searchParams.get('grant_type')==='fb_exchange_token'){assert.equal(url.searchParams.get('fb_exchange_token'),SHORT);return Response.json({access_token:USER,token_type:'bearer',expires_in:5_000_000});}
      if(w.exchange)return w.exchange();
      assert.equal(url.searchParams.get('code'),CODE);assert.equal(url.searchParams.get('redirect_uri'),REDIRECT);
      assert.equal(createHash('sha256').update(url.searchParams.get('code_verifier')||'').digest('base64url'),w.challenge,'PKCE verifier matches the S256 challenge');
      return Response.json({access_token:SHORT,token_type:'bearer',expires_in:3600});
    }
    if(path==='debug_token'){
      assert.equal(bearer,APP_ID+'|'+APP_SECRET);
      const token=url.searchParams.get('input_token')||'',page=w.pages.find(item=>pageToken(item.id)===token);
      if(token===USER)return Response.json({data:{is_valid:true,app_id:APP_ID,scopes:w.scopes,granular_scopes:[{scope:'whatsapp_business_management',target_ids:Object.keys(w.wabas)}],expires_at:seconds+60*86400,data_access_expires_at:seconds+90*86400}});
      if(page)return Response.json({data:{is_valid:true,app_id:APP_ID,scopes:w.scopes,profile_id:page.id,expires_at:0,data_access_expires_at:seconds+90*86400}});
      return Response.json({data:{is_valid:false,app_id:APP_ID,expires_at:seconds-10}});
    }
    if(path==='me/accounts'){
      if(w.listingStatus)return new Response('{"error":{"message":"private raw provider text"}}',{status:w.listingStatus});
      assert.equal(bearer,USER);
      return Response.json({data:w.pages.map(page=>({id:page.id,name:page.name,...fieldList.includes('access_token')?{access_token:pageToken(page.id)}:{},...fieldList.includes('instagram_business_account')&&page.ig?{instagram_business_account:page.ig}:{}}))});
    }
    let match=/^(\d+)\/phone_numbers$/.exec(path);
    if(match){assert.equal(bearer,USER);return Response.json({data:(w.wabas[match[1]]||[]).map(number=>({id:number.id,display_phone_number:number.display,verified_name:number.name}))});}
    match=/^(\d+)\/subscribed_apps$/.exec(path);
    if(match&&method==='DELETE')return Response.json({success:true});
    if(match)return Response.json({data:[{whatsapp_business_api_data:{id:APP_ID},override_callback_uri:ORIGIN+'/api/channels/whatsapp'}]});
    if(path===APP_ID+'/subscriptions'){assert.equal(bearer,APP_ID+'|'+APP_SECRET);return Response.json({data:[{object:'whatsapp_business_account',active:true,callback_url:ORIGIN+'/api/channels/whatsapp',fields:[{name:'messages'}]}]});}
    match=/^(\d+)$/.exec(path);
    if(match){
      const id=match[1];
      for(const numbers of Object.values(w.wabas)){const number=numbers.find(item=>item.id===id);if(number)return Response.json({id,display_phone_number:number.display,status:'CONNECTED',platform_type:'CLOUD_API'});}
      const page=w.pages.find(item=>item.id===id);if(page){assert.equal(bearer,pageToken(id));return Response.json({id,name:page.name,...page.ig?{instagram_business_account:{id:page.ig.id}}:{}});}
      const linked=w.pages.find(item=>item.ig?.id===id);if(linked)return Response.json({id,username:linked.ig!.username});
    }
    throw Error('Unexpected provider request '+path);
  }) as typeof fetch;
}
function line(calls:{url:URL;init:RequestInit}[]=[],tokens=[LINE_TOKEN],bot=LINE_BOT):typeof fetch{
  return (async(input:URL|RequestInfo,init?:RequestInit)=>{
    const url=new URL(String(input));calls.push({url,init:init||{}});
    assert.equal(init?.redirect,'manual');assert.equal(url.hostname,'api.line.me');
    if(url.pathname==='/v2/oauth/revoke'){assert.equal(init?.method,'POST');assert.ok(tokens.includes(new URLSearchParams(String(init?.body)).get('access_token')!));return new Response(null,{status:200});}
    assert.ok(tokens.map(token=>'Bearer '+token).includes(new Headers(init?.headers).get('authorization')!));
    if(url.pathname==='/v2/bot/info')return Response.json({userId:bot,displayName:'Fixture bot'});
    if(url.pathname==='/v2/bot/channel/webhook/endpoint')return Response.json({active:true,endpoint:ORIGIN+'/api/channels/line'});
    throw Error('Unexpected LINE request '+url.pathname);
  }) as typeof fetch;
}
async function authorize(staff:Staff,key:string,provider:registry.MetaProvider,w:World,e=env()){
  const start=await registry.startSocialOAuth(staff,key,{provider},{env:e});
  const url=new URL(start.authorizeUrl);w.challenge=url.searchParams.get('code_challenge')!;
  const result=await registry.completeSocialOAuth(staff,key,new URLSearchParams({code:CODE,state:url.searchParams.get('state')!}),{env:e,fetch:meta(w)});
  return {start,url,result};
}
async function assets(key=adminSession,staff=admin,e=env()){return (await registry.socialAccountsOverview(staff,key,{env:e})).attempts[0];}
async function connectPage(w:World,pageId:string,e=env()){
  const key=session(),{result}=await authorize(admin,key,'facebook',w,e);assert.equal(result.status,'awaiting_selection');
  const attempt=await assets(key,admin,e),index=w.pages.findIndex(page=>page.id===pageId);
  return registry.selectSocialAsset(admin,key,{attemptId:attempt.id,assetKey:attempt.assets[index].key},{env:e,fetch:meta(w)});
}
const accountRow=async(id:string)=>(await database.query('SELECT * FROM social_accounts WHERE org_id=$1 AND id=$2',[admin.orgId,id])).rows[0];
async function createStaff(orgId:string,role:'Admin'|'Agent'):Promise<Staff>{const id=randomUUID();await database.query('INSERT INTO members(id,org_id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5,$6)',[id,orgId,'Fixture '+role,id+'@example.invalid','not-a-password',role]);return {id,orgId,name:'Fixture '+role,email:id+'@example.invalid',role};}
async function signedLine(c:SocialChannelConfig,payload:unknown){const raw=new TextEncoder().encode(JSON.stringify(payload));return ingestSocialWebhook('line',raw,new Headers({'x-line-signature':createHmac('sha256',c.secret).update(raw).digest('base64')}),c);}
async function queuedLineReply(c:SocialChannelConfig){
  const mid=randomUUID();
  await signedLine(c,{destination:c.accountId,events:[{webhookEventId:'event-'+mid,type:'message',timestamp:Date.now()-1000,source:{type:'user',userId:c.testRecipient},message:{id:mid,type:'text',text:'Synthetic controlled test'}}]});
  const identity=(await database.query("SELECT * FROM social_identities WHERE org_id=$1 AND provider='line' AND account_id=$2 AND remote_id=$3",[c.orgId,c.accountId,c.testRecipient])).rows[0];
  await transaction(c.orgId,async tx=>{await tx.query("UPDATE conversations SET status='human_active',assignee_id=$3,version=version+1 WHERE org_id=$1 AND id=$2",[c.orgId,identity.conversation_id,admin.id]);});
  const messageId=randomUUID();
  return transaction(c.orgId,async tx=>{await tx.query("INSERT INTO messages(id,org_id,conversation_id,role,content) VALUES($1,$2,$3,'agent','Approved synthetic test')",[messageId,c.orgId,identity.conversation_id]);return enqueueSocialReply(tx,c.orgId,identity.conversation_id,messageId,'Approved synthetic test');});
}
async function auditDump(){return JSON.stringify((await database.query("SELECT * FROM audit_events WHERE org_id=$1 AND action LIKE 'social_account.%'",[admin.orgId])).rows);}
function assertNoSecrets(text:string,extra:string[]=[]){for(const secret of [...secrets,...extra])assert.ok(!text.includes(secret),'secret leaked: '+secret.slice(0,12));}

before(async()=>{
  process.env.DEMO_MODE='true';process.env.D1_LOCAL_DIR='.data/social-accounts-'+randomUUID();delete process.env.RRS_WORKERS;delete process.env.SOCIAL_ACCOUNTS_ENABLED;globalThis.fetch=failFetch;
  const org=randomUUID(),otherOrg=randomUUID();
  for(const id of [org,otherOrg])await database.query('INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)',[id,id,'Synthetic registry fixture']);
  admin=await createStaff(org,'Admin');admin2=await createStaff(org,'Admin');agent=await createStaff(org,'Agent');outsider=await createStaff(otherOrg,'Admin');
  adminSession=session();
});
after(async()=>{await closeDatabase();globalThis.fetch=originalFetch;for(const key of Object.keys(process.env))if(!(key in prior))delete process.env[key];Object.assign(process.env,prior);});

test('AES-GCM sealing round-trips; wrong key, tampering, another subject or purpose all fail closed',async()=>{
  const e=env(),subject=[admin.orgId,'line',LINE_BOT];
  const sealed=await registry.sealSocialSecret(LINE_TOKEN,'account-token',subject,e),again=await registry.sealSocialSecret(LINE_TOKEN,'account-token',subject,e);
  assert.equal(await registry.openSocialSecret(sealed,'account-token',subject,e),LINE_TOKEN);
  assert.notEqual(sealed.iv,again.iv);assert.notEqual(sealed.ciphertext,again.ciphertext);assert.equal(sealed.keyVersion,'1');
  assert.ok(!Buffer.from(sealed.ciphertext,'base64').toString('latin1').includes(LINE_TOKEN));
  await assert.rejects(registry.openSocialSecret(sealed,'account-token',subject,env({SOCIAL_TOKEN_KEYS:JSON.stringify({'1':K2})})),/token_unreadable/);
  await assert.rejects(registry.openSocialSecret(sealed,'account-token',subject,env({SOCIAL_TOKEN_KEYS:JSON.stringify({'2':K2}),SOCIAL_TOKEN_KEY_CURRENT:'2'})),/token_key_missing/);
  const flipped=Buffer.from(sealed.ciphertext,'base64');flipped[3]^=1;
  await assert.rejects(registry.openSocialSecret({...sealed,ciphertext:flipped.toString('base64')},'account-token',subject,e),/token_unreadable/);
  const iv=Buffer.from(sealed.iv,'base64');iv[0]^=1;
  await assert.rejects(registry.openSocialSecret({...sealed,iv:iv.toString('base64')},'account-token',subject,e),/token_unreadable/);
  await assert.rejects(registry.openSocialSecret(sealed,'account-token',[admin.orgId,'line','U'+'c'.repeat(32)],e),/token_unreadable/);
  await assert.rejects(registry.openSocialSecret(sealed,'account-secret',subject,e),/token_unreadable/);
  for(const keys of ['not-json',JSON.stringify({'1':'c2hvcnQ='}),JSON.stringify({'1':Buffer.alloc(32).toString('base64')}),JSON.stringify({'bad version':K1}),JSON.stringify([K1])])
    assert.throws(()=>registry.socialTokenKeyRing(env({SOCIAL_TOKEN_KEYS:keys})),(error:any)=>error.status===503&&error.message==='token_storage_unavailable');
  assert.throws(()=>registry.socialTokenKeyRing(env({SOCIAL_TOKEN_KEY_CURRENT:'9'})),/token_storage_unavailable/);
});

test('OAuth start builds the dialog URL only from configuration with PKCE S256 and a hashed, encrypted state record',async()=>{
  const key=session(),start=await registry.startSocialOAuth(admin,key,{provider:'facebook'},{env:env()}),url=new URL(start.authorizeUrl);
  assert.equal(url.origin+url.pathname,'https://www.facebook.com/v24.0/dialog/oauth');
  assert.equal(url.searchParams.get('client_id'),APP_ID);assert.equal(url.searchParams.get('redirect_uri'),REDIRECT);assert.equal(url.searchParams.get('response_type'),'code');
  assert.equal(url.searchParams.get('scope'),'pages_show_list,pages_messaging');assert.equal(url.searchParams.get('code_challenge_method'),'S256');
  const state=url.searchParams.get('state')!;assert.match(state,/^[A-Za-z0-9_-]{43}$/);
  const row=(await database.query('SELECT * FROM oauth_states WHERE id=$1',[start.attemptId])).rows[0];
  assert.equal(row.state_hash,createHash('sha256').update(state).digest('hex'));assert.ok(!JSON.stringify(row).includes(state));
  assert.equal(row.status,'authorizing');assert.equal(row.member_id,admin.id);assert.ok(Date.parse(row.expires_at)-Date.now()<=600_000);
  const verifier=await registry.openSocialSecret({ciphertext:row.verifier_ciphertext,iv:row.verifier_iv,keyVersion:row.key_version},'oauth-pkce',[admin.orgId,'facebook',row.id],env());
  assert.equal(createHash('sha256').update(verifier).digest('base64url'),url.searchParams.get('code_challenge'));
  const whatsapp=new URL((await registry.startSocialOAuth(admin,key,{provider:'whatsapp'},{env:env({META_OAUTH_SCOPES:'whatsapp_business_management whatsapp_business_messaging',META_WHATSAPP_CONFIG_ID:'777777777'})})).authorizeUrl);
  assert.equal(whatsapp.searchParams.get('scope'),'whatsapp_business_management,whatsapp_business_messaging');assert.equal(whatsapp.searchParams.get('config_id'),'777777777');
});

test('redirect URI mismatch, invalid Graph version or missing scopes are refused before any state is created',async()=>{
  const count=async()=>Number((await database.query('SELECT count(*) AS n FROM oauth_states WHERE org_id=$1',[admin.orgId])).rows[0].n),before=await count();
  for(const redirect of ['https://evil.example.invalid/api/admin/social-accounts/oauth/callback',REDIRECT+'/',REDIRECT+'?x=1','http://crm.example.invalid/api/admin/social-accounts/oauth/callback',''])
    await assert.rejects(registry.startSocialOAuth(admin,session(),{provider:'facebook'},{env:env({META_OAUTH_REDIRECT_URI:redirect})}),/redirect_uri_mismatch/);
  await assert.rejects(registry.startSocialOAuth(admin,session(),{provider:'facebook'},{env:env({APP_ORIGIN:ORIGIN+'/',META_OAUTH_REDIRECT_URI:ORIGIN+'//api/admin/social-accounts/oauth/callback'})}),/app_origin_invalid/);
  for(const version of ['v24','24.0','latest','v24.0/../x',''])
    await assert.rejects(registry.startSocialOAuth(admin,session(),{provider:'facebook'},{env:env({META_GRAPH_VERSION:version})}),/graph_version_invalid/);
  await assert.rejects(registry.startSocialOAuth(admin,session(),{provider:'facebook'},{env:env({META_OAUTH_SCOPES:JSON.stringify({instagram:'instagram_basic'})})}),/oauth_scopes_not_configured/);
  await assert.rejects(registry.startSocialOAuth(admin,session(),{provider:'facebook'},{env:env({META_OAUTH_SCOPES:'pages_show_list,DROP TABLE'})}),/oauth_scopes_not_configured/);
  await assert.rejects(registry.startSocialOAuth(admin,session(),{provider:'line'},{env:env()}),{status:400});
  await assert.rejects(registry.startSocialOAuth(agent,session(),{provider:'facebook'},{env:env()}),{status:403});
  assert.equal(await count(),before);
});

test('OAuth state is single-use, bound to the starting session, member and organization, and expires after 10 minutes',async()=>{
  const key=session(),w=world({pages:[{id:'3300000001',name:'Fixture Page One'}]}),e=env();
  const start=await registry.startSocialOAuth(admin,key,{provider:'facebook'},{env:e}),url=new URL(start.authorizeUrl),state=url.searchParams.get('state')!;w.challenge=url.searchParams.get('code_challenge')!;
  const query=new URLSearchParams({code:CODE,state});
  await assert.rejects(registry.completeSocialOAuth(admin,session(),query,{env:e,fetch:failFetch}),(error:any)=>error.status===403&&error.message==='oauth_state_mismatch');
  await assert.rejects(registry.completeSocialOAuth(admin2,key,query,{env:e,fetch:failFetch}),/oauth_state_mismatch/);
  await assert.rejects(registry.completeSocialOAuth(outsider,key,query,{env:e,fetch:failFetch}),/oauth_state_mismatch/);
  await assert.rejects(registry.completeSocialOAuth(admin,key,new URLSearchParams({code:CODE,state:state.slice(0,-1)+(state.endsWith('A')?'B':'A')}),{env:e,fetch:failFetch}),(error:any)=>error.status===400&&error.message==='oauth_state_invalid');
  assert.equal((await database.query('SELECT consumed_at FROM oauth_states WHERE id=$1',[start.attemptId])).rows[0].consumed_at,null);
  const results=await Promise.allSettled([registry.completeSocialOAuth(admin,key,query,{env:e,fetch:meta(w)}),registry.completeSocialOAuth(admin,key,query,{env:e,fetch:meta(w)})]);
  assert.equal(results.filter(item=>item.status==='fulfilled').length,1,'exactly one concurrent callback may consume the state');
  assert.match(String((results.find(item=>item.status==='rejected') as PromiseRejectedResult).reason.message),/oauth_state_used/);
  await assert.rejects(registry.completeSocialOAuth(admin,key,query,{env:e,fetch:failFetch}),(error:any)=>error.status===409&&error.message==='oauth_state_used');
  const lapsed=await registry.startSocialOAuth(admin,key,{provider:'facebook'},{env:e});
  await database.query('UPDATE oauth_states SET expires_at=$2 WHERE id=$1',[lapsed.attemptId,new Date(Date.now()-1000).toISOString()]);
  await assert.rejects(registry.completeSocialOAuth(admin,key,new URLSearchParams({code:CODE,state:new URL(lapsed.authorizeUrl).searchParams.get('state')!}),{env:e,fetch:failFetch}),(error:any)=>error.status===410&&error.message==='oauth_state_expired');
});

test('code exchange is a bounded server-side GET with redirect manual; failures leave no grant and leak no provider text',async()=>{
  const w=world({pages:[{id:'3300000002',name:'Exchange Page'}]}),key=session();
  const {result}=await authorize(admin,key,'facebook',w);assert.equal(result.status,'awaiting_selection');
  const exchange=w.calls.find(call=>call.url.pathname.endsWith('/oauth/access_token')&&call.url.searchParams.get('code'));
  assert.ok(exchange);assert.equal(exchange.init.method,'GET');assert.equal(exchange.init.redirect,'manual');
  for(const [response,code] of [[()=>new Response('private raw provider text '+SHORT,{status:400}),'provider_request_rejected'],[()=>new Response(null,{status:302,headers:{Location:'https://evil.example.invalid/'}}),'provider_redirect_rejected'],[()=>new Response('{}',{headers:{'Content-Length':'128001'}}),'provider_response_invalid'],[()=>Response.json({access_token:'short'}),'provider_response_invalid']] as const){
    const failing=world({pages:w.pages,exchange:response}),attempt=await authorize(admin,key,'facebook',failing);
    assert.deepEqual(attempt.result,{attemptId:attempt.start.attemptId,status:'failed',errorCode:code});
    const row=(await database.query('SELECT * FROM oauth_states WHERE id=$1',[attempt.start.attemptId])).rows[0];
    assert.equal(row.grant_ciphertext,null);assert.equal(row.verifier_ciphertext,null);assert.ok(!JSON.stringify(row).includes('private raw provider text'));
  }
  const denied=await registry.startSocialOAuth(admin,key,{provider:'facebook'},{env:env()});
  const deniedResult=await registry.completeSocialOAuth(admin,key,new URLSearchParams({error:'access_denied',state:new URL(denied.authorizeUrl).searchParams.get('state')!}),{env:env(),fetch:failFetch});
  assert.equal(deniedResult.errorCode,'oauth_denied');
  const missing=await authorize(admin,key,'facebook',world({pages:w.pages,scopes:['pages_show_list']}));
  assert.equal(missing.result.status,'missing_permission');assert.equal(missing.result.errorCode,'permission_declined');
  const review=await authorize(admin,key,'facebook',world({pages:w.pages,listingStatus:403}));
  assert.equal(review.result.status,'awaiting_provider_review');
  const none=await authorize(admin,key,'facebook',world({pages:[]}));
  assert.equal(none.result.status,'missing_permission');assert.equal(none.result.errorCode,'no_assets_granted');
  assertNoSecrets(JSON.stringify((await database.query('SELECT * FROM oauth_states WHERE org_id=$1',[admin.orgId])).rows));
  const overview=await registry.socialAccountsOverview(admin,key,{env:env()});
  assert.ok(overview.attempts.some(item=>item.status==='awaiting_provider_review'&&item.problem?.next));
});

test('asset selection re-checks the authorized grant and rejects mismatched pages, accounts and numbers',async()=>{
  const key=session(),w=world({pages:[{id:'3300000010',name:'Selected Page'},{id:'3300000011',name:'Revoked Page'}]});
  await authorize(admin,key,'facebook',w);
  const attempt=await assets(key);assert.equal(attempt.status,'awaiting_selection');assert.equal(attempt.step,4);
  assert.deepEqual(attempt.assets.map(item=>item.name),['Selected Page','Revoked Page']);assert.equal(attempt.assets[0].maskedIdentity,'•••0010');
  assert.ok(!JSON.stringify(attempt).includes('3300000010'),'raw provider IDs stay on the server');
  await assert.rejects(registry.selectSocialAsset(admin,key,{attemptId:attempt.id,assetKey:'0'.repeat(24)},{env:env(),fetch:meta(w)}),(error:any)=>error.status===403&&error.message==='asset_not_authorized');
  await assert.rejects(registry.selectSocialAsset(admin2,key,{attemptId:attempt.id,assetKey:attempt.assets[0].key},{env:env(),fetch:failFetch}),/oauth_state_mismatch/);
  await assert.rejects(registry.selectSocialAsset(admin,session(),{attemptId:attempt.id,assetKey:attempt.assets[0].key},{env:env(),fetch:failFetch}),/oauth_state_mismatch/);
  await assert.rejects(registry.selectSocialAsset(outsider,key,{attemptId:attempt.id,assetKey:attempt.assets[0].key},{env:env(),fetch:failFetch}),/connection_attempt_not_found/);
  const narrowed=world({pages:[w.pages[0]]});
  await assert.rejects(registry.selectSocialAsset(admin,key,{attemptId:attempt.id,assetKey:attempt.assets[1].key},{env:env(),fetch:meta(narrowed)}),/asset_not_authorized/);
  assert.equal((await database.query("SELECT count(*) AS n FROM social_accounts WHERE org_id=$1 AND account_id='3300000011'",[admin.orgId])).rows[0].n,0);
  const view=await registry.selectSocialAsset(admin,key,{attemptId:attempt.id,assetKey:attempt.assets[0].key},{env:env(),fetch:meta(w)});
  assert.equal(view.state,'webhook_pending');assert.equal(view.provider,'facebook');assert.equal(view.step,5);assert.equal(view.callbackUrl,ORIGIN+'/api/channels/facebook');
  assertNoSecrets(JSON.stringify(view),[pageToken('3300000010')]);
  const row=await accountRow(view.id);assert.equal(row.account_id,'3300000010');assert.equal(row.grant_id,attempt.id);
  assert.equal(await registry.openSocialSecret({ciphertext:row.token_ciphertext,iv:row.token_iv,keyVersion:row.key_version},'account-token',[admin.orgId,'facebook','3300000010'],env()),pageToken('3300000010'));
  const closed=(await database.query('SELECT * FROM oauth_states WHERE id=$1',[attempt.id])).rows[0];assert.equal(closed.status,'completed');assert.equal(closed.grant_ciphertext,null);
  await assert.rejects(registry.selectSocialAsset(admin,key,{attemptId:attempt.id,assetKey:attempt.assets[1].key},{env:env(),fetch:meta(w)}),/connection_attempt_closed/);

  const igWorld=world({pages:[{id:'3300000020',name:'IG Page',ig:{id:'17841400000000020',username:'rrs_fixture'}}]}),igKey=session();
  await authorize(admin,igKey,'instagram',igWorld);const ig=await assets(igKey);assert.equal(ig.assets[0].name,'@rrs_fixture');
  const moved=world({pages:[{id:'3300000021',name:'Other Page',ig:{id:'17841400000000020',username:'rrs_fixture'}}]});
  await assert.rejects(registry.selectSocialAsset(admin,igKey,{attemptId:ig.id,assetKey:ig.assets[0].key},{env:env(),fetch:meta(moved)}),/asset_not_authorized/);
  const igView=await registry.selectSocialAsset(admin,igKey,{attemptId:ig.id,assetKey:ig.assets[0].key},{env:env(),fetch:meta(igWorld)});
  assert.equal(igView.readiness.inbound,'unsupported');assert.equal((await accountRow(igView.id)).parent_ref,'3300000020');

  const waWorld=world({wabas:{'9900000030':[{id:'1200000030',display:'+66 81 000 0030',name:'RRS Fixture Export'}]}}),waKey=session();
  await authorize(admin,waKey,'whatsapp',waWorld);const wa=await assets(waKey);assert.equal(wa.assets[0].maskedIdentity,'+66 ••• 0030');
  await assert.rejects(registry.selectSocialAsset(admin,waKey,{attemptId:wa.id,assetKey:wa.assets[0].key},{env:env(),fetch:meta(world({wabas:{'9900000099':waWorld.wabas['9900000030']}}))}),/asset_not_authorized/);
  const waView=await registry.selectSocialAsset(admin,waKey,{attemptId:wa.id,assetKey:wa.assets[0].key},{env:env(),fetch:meta(waWorld)});
  const waRow=await accountRow(waView.id);assert.equal(waRow.parent_ref,'9900000030');assert.equal(waRow.display_identity,'66810000030');assert.ok(waRow.expires_at);
});

test('validate and verify reuse provider checks; a token-only account stays unready and is never activated',async()=>{
  const w=world({wabas:{'9900000040':[{id:'1200000040',display:'+66 81 000 0040',name:'Registered sender'}]}}),key=session();
  await authorize(admin,key,'whatsapp',w);const attempt=await assets(key);
  const view=await registry.selectSocialAsset(admin,key,{attemptId:attempt.id,assetKey:attempt.assets[0].key},{env:env(),fetch:meta(w)});
  await assert.rejects(registry.socialAccountAction(admin,view.id,{action:'verify'},{env:env(),fetch:failFetch}),/validation_required/);
  const validated=await registry.socialAccountAction(admin,view.id,{action:'validate'},{env:env(),fetch:meta(w)});
  assert.equal(validated.readiness.auth,'ready');assert.equal(validated.state,'webhook_pending');assert.equal(validated.step,6);
  // The existing WhatsApp checks run against the sender selected at authorization, not the env sender.
  const verified=await registry.socialAccountAction(admin,view.id,{action:'verify'},{env:env(),fetch:meta(w)});
  assert.equal(verified.verificationFresh,true);assert.equal(verified.state,'webhook_pending');
  assert.ok(w.calls.some(call=>call.url.pathname.endsWith('/'+APP_ID+'/subscriptions')),'existing app subscription check ran');
  const webhook=await registry.socialAccountAction(admin,view.id,{action:'check-webhook'},{env:env(),fetch:failFetch});
  assert.equal(webhook.readiness.inbound,'pending');assert.equal(webhook.problem?.code,'registry_inbound_pending');
  await assert.rejects(registry.socialAccountAction(admin,view.id,{action:'activate',confirm:true},{env:env(),fetch:failFetch}),/activation_not_allowed/);
  const shrunk=world({wabas:w.wabas,scopes:['whatsapp_business_management']});
  const missing=await registry.socialAccountAction(admin,view.id,{action:'validate'},{env:env(),fetch:meta(shrunk)});
  assert.equal(missing.state,'missing_permission');assert.equal(missing.step,3);assert.equal(missing.problem?.message,'ยังไม่ได้อนุญาตสิทธิ์ที่จำเป็นครบทุกข้อ');
  assert.equal((await registry.socialAccountAction(admin,view.id,{action:'validate'},{env:env(),fetch:meta(w)})).state,'webhook_pending');
});

test('state machine: only testing may become ready, and the database refuses an unproven ready or a credentialed disconnect',async()=>{
  const states=registry.SOCIAL_ACCOUNT_STATES;
  for(const from of states)assert.equal(registry.canTransition(from,'ready'),from==='testing'||from==='ready',from);
  assert.equal(registry.canTransition('ready','paused'),true);assert.equal(registry.canTransition('paused','ready'),false);
  assert.equal(registry.canTransition('disconnected','testing'),false);assert.equal(registry.canTransition('expired','testing'),false);
  for(const from of states.filter(state=>!['not_connected','authorizing','awaiting_selection','disconnected'].includes(state)))assert.equal(registry.canTransition(from,'disconnected'),true,from);
  const view=await connectPage(world({pages:[{id:'3300000050',name:'Machine Page'}]}),'3300000050');
  await assert.rejects(registry.socialAccountAction(admin,view.id,{action:'activate',confirm:true},{env:env(),fetch:failFetch}),/activation_not_allowed/);
  await assert.rejects(registry.socialAccountAction(admin,view.id,{action:'activate'},{env:env(),fetch:failFetch}),{status:422});
  await assert.rejects(database.query("UPDATE social_accounts SET state='ready' WHERE id=$1",[view.id]),/CHECK constraint/);
  await assert.rejects(database.query("UPDATE social_accounts SET state='disconnected' WHERE id=$1",[view.id]),/CHECK constraint/);
  await assert.rejects(database.query("UPDATE social_accounts SET state='celebrating' WHERE id=$1",[view.id]),/CHECK constraint/);
  const paused=await registry.socialAccountAction(admin,view.id,{action:'pause'},{env:env(),fetch:failFetch});assert.equal(paused.state,'paused');
  await assert.rejects(registry.socialAccountAction(admin,view.id,{action:'validate'},{env:env(),fetch:failFetch}),/invalid_state_transition/);
  assert.equal((await registry.socialAccountAction(admin,view.id,{action:'resume'},{env:env(),fetch:failFetch})).state,'webhook_pending');
  await assert.rejects(registry.socialAccountAction(admin,view.id,{action:'launch'},{env:env(),fetch:failFetch}),{status:400});
  await assert.rejects(registry.socialAccountAction(agent,view.id,{action:'pause'},{env:env(),fetch:failFetch}),{status:403});
  await assert.rejects(registry.socialAccountAction(outsider,view.id,{action:'pause'},{env:env(),fetch:failFetch}),/account_not_found/);
});

test('LINE manual entry validates formats, stores credentials encrypted and shows the exact callback URL',async()=>{
  const e=env(),valid={channelId:'1650000000',channelSecret:LINE_SECRET,accessToken:LINE_TOKEN,botUserId:LINE_BOT,displayName:'RRS LINE OA'};
  for(const [field,value,code] of [['channelSecret','0123456789ABCDEF0123456789ABCDEF','line_channel_secret_invalid'],['channelSecret',LINE_SECRET.slice(1),'line_channel_secret_invalid'],['botUserId','U'+'A'.repeat(32),'line_bot_user_id_invalid'],['botUserId','a'.repeat(33),'line_bot_user_id_invalid'],['channelId','12ab','line_channel_id_invalid'],['accessToken','has spaces in the token value','line_access_token_invalid'],['displayName','<script>','display_name_invalid']] as const)
    await assert.rejects(registry.saveLineAccount(admin,{...valid,[field]:value},{env:e}),(error:any)=>error.status===400&&error.message===code);
  await assert.rejects(registry.saveLineAccount(admin,{...valid,webhookUrl:'https://evil.example.invalid'},{env:e}),{status:400});
  const view=await registry.saveLineAccount(admin,valid,{env:e});
  assert.equal(view.callbackUrl,ORIGIN+'/api/channels/line');assert.equal(view.state,'webhook_pending');assert.equal(view.maskedIdentity,'U•••aaaa');assert.equal(view.displayName,'RRS LINE OA');
  const row=await accountRow(view.id);assert.equal(row.parent_ref,'1650000000');assertNoSecrets(JSON.stringify(row));assertNoSecrets(JSON.stringify(view));
  assert.equal(await registry.openSocialSecret({ciphertext:row.secret_ciphertext,iv:row.secret_iv,keyVersion:row.key_version},'account-secret',[admin.orgId,'line',LINE_BOT],e),LINE_SECRET);
  const mismatch=await registry.socialAccountAction(admin,view.id,{action:'validate'},{env:e,fetch:line([],[LINE_TOKEN],'U'+'f'.repeat(32))});
  assert.equal(mismatch.state,'degraded');assert.equal(mismatch.problem?.code,'provider_account_mismatch');
  assert.equal((await registry.socialAccountAction(admin,view.id,{action:'validate'},{env:e,fetch:line()})).readiness.auth,'ready');
});

test('LINE becomes ready only after the existing signed-webhook and controlled-test flow proves the same stored credential',async()=>{
  const e=lineEnv(),c=readSocialConfig('line',e),view=(await registry.socialAccountsOverview(admin,adminSession,{env:e})).accounts.find(item=>item.provider==='line')!;
  assert.equal(view.step,6);
  const pending=await registry.socialAccountAction(admin,view.id,{action:'check-webhook'},{env:e,fetch:failFetch});
  assert.equal(pending.readiness.inbound,'pending');assert.equal(pending.problem?.code,'waiting_for_signed_webhook');assert.ok(pending.problem?.next);
  await signedLine(c,{destination:LINE_BOT,events:[]});
  assert.equal((await registry.socialAccountAction(admin,view.id,{action:'check-webhook'},{env:e,fetch:failFetch})).readiness.inbound,'ready');
  const testing=await registry.socialAccountAction(admin,view.id,{action:'verify'},{env:e,fetch:line()});
  assert.equal(testing.state,'testing');assert.equal(testing.step,9);
  const untested=await registry.socialAccountAction(admin,view.id,{action:'check-test'},{env:e,fetch:failFetch});
  assert.equal(untested.problem?.code,'controlled_test_required');
  await assert.rejects(registry.socialAccountAction(admin,view.id,{action:'activate',confirm:true},{env:e,fetch:failFetch}),/controlled_test_required/);
  // The existing, unchanged controlled test flow: verify, enable-test, one approved reply to the test recipient.
  await socialChannelAction(admin,'line',{action:'verify'},{config:c,fetch:line()});
  await socialChannelAction(admin,'line',{action:'enable-test',confirm:true},{config:c});
  const command=await queuedLineReply(c);
  assert.equal((await dispatchSocialReply(c.orgId,command.commandId!,{config:c,fetch:(async()=>Response.json({sentMessages:[{id:'controlled-line-output'}]})) as typeof fetch})).status,'submitted');
  assert.equal((await socialChannelStatus(admin,'line',{config:c})).testPassed,true);
  assert.equal((await registry.socialAccountAction(admin,view.id,{action:'check-test'},{env:e,fetch:failFetch})).readiness.outbound,'test_passed');
  const ready=await registry.socialAccountAction(admin,view.id,{action:'activate',confirm:true},{env:e,fetch:failFetch});
  assert.equal(ready.state,'ready');assert.deepEqual(ready.readiness,{auth:'ready',inbound:'ready',outbound:'ready'});assert.equal(ready.step,10);
  // Registry state never changes the existing sender control.
  assert.equal((await socialChannelStatus(admin,'line',{config:c})).sendMode,'test');

  // Replacing the credential restarts onboarding; a token the existing sender does not use can never become ready.
  const other='fixtureLineTokenPrivate+/=0002';
  const replaced=await registry.saveLineAccount(admin,{channelId:'1650000000',channelSecret:LINE_SECRET,accessToken:other,botUserId:LINE_BOT},{env:e});
  assert.equal(replaced.id,view.id);assert.equal(replaced.state,'webhook_pending');assert.equal(replaced.readiness.outbound,'pending');
  await registry.socialAccountAction(admin,view.id,{action:'validate'},{env:e,fetch:line([],[other])});
  assert.equal((await registry.socialAccountAction(admin,view.id,{action:'check-webhook'},{env:e,fetch:failFetch})).readiness.inbound,'pending','old webhook evidence predates the new credential');
  await signedLine(c,{destination:LINE_BOT,events:[]});
  await registry.socialAccountAction(admin,view.id,{action:'check-webhook'},{env:e,fetch:failFetch});
  assert.equal((await registry.socialAccountAction(admin,view.id,{action:'verify'},{env:e,fetch:line([],[other])})).state,'testing');
  assert.equal((await registry.socialAccountAction(admin,view.id,{action:'check-test'},{env:e,fetch:failFetch})).problem?.code,'registry_dispatch_pending');
  await assert.rejects(registry.socialAccountAction(admin,view.id,{action:'activate',confirm:true},{env:e,fetch:failFetch}),/registry_dispatch_pending/);
  secrets.push(other);
});

test('key rotation re-encrypts stored tokens and secrets to the current key version',async()=>{
  const rotateEnv=lineEnv({SOCIAL_TOKEN_KEYS:JSON.stringify({'1':K1,'2':K2}),SOCIAL_TOKEN_KEY_CURRENT:'2'});
  const before=(await database.query("SELECT * FROM social_accounts WHERE org_id=$1 AND provider='line'",[admin.orgId])).rows[0];assert.equal(before.key_version,'1');
  const result=await registry.rotateSocialTokenKeys(admin,{env:rotateEnv});
  assert.ok(result.rotated>=1);assert.equal(result.remaining,0);assert.equal(result.keyVersion,'2');
  const after=(await database.query('SELECT * FROM social_accounts WHERE id=$1',[before.id])).rows[0];
  assert.equal(after.key_version,'2');assert.notEqual(after.token_ciphertext,before.token_ciphertext);assert.notEqual(after.secret_ciphertext,before.secret_ciphertext);
  const onlyNew=env({SOCIAL_TOKEN_KEYS:JSON.stringify({'2':K2}),SOCIAL_TOKEN_KEY_CURRENT:'2'}),subject=[admin.orgId,'line',LINE_BOT];
  assert.equal(await registry.openSocialSecret({ciphertext:after.secret_ciphertext,iv:after.secret_iv,keyVersion:'2'},'account-secret',subject,onlyNew),LINE_SECRET);
  await assert.rejects(registry.openSocialSecret({ciphertext:after.secret_ciphertext,iv:after.secret_iv,keyVersion:'2'},'account-secret',subject,env()),/token_key_missing/);
  assert.equal((await registry.rotateSocialTokenKeys(admin,{env:rotateEnv})).rotated,0,'rotation is idempotent');
  assert.ok((await auditDump()).includes('social_account.keys_rotated'));
  // Later tests use the rotated key ring.
  secrets.push(K2);
});

test('disconnect unsubscribes only that account where supported, skips shared env identities and keeps all history',async()=>{
  const e=lineEnv({SOCIAL_TOKEN_KEYS:JSON.stringify({'1':K1,'2':K2}),SOCIAL_TOKEN_KEY_CURRENT:'2'});
  const lineView=(await registry.socialAccountsOverview(admin,adminSession,{env:e})).accounts.find(item=>item.provider==='line')!;
  const history=async()=>(await database.query("SELECT (SELECT count(*) FROM social_events WHERE org_id=$1 AND provider='line' AND account_id=$2) AS events,(SELECT count(*) FROM social_identities WHERE org_id=$1 AND provider='line' AND account_id=$2) AS identities,(SELECT count(*) FROM social_message_provenance WHERE org_id=$1 AND provider='line' AND account_id=$2) AS messages",[admin.orgId,LINE_BOT])).rows[0];
  const before=await history();assert.ok(Number(before.events)>0&&Number(before.messages)>0);
  await assert.rejects(registry.socialAccountAction(admin,lineView.id,{action:'disconnect'},{env:e,fetch:failFetch}),{status:422});
  const calls:{url:URL;init:RequestInit}[]=[];
  const lineGone=await registry.socialAccountAction(admin,lineView.id,{action:'disconnect',confirm:true},{env:e,fetch:line(calls,['fixtureLineTokenPrivate+/=0002'])}) as registry.SocialAccountView&{providerResult:string};
  assert.equal(lineGone.state,'disconnected');assert.equal(lineGone.providerResult,'revoked');
  assert.equal(calls.length,1);assert.equal(calls[0].url.pathname,'/v2/oauth/revoke');
  assert.deepEqual(await history(),before,'conversations, identities, events and messages remain');
  const row=await accountRow(lineView.id);for(const column of ['token_ciphertext','token_iv','secret_ciphertext','secret_iv','token_fingerprint'])assert.equal(row[column],null);
  await assert.rejects(registry.socialAccountAction(admin,lineView.id,{action:'disconnect',confirm:true},{env:e,fetch:failFetch}),/already_disconnected/);
  // A credential shared with the existing env connection is never revoked from the registry.
  const shared=await registry.saveLineAccount(admin,{channelId:'1650000000',channelSecret:LINE_SECRET,accessToken:LINE_TOKEN,botUserId:LINE_BOT},{env:e});
  assert.equal(shared.state,'webhook_pending','a disconnected account can reconnect');
  const skipped=await registry.socialAccountAction(admin,shared.id,{action:'disconnect',confirm:true},{env:e,fetch:failFetch}) as registry.SocialAccountView&{providerResult:string};
  assert.equal(skipped.providerResult,'skipped_shared_with_existing_connection');

  const w=world({pages:[{id:'3300000060',name:'Leaving Page'},{id:'3300000061',name:'Env Page'}]});
  const leaving=await connectPage(w,'3300000060',e),envPage=await connectPage(w,'3300000061',e);
  w.calls.length=0;
  const gone=await registry.socialAccountAction(admin,leaving.id,{action:'disconnect',confirm:true},{env:e,fetch:meta(w)}) as registry.SocialAccountView&{providerResult:string};
  assert.equal(gone.providerResult,'unsubscribed');assert.equal(w.calls.length,1);
  assert.equal(w.calls[0].init.method,'DELETE');assert.equal(w.calls[0].url.pathname,'/v24.0/3300000060/subscribed_apps');
  assert.equal(new Headers(w.calls[0].init.headers).get('authorization'),'Bearer '+pageToken('3300000060'));
  const kept=await registry.socialAccountAction(admin,envPage.id,{action:'disconnect',confirm:true},{env:{...e,META_PAGE_ID:'3300000061'},fetch:failFetch}) as registry.SocialAccountView&{providerResult:string};
  assert.equal(kept.providerResult,'skipped_shared_with_existing_connection');
  const audit=await auditDump();assert.ok(audit.includes('"providerResult":"unsubscribed"'));assert.ok(audit.includes('social_account.disconnected'));
});

test('expiry alerts include accounts expiring within 7 days, and a lapsed credential leaves every ready-path state',async()=>{
  const e=env({SOCIAL_TOKEN_KEYS:JSON.stringify({'1':K1,'2':K2}),SOCIAL_TOKEN_KEY_CURRENT:'2'});
  const w=world({pages:[{id:'3300000070',name:'Soon Page'},{id:'3300000071',name:'Later Page'}]});
  const soon=await connectPage(w,'3300000070',e),later=await connectPage(w,'3300000071',e);
  await database.query('UPDATE social_accounts SET expires_at=$2 WHERE id=$1',[soon.id,new Date(Date.now()+3*86_400_000-60_000).toISOString()]);
  await database.query('UPDATE social_accounts SET expires_at=$2 WHERE id=$1',[later.id,new Date(Date.now()+10*86_400_000).toISOString()]);
  let overview=await registry.socialAccountsOverview(admin,adminSession,{env:e});
  const alert=overview.expiring.find(item=>item.id===soon.id);assert.ok(alert);assert.equal(alert.daysLeft,3);assert.equal(alert.expired,false);
  assert.ok(!overview.expiring.some(item=>item.id===later.id));
  await database.query('UPDATE social_accounts SET expires_at=$2 WHERE id=$1',[soon.id,new Date(Date.now()-1000).toISOString()]);
  overview=await registry.socialAccountsOverview(admin,adminSession,{env:e});
  const lapsed=overview.accounts.find(item=>item.id===soon.id)!;
  assert.equal(lapsed.state,'expired');assert.equal(lapsed.readiness.auth,'expired');assert.equal(lapsed.step,3);assert.equal(overview.expiring.find(item=>item.id===soon.id)?.expired,true);
  await assert.rejects(registry.socialAccountAction(admin,soon.id,{action:'verify'},{env:e,fetch:failFetch}),/invalid_state_transition/);
});

test('tokens, secrets, codes and keys never appear in views, audit or non-ciphertext columns',async()=>{
  const e=env({SOCIAL_TOKEN_KEYS:JSON.stringify({'1':K1,'2':K2}),SOCIAL_TOKEN_KEY_CURRENT:'2'});
  const overview=JSON.stringify(await registry.socialAccountsOverview(admin,adminSession,{env:e}));
  const pages=(await database.query("SELECT account_id FROM social_accounts WHERE org_id=$1 AND provider='facebook'",[admin.orgId])).rows.map(row=>pageToken(row.account_id));
  assertNoSecrets(overview,pages);assertNoSecrets(await auditDump(),pages);
  for(const id of ['3300000010','9900000030','1200000030',LINE_BOT])assert.ok(!overview.includes(id),'raw provider identity in overview');
  const rows=(await database.query('SELECT * FROM social_accounts WHERE org_id=$1',[admin.orgId])).rows.map(row=>{const copy={...row};for(const key of ['token_ciphertext','token_iv','secret_ciphertext','secret_iv'])delete copy[key];return copy;});
  assertNoSecrets(JSON.stringify(rows),pages);
});

test('with SOCIAL_ACCOUNTS_ENABLED unset the registry is absent and the env-based channel behaviour is unchanged',async()=>{
  const full=lineEnv({SOCIAL_CHANNELS_OWNER:'crm',META_PAGE_ID:'2234567890',META_PAGE_ACCESS_TOKEN:'fixture-not-real',META_API_VERSION:'v24.0',WHATSAPP_PHONE_NUMBER_ID:'1234567890',WHATSAPP_WABA_ID:'9988776655',WHATSAPP_ACCESS_TOKEN:'fixture-not-real',WHATSAPP_APP_SECRET:'fixture-secret'});
  for(const provider of ['whatsapp','line','facebook'] as const)assert.deepEqual(readSocialConfig(provider,{...full,SOCIAL_ACCOUNTS_ENABLED:'true'}),readSocialConfig(provider,{...full,SOCIAL_ACCOUNTS_ENABLED:undefined}));
  const off=env({SOCIAL_ACCOUNTS_ENABLED:undefined});
  await assert.rejects(registry.socialAccountsOverview(admin,adminSession,{env:off}),(error:any)=>error.status===404);
  await assert.rejects(registry.startSocialOAuth(admin,adminSession,{provider:'facebook'},{env:off}),(error:any)=>error.status===404);
  await assert.rejects(registry.saveLineAccount(admin,{},{env:{...off,SOCIAL_ACCOUNTS_ENABLED:'false'}}),(error:any)=>error.status===404);
  const token=randomUUID();await database.query('INSERT INTO staff_sessions(token_hash,org_id,member_id,expires_at) VALUES($1,$2,$3,$4)',[hashToken(token),admin.orgId,admin.id,new Date(Date.now()+3600000).toISOString()]);
  const cookie={Cookie:'rrs_staff='+token};delete process.env.SOCIAL_ACCOUNTS_ENABLED;
  for(const path of [[],['oauth','callback']]){
    const response=await GET(new Request(ORIGIN+'/api/admin/social-accounts/'+path.join('/')+'?code=x&state=y',{headers:cookie}),{params:Promise.resolve({path})});
    assert.equal(response.status,404);
  }
  assert.equal((await POST(new Request(ORIGIN+'/api/admin/social-accounts/line',{method:'POST',headers:{...cookie,Origin:ORIGIN,'Content-Type':'application/json'},body:'{}'}),{params:Promise.resolve({path:['line']})})).status,404);
  assert.equal((await channelGET(new Request(ORIGIN+'/api/admin/social-channels/line'),{params:Promise.resolve({provider:'line'})})).status,401,'existing channel route unchanged');
});

test('admin route requires HTTPS, an active Admin and same-origin POST; the OAuth return hides code and state',async()=>{
  Object.assign(process.env,env({SOCIAL_TOKEN_KEYS:JSON.stringify({'1':K1,'2':K2}),SOCIAL_TOKEN_KEY_CURRENT:'2'}));
  try{
    const login=async(staff:Staff)=>{const token=randomUUID();await database.query('INSERT INTO staff_sessions(token_hash,org_id,member_id,expires_at) VALUES($1,$2,$3,$4)',[hashToken(token),staff.orgId,staff.id,new Date(Date.now()+3600000).toISOString()]);return {Cookie:'rrs_staff='+token};};
    const adminCookie=await login(admin),agentCookie=await login(agent),root={params:Promise.resolve({path:[] as string[]})};
    assert.equal((await GET(new Request(ORIGIN+'/api/admin/social-accounts'),root)).status,401);
    assert.equal((await GET(new Request('http://crm.example.invalid/api/admin/social-accounts',{headers:adminCookie}),root)).status,400);
    const forbidden=await GET(new Request(ORIGIN+'/api/admin/social-accounts',{headers:agentCookie}),root);assert.equal(forbidden.status,403);
    const ok=await GET(new Request(ORIGIN+'/api/admin/social-accounts',{headers:adminCookie}),root);assert.equal(ok.status,200);
    assert.equal(ok.headers.get('cache-control'),'private, no-store');const body=await ok.json();assert.equal(body.enabled,true);
    assertNoSecrets(JSON.stringify(body));
    const start={params:Promise.resolve({path:['oauth','start']})},json={'Content-Type':'application/json'};
    assert.equal((await POST(new Request(ORIGIN+'/api/admin/social-accounts/oauth/start',{method:'POST',headers:{...adminCookie,...json,Origin:'https://attacker.example.invalid'},body:JSON.stringify({provider:'facebook'})}),start)).status,403);
    const started=await POST(new Request(ORIGIN+'/api/admin/social-accounts/oauth/start',{method:'POST',headers:{...adminCookie,...json,Origin:ORIGIN},body:JSON.stringify({provider:'facebook'})}),start);
    assert.equal(started.status,200);const dialog=new URL((await started.json()).authorizeUrl);
    const w=world({pages:[{id:'3300000080',name:'Route Page'}]});w.challenge=dialog.searchParams.get('code_challenge')!;globalThis.fetch=meta(w);
    const callback={params:Promise.resolve({path:['oauth','callback']})};
    const returned=await GET(new Request(ORIGIN+'/api/admin/social-accounts/oauth/callback?code='+CODE+'&state='+dialog.searchParams.get('state'),{headers:adminCookie}),callback);
    globalThis.fetch=failFetch;
    assert.equal(returned.status,303);assert.equal(returned.headers.get('location'),ORIGIN+'/?connection=returned#social-accounts');assert.equal(returned.headers.get('referrer-policy'),'no-referrer');
    const replay=await GET(new Request(ORIGIN+'/api/admin/social-accounts/oauth/callback?code='+CODE+'&state='+dialog.searchParams.get('state'),{headers:adminCookie}),callback);
    assert.equal(replay.headers.get('location'),ORIGIN+'/?connection=failed&reason=oauth_state_used#social-accounts');
    for(const response of [returned,replay])assert.ok(!String(response.headers.get('location')).includes(CODE));
    const anonymous=await GET(new Request(ORIGIN+'/api/admin/social-accounts/oauth/callback?code=x&state='+'a'.repeat(43)),callback);
    assert.equal(anonymous.headers.get('location'),ORIGIN+'/?connection=failed&reason=login_required#social-accounts');
    const invalid=await POST(new Request(ORIGIN+'/api/admin/social-accounts/line',{method:'POST',headers:{...adminCookie,...json,Origin:ORIGIN},body:JSON.stringify({channelId:'1',channelSecret:'x',accessToken:'y',botUserId:'z'})}),{params:Promise.resolve({path:['line']})});
    assert.equal(invalid.status,400);const error=await invalid.json();
    assert.equal(error.error,'Channel ID ต้องเป็นตัวเลข 6–20 หลัก');assert.ok(error.next);assert.ok(!/SOCIAL_|META_|LINE_CHANNEL|APP_ORIGIN/.test(JSON.stringify(error)),'no env names reach staff');
  }finally{for(const key of Object.keys(process.env))if(!(key in prior)&&!['DEMO_MODE','D1_LOCAL_DIR'].includes(key))delete process.env[key];globalThis.fetch=failFetch;}
});
