/** Isolated SQLite/private storage; no real visitors, provider traffic or production data. */
import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {database,closeDatabase,getDatabase,withDatabase,type D1Binding,type D1Statement} from '../src/lib/db';
import {hashToken,type Staff} from '../src/lib/auth';
import {createVisitor,conversationAction,visitorDetail,conversationDetail} from '../src/lib/service';
import {getPrivateBucket,type PrivateBucket} from '../src/lib/files';
import {webAttachmentActor,uploadWebAttachment,downloadWebAttachment,sweepWebAttachments,maintainWebAttachments} from '../src/lib/web-chat-attachments';
import {GET,POST} from '../src/app/api/chat/attachments/[[...path]]/route';
import {GET as staffGET,POST as staffPOST} from '../src/app/api/admin/conversations/[id]/web-attachments/[[...path]]/route';
import {createFlow,publishFlow} from '../src/lib/flows';
import {saveTeam} from '../src/lib/operators';
const origin='https://fixture.example.invalid',pdf=Buffer.from('%PDF-1.7\nSynthetic visitor evidence\n%%EOF'),previous={...process.env},originalFetch=globalThis.fetch;
before(async()=>{Object.assign(process.env,{DEMO_MODE:'true',RRS_WORKERS:'false',AI_PROVIDER:'disabled',D1_LOCAL_DIR:'.data/web-files-'+randomUUID(),APP_ORIGIN:origin,SESSION_SECRET:'synthetic-web-file-secret-at-least32characters',WEB_CHAT_ATTACHMENTS_ENABLED:'true'});delete process.env.FLOWS_ENABLED;globalThis.fetch=(async()=>{throw Error('No real network in fixture');}) as typeof fetch;await database.query('SELECT 1');});
after(async()=>{await closeDatabase();globalThis.fetch=originalFetch;for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);});
async function fixture(context:'widget'|'web'='widget'){
 const org=randomUUID(),id=randomUUID(),token=randomUUID(),other=randomUUID();await database.query('INSERT INTO organizations(id,slug,name) VALUES($1,$1,$2)',[org,'Synthetic private files']);
 for(const member of [id,other])await database.query("INSERT INTO members(id,org_id,name,email,password_hash,role) VALUES($1,$2,'Fixture',$3,'not-real','Admin')",[member,org,member+'@example.invalid']);
 const staff:Staff={id,orgId:org,name:'Fixture',email:id+'@example.invalid',role:'Admin'};await database.query("INSERT INTO staff_sessions(token_hash,org_id,member_id,expires_at) VALUES($1,$2,$3,'2099-01-01')",[hashToken(token),org,id]);
 process.env.PUBLIC_ORG_SLUG=org;const visitor=await createVisitor(context),sibling=await createVisitor(context);delete process.env.FLOWS_ENABLED;delete process.env.WEB_CHAT_FILE_STORAGE_LIMIT_BYTES;
 return {org,staff,other,token,visitor,sibling,context};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const ctx=(path:string[]=[])=>({params:Promise.resolve({path})});
function req(f:Fixture,{method='GET',staff=false,token,origin:from=origin,bytes=pdf,client=randomUUID(),name='synthetic.pdf',mime='application/pdf',version=1,widget=f.context==='widget'}:{method?:string;staff?:boolean;token?:string;origin?:string;bytes?:Buffer;client?:string;name?:string;mime?:string;version?:number;widget?:boolean}={}){
 return new Request(origin+'/api/chat/attachments',{method,headers:{cookie:(staff?'rrs_staff':widget?'rrs_widget_visitor':'rrs_visitor')+'='+(token??(staff?f.token:f.visitor.token)),...(widget&&!staff?{'X-RRS-Widget':'1'}:{}),Origin:from,'Content-Type':mime,'X-File-Name':encodeURIComponent(name),'X-Client-Id':client,'X-Conversation-Version':String(version)},...(method==='POST'?{body:new Uint8Array(bytes)}:{})});
}
async function upload(f:Fixture,options:Parameters<typeof req>[1]={},storage?:PrivateBucket){const request=req(f,{...options,method:'POST'}),actor=await webAttachmentActor(request,options?.staff?f.visitor.visitor.conversationId:undefined);return uploadWebAttachment(actor,request,{storage});}
const row=async(f:Fixture)=>(await database.query('SELECT * FROM conversations WHERE org_id=$1 AND id=$2',[f.org,f.visitor.visitor.conversationId])).rows[0];
const count=async(f:Fixture,table='messages')=>Number((await database.query(`SELECT count(*) AS n FROM ${table} WHERE org_id=$1`,[f.org])).rows[0].n);

test('route enforces original visitor cookie context, same origin, feature flag and prechat consent',async()=>{
 const f=await fixture();assert.equal((await GET(new Request(origin+'/api/chat/attachments'),ctx())).status,401);
 assert.equal((await GET(req(f,{widget:false}),ctx())).status,401);assert.equal((await POST(req(f,{method:'POST',origin:'https://evil.invalid'}),ctx())).status,403);
 delete process.env.WEB_CHAT_ATTACHMENTS_ENABLED;assert.equal((await POST(req(f,{method:'POST'}),ctx())).status,503);process.env.WEB_CHAT_ATTACHMENTS_ENABLED='true';
 await database.query("UPDATE organizations SET widget_config=json_set(widget_config,'$.prechatRequired',json('true')) WHERE id=$1",[f.org]);assert.equal((await POST(req(f,{method:'POST'}),ctx())).status,422);assert.equal(await count(f),0);
 await database.query("UPDATE organizations SET widget_config=json_set(widget_config,'$.prechatRequired',json('false'),'$.enabled',json('false')) WHERE id=$1",[f.org]);assert.equal((await POST(req(f,{method:'POST'}),ctx())).status,403);
});
test('visitor file is durable private message evidence, interrupts AI, increments unread sequence and exposes no storage path',async()=>{
 const f=await fixture();await database.query("UPDATE conversations SET generating_client_id='pending',generation_started_at=$2 WHERE id=$1",[f.visitor.visitor.conversationId,new Date().toISOString()]);process.env.FLOWS_ENABLED='true';
 const response=await POST(req(f,{method:'POST',name:'ใบเสนอราคา.pdf'}),ctx());assert.equal(response.status,201,await response.clone().text());const saved=await response.json();assert.equal((await row(f)).status,'waiting_human');assert.equal((await row(f)).customer_message_seq,1);assert.equal((await row(f)).generating_client_id,null);
 const detail=await visitorDetail(f.visitor.visitor);assert.equal(detail.messages[0].webAttachments[0].id,saved.file.id);assert.ok(!JSON.stringify(detail).includes('object_key'));assert.ok(!JSON.stringify(detail).includes('sessionHash'));
 const ingress=(await database.query('SELECT * FROM flow_ingress WHERE org_id=$1',[f.org])).rows[0];assert.equal(ingress.status,'processed');assert.equal(JSON.parse(ingress.signal).text,'');
 const download=await GET(req(f),ctx([saved.file.id]));assert.equal(download.status,200);assert.equal(download.headers.get('cache-control'),'private, no-store');assert.equal(download.headers.get('x-content-type-options'),'nosniff');assert.match(download.headers.get('content-disposition')!,/^attachment;/);assert.deepEqual(Buffer.from(await download.arrayBuffer()),pdf);
 assert.equal((await GET(req(f,{token:f.sibling.token}),ctx([saved.file.id]))).status,404);
 const g=await fixture();assert.equal((await GET(req(g),ctx([saved.file.id]))).status,404);
 const staffDownload=await staffGET(req(f,{staff:true}),{params:Promise.resolve({id:f.visitor.visitor.conversationId,path:[saved.file.id]})});assert.equal(staffDownload.status,200);
});
test('same upload client id is exactly-once across concurrent retries and rejects a different hash',async()=>{
 const f=await fixture('web'),client=randomUUID();const results=await Promise.all([upload(f,{client}),upload(f,{client})]);assert.equal(results[0].file.id,results[1].file.id);assert.equal(await count(f),1);assert.equal(await count(f,'web_chat_attachments'),1);assert.equal((await row(f)).customer_message_seq,1);
 await assert.rejects(upload(f,{client,bytes:Buffer.from('%PDF-different')}),{status:409});await assert.rejects(database.query("UPDATE web_chat_attachments SET sha256='changed' WHERE org_id=$1",[f.org]),/immutable/);
});
test('staff reply needs current claim and version, appears to visitor and never creates provider command',async()=>{
 const f=await fixture('web');await assert.rejects(upload(f,{staff:true}),{status:409});await conversationAction(f.staff,f.visitor.visitor.conversationId,'claim',{});const version=(await row(f)).version;
 const response=await staffPOST(req(f,{staff:true,method:'POST',version}),{params:Promise.resolve({id:f.visitor.visitor.conversationId})});assert.equal(response.status,201,await response.clone().text());const data=await response.json();
 const detail=await visitorDetail(f.visitor.visitor);assert.equal(detail.messages.at(-1)?.role,'agent');assert.equal(detail.messages.at(-1)?.webAttachments[0].id,data.file.id);assert.equal(await count(f,'social_outbound_commands'),0);assert.equal(await count(f,'external_send_commands'),0);
 const internal=await conversationDetail(f.org,f.visitor.visitor.conversationId,true);assert.match(internal.messages.at(-1)?.webAttachments[0].downloadUrl||'',/^\/api\/admin\/conversations\//);
});
test('staff generation/assignee and both session revocations fence the commit after private upload',async()=>{
 for(const mutation of ['seq','claim','staff-session','visitor-session']){
  const f=await fixture(),staff=mutation!=='visitor-session';if(staff)await conversationAction(f.staff,f.visitor.visitor.conversationId,'claim',{});const version=(await row(f)).version,bucket=await getPrivateBucket();
  const storage:PrivateBucket={...bucket,put:async(k,b,o)=>{await bucket.put(k,b,o);if(mutation==='seq')await database.query('UPDATE conversations SET customer_message_seq=customer_message_seq+1 WHERE id=$1',[f.visitor.visitor.conversationId]);if(mutation==='claim')await database.query('UPDATE conversations SET assignee_id=$2 WHERE id=$1',[f.visitor.visitor.conversationId,f.other]);if(mutation==='staff-session')await database.query('DELETE FROM staff_sessions WHERE token_hash=$1',[hashToken(f.token)]);if(mutation==='visitor-session')await database.query('DELETE FROM visitors WHERE token_hash=$1',[hashToken(f.visitor.token)]);}};
  await assert.rejects(upload(f,{staff,version},storage),(e:any)=>[401,409].includes(e.status));assert.equal(await count(f),0);assert.equal((await database.query('SELECT state FROM web_chat_attachments WHERE org_id=$1',[f.org])).rows[0].state,'pending');
 }
});
test('format, filename, streamed size, quota and stored hash fail closed',async()=>{
 const f=await fixture();await assert.rejects(upload(f,{mime:'text/html'}),{status:415});await assert.rejects(upload(f,{bytes:Buffer.from('<html>')}),{status:415});await assert.rejects(upload(f,{name:'../private.pdf'}),{status:400});await assert.rejects(upload(f,{bytes:Buffer.alloc(5*1024*1024+1)}),{status:413});
 const saved=await upload(f),r=(await database.query('SELECT * FROM web_chat_attachments WHERE org_id=$1',[f.org])).rows[0],bucket=await getPrivateBucket(),actor=await webAttachmentActor(req(f));
 await assert.rejects(downloadWebAttachment(actor,saved.file.id,{storage:{...bucket,get:async()=>({body:new Response(Buffer.from('%PDF-tampered')).body!})}}),{status:409});
 process.env.WEB_CHAT_FILE_STORAGE_LIMIT_BYTES=String(pdf.length);await assert.rejects(upload(f),{status:409});assert.equal((await sweepWebAttachments(f.org)).removed,0);
});
test('download rechecks logout and owner-only visibility after slow private read',async()=>{
 for(const mutate of ['logout','owner-only']){const f=await fixture(),saved=await upload(f),bucket=await getPrivateBucket(),actor=await webAttachmentActor(req(f));await assert.rejects(downloadWebAttachment(actor,saved.file.id,{storage:{...bucket,get:async key=>{const result=await bucket.get(key);if(mutate==='logout')await database.query('DELETE FROM visitors WHERE token_hash=$1',[hashToken(f.visitor.token)]);else await database.query('UPDATE messages SET source_owner_only=1 WHERE org_id=$1',[f.org]);return result;}}}),(e:any)=>[401,404].includes(e.status));}
});
test('published files are preserved; expired uncommitted uploads alone are cleaned',async()=>{
 const f=await fixture(),saved=await upload(f),bucket=await getPrivateBucket();await database.query("UPDATE web_chat_attachments SET expires_at='2000-01-01' WHERE org_id=$1",[f.org]);assert.equal((await sweepWebAttachments(f.org,bucket)).removed,0);assert.equal((await downloadWebAttachment(await webAttachmentActor(req(f)),saved.file.id)).status,200);
 const g=await fixture();await assert.rejects(upload(g,{}, {...bucket,put:async()=>{throw Error('Synthetic storage outage');}}),/storage outage/);await database.query("UPDATE web_chat_attachments SET expires_at='2000-01-01' WHERE org_id=$1",[g.org]);assert.equal((await sweepWebAttachments(g.org,bucket)).removed,1);assert.equal((await database.query('SELECT state FROM web_chat_attachments WHERE org_id=$1',[g.org])).rows[0].state,'expired');
});
test('late put after expiry keeps a durable deleting tombstone until cleanup succeeds',async()=>{
 for(const lost of [false,true]){const f=await fixture(),bucket=await getPrivateBucket();let objectKey='',rejectDelete=false;
  const storage:PrivateBucket={get:bucket.get,delete:async key=>{if(rejectDelete){rejectDelete=false;throw Error('Synthetic delete outage');}return bucket.delete!(key);},put:async(key,bytes,options)=>{objectKey=key;await database.query("UPDATE web_chat_attachments SET expires_at='2000-01-01' WHERE org_id=$1",[f.org]);await sweepWebAttachments(f.org,storage);await bucket.put(key,bytes,options);rejectDelete=true;if(lost)throw Error('Synthetic put committed response lost');}};
  await assert.rejects(upload(f,{},storage),{status:409});assert.equal((await database.query('SELECT state FROM web_chat_attachments WHERE org_id=$1',[f.org])).rows[0].state,'deleting');assert.ok(await bucket.get(objectKey));assert.equal((await sweepWebAttachments(f.org,storage)).removed,1);assert.equal(await bucket.get(objectKey),null);assert.equal(await count(f),0);
 }
});
test('ambiguous final D1 commit retains bytes and idempotent retry recovers the original message',async()=>{
 const f=await fixture(),client=randomUUID(),base=await getDatabase(),sqlBy=new WeakMap<D1Statement,string>();let lost=false;
 const wrapped:D1Binding={prepare(sql){const statement=base.prepare(sql);return {bind(...values){const bound=statement.bind(...values);sqlBy.set(bound,sql);return bound;},all:()=>statement.all()};},async batch(statements){const result=await base.batch(statements);if(!lost&&statements.some(s=>(sqlBy.get(s)||'').startsWith("UPDATE web_chat_attachments SET state='ready'"))){lost=true;throw Error('Synthetic final response lost');}return result;},withSession(){return wrapped;}};
 await assert.rejects(withDatabase(wrapped,()=>upload(f,{client})),/final response lost/);assert.equal(lost,true);const recovered=await upload(f,{client});assert.equal(recovered.duplicate,true);assert.equal(await count(f),1);assert.deepEqual(Buffer.from(await(await downloadWebAttachment(await webAttachmentActor(req(f)),recovered.file.id)).arrayBuffer()),pdf);
});
test('file ingress completes published flow assignment before basic team routing and never matches filename keywords',async()=>{
 const f=await fixture();await saveTeam(f.staff,{name:'Basic team A',timezone:'Asia/Bangkok',hours:Array.from({length:7},(_,day)=>({day,start:0,end:1440})),market:'all',provider:'web',accountId:'',enabled:true,priority:1,members:[{id:f.staff.id,capacity:10,available:true,leaveStart:'',leaveEnd:''}]});
 for(const [trigger,steps]of [[{type:'inbound_message'},[{id:'assign-b',type:'assign',memberId:f.other}]], [{type:'keyword',keywords:['STOP'],match:'contains'},[{id:'bad-label',type:'add_label',label:'filename-is-not-text'}]]] as const){const flow=await createFlow(f.staff,{name:'Synthetic file flow',definition:{version:1,trigger,conditions:[{type:'provider',providers:['web']}],steps}});await publishFlow(f.staff,flow.flow.id,{expectedRevision:flow.flow.draftRevision,confirm:true});}
 process.env.FLOWS_ENABLED='true';await upload(f,{name:'STOP.pdf'});assert.equal((await row(f)).assignee_id,f.other);assert.equal(Number((await database.query("SELECT count(*) AS n FROM audit_events WHERE org_id=$1 AND action='operator.team.assigned'",[f.org])).rows[0].n),0);assert.equal((await database.query('SELECT tags FROM leads WHERE org_id=$1 AND id=$2',[f.org,(await row(f)).lead_id])).rows[0].tags.includes('filename-is-not-text'),false);assert.equal((await maintainWebAttachments(f.org,await getPrivateBucket())).routed,0);
});
