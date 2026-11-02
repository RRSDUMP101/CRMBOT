/** Isolated SQLite + simulated recipient only; no customer/provider/network traffic. */
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash,createHmac} from 'node:crypto';
import {before,after,test} from 'node:test';
import {database,getDatabase,closeDatabase} from '../src/lib/db';
import {hashToken,type Staff} from '../src/lib/auth';
import {integrationOverview,createApiKey,revokeApiKey,saveWebhook,controlWebhook,publicRead,runPublicWebhooks,webhookTarget} from '../src/lib/public-integrations';
import {GET,POST} from '../src/app/api/admin/integrations/[[...path]]/route';
const envKeys=['DEMO_MODE','RRS_WORKERS','D1_LOCAL_DIR','APP_ORIGIN','SESSION_SECRET','AI_PROVIDER','CRM_PUBLIC_API_ENABLED','CRM_PUBLIC_WEBHOOKS_ENABLED','CRM_PUBLIC_WEBHOOK_RUNNER_ENABLED','CRM_WEBHOOK_ALLOWED_ORIGINS','CRM_WEBHOOK_SECRET_KEYS','CRM_WEBHOOK_SECRET_KEY_CURRENT'];
const previous=Object.fromEntries(envKeys.map(k=>[k,process.env[k]]));
const origin='https://crm.example.invalid',target='https://receiver.example.invalid/events',staffToken=randomUUID(),agentToken=randomUUID();
let admin:Staff,agent:Staff,other:Staff,lead:string,conversation:string,apiKey:{id:string;secret:string},hook:{id:string;secret:string};
let transportCalls=0,http=200,loseResponse=false,received=new Set<string>(),secretByVersion=new Map<string,string>(),hookPayloads:string[]=[],pauseHook:(()=>Promise<void>)|null=null;
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const req=(path='',body?:unknown,token:string=staffToken)=>new Request(origin+'/api/admin/integrations'+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:'rrs_staff='+token},...(body===undefined?{}:{body:JSON.stringify(body)})});
const context=(...path:string[])=>({params:Promise.resolve({path})});
const publicReq=(resource:string,token:string,query='')=>new Request(origin+'/api/public/v1/'+resource+query,{headers:{Authorization:'Bearer '+token}});
const reloadHook=async()=> (await integrationOverview(admin)).webhooks.find(h=>h.id===hook.id)!;
const transport:typeof fetch=async(input,init)=>{
 const request=new Request(input,init),body=await request.text(),h=request.headers;transportCalls++;hookPayloads.push(body);assert.equal(request.url,target);assert.equal(request.redirect,'manual');assert.ok(request.signal);
 assert.equal(h.get('origin'),null);const secret=secretByVersion.get(h.get('x-rrs-webhook-key-id')!)!;
 const canonical=['rrs-webhook-v1','POST',request.url,admin.orgId,h.get('x-rrs-webhook-time'),h.get('x-rrs-webhook-delivery'),h.get('x-rrs-webhook-key-id'),sha(body)].join('\n');
 assert.equal(h.get('x-rrs-webhook-signature'),createHmac('sha256',secret).update(canonical).digest('hex'));
 assert.ok(!body.includes('PRIVATE')&&!body.includes('@')&&!body.includes('+66'),'hooks contain no customer text or contacts');
 received.add(h.get('x-rrs-webhook-delivery')!);if(pauseHook){const fn=pauseHook;pauseHook=null;await fn();}
 if(loseResponse){loseResponse=false;throw Error('synthetic response loss after receiver applied ID');}
 return new Response('',{status:http});
};
before(async()=>{
 Object.assign(process.env,{DEMO_MODE:'true',RRS_WORKERS:'false',D1_LOCAL_DIR:'.data/public-integrations-'+randomUUID(),APP_ORIGIN:origin,SESSION_SECRET:randomBytes(32).toString('hex'),AI_PROVIDER:'disabled',CRM_WEBHOOK_ALLOWED_ORIGINS:JSON.stringify(['https://receiver.example.invalid']),CRM_WEBHOOK_SECRET_KEYS:JSON.stringify({v1:randomBytes(32).toString('base64')}),CRM_WEBHOOK_SECRET_KEY_CURRENT:'v1'});
 const org=randomUUID(),otherOrg=randomUUID();for(const id of [org,otherOrg])await database.query("INSERT INTO organizations(id,slug,name) VALUES($1,$1,'Integration fixture')",[id]);
 const make=async(orgId:string,role:'Admin'|'Agent')=>{const staff:Staff={id:randomUUID(),orgId,role,name:'Fixture',email:randomUUID()+'@example.invalid'};await database.query("INSERT INTO members(id,org_id,name,email,password_hash,role) VALUES($1,$2,$3,$4,'fixture',$5)",[staff.id,orgId,staff.name,staff.email,role]);return staff;};
 admin=await make(org,'Admin');agent=await make(org,'Agent');other=await make(otherOrg,'Admin');
 for(const [staff,token]of [[admin,staffToken],[agent,agentToken]] as const)await database.query("INSERT INTO staff_sessions(token_hash,org_id,member_id,expires_at) VALUES($1,$2,$3,'2099-01-01T00:00:00.000000Z')",[hashToken(token),staff.orgId,staff.id]);
 lead=randomUUID();conversation=randomUUID();await database.query("INSERT INTO leads(id,org_id,name,email,phone,facts) VALUES($1,$2,'PRIVATE name','PRIVATE@example.invalid','+660000000','{\"private\":true}')",[lead,org]);
 await database.query("INSERT INTO conversations(id,org_id,lead_id) VALUES($1,$2,$3)",[conversation,org,lead]);
 await database.query("INSERT INTO messages(id,org_id,conversation_id,role,content,source_owner_only) VALUES($1,$2,$3,'note','PRIVATE note',1)",[randomUUID(),org,conversation]);
 await database.query("INSERT INTO leads(id,org_id,name) VALUES($1,$2,'OTHER TENANT')",[randomUUID(),otherOrg]);
});
after(async()=>{await closeDatabase();for(const k of envKeys){if(previous[k]===undefined)delete process.env[k];else process.env[k]=previous[k];}});
test('admin session/CSRF routes, one-time scoped credentials, no plaintext persistence',async()=>{
 let r=await GET(req('',undefined,''),context());assert.equal(r.status,401);
 r=await GET(req('',undefined,agentToken),context());assert.equal(r.status,403);
 r=await POST(new Request(req('/keys',{name:'x',scopes:['leads:read']}),{headers:{Cookie:'rrs_staff='+staffToken,'Content-Type':'application/json'}}),context('keys'));assert.equal(r.status,403);
 r=await POST(req('/keys',{name:'Reporting',scopes:['leads:read'],expiresInDays:30}),context('keys'));assert.equal(r.status,200);apiKey=await r.json();
 assert.match(apiKey.secret,/^rrs_[a-f0-9-]{36}_[a-f0-9]{64}$/);
 const row=(await database.query('SELECT * FROM crm_public_api_keys WHERE id=$1',[apiKey.id])).rows[0];assert.equal(row.token_hash,sha(apiKey.secret));assert.ok(!JSON.stringify(row).includes(apiKey.secret));
 const overview=await integrationOverview(admin);assert.ok(!JSON.stringify(overview).includes(apiKey.secret));
 await assert.rejects(createApiKey(agent,{name:'x',scopes:['leads:read']}),e=>(e as any).status===403);
 await assert.rejects(createApiKey(admin,{name:'x',scopes:['messages:write']}),e=>(e as any).status===400);
});
test('public API default off, explicit scope/tenant/read-only whitelist and pagination',async()=>{
 let r=await publicRead(publicReq('leads',apiKey.secret),'leads');assert.equal(r.status,503);
 process.env.CRM_PUBLIC_API_ENABLED='true';
 r=await publicRead(publicReq('leads',apiKey.secret),'leads');assert.equal(r.status,200);const body=await r.json();assert.equal(body.data.length,1);assert.equal(body.data[0].id,lead);assert.ok(!('facts'in body.data[0])&&!('summary'in body.data[0]));assert.match(r.headers.get('cache-control')!,/no-store/);
 r=await publicRead(publicReq('conversations',apiKey.secret),'conversations');assert.equal(r.status,403);
 r=await publicRead(publicReq('messages',apiKey.secret),'messages');assert.equal(r.status,404);
 r=await publicRead(publicReq('leads',apiKey.secret+'0'),'leads');assert.equal(r.status,401);
 r=await publicRead(new Request(publicReq('leads',apiKey.secret),{headers:{Authorization:'Bearer '+apiKey.secret,Origin:origin}}),'leads');assert.equal(r.status,403);
 r=await publicRead(publicReq('leads',apiKey.secret,'?limit=1000'),'leads');assert.equal(r.status,400);
 r=await publicRead(publicReq('leads',apiKey.secret,'?limit=1&limit=2'),'leads');assert.equal(r.status,400);
 r=await publicRead(publicReq('leads',apiKey.secret,'?orgId='+other.orgId),'leads');assert.equal(r.status,400);
 const both=await createApiKey(admin,{name:'Conversation reporting',scopes:['conversations:read']});r=await publicRead(publicReq('conversations',both.secret),'conversations');assert.equal(r.status,200);assert.ok(!JSON.stringify(await r.json()).includes('PRIVATE'));
});
test('key rotation overlap, explicit revoke, expired key, issuer permission revocation and org isolation',async()=>{
 const rotated=await createApiKey(admin,{rotateId:apiKey.id});assert.ok(rotated.secret!==apiKey.secret);
 const old=(await database.query('SELECT expires_at FROM crm_public_api_keys WHERE id=$1',[apiKey.id])).rows[0];assert.ok(old.expires_at<=Date.now()+600000);
 await assert.rejects(revokeApiKey(other,{id:apiKey.id}),e=>(e as any).status===404);
 await revokeApiKey(admin,{id:apiKey.id});assert.equal((await publicRead(publicReq('leads',apiKey.secret),'leads')).status,401);
 apiKey={id:rotated.id,secret:rotated.secret};await database.query('UPDATE members SET active=0 WHERE id=$1',[admin.id]);assert.equal((await publicRead(publicReq('leads',apiKey.secret),'leads')).status,401);await database.query('UPDATE members SET active=1 WHERE id=$1',[admin.id]);
 await database.query('UPDATE crm_public_api_keys SET expires_at=0 WHERE id=$1',[apiKey.id]);assert.equal((await publicRead(publicReq('leads',apiKey.secret),'leads')).status,401);
});
test('webhook HTTPS allowlist rejects SSRF/userinfo/query/redirect targets and encrypts secret at rest',async()=>{
 for(const bad of ['http://receiver.example.invalid/events','https://127.0.0.1/a','https://receiver.example.invalid@evil.example/a','https://receiver.example.invalid/events?token=secret','https://receiver.example.invalid:444/events','https://receiver.example.invalid/events#x','https://evil.example/events'])assert.throws(()=>webhookTarget(bad),e=>(e as any).status===400,bad);
 assert.throws(()=>webhookTarget('https://127.0.0.1/events',{CRM_WEBHOOK_ALLOWED_ORIGINS:'["https://127.0.0.1"]'}));
 hook=await saveWebhook(admin,{name:'Fixture hook',url:target,events:['lead.changed','conversation.changed']});secretByVersion.set('1',hook.secret);
 const raw=(await database.query('SELECT * FROM crm_public_webhooks WHERE id=$1',[hook.id])).rows[0];assert.equal(raw.state,'paused');assert.ok(!JSON.stringify(raw).includes(hook.secret));assert.ok(raw.cursor>0,'existing history excluded on creation');
 assert.ok(!JSON.stringify(await integrationOverview(admin)).includes(hook.secret));
 await assert.rejects(controlWebhook(other,{id:hook.id,version:1,action:'enable',confirmed:true}),e=>(e as any).status===404);
 await assert.rejects(controlWebhook(admin,{id:hook.id,version:1,action:'enable'}),e=>(e as any).status===400);
});
test('paused/default-off sends nothing; active event capture/lease/HMAC is durable and idempotent',async()=>{
 const db=await getDatabase();assert.equal((await runPublicWebhooks(db,process.env,transport)).status,'disabled');assert.equal(transportCalls,0);
 Object.assign(process.env,{CRM_PUBLIC_WEBHOOKS_ENABLED:'true',CRM_PUBLIC_WEBHOOK_RUNNER_ENABLED:'true'});
 await database.query("UPDATE leads SET name='PRIVATE changed' WHERE id=$1",[lead]);await runPublicWebhooks(db,process.env,transport);assert.equal(transportCalls,0);
 await controlWebhook(admin,{id:hook.id,version:1,action:'enable',confirmed:true});
 const outcomes=await Promise.all([runPublicWebhooks(db,process.env,transport),runPublicWebhooks(db,process.env,transport)]);assert.equal(outcomes.reduce((n,r)=>n+r.sent,0),1);assert.equal(transportCalls,1);assert.equal(received.size,1);
 await runPublicWebhooks(db,process.env,transport);assert.equal(transportCalls,1);
 const delivery=(await database.query('SELECT * FROM crm_public_webhook_deliveries WHERE subscription_id=$1',[hook.id])).rows[0];assert.equal(delivery.status,'delivered');assert.equal(delivery.attempts,1);assert.equal(sha(delivery.body),delivery.body_hash);
 const payload=JSON.parse(hookPayloads[0]);assert.deepEqual(Object.keys(payload.data).sort(),['id','resource']);
});
test('response loss retries the same delivery ID; only bounded safe metadata is logged',async()=>{
 await database.query("UPDATE conversations SET status='human_active' WHERE id=$1",[conversation]);loseResponse=true;
 const db=await getDatabase();let result=await runPublicWebhooks(db,process.env,transport);assert.equal(result.failed,1);
 let row=(await database.query("SELECT * FROM crm_public_webhook_deliveries WHERE status='pending'")).rows[0];assert.ok(row.next_attempt_at>Date.now());const count=received.size;
 await database.query('UPDATE crm_public_webhook_deliveries SET next_attempt_at=0 WHERE id=$1',[row.id]);result=await runPublicWebhooks(db,process.env,transport);assert.equal(result.sent,1);assert.equal(received.size,count);
 row=(await database.query('SELECT * FROM crm_public_webhook_deliveries WHERE id=$1',[row.id])).rows[0];assert.equal(row.attempts,2);
 const attempts=(await database.query('SELECT * FROM crm_public_webhook_attempts')).rows;assert.ok(attempts.length>=3);assert.ok(!JSON.stringify(attempts).includes(hook.secret)&&!JSON.stringify(attempts).includes('PRIVATE'));
});
test('redirect never followed; permanent failure is retained for scoped manual retry',async()=>{
 await database.query("UPDATE leads SET stage='Qualified' WHERE id=$1",[lead]);http=302;const beforeCalls=transportCalls,db=await getDatabase();await runPublicWebhooks(db,process.env,transport);assert.equal(transportCalls,beforeCalls+1);
 const row=(await database.query("SELECT * FROM crm_public_webhook_deliveries WHERE status='dead'")).rows[0];assert.equal(row.http_status,302);
 const h=await reloadHook();await controlWebhook(admin,{id:h.id,version:h.version,action:'retry',deliveryId:row.id});http=200;await runPublicWebhooks(db,process.env,transport);assert.equal((await database.query('SELECT status FROM crm_public_webhook_deliveries WHERE id=$1',[row.id])).rows[0].status,'delivered');
});
test('pause and signing-secret rotation stop dispatch until explicit resume, retries use new key',async()=>{
 let h=await reloadHook();const rotation=await controlWebhook(admin,{id:h.id,version:h.version,action:'rotate'});secretByVersion.set(String(rotation.signingVersion),rotation.secret!);h=await reloadHook();assert.equal(h.state,'paused');
 await database.query("UPDATE leads SET stage='Follow-up' WHERE id=$1",[lead]);const db=await getDatabase(),beforeCalls=transportCalls;await runPublicWebhooks(db,process.env,transport);assert.equal(transportCalls,beforeCalls);
 await assert.rejects(controlWebhook(admin,{id:h.id,version:h.version-1,action:'enable',confirmed:true}),e=>(e as any).status===409);
 await controlWebhook(admin,{id:h.id,version:h.version,action:'enable',confirmed:true});await runPublicWebhooks(db,process.env,transport);assert.equal(transportCalls,beforeCalls+1);
 const audit=(await database.query("SELECT * FROM audit_events WHERE action LIKE 'integration.%'")).rows;assert.ok(!JSON.stringify(audit).includes(hook.secret)&&!JSON.stringify(audit).includes(rotation.secret!));
});
test('environment kill switch and allowlist changes are rechecked at delivery; no arbitrary target fetch',async()=>{
 await database.query("UPDATE leads SET stage='Won' WHERE id=$1",[lead]);const db=await getDatabase(),beforeCalls=transportCalls;
 process.env.CRM_PUBLIC_WEBHOOK_RUNNER_ENABLED='false';await runPublicWebhooks(db,process.env,transport);assert.equal(transportCalls,beforeCalls);
 process.env.CRM_PUBLIC_WEBHOOK_RUNNER_ENABLED='true';process.env.CRM_WEBHOOK_ALLOWED_ORIGINS='[]';await runPublicWebhooks(db,process.env,transport);assert.equal(transportCalls,beforeCalls);assert.ok((await database.query("SELECT id FROM crm_public_webhook_deliveries WHERE last_error='webhook_origin_not_allowed'")).rows.length);
 process.env.CRM_WEBHOOK_ALLOWED_ORIGINS=JSON.stringify(['https://receiver.example.invalid']);
});
test('pause during secret decryption is reauthorized before POST and consumes no delivery attempt',async()=>{
 await database.query("UPDATE leads SET stage='Qualified' WHERE id=$1",[lead]);
 const original=crypto.subtle.decrypt.bind(crypto.subtle),db=await getDatabase(),beforeCalls=transportCalls;let intercepted=false;
 crypto.subtle.decrypt=async(...args:Parameters<SubtleCrypto['decrypt']>)=>{const result=await original(...args);if(!intercepted){intercepted=true;const h=await reloadHook();await controlWebhook(admin,{id:h.id,version:h.version,action:'pause'});}return result;};
 try{await runPublicWebhooks(db,process.env,transport);}finally{crypto.subtle.decrypt=original;}
 assert.ok(intercepted);assert.equal(transportCalls,beforeCalls);const pending=(await database.query("SELECT * FROM crm_public_webhook_deliveries WHERE status='pending'")).rows[0];assert.equal(pending.attempts,0);assert.equal(pending.lease,'');
 const h=await reloadHook();await controlWebhook(admin,{id:h.id,version:h.version,action:'enable',confirmed:true});await database.query('UPDATE crm_public_webhook_deliveries SET next_attempt_at=0 WHERE id=$1',[pending.id]);await runPublicWebhooks(db,process.env,transport);assert.equal(transportCalls,beforeCalls+1);
});
test('retry budget retains a dead letter and a stable ID; revoked issuer cannot dispatch',async()=>{
 await database.query("UPDATE leads SET stage='Lost' WHERE id=$1",[lead]);http=503;const db=await getDatabase(),beforeCalls=transportCalls;
 await runPublicWebhooks(db,process.env,transport);const row=(await database.query("SELECT * FROM crm_public_webhook_deliveries WHERE status='pending'")).rows[0];assert.ok(row);
 for(let i=0;i<4;i++){await database.query('UPDATE crm_public_webhook_deliveries SET next_attempt_at=0 WHERE id=$1',[row.id]);await runPublicWebhooks(db,process.env,transport);}
 const exhausted=(await database.query('SELECT * FROM crm_public_webhook_deliveries WHERE id=$1',[row.id])).rows[0];assert.equal(exhausted.status,'dead');assert.equal(exhausted.attempts,5);assert.equal(transportCalls,beforeCalls+5);
 await runPublicWebhooks(db,process.env,transport);assert.equal(transportCalls,beforeCalls+5);http=200;
 await database.query('UPDATE members SET active=0 WHERE id=$1',[admin.id]);await database.query("UPDATE leads SET stage='New' WHERE id=$1",[lead]);await runPublicWebhooks(db,process.env,transport);assert.equal(transportCalls,beforeCalls+5);await database.query('UPDATE members SET active=1 WHERE id=$1',[admin.id]);
});
test('hung receiver is aborted within the five-second budget and its uncertain delivery stays retryable',async()=>{
 let signal:AbortSignal|null|undefined;const started=Date.now(),db=await getDatabase();
 const result=await runPublicWebhooks(db,process.env,async(_input,init)=>{signal=init?.signal;return new Promise<Response>(()=>{});});
 assert.equal(result.failed,1);assert.ok(signal?.aborted);assert.ok(Date.now()-started<6500);
 const row=(await database.query("SELECT * FROM crm_public_webhook_deliveries WHERE status='pending'")).rows[0];assert.equal(row.last_error,'webhook_unavailable');assert.equal(row.attempts,1);assert.equal(row.lease,'');
 // A crashed claimant with an expired lease is resumed with the same delivery ID.
 await database.query("UPDATE crm_public_webhook_deliveries SET status='sending',lease='crashed',lease_until=0,next_attempt_at=0 WHERE id=$1",[row.id]);await runPublicWebhooks(db,process.env,transport);
 assert.equal((await database.query('SELECT status FROM crm_public_webhook_deliveries WHERE id=$1',[row.id])).rows[0].status,'delivered');
});
test('API key request budget is enforced independently of user sessions',async()=>{
 const key=await createApiKey(admin,{name:'Rate fixture',scopes:['leads:read']});
 for(let i=0;i<60;i++){const response=await publicRead(publicReq('leads',key.secret),'leads');assert.equal(response.status,200);await response.body?.cancel();}
 assert.equal((await publicRead(publicReq('leads',key.secret),'leads')).status,429);
});
test('keyset pagination returns each scoped lead once without internal fields or cross-organization rows',async()=>{
 const extra=randomUUID();await database.query("INSERT INTO leads(id,org_id,name) VALUES($1,$2,'PRIVATE paginated fixture')",[extra,admin.orgId]);
 const key=await createApiKey(admin,{name:'Pagination',scopes:['leads:read']});let after='',ids:string[]=[];
 do{const response=await publicRead(publicReq('leads',key.secret,'?limit=1'+(after?'&after='+after:'')),'leads');assert.equal(response.status,200);const page=await response.json();ids.push(...page.data.map((r:{id:string})=>r.id));assert.ok(!page.data.some((r:Record<string,unknown>)=>'facts'in r||'summary'in r));after=page.nextCursor||'';}while(after);
 assert.deepEqual(ids.sort(),[lead,extra].sort());
});

