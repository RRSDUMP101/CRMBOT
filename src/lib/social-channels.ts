import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { database, transaction, type Executor, type Row } from './db';
import { ApiError } from './errors';

export type SocialProvider = 'whatsapp' | 'line' | 'facebook';
export type SocialChannelConfig = {
  provider: SocialProvider; orgId: string; accountId: string; wabaId?: string;
  secret: string; verifyToken?: string; accessToken?: string; apiVersion?: string;
  appId?: string; webhookUrl?: string; testRecipient?: string;
  owner: string; inboundEnabled: boolean; liveEnabled: boolean;
};
type Attachment = { type: string; ref: string; metadata: Record<string, unknown> };
type Event = {
  id: string; kind: 'message'|'unsend'|'receipt'|'read'|'follow'|'unfollow'|'ignored';
  remote: string; mid?: string; at: string; text?: string; messageType?: string;
  echo?: boolean; status?: 'sent'|'delivered'|'read'|'failed'; watermark?: number;
  metadata?: Record<string, unknown>; attachments?: Attachment[];
};
const maxPayload = 1_000_000;
const digest = (value: string|Uint8Array) => createHash('sha256').update(value).digest('hex');
const utc = (milliseconds:number) => new Date(milliseconds).toISOString().replace(/(\.\d{3})Z$/, (_,fraction)=>fraction+'000Z');
const now = () => utc(Date.now());
const deliveryRank: Record<string, number> = {queued:0,sending:0,unknown:0,submitted:1,sent:2,failed:2,delivered:3,read:4};
const providers = new Set(['whatsapp','line','facebook']);
export function socialProvider(value: string): SocialProvider {
  if (!providers.has(value)) throw new ApiError(404, 'Unknown channel');
  return value as SocialProvider;
}

