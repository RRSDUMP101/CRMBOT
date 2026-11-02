import {randomUUID} from 'node:crypto';
import {ApiError,type Staff,fields,requireAdmin,uuid,str} from './auth';
import {database,transaction,type Executor,type Row} from './db';
import {connectorAudit,connectorToken,hash,loadConnector,providerJson,safeApiUrl,stamp,type ConnectorOptions} from './external-connectors';
const json=(v:any)=>typeof v==='string'?JSON.parse(v):v;
export type Mail={id:string;thread:string;from:string;replyTo:string;subject:string;text:string;internetId:string;receivedAt:string;outgoing:boolean;removed?:boolean;mailboxReceived?:boolean};
export function emailAddress(raw:unknown){const value=String(raw||'').trim();if(/[\r\n]/.test(value)||value.length>400)throw new ApiError(422,'email_header_invalid');const match=value.match(/<([^<>]+)>$/),address=(match?.[1]||value).toLowerCase();if(!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(address)||address.length>254)throw new ApiError(422,'email_address_invalid');return address;}
const header=(headers:any[],name:string)=>String(headers.find(h=>String(h.name).toLowerCase()===name)?.value||'');
function plainHtml(html:string){return html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/\s+/g,' ').trim();}
function mimeText(part:Row,depth=0):string{if(depth>12)throw new ApiError(422,'mime_too_deep');if(part.filename||part.body?.attachmentId)return '';if(part.mimeType==='text/plain'&&part.body?.data)return Buffer.from(part.body.data,'base64url').toString('utf8');const parts=Array.isArray(part.parts)?part.parts:[];const plain=parts.filter((p:Row)=>p.mimeType==='text/plain').map((p:Row)=>mimeText(p,depth+1)).filter(Boolean);if(plain.length)return plain.join('\n');const children=parts.map((p:Row)=>mimeText(p,depth+1)).filter(Boolean);if(children.length)return children.join('\n');if(part.mimeType==='text/html'&&part.body?.data)return plainHtml(Buffer.from(part.body.data,'base64url').toString('utf8'));return '';}
const safeHeader=(s:string)=>{if(/[\r\n\0]/.test(s)||s.length>1000)throw new ApiError(422,'email_header_invalid');return s;};
export function normalizeGmail(raw:Row,account:Row):Mail{
 const headers=raw.payload?.headers||[],from=emailAddress(header(headers,'from')),replyTo=emailAddress(header(headers,'reply-to')||from),time=Number(raw.internalDate);
 if(!raw.id||!raw.threadId||!Number.isFinite(time))throw new ApiError(422,'gmail_message_invalid');
 const content=mimeText(raw.payload||{});return {id:String(raw.id),thread:String(raw.threadId),from,replyTo,subject:safeHeader(header(headers,'subject')).slice(0,500),text:content.slice(0,30000)||'[ข้อความนี้ไม่มีเนื้อหาข้อความที่รองรับ]',internetId:safeHeader(header(headers,'message-id')),receivedAt:new Date(time).toISOString(),outgoing:(raw.labelIds||[]).includes('SENT')||from===account.display_name,mailboxReceived:(raw.labelIds||[]).includes('INBOX')};
}
export function normalizeOutlook(raw:Row,account:Row):Mail{
 if(raw['@removed'])return {id:String(raw.id),removed:true,thread:'',from:'',replyTo:'',subject:'',text:'',internetId:'',receivedAt:stamp(),outgoing:false};
 const from=emailAddress(raw.from?.emailAddress?.address),replyTo=emailAddress(raw.replyTo?.[0]?.emailAddress?.address||from);
 if(!raw.id||!raw.conversationId||!Number.isFinite(Date.parse(raw.receivedDateTime)))throw new ApiError(422,'outlook_message_invalid');
 return {id:String(raw.id),thread:String(raw.conversationId),from,replyTo,subject:safeHeader(String(raw.subject||'')).slice(0,500),text:(raw.body?.contentType==='html'?plainHtml(String(raw.body?.content||'')):String(raw.body?.content||'')).slice(0,30000)||'[ข้อความนี้ไม่มีเนื้อหาข้อความที่รองรับ]',internetId:safeHeader(String(raw.internetMessageId||'')),receivedAt:new Date(raw.receivedDateTime).toISOString(),outgoing:from===account.display_name,mailboxReceived:true};
}
export async function fetchMailPage(account:Row,token:string,o:ConnectorOptions={}){
 const cursor=json(account.cursor),headers={Authorization:'Bearer '+token,Prefer:'outlook.body-content-type="text", IdType="ImmutableId"'};
 if(account.provider==='outlook'){
  const initial='https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$top=20&$select=id,conversationId,internetMessageId,subject,from,replyTo,body,receivedDateTime';
  const url=safeApiUrl('outlook',account.account_key,cursor.next||initial);const page=await providerJson(url,{headers},o);if(!Array.isArray(page.value)||page.value.length>100)throw new ApiError(502,'outlook_page_invalid');
  const next=page['@odata.nextLink']||page['@odata.deltaLink'];if(typeof next!=='string')throw new ApiError(502,'outlook_cursor_missing');safeApiUrl('outlook',account.account_key,next);
  return {messages:page.value.map((raw:Row)=>normalizeOutlook(raw,account)),cursor:{next},more:!!page['@odata.nextLink']};
 }
 const base='https://gmail.googleapis.com/gmail/v1/users/me/';let next={...cursor},ids:string[]=Array.isArray(cursor.pending)?cursor.pending:[],deleted:string[]=[];
 if(!ids.length){
  if(!cursor.history){const profile=await providerJson(base+'profile',{headers},o);next.history=String(profile.historyId);next.mode='full';}
  const full=next.mode==='full',url=new URL(base+(full?'messages':'history'));url.searchParams.set('maxResults','20');if(full)url.searchParams.set('labelIds','INBOX');else url.searchParams.set('startHistoryId',String(next.history));if(next.page)url.searchParams.set('pageToken',String(next.page));
  const page=await providerJson(url.href,{headers},o).catch(error=>{if(!full&&error instanceof ApiError&&/^provider_http_(404|410)$/.test(error.message))throw new ApiError(409,'gmail_history_expired');throw error;});ids=full?(page.messages||[]).map((m:Row)=>String(m.id)):[...new Set<string>((page.history||[]).flatMap((h:Row)=>[...(h.messagesAdded||[]),...(h.labelsAdded||[]).filter((m:Row)=>(m.labelIds||[]).includes('INBOX'))].map((m:Row)=>String(m.message.id))))];
  deleted=full?[]:(page.history||[]).flatMap((h:Row)=>(h.messagesDeleted||[]).map((m:Row)=>String(m.message.id)));
  if(ids.length>1000||deleted.length>1000)throw new ApiError(422,'gmail_history_page_too_large');next.page=page.nextPageToken||'';if(!full)next.endHistory=String(page.historyId||next.history);
 }
 const batch=ids.slice(0,20),messages:Mail[]=[];
 for(const id of batch){try{const raw=await providerJson(base+'messages/'+encodeURIComponent(id)+'?format=full',{headers},o);if((raw.labelIds||[]).includes('INBOX'))messages.push(normalizeGmail(raw,account));}catch(error){if(error instanceof ApiError&&/^provider_http_(404|410)$/.test(error.message))deleted.push(id);else throw error;}}
 for(const id of deleted)messages.push({id,removed:true,thread:'',from:'',replyTo:'',subject:'',text:'',internetId:'',receivedAt:stamp(),outgoing:false});
 next.pending=ids.slice(20);const more=!!next.page||next.pending.length>0;if(!more){if(next.endHistory)next.history=next.endHistory;next.mode='history';delete next.endHistory;}
 return {messages,cursor:next,more};
}
/** Canonical mail and cursor are committed together under the same account lease. */
export async function persistMailPage(c:Executor,account:Row,messages:Mail[]){
 const touched:string[]=[],threadCache=new Map<string,Row>(),seen=new Set<string>();
 for(const mail of messages){
  const known=(await c.query('SELECT message_id FROM external_messages WHERE org_id=$1 AND account_id=$2 AND remote_id=$3',[account.org_id,account.id,mail.id])).rows[0];
  if(mail.removed){if(known)await c.query('UPDATE external_messages SET removed_at=$4 WHERE org_id=$1 AND account_id=$2 AND remote_id=$3',[account.org_id,account.id,mail.id,stamp()]);continue;}
  // Self-tests can be labelled SENT as well as INBOX in Gmail. The receive copy proves the mailbox is readable.
  if(account.test_marker&&mail.subject===account.test_marker&&mail.from===account.display_name&&mail.mailboxReceived)await c.query('UPDATE external_accounts SET test_passed_at=$3 WHERE org_id=$1 AND id=$2',[account.org_id,account.id,stamp()]);
  if(known||mail.outgoing||seen.has(mail.id))continue;seen.add(mail.id);
  let thread=threadCache.get(mail.thread)||(await c.query('SELECT * FROM external_threads WHERE org_id=$1 AND account_id=$2 AND thread_id=$3',[account.org_id,account.id,mail.thread])).rows[0];
  if(!thread){const lead=randomUUID(),conversation=randomUUID();thread={lead_id:lead,conversation_id:conversation};await c.query('INSERT INTO leads(id,org_id,name,email,source) VALUES($1,$2,$3,$4,$5)',[lead,account.org_id,mail.from,mail.from,account.provider]);await c.query("INSERT INTO conversations(id,org_id,lead_id,status,handoff_at) VALUES($1,$2,$3,'waiting_human',$4)",[conversation,account.org_id,lead,mail.receivedAt]);await c.query('INSERT INTO external_threads(org_id,account_id,thread_id,conversation_id,lead_id,subject,reply_to,last_remote_id,last_message_id,last_received_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[account.org_id,account.id,mail.thread,conversation,lead,mail.subject,mail.replyTo,mail.id,mail.internetId,mail.receivedAt]);}
  else if(mail.receivedAt>=String(thread.last_received_at))await c.query('UPDATE external_threads SET subject=$4,reply_to=$5,last_remote_id=$6,last_message_id=$7,last_received_at=$8 WHERE org_id=$1 AND account_id=$2 AND thread_id=$3',[account.org_id,account.id,mail.thread,mail.subject,mail.replyTo,mail.id,mail.internetId,mail.receivedAt]);
  threadCache.set(mail.thread,!thread.last_received_at||mail.receivedAt>=String(thread.last_received_at)?{...thread,subject:mail.subject,reply_to:mail.replyTo,last_remote_id:mail.id,last_message_id:mail.internetId,last_received_at:mail.receivedAt}:thread);
  const message=randomUUID();await c.query("INSERT INTO messages(id,org_id,conversation_id,role,content,created_at) VALUES($1,$2,$3,'user',$4,$5)",[message,account.org_id,thread.conversation_id,mail.text,mail.receivedAt]);await c.query('INSERT INTO external_messages(org_id,account_id,remote_id,message_id,thread_id,internet_id) VALUES($1,$2,$3,$4,$5,$6)',[account.org_id,account.id,mail.id,message,mail.thread,mail.internetId]);
  await c.query("UPDATE conversations SET customer_message_seq=customer_message_seq+1,status=CASE WHEN status='human_active' THEN status ELSE 'waiting_human' END,version=version+1,generating_client_id=NULL,generation_started_at=NULL,first_customer_at=COALESCE(first_customer_at,$3),handoff_at=COALESCE(handoff_at,$3),updated_at=$4 WHERE org_id=$1 AND id=$2",[account.org_id,thread.conversation_id,mail.receivedAt,stamp()]);touched.push(thread.conversation_id);
 }
 return touched;
}
export function gmailReplyMime(input:{from:string;to:string;subject:string;text:string;messageId:string;inReplyTo?:string}){
 const from=emailAddress(input.from),to=emailAddress(input.to),subject='=?UTF-8?B?'+Buffer.from(safeHeader(input.subject)).toString('base64')+'?=',id=safeHeader(input.messageId),reply=input.inReplyTo?safeHeader(input.inReplyTo):'';
 if(reply&&!/^<[^<>\s]+>$/.test(reply))throw new ApiError(422,'reply_message_id_invalid');
 return Buffer.from([`From: ${from}`,`To: ${to}`,`Subject: ${subject}`,`Message-ID: <${id}@rrs.invalid>`,...(reply?[`In-Reply-To: ${reply}`,`References: ${reply}`]:[]),'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',Buffer.from(input.text).toString('base64').match(/.{1,76}/g)?.join('\r\n')||''].join('\r\n')).toString('base64url');
}
export async function enqueueEmailReply(c:Executor,staff:Staff,conversationId:string,messageId:string,text:string){
 const thread=(await c.query('SELECT * FROM external_threads WHERE org_id=$1 AND conversation_id=$2',[staff.orgId,conversationId])).rows[0];if(!thread)return null;
 const account=await loadConnector(staff.orgId,thread.account_id,c),conversation=(await c.query('SELECT version FROM conversations WHERE org_id=$1 AND id=$2',[staff.orgId,conversationId])).rows[0];
 if(process.env.EXTERNAL_CONNECTORS_ENABLED!=='true'||process.env.EMAIL_SEND_ENABLED!=='true'||!account.enabled||!account.send_enabled||!account.test_passed_at||account.state==='expired')throw new ApiError(409,'email_send_not_ready');
 const scope=account.provider==='gmail'?'https://www.googleapis.com/auth/gmail.send':'Mail.Send';if(!json(account.scopes).includes(scope))throw new ApiError(403,'email_send_scope_missing');
 const id=randomUUID(),payload=JSON.stringify({text,thread:thread.thread_id,replyTo:emailAddress(thread.reply_to),subject:thread.subject,remoteId:thread.last_remote_id,internetId:thread.last_message_id});
 await c.query('INSERT INTO external_send_commands(id,org_id,account_id,conversation_id,message_id,kind,payload,payload_hash,approved_by,account_revision,conversation_version,created_at) VALUES($1,$2,$3,$4,$5,\'reply\',$6,$7,$8,$9,$10,$11)',[id,staff.orgId,account.id,conversationId,messageId,payload,hash(payload),staff.id,account.revision,conversation.version,stamp()]);await c.query("UPDATE messages SET status='generating' WHERE org_id=$1 AND id=$2",[staff.orgId,messageId]);return id;
}
export async function queueEmailSelfTest(staff:Staff,input:Record<string,unknown>){
 requireAdmin(staff);fields(input,['id','confirm']);if(input.confirm!==true)throw new ApiError(400,'confirm_self_test');const id=randomUUID(),marker='RRS-TEST-'+id;
 await transaction(staff.orgId,async c=>{const account=await loadConnector(staff.orgId,uuid(input.id),c),scope=account.provider==='gmail'?'https://www.googleapis.com/auth/gmail.send':'Mail.Send';if(!['gmail','outlook'].includes(account.provider)||!json(account.scopes).includes(scope)||!account.enabled)throw new ApiError(409,'email_test_not_ready');const payload=JSON.stringify({replyTo:emailAddress(account.display_name),subject:marker,text:'RRS Connect mailbox verification. No customer message.'});await c.query('INSERT INTO external_send_commands(id,org_id,account_id,kind,payload,payload_hash,approved_by,account_revision,created_at) VALUES($1,$2,$3,\'self_test\',$4,$5,$6,$7,$8)',[id,staff.orgId,account.id,payload,hash(payload),staff.id,account.revision,stamp()]);await c.query('UPDATE external_accounts SET test_marker=$3,test_passed_at=NULL,send_enabled=0 WHERE org_id=$1 AND id=$2',[staff.orgId,account.id,marker]);await connectorAudit(c,staff.orgId,staff.id,'self_test_queued',account.id);},staff);return {commandId:id};
}
export async function dispatchEmail(org:string,id:string,o:ConnectorOptions={}){
 const env=o.env||process.env;if(env.EXTERNAL_CONNECTORS_ENABLED!=='true'||env.EMAIL_SEND_ENABLED!=='true')throw new ApiError(503,'email_sending_disabled');
 const claim=await transaction(org,async c=>{const command=(await c.query('SELECT * FROM external_send_commands WHERE org_id=$1 AND id=$2',[org,id])).rows[0];if(!command||command.status!=='queued')return null;const account=await loadConnector(org,command.account_id,c),member=(await c.query('SELECT active,role FROM members WHERE org_id=$1 AND id=$2',[org,command.approved_by])).rows[0];if(!account.enabled||account.revision!==command.account_revision||!member?.active)throw new ApiError(409,'email_approval_stale');if(command.kind==='self_test'&&member.role!=='Admin')throw new ApiError(403,'admin_required');if(command.kind==='reply'){const conversation=(await c.query('SELECT status,assignee_id,version FROM conversations WHERE org_id=$1 AND id=$2',[org,command.conversation_id])).rows[0];if(!account.send_enabled||!account.test_passed_at||conversation?.status!=='human_active'||conversation.assignee_id!==command.approved_by||conversation.version!==command.conversation_version)throw new ApiError(409,'email_reply_fenced');}await c.query("UPDATE external_send_commands SET status='sending',attempted_at=$3 WHERE org_id=$1 AND id=$2",[org,id,stamp()]);return {command,account};});if(!claim)return {status:'not_queued'};
 let status='unknown',providerId='';try{
  const {command,account}=claim,payload=json(command.payload),token=await connectorToken(account,o);const headers={Authorization:'Bearer '+token,'content-type':'application/json'};
  let url:string,body:unknown;if(account.provider==='gmail'){url='https://gmail.googleapis.com/gmail/v1/users/me/messages/send';body={raw:gmailReplyMime({from:account.display_name,to:payload.replyTo,subject:payload.subject,text:payload.text,messageId:id,inReplyTo:payload.internetId}),...(command.kind==='reply'?{threadId:payload.thread}:{})};}
  else if(command.kind==='reply'){url='https://graph.microsoft.com/v1.0/me/messages/'+encodeURIComponent(payload.remoteId)+'/reply';body={message:{body:{contentType:'Text',content:payload.text},toRecipients:[{emailAddress:{address:payload.replyTo}}]}};}
  else{url='https://graph.microsoft.com/v1.0/me/sendMail';body={message:{subject:payload.subject,body:{contentType:'Text',content:payload.text},toRecipients:[{emailAddress:{address:payload.replyTo}}]},saveToSentItems:true};}
  await transaction(org,async c=>{
    const fresh=await loadConnector(org,account.id,c),actor=(await c.query('SELECT active,role FROM members WHERE org_id=$1 AND id=$2',[org,command.approved_by])).rows[0];
    if(!fresh.enabled||fresh.revision!==command.account_revision||fresh.state==='expired'||!actor?.active)throw new ApiError(409,'email_send_fenced');
    if(command.kind==='self_test'&&actor.role!=='Admin')throw new ApiError(403,'admin_required');
    if(hash(command.payload)!==command.payload_hash)throw new ApiError(409,'email_payload_changed');
    const scope=account.provider==='gmail'?'https://www.googleapis.com/auth/gmail.send':'Mail.Send';if(!json(fresh.scopes).includes(scope))throw new ApiError(403,'email_send_scope_missing');
    const cap=Math.min(1000,Math.max(1,Number(env.EMAIL_DAILY_SEND_LIMIT)||100)),count=(await c.query("SELECT COUNT(*) AS n FROM external_send_commands WHERE org_id=$1 AND status IN ('submitted','sending','unknown') AND attempted_at>=$2",[org,new Date(Date.now()-86400_000).toISOString()])).rows[0].n;if(Number(count)>cap)throw new ApiError(429,'email_daily_cap');
    if(command.kind==='reply'){const conversation=(await c.query('SELECT status,version,assignee_id FROM conversations WHERE org_id=$1 AND id=$2',[org,command.conversation_id])).rows[0];if(!fresh.send_enabled||!fresh.test_passed_at||conversation?.status!=='human_active'||conversation.version!==command.conversation_version||conversation.assignee_id!==command.approved_by)throw new ApiError(409,'email_reply_fenced');}
  });
  const result=await providerJson(url,{method:'POST',headers,body:JSON.stringify(body)},o);providerId=String(result.id||'accepted');status='submitted';
 }catch(error){status=error instanceof ApiError&&error.status===429?'failed':'unknown';}
 await transaction(org,async c=>{await c.query("UPDATE external_send_commands SET status=$3,provider_id=$4,error_code=$5,submitted_at=$6 WHERE org_id=$1 AND id=$2 AND status='sending'",[org,id,status,providerId,status==='unknown'?'delivery_unknown_no_retry':status==='failed'?'provider_rejected':'',status==='submitted'?stamp():null]);if(claim.command.message_id)await c.query('UPDATE messages SET status=$3 WHERE org_id=$1 AND id=$2',[org,claim.command.message_id,status==='submitted'?'complete':'interrupted']);await connectorAudit(c,org,claim.command.approved_by,'email_'+status,id);});return {status};
}
export async function reconcileEmail(staff:Staff,input:Record<string,unknown>,o:ConnectorOptions={}){
 requireAdmin(staff);fields(input,['commandId']);const id=uuid(input.commandId),command=(await database.query('SELECT * FROM external_send_commands WHERE org_id=$1 AND id=$2',[staff.orgId,id])).rows[0];if(!command||command.status!=='unknown')throw new ApiError(409,'unknown_email_required');const account=await loadConnector(staff.orgId,command.account_id);if(account.provider!=='gmail')throw new ApiError(409,'outlook_unknown_requires_provider_review_no_retry');
 const token=await connectorToken(account,o),url=new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');url.searchParams.set('q','in:sent rfc822msgid:'+id+'@rrs.invalid');url.searchParams.set('maxResults','2');const found=await providerJson(url.href,{headers:{Authorization:'Bearer '+token}},o);if(!Array.isArray(found.messages)||found.messages.length!==1)return {status:'unknown',reason:'no_unique_provider_evidence'};
 await transaction(staff.orgId,async c=>{await c.query("UPDATE external_send_commands SET status='submitted',provider_id=$3,error_code='',submitted_at=$4 WHERE org_id=$1 AND id=$2 AND status='unknown'",[staff.orgId,id,String(found.messages[0].id),stamp()]);if(command.message_id)await c.query("UPDATE messages SET status='complete' WHERE org_id=$1 AND id=$2",[staff.orgId,command.message_id]);await connectorAudit(c,staff.orgId,staff.id,'email_reconciled',id);},staff);return {status:'submitted'};
}

