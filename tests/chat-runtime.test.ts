/** Synthetic SQLite and real request/cookie handlers. No provider or customer traffic. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { database, transaction, closeDatabase } from '../src/lib/db';
import { hashToken, STAFF_COOKIE, VISITOR_COOKIE, WIDGET_COOKIE, type Staff } from '../src/lib/auth';
import { signBridgeRequest } from '../src/lib/bridge-protocol';
import { handleBridgeCommand } from '../src/lib/bridge-commands';
import { messageStream, visitorDetail, conversationAction } from '../src/lib/service';
import { inbox as staffInbox } from '../src/lib/helpdesk';
import { readBridgeEvents } from '../src/lib/chat-bridge';
import { realtimeResponse } from '../src/lib/realtime';
import { POST } from '../src/app/api/bridge/[...path]/route';
import { GET as getApi } from '../src/app/api/[...path]/route';
import { NextRequest } from 'next/server';

const origin = 'http://localhost';
const secret = 'synthetic-command-and-stream-test-secret-32-characters';
const keys = ['DEMO_MODE','AI_PROVIDER','D1_LOCAL_DIR','RRS_WORKERS','APP_ORIGIN','SESSION_SECRET','CRM_BRIDGE_ENABLED','CRM_BRIDGE_ORG_ID','CRM_BRIDGE_SECRET','CRM_BRIDGE_ALLOWED_MEMBER_IDS'] as const;
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
before(() => {
  process.env.DEMO_MODE='true'; process.env.AI_PROVIDER='disabled'; process.env.RRS_WORKERS='false';
  process.env.D1_LOCAL_DIR=`.data/chat-runtime-${randomUUID()}`; process.env.APP_ORIGIN=origin;
  process.env.SESSION_SECRET=secret; process.env.CRM_BRIDGE_SECRET=secret; process.env.CRM_BRIDGE_ENABLED='true';
});
after(async () => {
  await closeDatabase();
  for (const key of keys) { if (previous[key]===undefined) delete process.env[key]; else process.env[key]=previous[key]; }
});

async function fixture() {
  const org=randomUUID(), member=randomUUID(), lead=randomUUID(), conversation=randomUUID();
  await database.query('INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)',[org,org,'Synthetic runtime tenant']);
  await database.query("INSERT INTO members(id,org_id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5,'Agent')",[member,org,'Synthetic agent',`${member}@example.invalid`,'not-a-login-hash']);
  await database.query('INSERT INTO leads(id,org_id,name) VALUES($1,$2,$3)',[lead,org,'Synthetic customer']);
  await database.query("INSERT INTO conversations(id,org_id,lead_id,status,assignee_id) VALUES($1,$2,$3,'human_active',$4)",[conversation,org,lead,member]);
  const staff:Staff={id:member,orgId:org,name:'Synthetic agent',email:`${member}@example.invalid`,role:'Agent'};
  return {org,member,lead,conversation,staff};
}
function allowBridge(f:Awaited<ReturnType<typeof fixture>>) {
  process.env.CRM_BRIDGE_ORG_ID=f.org;
  process.env.CRM_BRIDGE_ALLOWED_MEMBER_IDS=JSON.stringify([f.member]);
}
async function commandRequest(value:Record<string,unknown>) {
  const url=`${origin}/api/bridge/commands`,body=JSON.stringify(value);
  return new Request(url,{method:'POST',headers:await signBridgeRequest(url,{method:'POST',body,secret,orgId:process.env.CRM_BRIDGE_ORG_ID!}),body});
}
async function counts(org:string) {
  const row=(await database.query<{messages:number;commands:number;audits:number;outbound:number}>('SELECT (SELECT COUNT(*) FROM messages WHERE org_id=$1) AS messages,(SELECT COUNT(*) FROM crm_bridge_commands WHERE org_id=$1) AS commands,(SELECT COUNT(*) FROM audit_events WHERE org_id=$1) AS audits,(SELECT COUNT(*) FROM social_outbound_commands WHERE org_id=$1) AS outbound',[org])).rows[0];
  return {...row,head:(await readBridgeEvents(org)).headSequence};
}

test('concurrent signed commands and retry after a lost response commit one reply and one receipt',async()=>{
  const f=await fixture(); allowBridge(f);
  const command={commandId:randomUUID(),conversationId:f.conversation,actorId:f.member,action:'reply',text:'Synthetic reply exactly once'};
  const requests=await Promise.all([commandRequest(command),commandRequest(command)]);
  const responses=await Promise.all(requests.map(request=>POST(request)));
  assert.deepEqual(responses.map(response=>response.status),[200,200]);
  const first=await counts(f.org);
  assert.equal(first.messages,1); assert.equal(first.commands,1); assert.equal(first.audits,1); assert.equal(first.outbound,0);
  const records=(await database.query('SELECT role,content FROM messages WHERE org_id=$1',[f.org])).rows;
  assert.deepEqual(records,[{role:'agent',content:command.text}]);
  // The caller discards the first responses, then resends the same immutable command ID.
  const retry=await POST(await commandRequest(command));
  assert.equal(retry.status,200); assert.match(retry.headers.get('cache-control')!,/no-store/);
  assert.deepEqual(await retry.json(),{ok:true,commandId:command.commandId,conversationId:f.conversation});
  assert.deepEqual(await counts(f.org),first);
  const conflict=await POST(await commandRequest({...command,text:'Different payload with the old ID'}));
  assert.equal(conflict.status,409); assert.deepEqual(await counts(f.org),first);
});

test('receipt constraint failure rolls back reply, audit and bridge events before retry',async()=>{
  const f=await fixture(); allowBridge(f);
  const command={commandId:randomUUID(),conversationId:f.conversation,actorId:f.member,action:'reply',text:'Synthetic atomic reply'};
  const before=await counts(f.org);
  await database.query("CREATE TRIGGER runtime_reject_receipt BEFORE INSERT ON crm_bridge_commands BEGIN SELECT RAISE(ABORT,'synthetic_receipt_failure'); END");
  try { await assert.rejects(handleBridgeCommand(command),/synthetic_receipt_failure/); }
  finally { await database.query('DROP TRIGGER runtime_reject_receipt'); }
  assert.deepEqual(await counts(f.org),before);
  await handleBridgeCommand(command);
  const after=await counts(f.org); assert.equal(after.messages,1); assert.equal(after.commands,1); assert.equal(after.audits,1);
});

test('revoked or foreign actors cannot issue new commands or reuse a prior receipt',async()=>{
  const f=await fixture(),other=await fixture(); allowBridge(f);
  const command={commandId:randomUUID(),conversationId:f.conversation,actorId:f.member,action:'note',text:'Synthetic restricted note'};
  await handleBridgeCommand(command);
  const before=await counts(f.org);
  await transaction(f.org,async connection=>{await connection.query('UPDATE members SET active=0 WHERE org_id=$1 AND id=$2',[f.org,f.member]);});
  assert.equal((await POST(await commandRequest(command))).status,403);
  assert.equal((await POST(await commandRequest({...command,commandId:randomUUID()}))).status,403);
  // A stale Staff value must fail the inner transaction guard too.
  await assert.rejects(conversationAction(f.staff,f.conversation,'note',{text:'Stale actor must not write'}),{status:403});
  process.env.CRM_BRIDGE_ALLOWED_MEMBER_IDS=JSON.stringify([other.member]);
  assert.equal((await POST(await commandRequest({...command,commandId:randomUUID(),actorId:other.member}))).status,403);
  assert.deepEqual(await counts(f.org),before);
  assert.equal((await counts(other.org)).messages,0);
});

async function cookieSession(f:Awaited<ReturnType<typeof fixture>>,kind:'staff'|'visitor'|'widget') {
  const token=randomUUID(),cookie=kind==='staff'?STAFF_COOKIE:kind==='widget'?WIDGET_COOKIE:VISITOR_COOKIE;
  if(kind==='staff')await database.query("INSERT INTO staff_sessions(token_hash,org_id,member_id,expires_at) VALUES($1,$2,$3,'2099-01-01T00:00:00.000000Z')",[hashToken(token),f.org,f.member]);
  else await database.query("INSERT INTO visitors(token_hash,org_id,conversation_id,expires_at,context) VALUES($1,$2,$3,'2099-01-01T00:00:00.000000Z',$4)",[hashToken(token),f.org,f.conversation,kind==='widget'?'widget':'web']);
  return {token,cookie};
}
function streamRequest(session:{token:string;cookie:string},signal?:AbortSignal,headers:Record<string,string>={}) {
  return new Request(`${origin}/api/realtime`,{signal,headers:{cookie:`${session.cookie}=${session.token}`,origin,...headers}});
}
test('authenticated transcript and inbox resolve equal provider timestamps by customer sequence, preserving history time',async()=>{
  const f=await fixture(),session=await cookieSession(f,'staff'),at='2026-10-28T10:00:00.000000Z';
  const first='ffffffff-ffff-4fff-8fff-fffffffffff1',second='00000000-0000-4000-8000-000000000002',historic=randomUUID();
  for(const [id,content,seq,time] of [[first,'First customer message',1,at],[second,'Second customer message',2,at],[historic,'Older imported history',99,'2020-01-01T00:00:00.000000Z']])await database.query("INSERT INTO messages(id,org_id,conversation_id,role,content,customer_seq,created_at) VALUES($1,$2,$3,'user',$4,$5,$6)",[id,f.org,f.conversation,content,seq,time]);
  const get=async(path:string)=>{const response=await getApi(new NextRequest(origin+path,{headers:{cookie:`${session.cookie}=${session.token}`,origin}}));assert.equal(response.status,200);return response.json();};
  const detail=await get('/api/admin/conversations/'+f.conversation);assert.deepEqual(detail.messages.map((m:{id:string})=>m.id),[historic,first,second]);assert.equal(detail.messages[0].createdAt,'2020-01-01T00:00:00.000000Z');
  const inbox=await get('/api/admin/inbox');assert.equal(inbox.items.find((c:{id:string})=>c.id===f.conversation).lastMessage,'Second customer message');
  const snapshot=await get('/api/admin/snapshot');assert.equal(snapshot.conversations.find((c:{id:string})=>c.id===f.conversation).lastMessage,'Second customer message');
  const reply=randomUUID();await database.query("INSERT INTO messages(id,org_id,conversation_id,role,content,created_at) VALUES($1,$2,$3,'agent','Reply at the same timestamp',$4)",[reply,f.org,f.conversation,at]);
  assert.deepEqual((await get('/api/admin/conversations/'+f.conversation)).messages.map((m:{id:string})=>m.id),[historic,first,second,reply]);
});
async function chunk(reader:ReadableStreamDefaultReader<Uint8Array>) {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try { return await Promise.race([reader.read(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Timed out waiting for synthetic SSE event')),2500);})]); }
  finally { clearTimeout(timer); }
}
function frame(value:ReadableStreamReadResult<Uint8Array>,event:string) {
  assert.equal(value.done,false); assert.equal(new TextDecoder().decode(value.value),`event: ${event}\ndata: {}\n\n`);
}
async function quietForPoll(reader:ReadableStreamDefaultReader<Uint8Array>,mutate:()=>Promise<void>) {
  let settled=false;
  const pending=reader.read().then(value=>{settled=true;return value;});
  await mutate(); await new Promise(resolve=>setTimeout(resolve,650));
  assert.equal(settled,false,'An unrelated scope must not emit a realtime notification');
  return {pending};
}

test('staff SSE emits no foreign tenant data and terminates after the real session is revoked',async()=>{
  const f=await fixture(),other=await fixture(),session=await cookieSession(f,'staff');
  const response=await realtimeResponse(streamRequest(session),'staff');
  assert.match(response.headers.get('content-type')!,/text\/event-stream/); assert.match(response.headers.get('cache-control')!,/no-store/);
  const reader=response.body!.getReader();
  try {
    frame(await chunk(reader),'change');
    const quiet=await quietForPoll(reader,async()=>{await transaction(other.org,async connection=>{await connection.query('UPDATE leads SET name=$3 WHERE org_id=$1 AND id=$2',[other.org,other.lead,'Foreign confidential name']);});});
    await transaction(f.org,async connection=>{await connection.query('UPDATE leads SET name=$3 WHERE org_id=$1 AND id=$2',[f.org,f.lead,'Own tenant update']);});
    frame(await quiet.pending,'change');
    await database.query('DELETE FROM staff_sessions WHERE token_hash=$1',[hashToken(session.token)]);
    frame(await chunk(reader),'auth-required'); assert.equal((await chunk(reader)).done,true);
    await assert.rejects(realtimeResponse(streamRequest(session),'staff'),{status:401});
  } finally { await reader.cancel(); }
});

test('staff SSE rechecks active membership on an already open connection',async()=>{
  const f=await fixture(),session=await cookieSession(f,'staff');
  const reader=(await realtimeResponse(streamRequest(session),'staff')).body!.getReader();
  try {
    frame(await chunk(reader),'change');
    await transaction(f.org,async connection=>{await connection.query('UPDATE members SET active=0 WHERE org_id=$1 AND id=$2',[f.org,f.member]);});
    frame(await chunk(reader),'auth-required'); assert.equal((await chunk(reader)).done,true);
  } finally { await reader.cancel(); }
});

test('visitor SSE is conversation scoped, never returns contents, and closes when its cookie session expires',async()=>{
  const f=await fixture(),other=await fixture(),session=await cookieSession(f,'visitor');
  const sibling=randomUUID();
  await database.query('INSERT INTO conversations(id,org_id,lead_id) VALUES($1,$2,$3)',[sibling,f.org,f.lead]);
  const reader=(await realtimeResponse(streamRequest(session),'visitor')).body!.getReader();
  try {
    frame(await chunk(reader),'change');
    const quiet=await quietForPoll(reader,async()=>{
      for(const [org,conversation] of [[other.org,other.conversation],[f.org,sibling]])await transaction(org,async connection=>{
        await connection.query("INSERT INTO messages(id,org_id,conversation_id,role,content) VALUES($1,$2,$3,'user',$4)",[randomUUID(),org,conversation,'Other conversation secret']);
      });
    });
    await transaction(f.org,async connection=>{await connection.query("INSERT INTO messages(id,org_id,conversation_id,role,content) VALUES($1,$2,$3,'user',$4)",[randomUUID(),f.org,f.conversation,'Own visitor content never embedded in SSE']);});
    frame(await quiet.pending,'change');
    await database.query("UPDATE visitors SET expires_at='2000-01-01T00:00:00.000000Z' WHERE token_hash=$1",[hashToken(session.token)]);
    frame(await chunk(reader),'auth-required'); assert.equal((await chunk(reader)).done,true);
    await assert.rejects(realtimeResponse(streamRequest(session),'visitor'),{status:401});
  } finally { await reader.cancel(); }
});

test('SSE rejects missing, foreign-origin and wrong-context cookies; abort releases the open stream',async()=>{
  const f=await fixture(),staff=await cookieSession(f,'staff'),visitor=await cookieSession(f,'visitor'),widget=await cookieSession(f,'widget');
  for(const kind of ['staff','visitor'] as const)await assert.rejects(realtimeResponse(new Request(`${origin}/api/realtime`),kind),{status:401});
  await assert.rejects(realtimeResponse(streamRequest(staff,undefined,{origin:'https://foreign.example.invalid'}),'staff'),{status:403});
  await assert.rejects(realtimeResponse(streamRequest(visitor,undefined,{'sec-fetch-site':'cross-site'}),'visitor'),{status:403});
  await assert.rejects(realtimeResponse(streamRequest(visitor,undefined,{'x-rrs-widget':'1'}),'visitor'),{status:401});
  await assert.rejects(realtimeResponse(streamRequest(widget),'visitor'),{status:401});
  const abort=new AbortController();
  const reader=(await realtimeResponse(streamRequest(widget,abort.signal,{'x-rrs-widget':'1'}),'visitor')).body!.getReader();
  try { frame(await chunk(reader),'change'); abort.abort(); assert.equal((await chunk(reader)).done,true); }
  finally { await reader.cancel(); }
});

test('Thai customer question produces one English review acknowledgement and a scoped staff reply', async()=>{
  const f=await fixture(); allowBridge(f);
  const previousProvider=process.env.AI_PROVIDER, previousActors=process.env.CRM_CLARIFICATION_ALLOWED_MEMBER_IDS;
  try {
    process.env.AI_PROVIDER='sale_gateway';
    process.env.CRM_CLARIFICATION_ALLOWED_MEMBER_IDS=JSON.stringify([f.member]);
    await database.query("UPDATE conversations SET status='bot_active',assignee_id=NULL WHERE org_id=$1 AND id=$2",[f.org,f.conversation]);
    const visitor={orgId:f.org,conversationId:f.conversation}, request={text:'รุ่นนี้บรรทุกน้ำหนักได้เท่าไร',clientId:randomUUID()};
    const first=await messageStream(visitor,request,new AbortController().signal);
    assert.match(await first.text(),/Our sales team will review/);
    await (await messageStream(visitor,request,new AbortController().signal)).text();
    const items=(await database.query('SELECT * FROM messages WHERE org_id=$1 AND conversation_id=$2',[f.org,f.conversation])).rows;
    const source=items.find(x=>x.role==='user')!,acks=items.filter(x=>x.role==='assistant');
    assert.equal(acks.length,1); assert.equal(acks[0].sources[0].sourceMessageId,source.id);
    assert.doesNotMatch(JSON.stringify((await visitorDetail(visitor)).messages),/sales_clarification/);
    const events=await readBridgeEvents(f.org); assert.match(JSON.stringify(events),/sales_clarification/);
    const base={conversationId:f.conversation,actorId:f.member,clarificationSourceMessageId:source.id};
    await assert.rejects(handleBridgeCommand({...base,commandId:randomUUID(),action:'claim',clarificationSourceMessageId:randomUUID()}));
    await handleBridgeCommand({...base,commandId:randomUUID(),action:'claim'});
    await assert.rejects(handleBridgeCommand({...base,commandId:randomUUID(),action:'reply',text:'รับทราบครับ'}),{status:422});
    const reply={...base,commandId:randomUUID(),action:'reply',text:'We need the exact model to confirm the payload.'};
    await handleBridgeCommand(reply); await handleBridgeCommand(reply);
    const after=await visitorDetail(visitor); assert.equal(after.messages.filter(x=>x.content===reply.text).length,1);
  } finally { process.env.AI_PROVIDER=previousProvider; if(previousActors===undefined)delete process.env.CRM_CLARIFICATION_ALLOWED_MEMBER_IDS;else process.env.CRM_CLARIFICATION_ALLOWED_MEMBER_IDS=previousActors; }
});

test('staff composer replay commits one text and one note while rejecting changed content',async()=>{
  const f=await fixture();
  for (const action of ['reply','note']) {
    const body={commandId:randomUUID(), text:'Staff composer fixture '+action};
    await Promise.all([conversationAction(f.staff,f.conversation,action,body),conversationAction(f.staff,f.conversation,action,body)]);
    await conversationAction(f.staff,f.conversation,action,body);
    await assert.rejects(conversationAction(f.staff,f.conversation,action,{...body,text:'Changed fixture'}),/ข้อมูลอื่น/);
  }
  const state=await counts(f.org);
  assert.equal(state.messages,2);assert.equal(state.commands,2);assert.equal(state.audits,2);
});

test('company and quote search only locate linked work in the current customer market',async()=>{
  const f=await fixture(), other=await fixture(), deal=randomUUID();
  await database.query("UPDATE leads SET market='export' WHERE org_id=$1 AND id=$2",[f.org,f.lead]);
  const payload=JSON.stringify({companyName:'Example บริษัททดสอบ',quotation:{number:'QT-MARKET-FIXTURE'}});
  await database.query("INSERT INTO crm_sale_context(org_id,deal_id,lead_id,workspace,aggregate_version,sale_sequence,payload,updated_at) VALUES($1,$2,$3,'live',1,1,$4,$5)",[f.org,deal,f.lead,payload,new Date().toISOString()]);
  const find=(staff:Staff,q:string)=>staffInbox(staff,new URL('/api/admin/inbox?'+new URLSearchParams({q,leadId:f.lead}),origin));
  assert.equal((await find(f.staff,'บริษัททดสอบ')).items[0]?.id,f.conversation);
  assert.equal((await find(f.staff,'QT-MARKET-FIXTURE')).items[0]?.id,f.conversation);
  assert.equal((await find(other.staff,'QT-MARKET-FIXTURE')).items.length,0);
  await database.query("UPDATE leads SET market='domestic' WHERE org_id=$1 AND id=$2",[f.org,f.lead]);
  assert.equal((await find(f.staff,'QT-MARKET-FIXTURE')).items.length,0);
});

test('signed Sale inbox scopes counts, matching text, pagination and read receipts to the mapped member and eligible rooms',async()=>{
  const f=await fixture();allowBridge(f);
  const otherRoom=randomUUID(),otherLead=randomUUID(),notMapped=randomUUID();
  await database.query("UPDATE leads SET market='domestic' WHERE org_id=$1 AND id=$2",[f.org,f.lead]);
  await database.query("INSERT INTO leads(id,org_id,name,market) VALUES($1,$2,'Export customer','export')",[otherLead,f.org]);
  for(const [room,lead] of [[otherRoom,otherLead],[notMapped,f.lead]])await database.query("INSERT INTO conversations(id,org_id,lead_id) VALUES($1,$2,$3)",[room,f.org,lead]);
  const incoming=randomUUID(),privateMessage=randomUUID();
  for(const [room,id,seq,restricted] of [[f.conversation,incoming,1,0],[f.conversation,privateMessage,2,1],[otherRoom,randomUUID(),1,0],[notMapped,randomUUID(),1,0]]){
    await database.query("INSERT INTO messages(id,org_id,conversation_id,role,content,customer_seq,source_owner_only) VALUES($1,$2,$3,'user',$4,$5,$6)",[id,f.org,room,restricted?'Restricted source fixture':'Normal customer fixture',seq,restricted]);
  }
  const base={action:'list',actorId:f.member,workspace:'domestic',owner:false,roomIds:[f.conversation,otherRoom],view:'unread',limit:'1'};
  const send=async(payload:Record<string,unknown>)=>{
    const url=origin+'/api/bridge/inbox',body=JSON.stringify(payload);
    return POST(new Request(url,{method:'POST',headers:await signBridgeRequest(url,{secret,orgId:f.org,method:'POST',body}),body}));
  };
  async function list(extra:Record<string,unknown>={}){
    const response=await send({...base,...extra});assert.equal(response.status,200);
    return await response.json() as {total:number;counts:{all:number;unread:number};items:{id:string;lastMessage:string;unreadCount:number;lastCustomerMessageId:string}[];nextCursor:string|null};
  }
  const first=await list();
  assert.equal(first.total,1);assert.equal(first.counts.all,1);assert.equal(first.items[0].id,f.conversation);
  assert.equal(first.items[0].unreadCount,1);assert.equal(first.items[0].lastCustomerMessageId,incoming);
  assert.equal((await list({q:'Restricted source fixture'})).total,0);
  const eligible=[f.conversation,notMapped];const two=await list({roomIds:eligible});assert.ok(two.nextCursor);
  const next=await list({roomIds:eligible,cursor:two.nextCursor});assert.notEqual(two.items[0].id,next.items[0].id);
  const read={action:'read',actorId:f.member,workspace:'domestic',owner:false,conversationId:f.conversation,throughMessageId:incoming};
  assert.equal((await send({...read,throughMessageId:privateMessage})).status,404);
  assert.equal((await send(read)).status,200);assert.equal((await list()).counts.unread,0);
  assert.equal((await send({...base,actorId:randomUUID()})).status,403);
});