/** Secrets are read only on the server. Both environment and durable controls default off. */
export function readSocialConfig(provider: SocialProvider, env: Record<string,string|undefined> = process.env): SocialChannelConfig {
  const common = {provider,orgId:env.SOCIAL_CHANNELS_ORG_ID || '',owner:env.SOCIAL_CHANNELS_OWNER || '',
    inboundEnabled:env.SOCIAL_INBOUND_ENABLED === 'true',webhookUrl:env.APP_ORIGIN?env.APP_ORIGIN+'/api/channels/'+provider:'',
    testRecipient:env[provider==='whatsapp'?'WHATSAPP_TEST_RECIPIENT':provider==='line'?'LINE_TEST_RECIPIENT':'META_TEST_RECIPIENT']||'',
    liveEnabled:env.SOCIAL_LIVE_ENABLED === 'true' && env[provider === 'whatsapp' ? 'WHATSAPP_LIVE_ENABLED' : provider === 'line' ? 'LINE_LIVE_ENABLED' : 'DOMESTIC_LIVE_ENABLED'] === 'true' && (provider !== 'line' || env.DOMESTIC_LIVE_ENABLED === 'true')};
  if (provider === 'whatsapp') return {...common,accountId:env.WHATSAPP_PHONE_NUMBER_ID || '',wabaId:env.WHATSAPP_WABA_ID || '',appId:env.WHATSAPP_APP_ID||'',secret:env.WHATSAPP_APP_SECRET || '',verifyToken:env.WHATSAPP_VERIFY_TOKEN,accessToken:env.WHATSAPP_ACCESS_TOKEN,apiVersion:env.WHATSAPP_API_VERSION};
  if (provider === 'line') return {...common,accountId:env.LINE_BOT_USER_ID || '',secret:env.LINE_CHANNEL_SECRET || '',accessToken:env.LINE_CHANNEL_ACCESS_TOKEN};
  return {...common,accountId:env.META_PAGE_ID || '',secret:env.META_APP_SECRET || '',verifyToken:env.META_VERIFY_TOKEN,accessToken:env.META_PAGE_ACCESS_TOKEN,apiVersion:env.META_API_VERSION};
}
/** A one-way server-only fingerprint binds evidence to the exact current account and credentials. */
export function socialConfigFingerprint(config:SocialChannelConfig){
  return digest(JSON.stringify([config.provider,config.orgId,config.accountId,config.wabaId||'',config.appId||'',config.secret,config.accessToken||'',config.verifyToken||'',config.apiVersion||'',config.webhookUrl||'',config.testRecipient||'']));
}
export function socialVerificationReady(control:Row|undefined,config:SocialChannelConfig){
  const fp=socialConfigFingerprint(config);
  return !!control?.verified_at&&control.verification_fingerprint===fp&&Date.parse(control.verification_expires_at)>Date.now();
}
async function markTestPassed(c:Executor,config:SocialChannelConfig,messageId:string,status:string){
  if(!(config.provider==='line'?['submitted','sent','delivered','read']:['delivered','read']).includes(status))return;
  const control=(await c.query('SELECT * FROM social_channel_controls WHERE org_id=$1 AND provider=$2 AND account_id=$3',[config.orgId,config.provider,config.accountId])).rows[0];
  const command=(await c.query('SELECT remote_id,control_epoch,attempt_id FROM social_outbound_commands WHERE org_id=$1 AND message_id=$2',[config.orgId,messageId])).rows[0];
  if(control?.send_mode!=='test'||control.emergency_stop||!control.send_enabled||!command?.attempt_id||command.control_epoch!==control.epoch||command.remote_id!==control.test_recipient||!socialVerificationReady(control,config))return;
  await c.query('UPDATE social_channel_controls SET test_passed_at=$4,test_fingerprint=$5 WHERE org_id=$1 AND provider=$2 AND account_id=$3',[config.orgId,config.provider,config.accountId,now(),socialConfigFingerprint(config)]);
}
function assertConfig(config: SocialChannelConfig) {
  if (config.owner !== 'crm' || !config.inboundEnabled) throw new ApiError(503, 'CRM channel ownership is not enabled');
  if (!config.orgId || !config.accountId || !config.secret || config.provider === 'whatsapp' && !config.wabaId) throw new ApiError(503, 'Channel account scope is not configured');
}
function secretEqual(left: string, right: string) {
  const a = createHash('sha256').update(left).digest(), b = createHash('sha256').update(right).digest();
  return !!right && timingSafeEqual(a,b);
}
export function socialVerificationChallenge(request: Request, config: SocialChannelConfig): string {
  assertConfig(config);
  if (new URL(request.url).protocol !== 'https:') throw new ApiError(400, 'HTTPS required');
  const q = new URL(request.url).searchParams, challenge = q.get('hub.challenge') || '';
  if (config.provider === 'line' || q.get('hub.mode') !== 'subscribe' || !challenge || challenge.length > 1000 || !secretEqual(q.get('hub.verify_token') || '',config.verifyToken || '')) throw new ApiError(403, 'Verification failed');
  return challenge;
}
export async function readSocialBody(request: Request): Promise<Uint8Array> {
  if (Number(request.headers.get('content-length') || 0) > maxPayload) throw new ApiError(413, 'Payload too large');
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = []; let length = 0;
  try { while (true) {const {value,done} = await reader.read(); if(done) break; length += value.length; if(length > maxPayload) {await reader.cancel(); throw new ApiError(413,'Payload too large');} parts.push(value);} }
  finally {reader.releaseLock();}
  const bytes = new Uint8Array(length); let position = 0;
  for (const part of parts) {bytes.set(part,position);position += part.length;}
  return bytes;
}
export function verifySocialSignature(raw: Uint8Array, headers: Headers, config: SocialChannelConfig): boolean {
  if (!config.secret) return false;
  const header = headers.get(config.provider === 'line' ? 'x-line-signature' : 'x-hub-signature-256') || '';
  if (config.provider === 'line' ? !/^[A-Za-z0-9+/]{43}=$/.test(header) : !/^sha256=[a-f0-9]{64}$/i.test(header)) return false;
  const actual = Buffer.from(config.provider === 'line' ? header : header.slice(7),config.provider === 'line' ? 'base64' : 'hex');
  const expected = createHmac('sha256',config.secret).update(raw).digest();
  return actual.length === expected.length && timingSafeEqual(actual,expected);
}
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400,'Invalid webhook object');
  return value as Record<string,any>;
}
function array(value: unknown): any[] {if (!Array.isArray(value) || value.length > 100) throw new ApiError(400,'Invalid event list');return value;}
function identifier(value: unknown, maximum = 500): string {if(typeof value !== 'string' || !value || value.length > maximum || /[\x00-\x1f]/.test(value)) throw new ApiError(400,'Invalid provider identifier');return value;}
function timestamp(value: unknown, seconds = false) {
  const ms = Number(value) * (seconds ? 1000 : 1);
  if (!Number.isFinite(ms) || ms <= 0 || ms > Date.now()+300_000) throw new ApiError(400,'Invalid provider timestamp');
  return utc(ms);
}
function messageMetadata(message: Record<string,any>) {
  // Private provenance retains the original type/media fields, but never becomes executable HTML or a fetch target.
  const copy = {...message}; delete copy.text; delete copy.body;
  const encoded = JSON.stringify(copy);
  if(encoded.length > 50_000) throw new ApiError(413,'Message metadata too large');
  return copy;
}
function attachmentsFor(provider: SocialProvider, message: Record<string,any>, mid: string): Attachment[] {
  if(provider === 'whatsapp') {
    const type = String(message.type || 'unknown'), media = message[type];
    return ['image','video','audio','document','sticker'].includes(type) && media?.id ? [{type,ref:identifier(media.id),metadata:messageMetadata(media)}] : [];
  }
  if(provider === 'line') {
    return ['image','video','audio','file'].includes(message.type) ? [{type:message.type,ref:mid,metadata:messageMetadata(message)}] : [];
  }
  return array(message.attachments || []).map(item => {
    const media = object(item), payload = object(media.payload || {});
    return {type:String(media.type || 'attachment').slice(0,80),ref:typeof payload.attachment_id === 'string' ? payload.attachment_id : typeof payload.url === 'string' ? payload.url.slice(0,8000) : mid,metadata:messageMetadata(media)};
  });
}

