/** Explicit consent fixtures only. No provider requests and no real customer evidence. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {before,after,test} from 'node:test';
import {database,transaction,closeDatabase} from '../src/lib/db';
import {hashToken,type Staff} from '../src/lib/auth';
import {reviewWhatsAppConsent,whatsappConsentStatus} from '../src/lib/social-consent';
import {dispatchSocialReply,enqueueSocialReply} from '../src/lib/social-channels';
import {readBridgeEvents} from '../src/lib/chat-bridge';
import {GET,POST} from '../src/app/api/admin/whatsapp-consent/[conversationId]/route';

const origin='https://crm.example.invalid',time='2026-01-02T03:04:05.000000Z';
const keys=['DEMO_MODE','RRS_WORKERS','D1_LOCAL_DIR','APP_ORIGIN','SESSION_SECRET','AI_PROVIDER'] as const;
const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
before(()=>{process.env.DEMO_MODE='true';process.env.RRS_WORKERS='false';process.env.D1_LOCAL_DIR=`.data/social-consent-${randomUUID()}`;process.env.APP_ORIGIN=origin;process.env.SESSION_SECRET='synthetic-consent-secret-at-least-32-characters';process.env.AI_PROVIDER='disabled';});
after(async()=>{await closeDatabase();for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}});

async function fixture(){
  const org=randomUUID(),lead=randomUUID(),conversation=randomUUID(),identity=randomUUID();
  await database.query('INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)',[org,org,'Synthetic consent tenant']);
  const members:Record<string,{staff:Staff;token:string}>={};
  for(const role of ['Admin','Agent'] as const){
    const id=randomUUID(),token=randomUUID(),staff:Staff={id,orgId:org,name:'Synthetic '+role,email:`${id}@example.invalid`,role};
    await database.query('INSERT INTO members(id,org_id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5,$6)',[id,org,staff.name,staff.email,'not-a-real-hash',role]);
    await database.query("INSERT INTO staff_sessions(token_hash,org_id,member_id,expires_at) VALUES($1,$2,$3,'2099-01-01T00:00:00.000000Z')",[hashToken(token),org,id]);members[role]={staff,token};
  }
  await database.query("INSERT INTO leads(id,org_id,name,source,stage,facts) VALUES($1,$2,'Synthetic WhatsApp customer','whatsapp','Qualified','{\"preserved\":true}')",[lead,org]);
  await database.query("INSERT INTO conversations(id,org_id,lead_id,status,assignee_id) VALUES($1,$2,$3,'human_active',$4)",[conversation,org,lead,members.Admin.staff.id]);
  await database.query("INSERT INTO social_identities(id,org_id,provider,account_id,remote_id,lead_id,conversation_id,created_at,updated_at) VALUES($1,$2,'whatsapp','1000000001','66800000001',$3,$4,$5,$5)",[identity,org,lead,conversation,time]);
  return {org,lead,conversation,identity,admin:members.Admin,agent:members.Agent};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const input=(revision:number,decision='granted')=>({decision,evidenceNote:'Synthetic reviewed opt-in form 2026-01-02, reference fixture-001',expectedRevision:revision,confirm:true});
async function status(f:Fixture){const result=await whatsappConsentStatus(f.admin.staff,f.conversation);assert.equal(result.applicable,true);if(!result.applicable)throw Error();return result;}
function request(f:Fixture,token:string,body?:Record<string,unknown>,requestOrigin=origin){return new Request(`${origin}/api/admin/whatsapp-consent/${f.conversation}`,{method:body?'POST':'GET',headers:{cookie:`rrs_staff=${token}`,origin:requestOrigin,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});}
const params=(f:Fixture)=>({params:Promise.resolve({conversationId:f.conversation})});
async function queued(f:Fixture){
  const id=randomUUID();
  const result=await transaction(f.org,async c=>{await c.query("INSERT INTO messages(id,org_id,conversation_id,role,content) VALUES($1,$2,$3,'agent','Synthetic approved reply')",[id,f.org,f.conversation]);return enqueueSocialReply(c,f.org,f.conversation,id,'Synthetic approved reply');});
  return {id,commandId:result.commandId!};
}

test('only an active Admin in the conversation organization can read or record consent',async()=>{
  const f=await fixture(),other=await fixture(),body=input((await status(f)).revision);
  assert.equal((await GET(request(f,''),params(f))).status,401);
  for(const token of [f.agent.token,other.admin.token]){
    const expected=token===f.agent.token?403:404;
    assert.equal((await GET(request(f,token),params(f))).status,expected);
    assert.equal((await POST(request(f,token,body),params(f))).status,expected);
  }
  assert.equal((await POST(request(f,f.admin.token,body,'https://foreign.example.invalid'),params(f))).status,403);
  await transaction(f.org,async c=>{await c.query('UPDATE members SET active=0 WHERE org_id=$1 AND id=$2',[f.org,f.admin.staff.id]);});
  assert.equal((await POST(request(f,f.admin.token,body),params(f))).status,401);
  await assert.rejects(reviewWhatsAppConsent(f.admin.staff,f.conversation,body),{status:403});
  assert.equal((await database.query('SELECT COUNT(*) AS n FROM audit_events WHERE org_id=$1',[f.org])).rows[0].n,0);
  assert.equal((await database.query('SELECT contact_consent_at FROM leads WHERE id=$1',[f.lead])).rows[0].contact_consent_at,null);
});

test('explicit evidence is audited without creating messages, changing sales data, or leaking its note into bridge records',async()=>{
  const f=await fixture(),initial=await status(f);assert.equal(initial.granted,false);
  const result=await POST(request(f,f.admin.token,input(initial.revision)),params(f));assert.equal(result.status,200);assert.match(result.headers.get('cache-control')!,/no-store/);
  const reviewed=await result.json();assert.equal(reviewed.granted,true);assert.equal(reviewed.lastReview.decision,'granted');assert.match(reviewed.recordedAt,/\.\d{6}Z$/);
  const lead=(await database.query('SELECT * FROM leads WHERE id=$1',[f.lead])).rows[0];assert.equal(lead.stage,'Qualified');assert.deepEqual(lead.facts,{preserved:true});assert.match(lead.contact_consent_version,/^whatsapp-admin-v1:/);
  const audit=(await database.query("SELECT * FROM audit_events WHERE org_id=$1 AND action='whatsapp_consent.granted'",[f.org])).rows[0];
  assert.equal(audit.actor_id,f.admin.staff.id);assert.equal(audit.entity_id,f.lead);assert.equal(audit.metadata.evidenceNote,input(0).evidenceNote);
  assert.equal((await database.query('SELECT COUNT(*) AS n FROM messages WHERE org_id=$1',[f.org])).rows[0].n,0);
  assert.equal(JSON.stringify((await readBridgeEvents(f.org)).events).includes(input(0).evidenceNote),false);
});

test('review requires bounded evidence, explicit confirmation and a fresh revision; concurrent reviews cannot overwrite',async()=>{
  const f=await fixture(),revision=(await status(f)).revision;
  for(const body of [{...input(revision),evidenceNote:''},{...input(revision),evidenceNote:'x'.repeat(1001)},{...input(revision),decision:'inbound_implies_consent'},{...input(revision),expectedRevision:'0'},{...input(revision),orgId:f.org}])await assert.rejects(reviewWhatsAppConsent(f.admin.staff,f.conversation,body),{status:400});
  await assert.rejects(reviewWhatsAppConsent(f.admin.staff,f.conversation,{...input(revision),confirm:false}),{status:422});
  const results=await Promise.allSettled([reviewWhatsAppConsent(f.admin.staff,f.conversation,input(revision)),reviewWhatsAppConsent(f.admin.staff,f.conversation,input(revision,'revoked'))]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const rejected=results.find(r=>r.status==='rejected') as PromiseRejectedResult;assert.equal(rejected.reason.status,409);
  assert.equal((await database.query("SELECT COUNT(*) AS n FROM audit_events WHERE org_id=$1 AND action LIKE 'whatsapp_consent.%'",[f.org])).rows[0].n,1);
  await assert.rejects(reviewWhatsAppConsent(f.admin.staff,f.conversation,input(revision)),{status:409});
});

test('revocation cancels queued replies and stale approvals but preserves in-flight receipts, history and opt-out',async()=>{
  const f=await fixture();await reviewWhatsAppConsent(f.admin.staff,f.conversation,input((await status(f)).revision));
  const waiting=await queued(f),sending=await queued(f);
  await database.query("UPDATE social_outbound_commands SET status='sending',attempt_id='synthetic-started' WHERE id=$1",[sending.commandId]);
  await database.query("UPDATE social_message_provenance SET delivery_status='sending' WHERE org_id=$1 AND message_id=$2",[f.org,sending.id]);
  await transaction(f.org,async c=>{await c.query('UPDATE social_identities SET opt_out=1 WHERE org_id=$1 AND id=$2',[f.org,f.identity]);});
  const oldVersion=(await database.query('SELECT version FROM conversations WHERE id=$1',[f.conversation])).rows[0].version;
  const revoked=await reviewWhatsAppConsent(f.admin.staff,f.conversation,input((await status(f)).revision,'revoked'));assert.equal(revoked.applicable,true);if(!revoked.applicable)throw Error();
  assert.equal(revoked.granted,false);assert.equal(revoked.optedOut,true);assert.equal(revoked.inFlight,1);
  const rows=(await database.query('SELECT id,status,error_code FROM social_outbound_commands WHERE org_id=$1',[f.org])).rows;
  assert.equal(rows.find(r=>r.id===waiting.commandId)!.status,'cancelled');assert.equal(rows.find(r=>r.id===sending.commandId)!.status,'sending');
  assert.equal((await database.query('SELECT delivery_status FROM social_message_provenance WHERE org_id=$1 AND message_id=$2',[f.org,waiting.id])).rows[0].delivery_status,'cancelled');
  assert.equal((await database.query('SELECT version FROM conversations WHERE id=$1',[f.conversation])).rows[0].version,oldVersion+1);
  let calls=0;assert.equal((await dispatchSocialReply(f.org,waiting.commandId,{fetch:async()=>{calls++;throw Error('No provider call permitted');}})).status,'cancelled');assert.equal(calls,0);
  await assert.rejects(reviewWhatsAppConsent(f.admin.staff,f.conversation,input(revoked.revision)),{status:409});
  assert.equal((await database.query('SELECT COUNT(*) AS n FROM messages WHERE org_id=$1',[f.org])).rows[0].n,2);
});

test('granting evidence does not release replies approved before consent review',async()=>{
  const f=await fixture(),waiting=await queued(f);assert.equal((await status(f)).granted,false);
  await reviewWhatsAppConsent(f.admin.staff,f.conversation,input((await status(f)).revision));
  assert.equal((await database.query('SELECT status FROM social_outbound_commands WHERE id=$1',[waiting.commandId])).rows[0].status,'cancelled');
  assert.equal((await database.query('SELECT opt_out FROM social_identities WHERE id=$1',[f.identity])).rows[0].opt_out,0);
});

test('an audit write failure rolls back consent, approval fences and cancellations together',async()=>{
  const f=await fixture(),waiting=await queued(f),initial=await status(f),head=(await readBridgeEvents(f.org)).headSequence;
  await database.query("CREATE TRIGGER consent_fail_audit BEFORE INSERT ON audit_events WHEN NEW.action LIKE 'whatsapp_consent.%' BEGIN SELECT RAISE(ABORT,'synthetic_consent_audit_failure'); END");
  try{await assert.rejects(reviewWhatsAppConsent(f.admin.staff,f.conversation,input(initial.revision)),/synthetic_consent_audit_failure/);}finally{await database.query('DROP TRIGGER consent_fail_audit');}
  assert.deepEqual(await status(f),initial);assert.equal((await readBridgeEvents(f.org)).headSequence,head);
  assert.equal((await database.query('SELECT status FROM social_outbound_commands WHERE id=$1',[waiting.commandId])).rows[0].status,'queued');
});
