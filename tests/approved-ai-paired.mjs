// Actual Sale approval/context validation + CRM enqueue/dispatch + both databases.
// Only the provider response is fake. Requires the companion checkout; no live network.
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFile,readdir,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
if(!process.env.RRS_SALE_CHECKOUT)throw Error('Set RRS_SALE_CHECKOUT to the companion Sale checkout');
const crm=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),sale=path.resolve(process.env.RRS_SALE_CHECKOUT);process.chdir(crm);
const crmRequire=createRequire(path.join(crm,'package.json')),saleRequire=createRequire(path.join(sale,'package.json')),{build}=crmRequire('esbuild'),{Miniflare}=saleRequire(createRequire(saleRequire.resolve('wrangler/package.json')).resolve('miniflare'));
const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("synthetic")}}',d1Databases:['DB'],r2Buckets:['BUCKET'],cf:false}),DB=await mf.getD1Database('DB');
const org=randomUUID(),admin=randomUUID(),lead=randomUUID(),conversation=randomUUID(),identity=randomUUID(),secret=randomBytes(40).toString('hex'),sourceOrigin='https://sale.example.invalid',crmOrigin='https://crm.example.invalid',at=new Date().toISOString();
Object.assign(process.env,{DEMO_MODE:'true',RRS_WORKERS:'false',AI_PROVIDER:'disabled',D1_LOCAL_DIR:'.data/approved-ai-paired-'+randomUUID(),APP_ORIGIN:crmOrigin,CRM_BRIDGE_ENABLED:'true',CRM_BRIDGE_ORG_ID:org,CRM_BRIDGE_SECRET:secret,CRM_BRIDGE_ALLOWED_MEMBER_IDS:JSON.stringify([admin]),CRM_APPROVED_AI_ENABLED:'true',CRM_APPROVED_AI_SOURCE_ORIGIN:sourceOrigin,SOCIAL_CHANNELS_ORG_ID:org,SOCIAL_CHANNELS_OWNER:'crm',SOCIAL_INBOUND_ENABLED:'true',SOCIAL_LIVE_ENABLED:'true',WHATSAPP_LIVE_ENABLED:'true',WHATSAPP_PHONE_NUMBER_ID:'1234567890',WHATSAPP_WABA_ID:'9988776655',WHATSAPP_APP_ID:'1122334455',WHATSAPP_APP_SECRET:'synthetic-wa-secret',WHATSAPP_ACCESS_TOKEN:'synthetic-wa-token',WHATSAPP_VERIFY_TOKEN:'synthetic-wa-verify',WHATSAPP_API_VERSION:'v99.0'});
const {database,transaction,closeDatabase}=await import(pathToFileURL(path.join(crm,'src/lib/db.ts'))),bridgeRoute=await import(pathToFileURL(path.join(crm,'src/app/api/bridge/[...path]/route.ts'))),social=await import(pathToFileURL(path.join(crm,'src/lib/social-channels.ts'))),approved=await import(pathToFileURL(path.join(crm,'src/lib/approved-ai.ts')));
const owner={id:'fixture',email:'fixture-owner',role:'owner',workspace:'live',demo:false};
const env={DB,BUCKET:await mf.getR2Bucket('BUCKET'),ADMIN_USERNAME:owner.email,SESSION_SECRET:randomBytes(40).toString('hex'),RRS_SITE_ORIGIN:sourceOrigin,RRS_CHAT_OWNER:'crm',RRS_CRM_APPROVED_AI_ENABLED:'true',RRS_CRM_BRIDGE_ENABLED:'true',RRS_CRM_ORG_ID:org,RRS_CRM_BRIDGE_SECRET:secret,RRS_CRM_ORIGIN:crmOrigin,RRS_CRM_SALE_WORKSPACE:'live',RRS_CRM_ACTOR_MAP_JSON:JSON.stringify({[owner.email]:admin}),AI_LIVE_ENABLED:'true',AI_DAILY_BUDGET_LIMIT:'10',ANTHROPIC_LIVE_ENABLED:'true',OPENAI_LIVE_ENABLED:'true',WHATSAPP_LIVE_ENABLED:'false',ANTHROPIC_API_KEY:'synthetic-anthropic-key',OPENAI_API_KEY:'synthetic-openai-key',ANTHROPIC_MODEL:'fixture-claude',OPENAI_SOL_MODEL:'fixture-sol',OPENAI_ASTRA_MODEL:'fixture-astra',AI_MODEL_PRICING_JSON:JSON.stringify(Object.fromEntries(['fixture-claude','fixture-sol','fixture-astra'].map(m=>[m,{input:1,output:1}])))};
globalThis.__RRS_AI_PAIRED=env;
const bundle=await build({absWorkingDir:sale,stdin:{contents:`export * as outbox from './lib/integrations/outbox';export * as handoff from './lib/integrations/crm-approved-ai';export * as bridge from './lib/rrs/crm-bridge';export * as protocol from './lib/rrs/bridge-protocol';export * as context from './lib/ai/context';export * as provider from './lib/ai/providers';export * as store from './lib/ai/store';export * as model from './lib/rrs/model';export * as server from './lib/rrs/server';export * as security from './lib/rrs/security';`,resolveDir:sale},bundle:true,write:false,format:'esm',platform:'node',target:'node24',plugins:[{name:'fixture',setup(b){b.onResolve({filter:/^cloudflare:workers$/},()=>({path:'env',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const env=globalThis.__RRS_AI_PAIRED;'}));}}]});
const source=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
let sends=0,proofs=0,dropReply=false,providerUnknown=false;const originalFetch=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
 const request=new Request(input,init),url=new URL(request.url);
 if(url.origin===sourceOrigin){assert.equal(url.pathname,'/api/rrs/crm/approved-ai/validate');proofs++;return source.handoff.approvedAiValidation(request);}
 if(url.origin===crmOrigin){assert.ok(url.pathname.startsWith('/api/bridge/'));const response=await bridgeRoute[request.method](request);if(dropReply&&url.pathname==='/api/bridge/approved-commands'&&request.method==='POST'){dropReply=false;throw Error('Synthetic lost handoff HTTP response');}return response;}
 assert.equal(url.origin,'https://graph.facebook.com');assert.equal(url.pathname,'/v99.0/1234567890/messages');sends++;if(providerUnknown)throw Error('Synthetic provider result unknown');return Response.json({messages:[{id:'wamid.paired.'+sends}]});
};
let passed=0;const check=async(name,fn)=>{await fn();passed++;console.log('PASS '+name);};
async function job(){
 const id=randomUUID(),resultId=randomUUID(),approvalId=randomUUID(),state=await source.server.readState(owner),deal=source.model.get(state,'deal','demo-deal-0'),claim=deal.fields[0].value;
 const input={request:'Reply from verified fixture evidence',customer_id:deal.id,source_ids:[deal.id],mode:'Draft for Review',intent:'message',priority:'normal',acceptance_criteria:['Exact approved source'],attachments:[],idempotency_key:randomUUID()};
 const context=await source.context.buildContext(owner,input),result=JSON.stringify({summary:'Synthetic review retained privately',customer_reply:{text:claim,language:'en',claims:[{claim,source_id:deal.id,quote:claim}],missing_information:[],required_source:[]}}),hash=await source.security.digest(result),time=new Date().toISOString();
 await DB.batch([
  DB.prepare("INSERT INTO ai_jobs(id,workspace,created_by,creator_role,customer_id,status,version,dedupe,idempotency_key,payload,created_at,updated_at) VALUES(?,'live',?,'owner',?,'Waiting for Approval',1,?,?,?,?,?)").bind(id,owner.email,deal.id,id,id,JSON.stringify({input,context:context.context,context_hash:context.hash,control_epoch:0}),time,time),
  DB.prepare("INSERT INTO ai_results(id,job_id,workspace,step_id,run_id,revision,payload,hash,created_at) VALUES(?,?,'live','consolidated','fixture',1,?,?,?)").bind(resultId,id,result,hash,time),
  DB.prepare("INSERT INTO ai_approvals(id,job_id,workspace,result_id,result_hash,status,created_at) VALUES(?,?,'live',?,?,'Waiting for Approval',?)").bind(approvalId,id,resultId,hash,time),
  DB.prepare("INSERT INTO ai_job_steps(id,job_id,workspace,agent,status,revision,payload,updated_at) VALUES(?,?,'live','astra','Approved',1,'{}',?)").bind(randomUUID(),id,time)
 ]);
 return {id,resultId,approvalId,hash,approve:()=>source.outbox.approveReply(owner,id,{approval_id:approvalId,result_hash:hash,version:1,recipient_contact_id:'demo-contact-0',recipient_phone:'+66812345678',confirm:true})};
}
try{
 for(const file of(await readdir(path.join(sale,'drizzle'))).filter(f=>f.endsWith('.sql')).sort())for(const sql of(await readFile(path.join(sale,'drizzle',file),'utf8')).split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean))await DB.prepare(sql).run();
 const records=source.model.seedDemo(),time=new Date().toISOString();records.push({id:'catalog-initial-20260910',kind:'catalogImport',source:'',status:'review',capturedAt:'',items:[],missing:[],note:'synthetic',created:time,updated:time});
 Object.assign(records.find(r=>r.id==='demo-contact-0'),{whatsapp:'+66812345678',optIn:true,optOut:false,consentNote:'Synthetic explicit opt-in evidence',verifiedInbound:time});records.find(r=>r.id==='demo-deal-0').fields=[{id:'warranty',label:'Warranty',value:'Warranty is 1 year.',status:'confirmed',visibility:'customer'}];
 for(const workspace of ['live','domestic']){await DB.prepare('INSERT INTO rrs_workspaces(id,revision,token) VALUES(?,1,?)').bind(workspace,'').run();for(const r of records)await DB.prepare('INSERT INTO rrs_records(workspace,id,kind,data) VALUES(?,?,?,?)').bind(workspace,r.id,r.kind,JSON.stringify(r)).run();}
 for(const connection of ['claude','openai'])await DB.prepare("INSERT INTO rrs_connection_controls(id,enabled,mode,epoch,updated_at,updated_by) VALUES(?,1,'Draft for Review',1,?,?)").bind(connection,time,owner.email).run();
 for(const agent of ['claude','sol','astra']){const model=source.provider.providerConfig(agent).model;await DB.prepare("INSERT INTO ai_provider_status(id,fingerprint,status,model,checked_at,detail,models,actual_model) VALUES(?,?,'Connected',?,?,'Synthetic verified provider fixture','[]',?)").bind(agent,await source.provider.fingerprint(agent),model,time,model).run();}
 await database.query('INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)',[org,org,'Synthetic paired organization']);await database.query("INSERT INTO members(id,org_id,name,email,password_hash,role) VALUES($1,$2,'Fixture Admin',$3,'not-a-hash','Admin')",[admin,org,admin+'@example.invalid']);
 await database.query("INSERT INTO leads(id,org_id,source,market,contact_consent_at,contact_consent_version) VALUES($1,$2,'whatsapp','export',$3,'fixture-consent')",[lead,org,time]);await database.query("INSERT INTO conversations(id,org_id,lead_id,status,assignee_id) VALUES($1,$2,$3,'human_active',$4)",[conversation,org,lead,admin]);
 await database.query("INSERT INTO social_identities(id,org_id,provider,account_id,remote_id,lead_id,conversation_id,created_at,updated_at) VALUES($1,$2,'whatsapp','1234567890','66812345678',$3,$4,$5,$5)",[identity,org,lead,conversation,time]);
 const inbound=randomUUID();await database.query("INSERT INTO messages(id,org_id,conversation_id,role,content) VALUES($1,$2,$3,'user','Synthetic verified inbound')",[inbound,org,conversation]);await database.query("INSERT INTO social_message_provenance(org_id,message_id,provider,account_id,remote_id,provider_message_id,provider_type,direction,delivery_status,provider_timestamp) VALUES($1,$2,'whatsapp','1234567890','66812345678','paired-inbound','text','in','received',$3)",[org,inbound,time]);
 const config=social.readSocialConfig('whatsapp'),fp=social.socialConfigFingerprint(config);await database.query("INSERT INTO social_channel_controls(org_id,provider,account_id,send_enabled,emergency_stop,verified_at,epoch,updated_at,verification_fingerprint,verification_expires_at,webhook_fingerprint,webhook_verified_at,send_mode) VALUES($1,'whatsapp',$2,1,0,$3,1,$3,$4,$5,$4,$3,'live')",[org,config.accountId,time,fp,new Date(Date.now()+86400000).toISOString()]);
 await DB.prepare("INSERT INTO rrs_crm_customer_map(org_id,lead_id,workspace,contact_id,company_id,deal_id,mapped_by,mapped_at) VALUES(?,?,'live','demo-contact-0','demo-company-0','demo-deal-0','fixture',?)").bind(org,lead,time).run();
 await source.bridge.pullCrmEvents();
 await check('actual Sale human approval → signed callback → CRM exact intent → fake provider once',async()=>{
  const j=await job(),result=await j.approve();assert.equal(result.outbox.status,'Submitted');assert.equal(sends,1);assert.ok(proofs>=3);
  const row=await DB.prepare('SELECT * FROM rrs_crm_approved_ai WHERE outbox_id=?').bind(result.outbox.id).first(),payload=JSON.parse(row.payload);assert.equal(payload.source.jobVersion,2);assert.equal(payload.source.resultHash,j.hash);
  assert.equal((await database.query('SELECT content FROM messages WHERE id=$1',[row.crm_message_id])).rows[0].content,'Warranty is 1 year.');await source.outbox.sendOutbox(owner,result.outbox.id,true);assert.equal(sends,1);
  assert.equal((await DB.prepare("SELECT COUNT(*) AS n FROM rrs_records WHERE workspace='live' AND id=?").bind(result.outbox.id).first()).n,0,'no duplicate legacy message');
 });
 await check('lost handoff response recovers exact IDs/status from signed read without resending',async()=>{
  const j=await job();dropReply=true;await assert.rejects(j.approve(),/lost handoff/);assert.equal(sends,2);
  const before=await DB.prepare('SELECT * FROM rrs_crm_approved_ai WHERE outbox_id=(SELECT id FROM rrs_communication_outbox WHERE job_id=?)').bind(j.id).first();assert.equal(before.crm_message_id,'');
  await source.handoff.syncApprovedAiReceipts();const recovered=await DB.prepare('SELECT * FROM rrs_crm_approved_ai WHERE outbox_id=?').bind(before.outbox_id).first();assert.ok(recovered.crm_message_id);assert.equal(recovered.crm_status,'submitted');assert.equal(sends,2);
 });
 await check('fresh source mutation, approver removal and Learning Mode block queued CRM dispatch',async()=>{
  process.env.WHATSAPP_LIVE_ENABLED='false';const j=await job(),result=await j.approve();assert.equal(result.outbox.status,'Approved');process.env.WHATSAPP_LIVE_ENABLED='true';
  const stored=await DB.prepare('SELECT * FROM rrs_crm_approved_ai WHERE outbox_id=?').bind(result.outbox.id).first();const n=sends;
  env.ADMIN_USERNAME='different-owner';await assert.rejects(social.dispatchSocialReply(org,stored.crm_outbound_id),{status:409});env.ADMIN_USERNAME=owner.email;
  await DB.prepare("INSERT INTO rrs_connection_controls(id,enabled,mode,epoch,updated_at,updated_by) VALUES('whatsapp',0,'Learning Mode',1,?,?)").bind(time,owner.email).run();await assert.rejects(social.dispatchSocialReply(org,stored.crm_outbound_id),{status:409});await DB.prepare("UPDATE rrs_connection_controls SET mode='Draft for Review' WHERE id='whatsapp'").run();
  const old=await source.server.readState(owner),next=structuredClone(old);source.model.get(next,'deal','demo-deal-0').fields[0].value='Warranty is 2 years.';await source.server.commit(owner,old,next,'fixture','demo-deal-0','Synthetic source revision');
  await assert.rejects(social.dispatchSocialReply(org,stored.crm_outbound_id),{status:409});assert.equal(sends,n);
 });
 await check('source consent/claims revalidation and provider unknown result never produce a retry send',async()=>{
  const j=await job();providerUnknown=true;const result=await j.approve();providerUnknown=false;assert.equal(result.outbox.status,'Unknown');const n=sends;await source.outbox.sendOutbox(owner,result.outbox.id,true);assert.equal(sends,n);
  const old=await source.server.readState(owner),next=structuredClone(old);source.model.get(next,'contact','demo-contact-0').optOut=true;await source.server.commit(owner,old,next,'fixture','demo-contact-0','Synthetic opt-out');
  const row=await DB.prepare('SELECT * FROM rrs_crm_approved_ai WHERE outbox_id=?').bind(result.outbox.id).first(),nonce=randomUUID(),body=JSON.stringify({commandId:row.command_id,payloadHash:row.payload_hash,nonce}),url=sourceOrigin+'/api/rrs/crm/approved-ai/validate';
  const proof=await source.handoff.approvedAiValidation(new Request(url,{method:'POST',headers:await source.protocol.signBridgeRequest(url,{orgId:org,secret,method:'POST',body}),body}));assert.equal(proof.status,409);assert.equal(sends,n);
 });
 await check('legacy attempted/unknown delivery cannot be rehomed as a fresh CRM send',async()=>{
  const row=await DB.prepare('SELECT * FROM rrs_communication_outbox LIMIT 1').first();for(const values of [{status:'Submitted',provider_id:'wamid.prior'},{status:'Unknown',attempt:1},{status:'Approved',attempt:1},{status:'Approved',attempt_id:'prior-attempt'}])await assert.rejects(source.handoff.handoffApprovedAi(owner,{...row,id:randomUUID(),attempt:0,attempt_id:'',provider_id:'',...values}),e=>e.message==='CRM_AI_PRIOR_DELIVERY_RECONCILIATION_REQUIRED');
 });
 console.log(JSON.stringify({passed,providerCalls:sends,sourceValidationCalls:proofs,externalNetwork:false}));
}finally{globalThis.fetch=originalFetch;await closeDatabase();await mf.dispose();delete globalThis.__RRS_AI_PAIRED;}
