/** Compiled OpenNext Worker acceptance on isolated D1/R2. Every outbound fetch is intercepted. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readdir,readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {mediaArchiveRunnerRequest,mediaArchivePath} from '../src/lib/media-archive-auth';
import {signBridgeRequest} from '../src/lib/bridge-protocol';

const origin='https://crm-archive-fixture.test',org=randomUUID(),secret='synthetic-archive-worker-secret-never-production';
const account='1234567890',fixtureBytes=new TextEncoder().encode('%PDF-1.7\nCompiled Worker synthetic archive\n%%EOF');
const sha=createHash('sha256').update(fixtureBytes).digest('hex'),checks:string[]=[],network:{url:string;method:string}[]=[];
let failRetryOnce=true,providerExpired=false;
const outbound=async(request:Request)=>{
 const url=new URL(request.url);network.push({url:url.href,method:request.method});assert.equal(request.method,'GET','archive runtime must never send a customer message');
 assert.equal(request.headers.get('authorization'),'Bearer synthetic-archive-only-token');
 if(url.origin==='https://graph.facebook.com'&&['/v24.0/fixture-media-ready','/v24.0/fixture-media-retry'].includes(url.pathname)){
  if(providerExpired)return new Response(null,{status:410});
  if(url.pathname.endsWith('fixture-media-retry')&&failRetryOnce){failRetryOnce=false;return Response.json({error:{message:'Synthetic transient GET failure'}},{status:503});}
  return Response.json({url:'https://lookaside.fbsbx.com/whatsapp_business/attachments/?id='+url.pathname.split('/').at(-1),file_size:fixtureBytes.length,mime_type:'application/pdf',sha256:sha});
 }
 if(url.origin==='https://lookaside.fbsbx.com'&&url.pathname==='/whatsapp_business/attachments/')return providerExpired?new Response(null,{status:410}):new Response(fixtureBytes,{headers:{'Content-Type':'application/pdf','Content-Length':String(fixtureBytes.length)}});
 throw Error('Unexpected external request is blocked: '+url.origin+url.pathname);
};
function fixture(enabled:boolean){return new Miniflare(convertV4MiniflareOptions({
 host:'127.0.0.1',port:0,modules:true,scriptPath:'.wrangler/bundle/worker.js',cf:false,
 compatibilityDate:'2026-10-28',compatibilityFlags:['nodejs_compat','global_fetch_strictly_public'],
 bindings:{APP_ORIGIN:origin,RRS_WORKERS:'true',DEMO_MODE:'false',PUBLIC_ORG_SLUG:'fixture',AI_PROVIDER:'disabled',SESSION_SECRET:secret,TRUSTED_IP_HEADER:'cf-connecting-ip',SOCIAL_MEDIA_ARCHIVE_ENABLED:String(enabled),SOCIAL_CHANNELS_OWNER:'crm',SOCIAL_CHANNELS_ORG_ID:org,SOCIAL_INBOUND_ENABLED:'true',SOCIAL_LIVE_ENABLED:'false',WHATSAPP_LIVE_ENABLED:'false',WHATSAPP_PHONE_NUMBER_ID:account,WHATSAPP_ACCESS_TOKEN:'synthetic-archive-only-token',WHATSAPP_APP_SECRET:'synthetic-not-live',WHATSAPP_API_VERSION:'v24.0',CRM_BRIDGE_ENABLED:'true',CRM_BRIDGE_ORG_ID:org,CRM_BRIDGE_SECRET:secret,FILE_STORAGE_LIMIT_BYTES:'1048576'},
 d1Databases:['DB'],r2Buckets:['BUCKET'],outboundService:outbound as any,
}));}
async function schema(mf:Miniflare){
 const db=await mf.getD1Database('DB'),parser=new DatabaseSync(':memory:');
 try{for(const name of(await readdir('migrations/d1')).filter(name=>name.endsWith('.sql')).sort()){
  let remaining=await readFile('migrations/d1/'+name,'utf8');const statements:string[]=[];
  while((remaining=remaining.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/,''))){const statement=parser.prepare(remaining),source=statement.sourceSQL;if(!source)throw Error('Migration parser made no progress: '+name);statement.run();statements.push(source);remaining=remaining.slice(source.length);}
  if(statements.length)await db.batch(statements.map(sql=>db.prepare(sql)));
 }}finally{parser.close();}return db;
}
function passed(name:string){checks.push(name);console.log('PASS '+name);}
// Miniflare v5's structural ReplaceWorkersTypes conditional resolves these two
// unrelated binding types to Request with this project's DOM declarations.
// Keep the documented methods explicit; the runtime calls still target workerd.
type ScheduledBinding={scheduled(options:{scheduledTime:number;cron:string}):Promise<unknown>};
type BucketBinding={get(key:string):Promise<{arrayBuffer():Promise<ArrayBuffer>}|null>};
async function dispatch(mf:Miniflare,url:string,init:NonNullable<Parameters<Miniflare['dispatchFetch']>[1]>={}){
 return mf.dispatchFetch(url,init);
}
async function main(){
 const mf=fixture(true);
 try{
  await mf.ready;const db=await schema(mf),bucket=await mf.getR2Bucket('BUCKET') as unknown as BucketBinding;
  await db.prepare('INSERT INTO organizations(id,slug,name) VALUES(?,?,?)').bind(org,'fixture','Compiled archive synthetic organization').run();
  const bad=await dispatch(mf,origin+mediaArchivePath,{method:'POST',body:'{}',headers:{'Content-Type':'application/json'}});assert.equal(bad.status,403);assert.match(bad.headers.get('cache-control')||'',/no-store/);assert.equal((await bad.json() as any).error,'Invalid archive runner proof');assert.equal(network.length,0);
  const staleRequest=mediaArchiveRunnerRequest(origin,secret,Date.now()-120000),stale=await dispatch(mf,staleRequest.url,{method:'POST',headers:staleRequest.headers,body:'{}'});assert.equal(stale.status,403);assert.equal(network.length,0);passed('compiled internal route rejects missing and expired proof without provider access');
  const wrongOriginProof=mediaArchiveRunnerRequest(origin,secret),wrongOrigin=await dispatch(mf,'https://wrong-archive-fixture.test'+mediaArchivePath,{method:'POST',headers:wrongOriginProof.headers,body:'{}'});assert.equal(wrongOrigin.status,403);assert.equal(network.length,0);passed('valid proof for the configured origin rejects a different reconstructed HTTPS host');
  const signed=mediaArchiveRunnerRequest(origin,secret),empty=await dispatch(mf,signed.url,{method:'POST',headers:signed.headers,body:'{}'});assert.equal(empty.status,200);assert.deepEqual(await empty.json(),{results:[],disabled:false});passed('signed empty runner request reaches compiled OpenNext handler with D1 context');
  const forged=mediaArchiveRunnerRequest(origin,secret),forgedHeaders=new Headers(forged.headers);forgedHeaders.set('Host','forged.invalid');forgedHeaders.set('X-Forwarded-Host','forged.invalid');forgedHeaders.set('X-Forwarded-Proto','http');forgedHeaders.set('X-Forwarded-Port','80');forgedHeaders.set('Forwarded','host=forged.invalid;proto=http');forgedHeaders.set('x-middleware-subrequest','middleware');const forgedResult=await dispatch(mf,forged.url,{method:'POST',headers:forgedHeaders,body:'{}'});assert.equal(forgedResult.status,200);assert.deepEqual(await forgedResult.json(),{results:[],disabled:false});passed('compiled edge ignores forged forwarding headers and binds proof to the actual HTTPS URL');
  const lead=randomUUID(),conversation=randomUUID(),created=new Date().toISOString();
  await db.prepare("INSERT INTO leads(id,org_id,name,source,market) VALUES(?,?,'Synthetic archive contact','whatsapp','export')").bind(lead,org).run();
  await db.prepare("INSERT INTO conversations(id,org_id,lead_id,status) VALUES(?,?,?,'waiting_human')").bind(conversation,org,lead).run();
  async function seedJob(ref:string){const message=randomUUID(),id=randomUUID();await db.batch([
   db.prepare("INSERT INTO messages(id,org_id,conversation_id,role,content) VALUES(?,?,?,'user','[synthetic private PDF]')").bind(message,org,conversation),
   db.prepare("INSERT INTO social_message_provenance(org_id,message_id,provider,account_id,remote_id,provider_type,direction,delivery_status,provider_timestamp) VALUES(?,?,'whatsapp',?,'synthetic-remote','document','in','received',?)").bind(org,message,account,created),
   db.prepare("INSERT INTO social_message_attachments(id,org_id,message_id,provider,account_id,media_type,provider_ref,metadata) VALUES(?,?,?,'whatsapp',?,'document',?,'{}')").bind(id,org,message,account,ref),
   db.prepare('INSERT INTO social_media_archive_jobs(org_id,attachment_id,account_id,created_at,updated_at) VALUES(?,?,?,?,?)').bind(org,id,account,created,created),
  ]);return id;}
  const first=await seedJob('fixture-media-ready'),retry=await seedJob('fixture-media-retry');
  const worker=await mf.getWorker() as unknown as ScheduledBinding;await worker.scheduled({scheduledTime:Date.now(),cron:'* * * * *'});
  const row=await db.prepare('SELECT * FROM social_media_archive_jobs WHERE org_id=? AND attachment_id=?').bind(org,first).first<any>(),retryRow=await db.prepare('SELECT * FROM social_media_archive_jobs WHERE org_id=? AND attachment_id=?').bind(org,retry).first<any>();
  assert.equal(row.status,'archived');assert.equal(row.attempts,1);assert.equal(retryRow.status,'retry');assert.equal(retryRow.attempts,1);assert.ok(retryRow.next_attempt_at>Date.now());assert.equal(retryRow.lease_until,0);assert.equal(retryRow.lease_token,'');
  const stored=await db.prepare('SELECT * FROM social_media_archive WHERE org_id=? AND attachment_id=?').bind(org,first).first<any>();assert.equal(stored.status,'ready');assert.equal(stored.sha256,sha);const object=await bucket.get(stored.object_key);assert.ok(object);assert.deepEqual(new Uint8Array(await object.arrayBuffer()),fixtureBytes);
  const metadata=JSON.parse((await db.prepare('SELECT metadata FROM social_message_attachments WHERE org_id=? AND id=?').bind(org,retry).first<any>()).metadata);assert.equal(metadata.archiveState,'retry');assert.ok(metadata.archiveNextAttemptAt>Date.now());passed('actual compiled scheduled hook binds D1/R2 and archives one job while durably scheduling transient retry');
  const calls=network.length;await worker.scheduled({scheduledTime:Date.now(),cron:'* * * * *'});assert.equal(network.length,calls);assert.equal((await db.prepare('SELECT attempts FROM social_media_archive_jobs WHERE org_id=? AND attachment_id=?').bind(org,retry).first<any>()).attempts,1);passed('scheduled replay skips archived jobs and retries that are not due');
  await db.prepare('UPDATE social_media_archive_jobs SET next_attempt_at=0 WHERE org_id=? AND attachment_id=?').bind(org,retry).run();await worker.scheduled({scheduledTime:Date.now(),cron:'* * * * *'});const recovered=await db.prepare('SELECT status,attempts FROM social_media_archive_jobs WHERE org_id=? AND attachment_id=?').bind(org,retry).first<any>();assert.deepEqual(recovered,{status:'archived',attempts:2});passed('next scheduled invocation recovers the durable retry without any message POST');
  providerExpired=true;const before=network.length,url=origin+'/api/bridge/attachments/'+first,headers=await signBridgeRequest(url,{orgId:org,secret});const download=await dispatch(mf,url,{headers});assert.equal(download.status,200);assert.match(download.headers.get('cache-control')||'',/no-store/);assert.deepEqual(new Uint8Array(await download.arrayBuffer()),fixtureBytes);assert.equal(network.length,before);passed('compiled signed attachment download uses private archived bytes after provider expiry');
 }finally{await mf.dispose();}
 const disabled=fixture(false);
 try{await disabled.ready;const before=network.length,request=mediaArchiveRunnerRequest(origin,secret),response=await dispatch(disabled,request.url,{method:'POST',headers:request.headers,body:'{}'});assert.equal(response.status,200);assert.deepEqual(await response.json(),{disabled:true,results:[]});await(await disabled.getWorker() as unknown as ScheduledBinding).scheduled({scheduledTime:Date.now(),cron:'* * * * *'});assert.equal(network.length,before);passed('disabled compiled runner and scheduled hook do not process jobs or call providers');}finally{await disabled.dispose();}
 console.log(JSON.stringify({passed:true,compiledArtifact:'.wrangler/bundle/worker.js',checks:checks.length,passedChecks:checks,providerRequests:network,realProviderCalls:0,productionMutations:0}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