/** Normalizes only after validating every envelope account, so a mixed-account payload writes nothing. */
function normalize(payload: Record<string,any>, config: SocialChannelConfig): Event[] {
  const result: Event[] = [];
  if(config.provider === 'whatsapp') {
    if(payload.object !== 'whatsapp_business_account') throw new ApiError(400,'Expected WhatsApp webhook');
    for(const entry of array(payload.entry)) {
      if(String(entry?.id) !== config.wabaId) throw new ApiError(403,'WhatsApp account mismatch');
      for(const change of array(entry.changes)) {
        const value = object(change?.value);
        if(String(value.metadata?.phone_number_id) !== config.accountId) throw new ApiError(403,'WhatsApp phone mismatch');
        for(const incoming of array(value.messages || [])) {
          const m=object(incoming), mid=identifier(m.id), remote=identifier(m.from,200);
          if(!/^\d{8,15}$/.test(remote)) throw new ApiError(400,'Invalid WhatsApp sender');
          const type=String(m.type || 'unknown').slice(0,80);
          const text = m.text?.body || m.button?.text || m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || m[type]?.caption || `[ข้อความ ${type} — ตรวจสื่อใน WhatsApp]`;
          result.push({id:'message:'+mid,kind:'message',remote,mid,at:timestamp(m.timestamp,true),text:String(text).slice(0,15000),messageType:type,metadata:messageMetadata(m),attachments:attachmentsFor('whatsapp',m,mid)});
        }
        for(const receipt of array(value.statuses || [])) {
          const r=object(receipt),mid=identifier(r.id),at=timestamp(r.timestamp,true);
          if(!['sent','delivered','read','failed'].includes(r.status)) continue;
          result.push({id:`receipt:${mid}:${r.status}:${r.timestamp}`,kind:'receipt',remote:typeof r.recipient_id === 'string' ? identifier(r.recipient_id,200) : '',mid,at,status:r.status});
        }
      }
    }
  } else if(config.provider === 'line') {
    if(payload.destination !== config.accountId) throw new ApiError(403,'LINE account mismatch');
    for(const input of array(payload.events)) {
      const e=object(input),at=timestamp(e.timestamp),id=typeof e.webhookEventId === 'string' ? identifier(e.webhookEventId) : digest(JSON.stringify(e));
      // Existing application supports direct user chats; group/room identities never collapse into a user.
      if(e.source?.type !== 'user') {result.push({id,kind:'ignored',remote:'',at});continue;}
      const remote=identifier(e.source.userId,200);
      if(e.type === 'unsend') {const mid=identifier(e.unsend?.messageId);result.push({id:'unsend:'+mid+':'+remote,kind:'unsend',remote,mid,at});}
      else if(e.type === 'follow' || e.type === 'unfollow') result.push({id,kind:e.type,remote,at});
      else if(e.type === 'message') {
        const m=object(e.message),mid=identifier(m.id),type=String(m.type || 'unknown').slice(0,80);
        result.push({id,kind:'message',remote,mid,at,text:String(m.text || (type === 'sticker' ? '[สติกเกอร์ LINE]' : type === 'file' ? `[ไฟล์ ${String(m.fileName || 'แนบ').slice(0,200)}]` : `[${type}]`)).slice(0,15000),messageType:type,metadata:messageMetadata(m),attachments:attachmentsFor('line',m,mid)});
      } else result.push({id,kind:'ignored',remote,at});
    }
  } else {
    if(payload.object !== 'page') throw new ApiError(400,'Expected Page webhook');
    for(const entry of array(payload.entry)) {
      if(String(entry?.id) !== config.accountId) throw new ApiError(403,'Facebook page mismatch');
      for(const input of array(entry.messaging || [])) {
        const e=object(input),echo=e.message?.is_echo === true,remote=identifier(echo?e.recipient?.id:e.sender?.id,200),at=timestamp(e.timestamp);
        if((echo ? e.sender?.id : e.recipient?.id) !== config.accountId) throw new ApiError(403,'Facebook recipient mismatch');
        if(e.message) {
          const m=object(e.message),mid=identifier(m.mid);
          result.push({id:'message:'+mid,kind:'message',remote,mid,at,echo,text:String(m.text || '[ไฟล์แนบ Facebook]').slice(0,15000),messageType:typeof m.text === 'string' ? 'text' : String(m.attachments?.[0]?.type || 'attachment').slice(0,80),metadata:messageMetadata(m),attachments:attachmentsFor('facebook',m,mid)});
        } else if(e.delivery?.mids) {
          for(const value of array(e.delivery.mids)) {const mid=identifier(value);result.push({id:`receipt:${mid}:delivered:${e.delivery.watermark || e.timestamp}`,kind:'receipt',remote,mid,at,status:'delivered'});}
        } else if(e.read?.watermark) {
          const watermark=Number(e.read.watermark);timestamp(watermark);
          result.push({id:`read:${remote}:${watermark}`,kind:'read',remote,at,watermark});
        } else result.push({id:digest(JSON.stringify(e)),kind:'ignored',remote,at});
      }
    }
  }
  if(result.length > 100) throw new ApiError(400,'Event limit exceeded');
  return result;
}

