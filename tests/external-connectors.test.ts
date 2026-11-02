import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHmac} from 'node:crypto';
import {before,after,test} from 'node:test';
import {database,closeDatabase,transaction,getDatabase} from '../src/lib/db';
import type {Staff} from '../src/lib/auth';
import {beginConnectorOAuth,completeConnectorOAuth,connectorToken,controlConnector,loadConnector,stamp,safeApiUrl,type ConnectorOptions} from '../src/lib/external-connectors';
import {sealSocialSecret} from '../src/lib/social-accounts';
import {persistMailPage,fetchMailPage,gmailReplyMime,dispatchEmail,queueEmailSelfTest,reconcileEmail,enqueueEmailReply,type Mail} from '../src/lib/external-mail';
import {syncConnector,runExternalConnectors} from '../src/lib/external-sync';
import {shopifyWebhook,safeResource,subscribeShopify} from '../src/lib/external-commerce';
import {openSocialSecret} from '../src/lib/social-accounts';
const saved={...process.env},originalFetch=globalThis.fetch;let admin:Staff;
before(async()=>{Object.assign(process.env,{DEMO_MODE:'true',RRS_WORKERS:'false',D1_LOCAL_DIR:'.data/connectors-'+randomUUID(),APP_ORIGIN:'https://crm.example.invalid',EXTERNAL_CONNECTORS_ENABLED:'true',EMAIL_SEND_ENABLED:'true',SOCIAL_TOKEN_KEY_CURRENT:'test',SOCIAL_TOKEN_KEYS:JSON.stringify({test:randomBytes(32).toString('base64')}),GMAIL_CLIENT_ID:'synthetic-client',GMAIL_CLIENT_SECRET:'synthetic-secret',OUTLOOK_CLIENT_ID:'synthetic-client',OUTLOOK_CLIENT_SECRET:'synthetic-secret',SHOPIFY_CLIENT_SECRET:'synthetic-shop-secret'});globalThis.fetch=(async()=>{throw new Error('Real network forbidden');}) as typeof fetch;const org=randomUUID(),id=randomUUID();await database.query('INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)',[org,org,'Connector fixture']);await database.query("INSERT INTO members(id,org_id,name,email,password_hash,role) VALUES($1,$2,'Admin',$3,'fixture','Admin')",[id,org,id+'@example.invalid']);admin={id,orgId:org,name:'Admin',email:id+'@example.invalid',role:'Admin'};});
after(async()=>{await closeDatabase();globalThis.fetch=originalFetch;for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);});
async function account(provider='gmail',overrides:Record<string,unknown>={}){const id=randomUUID(),key=provider==='shopify'?'fixture-'+id+'.myshopify.com':'mailbox-'+id+'@example.invalid',credential=await sealSocialSecret(JSON.stringify({access:'synthetic-access',refresh:'synthetic-refresh'}),'external-account',[admin.orgId,provider,key]);await database.query('INSERT INTO external_accounts(id,org_id,provider,account_key,display_name,scopes,credential,connected_by,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)',[id,admin.orgId,provider,key,key,JSON.stringify(provider==='gmail'?['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send']:['Mail.Read','Mail.Send']),JSON.stringify(credential),admin.id,stamp()]);for(const [name,value]of Object.entries(overrides)){assert.ok(['cursor','expires_at','test_marker','state'].includes(name));await database.query(`UPDATE external_accounts SET ${name}=$3 WHERE org_id=$1 AND id=$2`,[admin.orgId,id,value]);}return loadConnector(admin.orgId,id);}
const mail=(id:string,thread='thread'):Mail=>({id,thread,from:'customer@example.invalid',replyTo:'customer@example.invalid',subject:'Enquiry',text:'Synthetic enquiry '+id,internetId:'<'+id+'@example.invalid>',receivedAt:'2026-11-01T00:00:00.000Z',outgoing:false,mailboxReceived:true});
test('rotating refresh token has one lease and stores the new credential encrypted',async()=>{
 const a=await account('gmail',{expires_at:'2000-01-01T00:00:00Z'});let finish!:(value:Response)=>void,entered!:(value:void)=>void;const began=new Promise<void>(resolve=>entered=resolve),response=new Promise<Response>(resolve=>finish=resolve);
 const o={fetch:(async()=>{entered();return response;}) as typeof fetch};const first=connectorToken(a,o);await began;await assert.rejects(connectorToken(a,o),/busy/);finish(Response.json({access_token:'rotated-access',refresh_token:'rotated-refresh',expires_in:3600}));assert.equal(await first,'rotated-access');
 const fresh=await loadConnector(admin.orgId,a.id);assert.doesNotMatch(fresh.credential,/rotated/);const plain=JSON.parse(await openSocialSecret(JSON.parse(fresh.credential),'external-account',[admin.orgId,'gmail',a.account_key]));assert.equal(plain.refresh,'rotated-refresh');assert.equal(fresh.refresh_lease,'');
});
test('pause then resume fences an in-flight send while preserving a rotated refresh credential',async()=>{
 const a=await account('gmail',{expires_at:'2000-01-01T00:00:00Z'}),queued=await queueEmailSelfTest(admin,{id:a.id,confirm:true});let sends=0;
 const outcome=await dispatchEmail(admin.orgId,queued.commandId,{fetch:(async(input:unknown)=>{if(String(input).includes('oauth2.googleapis.com')){await controlConnector(admin,{id:a.id,expectedRevision:1,action:'pause',confirm:true});await controlConnector(admin,{id:a.id,expectedRevision:2,action:'resume',confirm:true});return Response.json({access_token:'fresh-token',refresh_token:'fresh-rotation',expires_in:3600});}sends++;return Response.json({id:'unexpected'});}) as typeof fetch});
 assert.equal(sends,0);assert.equal(outcome.status,'unknown');const fresh=await loadConnector(admin.orgId,a.id);assert.equal(fresh.revision,3);const tokens=JSON.parse(await openSocialSecret(JSON.parse(fresh.credential),'external-account',[admin.orgId,'gmail',a.account_key]));assert.equal(tokens.refresh,'fresh-rotation');
 await assert.rejects(controlConnector(admin,{id:a.id,expectedRevision:1,action:'pause',confirm:true}),/changed/);
});
test('failed canonical mail transaction never advances provider cursor; retry commits exactly once',async()=>{
 const a=await account('outlook');const raw={id:'immutable-id',conversationId:'thread',from:{emailAddress:{address:'customer@example.invalid'}},subject:'Test',body:{contentType:'Text',content:'Fixture'},internetMessageId:'<m@example.invalid>',receivedDateTime:'2026-11-01T00:00:00Z'};
 const o={fetch:(async()=>Response.json({value:[raw],'@odata.deltaLink':'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=done'})) as typeof fetch};
 await database.query(`CREATE TRIGGER fail_external_test BEFORE INSERT ON external_messages WHEN NEW.account_id='${a.id}' BEGIN SELECT RAISE(ABORT,'injected_external'); END`);
 const failed=await syncConnector(admin.orgId,a.id,o);assert.equal(failed.status,'deferred');assert.equal((await loadConnector(admin.orgId,a.id)).cursor,'{}');assert.equal((await database.query('SELECT * FROM external_threads WHERE account_id=$1',[a.id])).rows.length,0);
 await database.query('DROP TRIGGER fail_external_test');assert.equal((await syncConnector(admin.orgId,a.id,o)).status,'synced');await syncConnector(admin.orgId,a.id,o);assert.equal((await database.query('SELECT * FROM external_messages WHERE account_id=$1',[a.id])).rows.length,1);
});
test('OAuth state is session-bound, single-use, PKCE protected and encrypted at rest; read permission does not grant send',async()=>{
 const begin=await beginConnectorOAuth(admin,{provider:'gmail',authorizeSend:false}),url=new URL(begin.url);assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.ok(!url.searchParams.get('scope')!.includes('gmail.send'));
 let verifier='';const fetcher=(async(input:unknown,init:RequestInit)=>{if(String(input).includes('oauth2.googleapis.com')){verifier=new URLSearchParams(String(init.body)).get('code_verifier')||'';return Response.json({access_token:'new-secret-access',refresh_token:'new-secret-refresh',expires_in:3600,scope:'https://www.googleapis.com/auth/gmail.readonly'});}return Response.json({emailAddress:'owner@example.invalid',historyId:'10'});}) as typeof fetch;
 const callback=new URL('https://crm.example.invalid/api/admin/connectors/oauth/callback');callback.searchParams.set('state',url.searchParams.get('state')!);callback.searchParams.set('code','synthetic-code');
 const other=randomUUID();await database.query("INSERT INTO members(id,org_id,name,email,password_hash,role) VALUES($1,$2,'Other',$3,'fixture','Admin')",[other,admin.orgId,other+'@example.invalid']);await assert.rejects(completeConnectorOAuth({...admin,id:other},callback,{fetch:fetcher}),/state/);
 const connected=await completeConnectorOAuth(admin,callback,{fetch:fetcher});assert.ok(verifier.length>=43);const row=await loadConnector(admin.orgId,connected.id);assert.doesNotMatch(row.credential,/new-secret/);assert.equal(row.send_enabled,0);
 await assert.rejects(completeConnectorOAuth(admin,callback,{fetch:fetcher}),/state/);await assert.rejects(queueEmailSelfTest(admin,{id:connected.id,confirm:true}),/not_ready/);
});
test('two messages in a new thread and a replay create one conversation and two messages atomically',async()=>{
 const a=await account();await transaction(admin.orgId,c=>persistMailPage(c,a,[mail('one'),mail('two')]));await transaction(admin.orgId,c=>persistMailPage(c,a,[mail('one'),mail('two')]));
 assert.equal((await database.query('SELECT * FROM external_threads WHERE org_id=$1 AND account_id=$2',[admin.orgId,a.id])).rows.length,1);assert.equal((await database.query('SELECT * FROM external_messages WHERE org_id=$1 AND account_id=$2',[admin.orgId,a.id])).rows.length,2);
 const thread=(await database.query('SELECT conversation_id FROM external_threads WHERE account_id=$1',[a.id])).rows[0],c=(await database.query('SELECT status,customer_message_seq FROM conversations WHERE id=$1',[thread.conversation_id])).rows[0];assert.equal(c.status,'waiting_human');assert.equal(c.customer_message_seq,2);
 await assert.rejects(loadConnector(randomUUID(),a.id),/not_found/);
});
test('mail send is fenced when takeover changes while credentials refresh; self-test needs Inbox readback',async()=>{
 const a=await account('gmail',{expires_at:'2000-01-01T00:00:00Z'}),queued=await queueEmailSelfTest(admin,{id:a.id,confirm:true}),fresh=await loadConnector(admin.orgId,a.id);
 const self={...mail('self','self'),subject:fresh.test_marker,from:fresh.display_name,outgoing:true,mailboxReceived:false};await transaction(admin.orgId,c=>persistMailPage(c,fresh,[self]));assert.equal((await loadConnector(admin.orgId,a.id)).test_passed_at,null);
 await transaction(admin.orgId,c=>persistMailPage(c,fresh,[{...self,mailboxReceived:true}]));assert.ok((await loadConnector(admin.orgId,a.id)).test_passed_at);
 await transaction(admin.orgId,c=>persistMailPage(c,a,[mail('customer','reply-thread')]));const thread=(await database.query('SELECT * FROM external_threads WHERE account_id=$1',[a.id])).rows[0];
 await database.query("UPDATE external_accounts SET send_enabled=1 WHERE id=$1",[a.id]);await database.query("UPDATE conversations SET status='human_active',assignee_id=$2 WHERE id=$1",[thread.conversation_id,admin.id]);const message=randomUUID();
 const command=await transaction(admin.orgId,async c=>{await c.query("INSERT INTO messages(id,org_id,conversation_id,role,content,author_type,author_member_id) VALUES($1,$2,$3,'agent','Fixture reply','human',$4)",[message,admin.orgId,thread.conversation_id,admin.id]);return enqueueEmailReply(c,admin,thread.conversation_id,message,'Fixture reply');});let customerSends=0;
 const result=await dispatchEmail(admin.orgId,command!,{fetch:(async(input:unknown)=>{if(String(input).includes('oauth2.googleapis.com')){await database.query("UPDATE conversations SET status='resolved',version=version+1 WHERE id=$1",[thread.conversation_id]);return Response.json({access_token:'refreshed',refresh_token:'rotated',expires_in:3600});}customerSends++;return Response.json({id:'should-not-send'});}) as typeof fetch});assert.equal(customerSends,0);assert.equal(result.status,'unknown');
});
test('provider cursors cannot leak bearer tokens; failed page leaves cursor unchanged and applies backoff',async()=>{
 assert.throws(()=>safeApiUrl('outlook','x','https://evil.invalid/v1.0/me/mailFolders/inbox/messages/delta'),/cursor/);assert.throws(()=>safeApiUrl('gmail','x','https://gmail.googleapis.com/gmail/v1/users/other/messages'),/cursor/);
 const a=await account('outlook',{cursor:JSON.stringify({next:'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=safe'})});let calls=0;
 const result=await syncConnector(admin.orgId,a.id,{fetch:(async()=>{calls++;return new Response(null,{status:429,headers:{'retry-after':'600'}});}) as typeof fetch});assert.equal(result.status,'deferred');const fresh=await loadConnector(admin.orgId,a.id);assert.equal(fresh.cursor,a.cursor);assert.ok(Date.parse(fresh.next_sync_at)>Date.now()+500_000);assert.equal(calls,1);
 const disabled=await runExternalConnectors(await getDatabase(),{...process.env,EXTERNAL_CONNECTOR_RUNNER_ENABLED:'false'});assert.equal(disabled.status,'disabled');
});
test('Gmail full pages retain high-water history until paging completes, then use history incrementally',async()=>{
 const a=await account();let calls:string[]=[];const fetcher=(async(input:unknown)=>{const u=String(input);calls.push(u);if(u.endsWith('/profile'))return Response.json({historyId:'50'});if(u.includes('/messages?'))return Response.json({messages:[],nextPageToken:'next'});throw new Error('Unexpected request');}) as typeof fetch;
 const first=await fetchMailPage(a,'token',{fetch:fetcher});assert.equal(first.cursor.history,'50');assert.equal(first.cursor.mode,'full');assert.equal(first.cursor.page,'next');
 const second=await fetchMailPage({...a,cursor:JSON.stringify(first.cursor)},'token',{fetch:(async(input:unknown)=>{assert.match(String(input),/pageToken=next/);return Response.json({messages:[]});}) as typeof fetch});assert.equal(second.cursor.mode,'history');assert.equal(second.cursor.history,'50');
});
test('MIME rejects header injection and unknown provider send is never repeated; Gmail reconciliation only reads evidence',async()=>{
 assert.throws(()=>gmailReplyMime({from:'owner@example.invalid',to:'user@example.invalid\r\nBcc: victim@example.invalid',subject:'Hello',text:'Body',messageId:'id'}),/header/);
 const a=await account(),queued=await queueEmailSelfTest(admin,{id:a.id,confirm:true});let sends=0;
 const ambiguous=(async()=>{sends++;throw new Error('after submission transport lost');}) as typeof fetch;assert.equal((await dispatchEmail(admin.orgId,queued.commandId,{fetch:ambiguous})).status,'unknown');await dispatchEmail(admin.orgId,queued.commandId,{fetch:ambiguous});assert.equal(sends,1);
 const result=await reconcileEmail(admin,{commandId:queued.commandId},{fetch:(async(input:unknown,init:RequestInit)=>{assert.match(String(input),/rfc822msgid/);assert.equal(init.method,undefined);return Response.json({messages:[{id:'provider-sent-proof'}]});}) as typeof fetch});assert.equal(result.status,'submitted');
});
test('Shopify signed duplicate/stale events are idempotent and use same GID as GraphQL data',async()=>{
 const a=await account('shopify'),event=randomUUID();const request=(body:string,signature?:string)=>new Request('https://crm.example.invalid/api/connectors/shopify/'+a.id,{method:'POST',headers:{'x-shopify-shop-domain':a.account_key,'x-shopify-topic':'orders/updated','x-shopify-event-id':event,'x-shopify-hmac-sha256':signature||createHmac('sha256',process.env.SHOPIFY_CLIENT_SECRET!).update(body).digest('base64')},body});
 const raw=JSON.stringify({id:123,name:'#123',updated_at:'2026-11-01T00:00:00Z',total_price:'15.00',currency:'USD'});await assert.rejects(shopifyWebhook(a.id,request(raw,'invalid')),/signature/);assert.equal((await shopifyWebhook(a.id,request(raw))).duplicate,false);assert.equal((await shopifyWebhook(a.id,request(raw))).duplicate,true);await assert.rejects(shopifyWebhook(a.id,request(JSON.stringify({id:123,name:'changed'}))),/replay/);
 const resource=(await database.query('SELECT remote_id FROM external_resources WHERE account_id=$1',[a.id])).rows[0];assert.equal(resource.remote_id,'gid://shopify/Order/123');assert.equal(safeResource('shopify','order',{id:'gid://shopify/Order/123',updatedAt:'2026-11-01T00:00:00Z'}).id,resource.remote_id);
});