async function findIdentity(c: Executor, config: SocialChannelConfig, remote: string) {
  return (await c.query('SELECT * FROM social_identities WHERE org_id=$1 AND provider=$2 AND account_id=$3 AND remote_id=$4',[config.orgId,config.provider,config.accountId,remote])).rows[0];
}
async function createIdentity(c: Executor, config: SocialChannelConfig, event: Event) {
  const time=now(), leadId=randomUUID(), conversationId=randomUUID(), id=randomUUID();
  await c.query('INSERT INTO leads(id,org_id,name,source,market,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6)',[leadId,config.orgId,`รอยืนยันตัวตน · ${config.provider} ${event.remote.slice(-6)}`,config.provider,config.provider === 'whatsapp' ? 'export' : 'domestic',time]);
  await c.query("INSERT INTO conversations(id,org_id,lead_id,status,created_at,updated_at) VALUES($1,$2,$3,'waiting_human',$4,$4)",[conversationId,config.orgId,leadId,time]);
  await c.query('INSERT INTO social_identities(id,org_id,provider,account_id,remote_id,lead_id,conversation_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)',[id,config.orgId,config.provider,config.accountId,event.remote,leadId,conversationId,time]);
  return {id,org_id:config.orgId,provider:config.provider,account_id:config.accountId,remote_id:event.remote,lead_id:leadId,conversation_id:conversationId,opt_out:0,read_watermark_ms:0,fresh:true};
}
async function updateReceipt(c: Executor, config: SocialChannelConfig, event: Event) {
  const args=[config.orgId,config.provider,config.accountId,event.mid!,event.remote,event.status!,deliveryRank[event.status!],event.at,now()];
  await c.query(`INSERT INTO social_delivery_receipts(org_id,provider,account_id,provider_message_id,remote_id,status,rank,provider_timestamp,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT(org_id,provider,account_id,provider_message_id) DO UPDATE SET status=excluded.status,rank=excluded.rank,updated_at=excluded.updated_at WHERE excluded.rank>=social_delivery_receipts.rank`,args);
  const matched=(await c.query('SELECT * FROM social_message_provenance WHERE org_id=$1 AND provider=$2 AND account_id=$3 AND provider_message_id=$4',[...args.slice(0,4)])).rows[0];
  if(matched && matched.direction === 'out' && (!event.remote || event.remote === matched.remote_id) && deliveryRank[matched.delivery_status] <= deliveryRank[event.status!]) {
    await c.query('UPDATE social_message_provenance SET delivery_status=$3 WHERE org_id=$1 AND message_id=$2',[config.orgId,matched.message_id,event.status!]);
    await c.query('UPDATE social_outbound_commands SET status=$3,updated_at=$4 WHERE org_id=$1 AND message_id=$2',[config.orgId,matched.message_id,event.status!,now()]);
    await markTestPassed(c,config,matched.message_id,event.status!);
  }
}
async function ingestEvent(c: Executor, config: SocialChannelConfig, event: Event, payloadHash: string): Promise<boolean> {
  const keys=[config.orgId,config.provider,config.accountId,event.id];
  if((await c.query('SELECT 1 FROM social_events WHERE org_id=$1 AND provider=$2 AND account_id=$3 AND event_id=$4',keys)).rows.length) return false;
  const time=now();
  // Event receipt is committed atomically with its normalized business changes.
  await c.query('INSERT INTO social_events(org_id,provider,account_id,event_id,event_kind,provider_message_id,remote_id,payload_sha256,received_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[...keys,event.kind,event.mid || null,event.remote,payloadHash,time]);
  await c.query('INSERT OR IGNORE INTO social_channel_controls(org_id,provider,account_id,updated_at) VALUES($1,$2,$3,$4)',[config.orgId,config.provider,config.accountId,time]);
  if(event.kind === 'ignored') return true;
  if(event.kind === 'receipt') {await updateReceipt(c,config,event);return true;}
  let identity=await findIdentity(c,config,event.remote);
  if(event.kind === 'unsend') {
    await c.query('INSERT OR IGNORE INTO social_tombstones(org_id,provider,account_id,remote_id,provider_message_id,created_at) VALUES($1,$2,$3,$4,$5,$6)',[config.orgId,config.provider,config.accountId,event.remote,event.mid!,time]);
    const message=(await c.query('SELECT message_id FROM social_message_provenance WHERE org_id=$1 AND provider=$2 AND account_id=$3 AND remote_id=$4 AND provider_message_id=$5',[config.orgId,config.provider,config.accountId,event.remote,event.mid!])).rows[0];
    if(message) {
      await c.query("UPDATE messages SET content='[ลูกค้ายกเลิกข้อความ]',sources='[]' WHERE org_id=$1 AND id=$2",[config.orgId,message.message_id]);
      await c.query("UPDATE social_message_provenance SET delivery_status='cancelled',metadata='{}',removed_at=$3 WHERE org_id=$1 AND message_id=$2",[config.orgId,message.message_id,time]);
      await c.query("UPDATE social_message_attachments SET provider_ref='',metadata='{}',object_key=NULL,storage_state='removed',removed_at=$3 WHERE org_id=$1 AND message_id=$2",[config.orgId,message.message_id,time]);
    }
    if(identity) await cancelGeneration(c,config.orgId,identity.conversation_id,'Customer unsent a message',true);
    return true;
  }
  if(event.kind === 'message') {
    const scope=[config.orgId,config.provider,config.accountId,event.remote,event.mid!];
    if(config.provider === 'line') {
      const legacyId='dom:line:unsend:'+digest(config.accountId+':'+event.remote+':'+event.mid!);
      if((await c.query("SELECT 1 FROM crm_legacy_webhooks WHERE org_id=$1 AND workspace='domestic' AND id=$2 LIMIT 1",[config.orgId,legacyId])).rows.length) return true;
    }
    if((await c.query('SELECT 1 FROM social_tombstones WHERE org_id=$1 AND provider=$2 AND account_id=$3 AND remote_id=$4 AND provider_message_id=$5',scope)).rows.length) return true;
    if((await c.query('SELECT 1 FROM social_message_provenance WHERE org_id=$1 AND provider=$2 AND account_id=$3 AND provider_message_id=$4',[config.orgId,config.provider,config.accountId,event.mid!])).rows.length) return false;
  }
  if(!identity && ['message','follow'].includes(event.kind)) identity=await createIdentity(c,config,event);
  if(!identity) return true;
  if(event.kind === 'follow' || event.kind === 'unfollow') {
    await c.query('UPDATE social_identities SET opt_out=$3,updated_at=$4 WHERE org_id=$1 AND id=$2',[config.orgId,identity.id,event.kind === 'unfollow' ? 1 : 0,time]);
    await cancelGeneration(c,config.orgId,identity.conversation_id,event.kind === 'unfollow' ? 'Customer opted out' : 'Customer followed; human review required',true);
    return true;
  }
  if(event.kind === 'read') {
    await c.query('UPDATE social_identities SET read_watermark_ms=MAX(read_watermark_ms,$3) WHERE org_id=$1 AND id=$2',[config.orgId,identity.id,event.watermark!]);
    const items=(await c.query("SELECT p.message_id FROM social_message_provenance p WHERE p.org_id=$1 AND p.provider=$2 AND p.account_id=$3 AND p.remote_id=$4 AND p.direction='out' AND p.provider_message_id IS NOT NULL AND p.provider_timestamp<=$5 AND p.delivery_status IN ('submitted','sent','delivered')",[config.orgId,config.provider,config.accountId,event.remote,utc(event.watermark!)])).rows;
    for(const item of items) {await c.query("UPDATE social_message_provenance SET delivery_status='read' WHERE org_id=$1 AND message_id=$2",[config.orgId,item.message_id]);await c.query("UPDATE social_outbound_commands SET status='read',updated_at=$3 WHERE org_id=$1 AND message_id=$2",[config.orgId,item.message_id,time]);await markTestPassed(c,config,item.message_id,'read');}
    return true;
  }
  const conversation=identity.fresh ? {customer_message_seq:0} : (await c.query('SELECT customer_message_seq FROM conversations WHERE org_id=$1 AND id=$2',[config.orgId,identity.conversation_id])).rows[0];
  const messageId=randomUUID(), seq=event.echo ? null : Number(conversation.customer_message_seq)+1;
  await c.query("INSERT INTO messages(id,org_id,conversation_id,role,content,status,customer_seq,created_at) VALUES($1,$2,$3,$4,$5,'complete',$6,$7)",[messageId,config.orgId,identity.conversation_id,event.echo ? 'agent' : 'user',event.text!,seq,event.at]);
  await c.query('INSERT INTO social_message_provenance(org_id,message_id,provider,account_id,remote_id,provider_message_id,provider_type,direction,delivery_status,provider_timestamp,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[config.orgId,messageId,config.provider,config.accountId,event.remote,event.mid!,event.messageType!,event.echo ? 'out' : 'in',event.echo ? 'sent' : 'received',event.at,JSON.stringify(event.metadata || {})]);
  for(const attachment of event.attachments || []) await c.query('INSERT INTO social_message_attachments(id,org_id,message_id,provider,account_id,media_type,provider_ref,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),config.orgId,messageId,config.provider,config.accountId,attachment.type,attachment.ref,JSON.stringify(attachment.metadata)]);
  const optOut=/^(stop|unsubscribe|หยุดติดต่อ|หยุด|ยกเลิกการติดต่อ)(?:$|\s|[.!])/i.test(event.text!.trim());
  if(optOut) await c.query('UPDATE social_identities SET opt_out=1,updated_at=$3 WHERE org_id=$1 AND id=$2',[config.orgId,identity.id,time]);
  await c.query(`UPDATE conversations SET customer_message_seq=customer_message_seq+$3,first_customer_at=CASE WHEN $3=1 THEN COALESCE(first_customer_at,$4) ELSE first_customer_at END,updated_at=$5 WHERE org_id=$1 AND id=$2`,[config.orgId,identity.conversation_id,event.echo ? 0 : 1,event.at,time]);
  await cancelGeneration(c,config.orgId,identity.conversation_id,event.echo ? 'External employee reply' : 'New customer message',false);
  return true;
}
async function cancelGeneration(c: Executor,orgId: string,conversationId: string,reason: string,forceWaiting: boolean) {
  // Incrementing the generation fence invalidates pending AI work and stale human send approvals.
  await c.query(`UPDATE conversations SET version=version+1,generating_client_id=NULL,generation_started_at=NULL,status=CASE WHEN status='human_active' THEN status ELSE 'waiting_human' END,updated_at=$3 WHERE org_id=$1 AND id=$2`,[orgId,conversationId,now()]);
  await c.query("UPDATE social_outbound_commands SET status='cancelled',error_code=$3,updated_at=$4 WHERE org_id=$1 AND conversation_id=$2 AND status='queued'",[orgId,conversationId,reason,now()]);
  // Already-sending commands remain quarantined/receipt-driven, never assumed cancelled at provider.
  if(forceWaiting) await c.query("UPDATE messages SET status='interrupted' WHERE org_id=$1 AND conversation_id=$2 AND status='generating'",[orgId,conversationId]);
}

export async function ingestSocialWebhook(provider: SocialProvider,raw: Uint8Array,headers: Headers,config: SocialChannelConfig): Promise<{accepted:number;duplicates:number}> {
  if(provider !== config.provider) throw new ApiError(403,'Provider mismatch');
  assertConfig(config);
  if(raw.byteLength > maxPayload) throw new ApiError(413,'Payload too large');
  if(!verifySocialSignature(raw,headers,config)) throw new ApiError(403,'Invalid webhook signature');
  let payload: Record<string,any>;
  try {payload=object(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)));} catch {throw new ApiError(400,'Invalid webhook JSON');}
  const events=normalize(payload,config), hash=digest(raw); let accepted=0,duplicates=0;
  for(const event of events) {
    const written=await transaction(config.orgId,c=>ingestEvent(c,config,event,hash));
    if(written) accepted++;else duplicates++;
  }
  // Includes LINE's signed events:[] callback probe. Invalid signatures/accounts
  // never reach this evidence write; credential rotation invalidates old proof.
  await transaction(config.orgId,async c=>{
    await c.query('INSERT INTO social_channel_controls(org_id,provider,account_id,updated_at,webhook_fingerprint,webhook_verified_at) VALUES($1,$2,$3,$4,$5,$4) ON CONFLICT(org_id,provider,account_id) DO UPDATE SET webhook_fingerprint=excluded.webhook_fingerprint,webhook_verified_at=excluded.webhook_verified_at',[config.orgId,config.provider,config.accountId,now(),socialConfigFingerprint(config)]);
  });
  return {accepted,duplicates};
}

/** Called inside the human reply transaction, immediately after staging the native message INSERT. */
export async function enqueueSocialReply(c: Executor,orgId: string,conversationId: string,messageId: string,text: string): Promise<{commandId:string|null;status:string}> {
  const identity=(await c.query('SELECT * FROM social_identities WHERE org_id=$1 AND conversation_id=$2',[orgId,conversationId])).rows[0];
  if(!identity) return {commandId:null,status:'non_social'};
  const existing=(await c.query('SELECT id,status,body FROM social_outbound_commands WHERE org_id=$1 AND message_id=$2',[orgId,messageId])).rows[0];
  if(existing) {if(existing.body !== text) throw new ApiError(409,'Message idempotency conflict');return {commandId:existing.id,status:existing.status};}
  const conversation=(await c.query('SELECT status,version,assignee_id FROM conversations WHERE org_id=$1 AND id=$2',[orgId,conversationId])).rows[0];
  if(!conversation || conversation.status !== 'human_active' || !conversation.assignee_id) throw new ApiError(409,'Claim this conversation before sending');
  if(identity.opt_out) throw new ApiError(409,'Customer has opted out');
  const maximum=identity.provider === 'whatsapp' ? 4096 : 2000;
  if(!text.trim() || text.length > maximum) throw new ApiError(400,`Channel replies require 1–${maximum} characters`);
  const id=randomUUID(),time=now();
  await c.query('INSERT INTO social_outbound_commands(id,org_id,identity_id,conversation_id,message_id,provider,account_id,remote_id,body,conversation_version,approved_by,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)',[id,orgId,identity.id,conversationId,messageId,identity.provider,identity.account_id,identity.remote_id,text,conversation.version,conversation.assignee_id,time]);
  await c.query("INSERT INTO social_message_provenance(org_id,message_id,provider,account_id,remote_id,provider_type,direction,delivery_status,provider_timestamp,metadata) VALUES($1,$2,$3,$4,$5,'text','out','queued',$6,$7)",[orgId,messageId,identity.provider,identity.account_id,identity.remote_id,time,JSON.stringify({approval:'human_reply',approvedBy:conversation.assignee_id,commandId:id})]);
  return {commandId:id,status:'queued'};
}

type DispatchOptions = {config?: SocialChannelConfig;fetch?: typeof fetch};
function checkOutboundConfig(config: SocialChannelConfig,command: Row) {
  if(config.owner !== 'crm' || !config.inboundEnabled || !config.liveEnabled) throw new ApiError(503,'Live social sending is disabled');
  if(config.orgId !== command.org_id || config.provider !== command.provider || config.accountId !== command.account_id) throw new ApiError(409,'Channel account changed');
  if(!config.accessToken || !config.secret || config.provider === 'whatsapp' && !config.wabaId) throw new ApiError(503,'Channel credentials are not configured');
  if(config.provider !== 'line' && !/^v\d+\.\d+$/.test(config.apiVersion || '')) throw new ApiError(503,'Graph API version is not configured');
  if(config.provider !== 'line' && !/^\d{5,40}$/.test(config.accountId)) throw new ApiError(503,'Invalid channel account');
}
async function outboundGuard(c: Executor,command: Row,config:SocialChannelConfig,epoch?: number): Promise<Row> {
  const controls=(await c.query('SELECT * FROM social_channel_controls WHERE org_id=$1 AND provider=$2 AND account_id=$3',[command.org_id,command.provider,command.account_id])).rows[0];
  if(!controls || !controls.send_enabled || controls.emergency_stop || !socialVerificationReady(controls,config)||controls.webhook_fingerprint!==socialConfigFingerprint(config)) throw new ApiError(503,'Channel send control is disabled or unverified');
  if(controls.send_mode==='test'&&(!controls.test_recipient||controls.test_recipient!==command.remote_id))throw new ApiError(409,'Test mode allows only the configured test recipient');
  if(!['test','live'].includes(controls.send_mode))throw new ApiError(503,'Channel sending mode is disabled');
  if(epoch !== undefined && controls.epoch !== epoch) throw new ApiError(409,'Channel control changed');
  const identity=(await c.query('SELECT * FROM social_identities WHERE org_id=$1 AND id=$2',[command.org_id,command.identity_id])).rows[0];
  if(!identity || identity.opt_out || identity.remote_id !== command.remote_id || identity.account_id !== command.account_id || identity.provider !== command.provider || identity.conversation_id !== command.conversation_id) throw new ApiError(409,'Recipient identity changed or opted out');
  const inbound=(await c.query("SELECT MAX(provider_timestamp) AS last_inbound FROM social_message_provenance WHERE org_id=$1 AND provider=$2 AND account_id=$3 AND remote_id=$4 AND direction='in' AND removed_at IS NULL",[command.org_id,command.provider,command.account_id,command.remote_id])).rows[0]?.last_inbound;
  const elapsed=Date.now()-Date.parse(inbound || '');
  if(command.provider === 'whatsapp' || command.provider === 'facebook') {
    if(!Number.isFinite(elapsed) || elapsed < -300_000 || elapsed >= 86_400_000) throw new ApiError(409,'Verified inbound message required within the 24 hour reply window; templates are not enabled');
  } else {
    const friendship=(await c.query("SELECT event_kind FROM social_events WHERE org_id=$1 AND provider='line' AND account_id=$2 AND remote_id=$3 AND event_kind IN ('follow','unfollow') ORDER BY received_at DESC,event_id DESC LIMIT 1",[command.org_id,command.account_id,command.remote_id])).rows[0];
    if(friendship?.event_kind !== 'follow' && (!Number.isFinite(elapsed) || elapsed < -300_000 || elapsed >= 7*86_400_000)) throw new ApiError(409,'Verified LINE follow or inbound within seven days required');
  }
  if(command.provider === 'whatsapp') {
    const lead=(await c.query('SELECT contact_consent_at,contact_consent_version FROM leads WHERE org_id=$1 AND id=$2',[command.org_id,identity.lead_id])).rows[0];
    if(!lead?.contact_consent_at || !lead.contact_consent_version) throw new ApiError(409,'Recorded WhatsApp contact consent evidence required');
  }
  const conversation=(await c.query('SELECT * FROM conversations WHERE org_id=$1 AND id=$2',[command.org_id,command.conversation_id])).rows[0];
  if(!conversation || conversation.version !== command.conversation_version || conversation.status !== 'human_active' || conversation.assignee_id !== command.approved_by) throw new ApiError(409,'Human approval is stale after takeover or new input');
  const member=(await c.query('SELECT active FROM members WHERE org_id=$1 AND id=$2',[command.org_id,command.approved_by])).rows[0];
  if(!member?.active) throw new ApiError(409,'Approving staff member is inactive');
  const message=(await c.query('SELECT role,content,status FROM messages WHERE org_id=$1 AND conversation_id=$2 AND id=$3',[command.org_id,command.conversation_id,command.message_id])).rows[0];
  if(!message || message.role !== 'agent' || message.status !== 'complete' || message.content !== command.body) throw new ApiError(409,'Approved message changed');
  return controls;
}
function providerRequest(config: SocialChannelConfig,command: Row,signal: AbortSignal): {url:string;init:RequestInit} {
  const headers: Record<string,string>={'Content-Type':'application/json',Authorization:'Bearer '+config.accessToken};
  let url: string, body: unknown;
  if(config.provider === 'line') {
    url='https://api.line.me/v2/bot/message/push';headers['X-Line-Retry-Key']=command.id;
    body={to:command.remote_id,messages:[{type:'text',text:command.body}]};
  } else {
    // Fixed provider host; untrusted message media URLs are never fetched by this module.
    url=`https://graph.facebook.com/${config.apiVersion}/${encodeURIComponent(config.accountId)}/messages`;
    body=config.provider === 'whatsapp' ? {messaging_product:'whatsapp',recipient_type:'individual',to:command.remote_id,type:'text',text:{preview_url:false,body:command.body},biz_opaque_callback_data:command.attempt_id} : {recipient:{id:command.remote_id},messaging_type:'RESPONSE',message:{text:command.body}};
  }
  return {url,init:{method:'POST',headers,body:JSON.stringify(body),redirect:'manual',signal}};
}
async function setCommandStatus(c: Executor,command: Row,status: string,errorCode = '',providerMessageId?: string) {
  await c.query('UPDATE social_outbound_commands SET status=$3,error_code=$4,provider_message_id=COALESCE($5,provider_message_id),updated_at=$6 WHERE org_id=$1 AND id=$2',[command.org_id,command.id,status,errorCode,providerMessageId || null,now()]);
  await c.query('UPDATE social_message_provenance SET delivery_status=$3,provider_message_id=COALESCE($4,provider_message_id) WHERE org_id=$1 AND message_id=$2',[command.org_id,command.message_id,status,providerMessageId || null]);
}
/** One durable claim permits at most one attempt. No timer, 5xx, unknown result or restart resends it. */
export async function dispatchSocialReply(orgId: string,commandId: string,options: DispatchOptions = {}): Promise<{commandId:string;status:string}> {
  const claimed=await transaction<Row & {claimed:boolean}>(orgId,async c=>{
    const command=(await c.query('SELECT * FROM social_outbound_commands WHERE org_id=$1 AND id=$2',[orgId,commandId])).rows[0];
    if(!command) throw new ApiError(404,'Social command not found');
    if(command.status === 'sending' && command.lease_expires_at && command.lease_expires_at < now()) {
      await setCommandStatus(c,command,'unknown','dispatch_lease_expired');return {...command,status:'unknown',claimed:false};
    }
    if(command.status !== 'queued') return {...command,claimed:false};
    const config=options.config || readSocialConfig(command.provider);
    checkOutboundConfig(config,command);
    const control=await outboundGuard(c,command,config),attempt=randomUUID(),expires=utc(Date.now()+60_000);
    await c.query("UPDATE social_outbound_commands SET status='sending',attempt_id=$3,control_epoch=$4,lease_expires_at=$5,updated_at=$6 WHERE org_id=$1 AND id=$2",[orgId,commandId,attempt,control.epoch,expires,now()]);
    // Messenger read watermarks compare against the send attempt, never an earlier queued draft time.
    await c.query("UPDATE social_message_provenance SET delivery_status='sending',provider_timestamp=$3 WHERE org_id=$1 AND message_id=$2",[orgId,command.message_id,now()]);
    return {...command,status:'sending',attempt_id:attempt,control_epoch:control.epoch,claimed:true};
  });
  if(!claimed.claimed) return {commandId,status:claimed.status};
  const config=options.config || readSocialConfig(claimed.provider);
  try {
    checkOutboundConfig(config,claimed);
    // Re-read the generation fence and emergency stop immediately before the external effect.
    await transaction(orgId,c=>outboundGuard(c,claimed,config,claimed.control_epoch));
  } catch {
    await transaction(orgId,c=>setCommandStatus(c,claimed,'cancelled','guard_changed_before_send'));
    return {commandId,status:'cancelled'};
  }
  let status='unknown', providerMessageId:string|undefined,errorCode='provider_outcome_unknown';
  const abort=new AbortController();let polling=false;
  const deadline=setTimeout(()=>abort.abort(),20_000);
  const monitor=setInterval(async()=>{
    if(polling)return;polling=true;
    try {const current=options.config || readSocialConfig(claimed.provider);checkOutboundConfig(current,claimed);await outboundGuard(database,claimed,current,claimed.control_epoch);}
    catch {abort.abort();}
    finally {polling=false;}
  },500);
  try {
    const request=providerRequest(config,claimed,abort.signal),response=await (options.fetch || fetch)(request.url,request.init);
    if(response.status >= 300 && response.status < 400) {await response.body?.cancel();errorCode='provider_redirect_rejected';}
    else {
      // A bounded body prevents a faulty upstream response from consuming unbounded memory.
      const content=await readBoundedResponse(response,64_000);
      let data: Record<string,any>={};try {data=object(JSON.parse(content));} catch { /* An HTTP response alone is not a message receipt. */ }
      const candidate=config.provider === 'whatsapp' ? data.messages?.[0]?.id : config.provider === 'line' ? data.sentMessages?.[0]?.id : data.message_id;
      if(response.ok) {
        if(typeof candidate === 'string' && candidate && candidate.length <= 500) {providerMessageId=candidate;status='submitted';errorCode='';}
        // LINE may acknowledge without exposing a message ID; it is still only submitted.
        else if(config.provider === 'line' && response.status === 200) {status='submitted';errorCode='';}
        else errorCode='provider_success_without_message_id';
      } else if(response.status >= 400 && response.status < 500) {status='failed';errorCode='provider_http_'+response.status;}
      else errorCode='provider_http_'+response.status;
    }
  } catch { /* Includes timeout/network/JSON-body interruption: quarantine; no blind retry. */ }
  finally {clearTimeout(deadline);clearInterval(monitor);}
  const settled=await transaction(orgId,async c=>{
    const command=(await c.query('SELECT * FROM social_outbound_commands WHERE org_id=$1 AND id=$2',[orgId,commandId])).rows[0];
    if(!command || command.attempt_id !== claimed.attempt_id) throw new ApiError(409,'Dispatch attempt changed');
    let finalStatus=status;
    if(providerMessageId) {
      const receipt=(await c.query('SELECT * FROM social_delivery_receipts WHERE org_id=$1 AND provider=$2 AND account_id=$3 AND provider_message_id=$4',[orgId,command.provider,command.account_id,providerMessageId])).rows[0];
      if(receipt && (!receipt.remote_id || receipt.remote_id === command.remote_id) && receipt.rank >= deliveryRank[finalStatus]) finalStatus=receipt.status;
      const identity=(await c.query('SELECT read_watermark_ms FROM social_identities WHERE org_id=$1 AND id=$2',[orgId,command.identity_id])).rows[0];
      if(command.provider === 'facebook' && Number(identity?.read_watermark_ms) >= Date.parse(command.updated_at) && ['submitted','sent','delivered'].includes(finalStatus)) finalStatus='read';
      // A verified Facebook echo may arrive before the HTTP response. Merge only by the exact provider ID.
      const echo=(await c.query('SELECT message_id,delivery_status FROM social_message_provenance WHERE org_id=$1 AND provider=$2 AND account_id=$3 AND remote_id=$4 AND provider_message_id=$5',[orgId,command.provider,command.account_id,command.remote_id,providerMessageId])).rows[0];
      if(echo && echo.message_id !== command.message_id) {
        // Keep both native records for audit; transfer provider identity to the approved command, not by content/name.
        await c.query('UPDATE social_message_provenance SET provider_message_id=NULL WHERE org_id=$1 AND message_id=$2',[orgId,echo.message_id]);
        if(deliveryRank[echo.delivery_status] > deliveryRank[finalStatus]) finalStatus=echo.delivery_status;
      }
    }
    if(['sent','delivered','read'].includes(command.status) && deliveryRank[command.status] > deliveryRank[finalStatus]) finalStatus=command.status;
    await setCommandStatus(c,command,finalStatus,errorCode,providerMessageId);
    await markTestPassed(c,config,command.message_id,finalStatus);
    return finalStatus;
  });
  return {commandId,status:settled};
}
async function readBoundedResponse(response: Response,limit: number) {
  const reader=response.body?.getReader();if(!reader) return '';
  const decoder=new TextDecoder();let text='',length=0;
  try {while(true) {const part=await reader.read();if(part.done) break;length += part.value.length;if(length>limit) {await reader.cancel();throw new Error('Oversized provider response');}text += decoder.decode(part.value,{stream:true});}return text+decoder.decode();}
  finally {reader.releaseLock();}
}
/** Bounded dispatch for a signed/admin-triggered runner. A failed/unknown command never returns to this queue. */
export async function dispatchPendingSocialReplies(orgId: string,limit=10): Promise<{results:Array<{commandId:string;status:string}>}> {
  const size=Math.min(25,Math.max(1,Math.floor(Number.isFinite(limit)?limit:10)));
  const pending=(await database.query("SELECT id FROM social_outbound_commands WHERE org_id=$1 AND status IN ('queued','sending') ORDER BY created_at,id LIMIT $2",[orgId,size])).rows;
  const results:Array<{commandId:string;status:string}>=[];
  for(const command of pending) {
    try {results.push(await dispatchSocialReply(orgId,command.id));}
    catch(error) {if(error instanceof ApiError) results.push({commandId:command.id,status:error.status === 503 ? 'blocked' : 'guard_rejected'});else throw error;}
  }
  return {results};
}