test('out-of-order history keeps the newest thread recipient and reply ID for Gmail and Outlook',async()=>{
 for(const provider of ['gmail','outlook']){
  const a=await account(provider),messages=[100,10,20].map(n=>({...mail('m'+n),replyTo:`recipient${n}@example.invalid`,subject:'Subject '+n,receivedAt:new Date(Date.UTC(2026,10,1,0,0,n)).toISOString()}));
  await transaction(admin.orgId,c=>persistMailPage(c,a,messages));
  // A subsequent old page must not lower the current persisted head either.
  await transaction(admin.orgId,c=>persistMailPage(c,a,[{...mail('m30'),replyTo:'recipient30@example.invalid',receivedAt:new Date(Date.UTC(2026,10,1,0,0,30)).toISOString()}]));
  const thread=(await database.query('SELECT * FROM external_threads WHERE account_id=$1',[a.id])).rows[0];
  assert.equal(thread.reply_to,'recipient100@example.invalid');assert.equal(thread.last_remote_id,'m100');assert.equal(thread.last_message_id,'<m100@example.invalid>');assert.equal(thread.subject,'Subject 100');assert.equal(thread.last_received_at,messages[0].receivedAt);
  await database.query("UPDATE external_accounts SET send_enabled=1,test_passed_at=$2 WHERE id=$1",[a.id,stamp()]);await database.query("UPDATE conversations SET status='human_active',assignee_id=$2 WHERE id=$1",[thread.conversation_id,admin.id]);
  const message=randomUUID(),command=await transaction(admin.orgId,async c=>{await c.query("INSERT INTO messages(id,org_id,conversation_id,role,content,author_member_id,author_type) VALUES($1,$2,$3,'agent','Fixture reply',$4,'human')",[message,admin.orgId,thread.conversation_id,admin.id]);return enqueueEmailReply(c,admin,thread.conversation_id,message,'Fixture reply');});
  let calls=0;const result=await dispatchEmail(admin.orgId,command!,{fetch:(async(input:unknown,init:RequestInit)=>{calls++;const body=JSON.parse(String(init.body));
   if(provider==='gmail'){const mime=Buffer.from(body.raw,'base64url').toString('utf8');assert.match(mime,/To: recipient100@example\.invalid/);assert.match(mime,/In-Reply-To: <m100@example\.invalid>/);assert.equal(body.threadId,'thread');return Response.json({id:'gmail-reply-proof'});}
   assert.ok(String(input).endsWith('/messages/m100/reply'));assert.equal(body.message.toRecipients[0].emailAddress.address,'recipient100@example.invalid');return new Response(null,{status:202});
  }) as typeof fetch});assert.equal(calls,1);assert.equal(result.status,'submitted');
 }
});

test('self-test Admin demotion during refresh blocks external POST despite an earlier valid claim',async()=>{
 const a=await account('gmail',{expires_at:'2000-01-01T00:00:00Z'}),queued=await queueEmailSelfTest(admin,{id:a.id,confirm:true});let posts=0;
 try{
  const result=await dispatchEmail(admin.orgId,queued.commandId,{fetch:(async(input:unknown)=>{
   if(String(input).includes('oauth2.googleapis.com')){await database.query("UPDATE members SET role='Agent' WHERE id=$1",[admin.id]);return Response.json({access_token:'new-self-test-token',refresh_token:'new-refresh',expires_in:3600});}
   posts++;return Response.json({id:'unexpected-send'});
  }) as typeof fetch});assert.equal(posts,0);assert.notEqual(result.status,'submitted');
 }finally{await database.query("UPDATE members SET role='Admin' WHERE id=$1",[admin.id]);}
});

test('Shopify subscription creation rechecks pause, credential revision and active Admin before each mutation',async()=>{
 for(const change of ['pause','rotate','demote','pause-after-first']){
  const a=await account('shopify');let mutations=0;
  const mutate=async()=>{
   if(change==='pause'||change==='pause-after-first')await controlConnector(admin,{id:a.id,expectedRevision:1,action:'pause',confirm:true});
   else if(change==='demote')await database.query("UPDATE members SET role='Agent' WHERE id=$1",[admin.id]);
   else{const credential=await sealSocialSecret(JSON.stringify({access:'new-shop-token',refresh:''}),'external-account',[admin.orgId,'shopify',a.account_key]);await database.query('UPDATE external_accounts SET credential=$2,revision=revision+1 WHERE id=$1',[a.id,JSON.stringify(credential)]);}
  };
  try{
   await assert.rejects(subscribeShopify(admin,{id:a.id,confirm:true},{fetch:(async(_input:unknown,init:RequestInit)=>{
    const body=JSON.parse(String(init.body));if(body.query.startsWith('query')){if(change!=='pause-after-first')await mutate();return Response.json({data:{webhookSubscriptions:{nodes:[],pageInfo:{hasNextPage:false}}}});}
    mutations++;if(change==='pause-after-first'&&mutations===1)await mutate();return Response.json({data:{webhookSubscriptionCreate:{webhookSubscription:{id:'fixture-subscription'},userErrors:[]}}});
   }) as typeof fetch}),error=>error instanceof Error&&(error.message==='subscription_fenced'||'status'in error&&error.status===403));
   assert.equal(mutations,change==='pause-after-first'?1:0);
  }finally{await database.query("UPDATE members SET role='Admin' WHERE id=$1",[admin.id]);}
 }
});

test('Gmail deleted-message 404 preserves pending history, while only expired history resets the cursor',async()=>{
 const a=await account('gmail',{cursor:JSON.stringify({history:'50',mode:'history'})});await transaction(admin.orgId,c=>persistMailPage(c,a,[mail('gone')]));
 const ids=['gone',...Array.from({length:20},(_,i)=>'history-'+i)],calls:string[]=[];
 const transport=(async(input:unknown)=>{const url=new URL(String(input));calls.push(url.href);
  if(url.pathname.endsWith('/history'))return Response.json({historyId:'90',history:[{id:'80',messagesAdded:ids.map(id=>({message:{id}}))}]});
  const id=url.pathname.split('/').at(-1)!;if(id==='gone')return new Response(null,{status:404});
  return Response.json({id,threadId:'thread',internalDate:String(Date.parse('2026-11-01T00:00:00Z')),labelIds:['INBOX'],payload:{mimeType:'text/plain',headers:[{name:'From',value:'customer@example.invalid'},{name:'Message-ID',value:`<${id}@example.invalid>`},{name:'Subject',value:'History fixture'}],body:{data:Buffer.from('Synthetic history '+id).toString('base64url')}}});
 }) as typeof fetch;
 const first=await syncConnector(admin.orgId,a.id,{fetch:transport});assert.equal(first.status,'synced');assert.equal(first.more,true);
 const savedCursor=JSON.parse((await loadConnector(admin.orgId,a.id)).cursor);assert.equal(savedCursor.history,'50');assert.equal(savedCursor.endHistory,'90');assert.deepEqual(savedCursor.pending,['history-19']);
 assert.ok((await database.query("SELECT removed_at FROM external_messages WHERE account_id=$1 AND remote_id='gone'",[a.id])).rows[0].removed_at);
 const second=await syncConnector(admin.orgId,a.id,{fetch:transport});assert.equal(second.status,'synced');assert.equal(second.more,false);assert.equal(JSON.parse((await loadConnector(admin.orgId,a.id)).cursor).history,'90');assert.equal(calls.filter(url=>url.includes('/history?')).length,1);
 assert.equal((await database.query('SELECT COUNT(*) AS n FROM external_messages WHERE account_id=$1',[a.id])).rows[0].n,21);
 const expired=await syncConnector(admin.orgId,a.id,{fetch:(async(input:unknown)=>{assert.ok(new URL(String(input)).pathname.endsWith('/history'));return new Response(null,{status:404});}) as typeof fetch});assert.equal(expired.status,'deferred');assert.equal(expired.error,'gmail_history_expired');assert.equal((await loadConnector(admin.orgId,a.id)).cursor,'{}');assert.equal((await database.query('SELECT COUNT(*) AS n FROM external_messages WHERE account_id=$1',[a.id])).rows[0].n,21);
});
