import { createHash } from 'node:crypto';
import { database, transaction, type Executor, type Row } from './db';
import { BridgeError } from './bridge-protocol';

export type LegacySnapshot = { version: 1; sourceSystem: 'rrs-sale-office'; workspace: 'live'|'domestic'; snapshotId: string; revision: number; tailSequence?:number; records: Row[]; webhooks: {id:string;time:string}[]; auxiliary?:{table:string;id:string;record:Row}[] };
export type LegacyImportOptions = { whatsappAccountId?: string; phoneContactMap?: Record<string,string>; contactLeadMap?: Record<string,string>; allowSourceUpdates?: boolean };
type Issue = { code: string; sourceId: string; message: string };
type Unit = { type: 'archive'|'webhook'|'auxiliary'|'lead'|'conversation'|'identity'|'message'|'provenance'|'attachment'|'tombstone'; row: Row };
type TargetContext = { identities?: Row[]; messages?: Row[]; mappings?: Row[]; baselines?: Row[]; tombstones?: Row[] };
export type LegacyPlan = { valid: boolean; orgId: string; allowSourceUpdates: boolean; snapshot: LegacySnapshot; snapshotHash: string; planHash: string; counts: Record<string,number>; issues: Issue[]; warnings: Issue[]; unresolvedFiles: {sourceId:string;reference:string}[]; units: Unit[] };

const canonical = (value: unknown): string => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? '['+value.map(canonical).join(',')+']' : '{'+Object.keys(value as object).sort().map(key=>JSON.stringify(key)+':'+canonical((value as Row)[key])).join(',')+'}';
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const phone = (value: unknown) => typeof value === 'string' ? value.replace(/^\+/, '').trim() : '';
const key = (...parts: string[]) => JSON.stringify(parts);
const sourceKey = (record: Row) => key(record.kind,record.id);
const knownKinds = new Set(['contact','company','deal','message','inbound','conversation','domThread','domChannel','domMessage']);
const unsafeStates = new Set(['draft','review','queued','sending','unknown','failed','cancelled']);
const deliveryStates = new Set(['received','queued','sending','submitted','sent','delivered','read','failed','unknown','cancelled']);
const entityOrder: Unit['type'][] = ['archive','webhook','auxiliary','lead','conversation','identity','message','provenance','attachment','tombstone'];

/** Match CRM's lexically ordered UTC microsecond timestamps without losing existing microseconds. */
export function canonicalLegacyTimestamp(value:string){
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(value))throw new BridgeError(400,'Original timestamp requires an explicit timezone');
  const date=new Date(value);if(!Number.isFinite(date.getTime()))throw new BridgeError(400,'Invalid original timestamp');
  const fraction=/T\d{2}:\d{2}:\d{2}\.(\d+)(?:Z|[+-]\d{2}:?\d{2})$/i.exec(value)?.[1]||'';
  if(fraction.length>6)throw new BridgeError(400,'Original timestamp precision exceeds CRM microseconds');
  const iso=date.toISOString();if(!/^\d{4}-/.test(iso))throw new BridgeError(400,'Original timestamp year is unsupported');
  return iso.replace(/\.(\d{3})Z$/,(_,milliseconds:string)=>'.'+milliseconds+fraction.slice(3).padEnd(3,'0')+'Z');
}

/** Stable UUID v5, namespaced by organization, market and source identity. */
export function legacyId(orgId: string, workspace: string, kind: string, id: string) {
  const namespace = Buffer.from('c8a7c215462352d0a3818f1c4d3da900','hex');
  const bytes = createHash('sha1').update(namespace).update(key(orgId,workspace,kind,id)).digest().subarray(0,16);
  bytes[6]=(bytes[6]&15)|80;bytes[8]=(bytes[8]&63)|128;
  const hex=bytes.toString('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export function planLegacyImport(raw: unknown, orgId: string, options: LegacyImportOptions = {}, target: TargetContext = {}): LegacyPlan {
  if (!raw || typeof raw!=='object' || Array.isArray(raw)) throw new BridgeError(400,'Invalid legacy snapshot');
  const snapshot=raw as LegacySnapshot;
  if(snapshot.version!==1||snapshot.sourceSystem!=='rrs-sale-office'||!['live','domestic'].includes(snapshot.workspace)||typeof snapshot.snapshotId!=='string'||!snapshot.snapshotId||snapshot.snapshotId.length>200||!Number.isSafeInteger(snapshot.revision)||snapshot.revision<0||!Array.isArray(snapshot.records)||snapshot.records.length>20000||!Array.isArray(snapshot.webhooks)||snapshot.webhooks.length>50000)throw new BridgeError(400,'Invalid legacy snapshot envelope');
  if(snapshot.tailSequence!==undefined&&(!Number.isSafeInteger(snapshot.tailSequence)||snapshot.tailSequence<0))throw new BridgeError(400,'Invalid source tail sequence');
  if(snapshot.auxiliary!==undefined&&(!Array.isArray(snapshot.auxiliary)||snapshot.auxiliary.length>50000))throw new BridgeError(400,'Invalid auxiliary evidence');
  const auxiliaryTables=new Set(['rrs_communication_queue','rrs_communication_outbox','rrs_uploads','rrs_file_scopes','ai_jobs','ai_results','ai_approvals','ai_revisions','ai_job_steps']);
  const auxiliaryIds=new Set<string>();
  for(const auxiliary of snapshot.auxiliary||[]){if(!auxiliary||!auxiliaryTables.has(auxiliary.table)||typeof auxiliary.id!=='string'||!auxiliary.id||!auxiliary.record||typeof auxiliary.record!=='object'||Array.isArray(auxiliary.record))throw new BridgeError(400,'Invalid auxiliary record');if(auxiliary.record.workspace&&auxiliary.record.workspace!==snapshot.workspace)throw new BridgeError(400,'Auxiliary record belongs to another source workspace');const identity=key(auxiliary.table,auxiliary.id);if(auxiliaryIds.has(identity))throw new BridgeError(400,'Duplicate auxiliary record');auxiliaryIds.add(identity);}
  if(!orgId||typeof options!=='object'||options===null||Object.keys(options).some(k=>!['whatsappAccountId','phoneContactMap','contactLeadMap','allowSourceUpdates'].includes(k)))throw new BridgeError(400,'Invalid import options');
  if(options.allowSourceUpdates!==undefined&&typeof options.allowSourceUpdates!=='boolean')throw new BridgeError(400,'allowSourceUpdates must be explicit boolean');
  if(options.whatsappAccountId!==undefined&&(typeof options.whatsappAccountId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(options.whatsappAccountId)))throw new BridgeError(400,'Invalid verified WhatsApp account ID');
  for(const map of [options.phoneContactMap,options.contactLeadMap])if(map!==undefined&&(!map||typeof map!=='object'||Array.isArray(map)||Object.entries(map).some(([k,v])=>!k||typeof v!=='string'||!v||v.length>200)))throw new BridgeError(400,'Invalid explicit mapping');
  if(Object.values(options.contactLeadMap||{}).some(value=>!/^[-a-f0-9]{36}$/i.test(value)))throw new BridgeError(400,'CRM contact mappings require UUIDs');
  const issues:Issue[]=[],warnings:Issue[]=[],unresolvedFiles:{sourceId:string;reference:string}[]=[],units:Unit[]=[];
  const problem=(code:string,sourceId:string,message:string)=>issues.push({code,sourceId,message});
  const warning=(code:string,sourceId:string,message:string)=>warnings.push({code,sourceId,message});
  const id=(kind:string,value:string)=>legacyId(orgId,snapshot.workspace,kind,value);
  const priorMappings=new Map((target.mappings||[]).filter(r=>r.source_workspace===snapshot.workspace).map(r=>[key(r.entity_kind,r.source_id),r]));
  const baselineRows=(target.baselines||[]).filter(r=>r.workspace===snapshot.workspace);
  const baselines=new Map(baselineRows.map(r=>[key(r.entity,r.target_id),typeof r.source_json==='string'?JSON.parse(r.source_json):r.source_json]));
  const byId=new Map<string,Row>(), mapped=new Map<string,string>();
  for(const record of snapshot.records){if(!record||typeof record!=='object'||Array.isArray(record)||typeof record.id!=='string'||!record.id||typeof record.kind!=='string'||!record.kind)throw new BridgeError(400,'Invalid source record identity');if(['message','conversation','domMessage'].includes(record.kind))for(const field of ['attachments','mediaIds'])if(record[field]!==undefined&&(!Array.isArray(record[field])||record[field].some((v:unknown)=>typeof v!=='string')))problem('INVALID_REFERENCES',record.id,`Invalid ${field}`);if(byId.has(record.id))problem('DUPLICATE_SOURCE_ID',record.id,'Source IDs must be unique within a workspace');else byId.set(record.id,record);}
  const records=[...byId.values()].sort((a,b)=>String(a.id).localeCompare(String(b.id)));
  const cachedInboundFiles=new Map<string,string>();
  for(const item of snapshot.auxiliary||[])if(item.table==='rrs_communication_queue'&&item.record.file_id){const row=item.record;if(typeof row.inbound_id!=='string'||typeof row.file_id!=='string'||!/^[A-Za-z0-9-]{1,150}$/.test(row.file_id))throw new BridgeError(400,'Invalid cached inbound file reference');if(cachedInboundFiles.has(row.inbound_id)&&cachedInboundFiles.get(row.inbound_id)!==row.file_id)problem('AMBIGUOUS_CACHED_MEDIA',row.inbound_id,'Conflicting cached source files');cachedInboundFiles.set(row.inbound_id,row.file_id);}
  const privateFileIds=new Set<string>();
  const markPrivate=(value:unknown)=>{if(typeof value==='string')for(const match of value.matchAll(/\/api\/rrs\/files\?id=([A-Za-z0-9-]+)/g))privateFileIds.add(match[1]);else if(Array.isArray(value))value.forEach(markPrivate);};
  for(const record of records){if(record.kind==='conversation'&&record.direction==='internal')markPrivate(record.attachments);for(const field of [...(Array.isArray(record.fields)?record.fields:[]),...(Array.isArray(record.productSnapshot)?record.productSnapshot:[])])if(field.visibility==='internal')markPrivate(field.value);}
  const get=(kind:string,value:unknown,sourceId:string,optional=false)=>{const r=typeof value==='string'?byId.get(value):undefined;if(r?.kind===kind)return r;if(!optional)problem('MISSING_PARENT',sourceId,`Missing ${kind} reference`);return undefined;};
  for(const deal of records.filter(r=>r.kind==='deal')){const contact=get('contact',deal.contactId,deal.id);get('company',deal.companyId,deal.id);if(contact&&contact.companyId!==deal.companyId)problem('RELATION_CONFLICT',deal.id,'Deal and contact belong to different source companies');}
  for(const record of records.filter(r=>['message','conversation'].includes(r.kind)&&r.dealId)){const deal=get('deal',record.dealId,record.id);if(deal&&record.contactId!==deal.contactId)problem('RELATION_CONFLICT',record.id,'Message contact does not match the source deal');}
  for(const thread of records.filter(r=>r.kind==='domThread'&&r.linkedDeal)){const deal=get('deal',thread.linkedDeal,thread.id);if(deal&&deal.contactId!==thread.customerId)problem('RELATION_CONFLICT',thread.id,'Thread customer does not match the linked source deal');}
  const time=(record:Row,...fields:string[])=>{for(const field of fields){const value=record[field];if(typeof value==='string'&&value){try{return canonicalLegacyTimestamp(value);}catch{problem('INVALID_TIMESTAMP',record.id,`Invalid or unsupported ${field}`);return '1970-01-01T00:00:00.000000Z';}}}problem('MISSING_TIMESTAMP',record.id,'Original timestamp is required');return '1970-01-01T00:00:00.000000Z';};
  const contacts=records.filter(r=>r.kind==='contact'), nativeLeads=new Map<string,Row>(), nativeConversations=new Map<string,Row>(), identities=new Map<string,Row>();
  const contactIds=new Map(contacts.map(c=>[c.id,options.contactLeadMap?.[c.id]||priorMappings.get(sourceKey(c))?.target_id||id('contact',c.id)]));
  const existingIdentities=new Map((target.identities||[]).map(r=>[key(r.provider,r.account_id,r.remote_id),r]));
  const existingMessages=new Map((target.messages||[]).filter(r=>r.provider_message_id).map(r=>[key(r.provider,r.account_id,r.provider_message_id),r]));
  const selectContact=(record:Row):Row|undefined=>{
    if(record.contactId)return get('contact',record.contactId,record.id);
    if(record.assignedDeal){const deal=get('deal',record.assignedDeal,record.id);if(deal)return get('contact',deal.contactId,record.id);}
    const number=phone(record.phone);const explicit=options.phoneContactMap?.[number];
    if(explicit)return get('contact',explicit,record.id);
    const matches=contacts.filter(c=>phone(c.whatsapp)===number&&number);
    if(matches.length>1){problem('AMBIGUOUS_CONTACT',record.id,'Several contacts share this phone; provide phoneContactMap');return undefined;}
    return matches[0];
  };
  // Resolve only exact provider/account/user identities. Names never participate.
  const linkedExisting=new Map<string,string>();
  const bindExisting=(contact:Row|undefined,provider:string,account:string,remote:string,source:string)=>{
    const match=existingIdentities.get(key(provider,account,remote));if(!match||!contact)return;
    const previous=linkedExisting.get(contact.id),explicit=options.contactLeadMap?.[contact.id];
    if(previous&&previous!==match.lead_id||explicit&&explicit!==match.lead_id)problem('IDENTITY_LEAD_CONFLICT',source,'Exact channel identities resolve to different CRM leads; reconcile explicitly');
    else{linkedExisting.set(contact.id,match.lead_id);contactIds.set(contact.id,match.lead_id);}
  };
  for(const thread of records.filter(r=>r.kind==='domThread')){const channel=get('domChannel',thread.channelId,thread.id),contact=get('contact',thread.customerId,thread.id);if(channel&&channel.provider!=='manual')bindExisting(contact,channel.provider,channel.accountId,thread.remoteId,thread.id);}
  for(const record of records.filter(r=>r.kind==='inbound'||r.kind==='message'&&r.source==='whatsapp')){const contact=selectContact(record),remote=phone(record.phone||contact?.whatsapp);if(options.whatsappAccountId)bindExisting(contact,'whatsapp',options.whatsappAccountId,remote,record.id);}
  for(const contact of contacts){get('company',contact.companyId,contact.id);const native=contactIds.get(contact.id)!;mapped.set(sourceKey(contact),native);const consent=contact.optIn===true&&!contact.optOut&&typeof contact.consentNote==='string'&&contact.consentNote.trim();if(!nativeLeads.has(native))nativeLeads.set(native,{id:native,org_id:orgId,name:String(contact.name||''),phone:String(contact.whatsapp||''),email:String(contact.email||''),market:snapshot.workspace==='domestic'?'domestic':'export',source:'rrs-sale-office',facts:JSON.stringify({rrs_sale_office:{workspace:snapshot.workspace,contactId:contact.id,companyId:contact.companyId}}),contact_consent_at:consent?time(contact,'updated','created'):null,contact_consent_version:consent?'rrs-sale-office evidence observed at source updated timestamp: '+contact.consentNote:null,created_at:time(contact,'created'),updated_at:time(contact,'updated','created')});}
  const ensureConversation=(source:string,contact:Row|undefined,record:Row,provider='',account='',remote='')=>{
    const identityKey=provider?key(provider,account,remote):'';
    if(provider&&(!account||!remote))problem('MISSING_CHANNEL_IDENTITY',record.id,'Verified account and remote identity are required');
    const existing=identityKey?existingIdentities.get(identityKey):undefined;
    const lead=existing?.lead_id||(contact?contactIds.get(contact.id):id('unmatched-contact',remote||source));
    if(!nativeLeads.has(lead))nativeLeads.set(lead,{id:lead,org_id:orgId,name:'รอยืนยันข้อมูลลูกค้า',phone:provider==='whatsapp'?remote:'',email:'',market:snapshot.workspace==='domestic'?'domestic':'export',source:'rrs-sale-office',created_at:time(record,'created','occurredAt','received'),updated_at:time(record,'updated','created','occurredAt','received')});
    const conversation=existing?.conversation_id||(record.kind==='domThread'?priorMappings.get(sourceKey(record))?.target_id:undefined)||id('conversation',identityKey||source);
    if(!nativeConversations.has(conversation))nativeConversations.set(conversation,{id:conversation,org_id:orgId,lead_id:lead,status:'waiting_human',created_at:time(record,'created','occurredAt','received'),updated_at:time(record,'updated','created','occurredAt','received')});
    if(provider&&!identities.has(identityKey))identities.set(identityKey,{id:existing?.id||id('identity',identityKey),org_id:orgId,provider,account_id:account,remote_id:remote,lead_id:lead,conversation_id:conversation,opt_out:record.optOut||contact?.optOut?1:0,created_at:time(record,'created','occurredAt','received'),updated_at:time(record,'updated','created','occurredAt','received')});
    return {conversation,lead,provider,account,remote};
  };
  const threadContexts=new Map<string,ReturnType<typeof ensureConversation>>(),seenThreads=new Set<string>();
  for(const thread of records.filter(r=>r.kind==='domThread')){
    const channel=get('domChannel',thread.channelId,thread.id),contact=get('contact',thread.customerId,thread.id);if(!channel)continue;
    if(!['line','facebook','manual'].includes(channel.provider)){problem('UNSUPPORTED_CHANNEL',thread.id,'Unknown source domestic provider');continue;}
    if(thread.linkedDeal)get('deal',thread.linkedDeal,thread.id);
    const provider=channel.provider==='manual'?'':String(channel.provider),account=String(channel.accountId||''),remote=String(thread.remoteId||'');
    const external=key(provider,account,remote);if(provider&&seenThreads.has(external))problem('DUPLICATE_THREAD_IDENTITY',thread.id,'Multiple source threads have the same channel identity');seenThreads.add(external);
    const ctx=ensureConversation('thread:'+thread.id,contact,thread,provider,account,remote);threadContexts.set(thread.id,ctx);mapped.set(sourceKey(thread),ctx.conversation);
  }
  const logicalMessages=new Map<string,Row>(),logicalOrigins=new Map<string,Row>(),provenance=new Map<string,Row>(),attachments=new Map<string,Row>(),tombstones=new Map<string,Row>();
  const messageRecords=records.filter(r=>['inbound','message','conversation','domMessage'].includes(r.kind)).sort((a,b)=>time(a,'occurredAt','received','sentAt','created').localeCompare(time(b,'occurredAt','received','sentAt','created'))||String(a.id).localeCompare(String(b.id)));
  for(const record of messageRecords){
    let ctx:ReturnType<typeof ensureConversation>|undefined;
    if(record.kind==='domMessage')ctx=threadContexts.get(record.threadId);
    else{const contact=selectContact(record),wa=record.kind==='inbound'||record.kind==='message'&&record.source==='whatsapp',prior=baselines.get(key('provenance',priorMappings.get(sourceKey(record))?.target_id||''));if(wa&&!options.whatsappAccountId)problem('WHATSAPP_ACCOUNT_REQUIRED',record.id,'Supply the verified original WhatsApp phone-number account ID');if(wa&&prior&&prior.account_id!==options.whatsappAccountId)problem('CHANNEL_ACCOUNT_CHANGED',record.id,'Original WhatsApp account mapping cannot change during catch-up');if(record.dealId)get('deal',record.dealId,record.id);ctx=ensureConversation('deal:'+(record.dealId||record.assignedDeal||contact?.id||record.id),contact,record,wa?'whatsapp':'',wa?options.whatsappAccountId||'':'',wa?prior?.remote_id||phone(record.phone||contact?.whatsapp):'');}
    if(!ctx){problem('MISSING_THREAD',record.id,'Source message thread is unavailable');continue;}
    const providerId=typeof record.providerId==='string'?record.providerId:'';
    const legacyUnsend=ctx.provider==='line'&&snapshot.webhooks.some(w=>w.id==='dom:line:unsend:'+createHash('sha256').update(ctx.account+':'+ctx.remote+':'+providerId).digest('hex'));
    const knownTombstone=(target.tombstones||[]).some(t=>t.provider===ctx!.provider&&t.account_id===ctx!.account&&t.remote_id===ctx!.remote&&t.provider_message_id===providerId);
    const cancelled=record.status==='cancelled'||legacyUnsend||knownTombstone,internal=cancelled||record.direction==='internal'||unsafeStates.has(record.status)||record.author==='system';
    const incoming=record.kind==='inbound'||record.direction==='in'||record.author==='customer';
    const role=internal?'note':incoming?'user':record.author==='ai'?'assistant':'agent';
    const text=cancelled?'[ลูกค้ายกเลิกข้อความ]':String(record.text||'');
    const multiple=providerId.includes(',');if(multiple)warning('MULTIPART_PROVIDER_ID',record.id,'Multipart provider IDs retained in raw archive; delivery mapping needs reconciliation');
    const providerKey=ctx.provider&&providerId&&!multiple?key(ctx.provider,ctx.account,providerId):'';
    const logicalKey=providerKey||sourceKey(record),known=providerKey?existingMessages.get(providerKey):undefined;
    const priorNative=priorMappings.get(sourceKey(record))?.target_id;
    if(priorNative&&known?.message_id&&priorNative!==known.message_id)problem('PROVIDER_MAPPING_CONFLICT',record.id,'Provider identity now refers to another CRM message');
    const native=priorNative||known?.message_id||id('message',logicalKey),created=baselines.get(key('message',native))?.created_at||time(record,'occurredAt','received','sentAt','created');
    const previous=logicalMessages.get(native);
    const previousOrigin=logicalOrigins.get(native);
    if(previousOrigin&&!((previousOrigin.kind==='inbound'&&record.kind==='message'&&record.direction==='in')||(record.kind==='inbound'&&previousOrigin.kind==='message'&&previousOrigin.direction==='in')))problem('DUPLICATE_PROVIDER_MESSAGE',record.id,'Only the known WhatsApp inbound/assigned-message pair may alias one provider message');
    if(previous&&(previous.content!==text||previous.conversation_id!==ctx.conversation))problem('CONFLICTING_PROVIDER_MESSAGE',record.id,'Source rows sharing provider ID disagree');
    if(known&&(known.conversation_id!==ctx.conversation||known.content!==text&&!(options.allowSourceUpdates&&baselines.has(key('message',native)))))problem('EXISTING_MESSAGE_CONFLICT',record.id,'Existing CRM provider message differs; explicit reconciliation required');
    if(!previous){logicalMessages.set(native,{id:native,org_id:orgId,conversation_id:ctx.conversation,role,content:text,status:'complete',source_owner_only:record.direction==='internal'?1:0,created_at:created,sources:'[]'});logicalOrigins.set(native,record);}
    mapped.set(sourceKey(record),native);
    const refs:string[]=[];
    if(!cancelled){for(const link of Array.isArray(record.attachments)?record.attachments:[])if(typeof link==='string')refs.push(link);for(const mediaId of Array.isArray(record.mediaIds)?record.mediaIds:[]){const media=get('media',mediaId,record.id);if(media?.url)refs.push(media.url);}if(record.quoteId){const quote=get('quote',record.quoteId,record.id);if(quote?.url)refs.push(quote.url);}if(record.mediaId){const file=cachedInboundFiles.get(record.id);refs.push(file?'/api/rrs/files?id='+encodeURIComponent(file)+'&mode='+snapshot.workspace:'provider:whatsapp:'+record.mediaId);}}
    for(const reference of refs)unresolvedFiles.push({sourceId:record.id,reference});
    {
      const provider=ctx.provider||'legacy',account=ctx.account||'legacy:'+snapshot.workspace;
      const status=cancelled?'cancelled':deliveryStates.has(record.status)?record.status:record.kind==='inbound'||role==='user'?'received':'unknown';
      if(!provenance.has(native))provenance.set(native,{org_id:orgId,message_id:native,provider,account_id:account,remote_id:ctx.remote,provider_message_id:ctx.provider&&providerId&&!multiple?providerId:null,provider_type:String(record.mediaType||'text'),direction:incoming?'in':'out',delivery_status:status,provider_timestamp:created,metadata:JSON.stringify({sourceSystem:'rrs-sale-office',workspace:snapshot.workspace,sourceWorkspace:snapshot.workspace,sourceId:record.id,originalChannel:record.channel||ctx.provider||record.source||'manual',originalStatus:record.status||'received',originalProviderId:providerId,originalCreated:record.created||null,originalUpdated:record.updated||null,originalOccurredAt:record.occurredAt||record.received||record.sentAt||record.created||null,sourceOwnerOnly:record.direction==='internal',internal}),removed_at:cancelled?time(record,'updated','occurredAt','created'):null});
      for(const reference of refs){const aid=id('attachment',key(native,reference)),fileId=/^\/api\/rrs\/files\?id=([A-Za-z0-9-]+)/.exec(reference)?.[1];attachments.set(aid,{id:aid,org_id:orgId,message_id:native,provider,account_id:account,media_type:String(record.mediaType||'unknown'),provider_ref:reference,metadata:JSON.stringify({sourceSystem:'rrs-sale-office',workspace:snapshot.workspace,sourceWorkspace:snapshot.workspace,sourceId:record.id,originalRef:reference,sourceOwnerOnly:record.direction==='internal'||!!fileId&&privateFileIds.has(fileId),sourceScopeUnknown:!!fileId,unverified:true}),storage_state:'provider_reference'});}
      if(ctx.provider&&cancelled&&providerId)tombstones.set(providerKey,{org_id:orgId,provider:ctx.provider,account_id:ctx.account,remote_id:ctx.remote,provider_message_id:providerId,created_at:created});
    }
  }
  // Source-owned attachments disappearing from a later full snapshot are revoked,
  // not deleted. Keep the archived object key and never touch newly added CRM files.
  for(const previous of baselineRows.filter(r=>r.entity==='attachment')){
    const row=typeof previous.source_json==='string'?JSON.parse(previous.source_json):previous.source_json;
    if(attachments.has(row.id)||!logicalMessages.has(row.message_id))continue;
    const source=logicalOrigins.get(row.message_id)!;
    attachments.set(row.id,{...row,storage_state:'removed',removed_at:time(source,'updated','occurredAt','created')});
  }
  for(const record of records){units.push({type:'archive',row:{record,content_hash:hash(record),target_id:mapped.get(sourceKey(record))||id('archive',sourceKey(record))}});if(!knownKinds.has(record.kind)&&['job','domJob'].includes(record.kind)&&!['done','cancelled'].includes(record.status))warning('IN_FLIGHT_JOB',record.id,'Archived only; reconcile the old worker before cutover');}
  const webhookIds=new Set<string>();for(const webhook of snapshot.webhooks){if(!webhook||typeof webhook.id!=='string'||!webhook.id||typeof webhook.time!=='string'||!Number.isFinite(Date.parse(webhook.time)))throw new BridgeError(400,'Invalid legacy webhook');if(webhookIds.has(webhook.id))problem('DUPLICATE_WEBHOOK',webhook.id,'Duplicate webhook receipt');webhookIds.add(webhook.id);units.push({type:'webhook',row:webhook});}
  for(const auxiliary of snapshot.auxiliary||[]){units.push({type:'auxiliary',row:auxiliary});if(auxiliary.table==='rrs_communication_outbox'&&['Sending','Unknown'].includes(auxiliary.record.status))warning('UNRESOLVED_DELIVERY',auxiliary.id,'Archived delivery evidence only; reconcile provider outcome before cutover');}
  for(const [type,rows] of [['lead',nativeLeads],['conversation',nativeConversations],['identity',identities],['message',logicalMessages],['provenance',provenance],['attachment',attachments],['tombstone',tombstones]] as const)for(const row of rows.values())units.push({type,row});
  units.sort((a,b)=>entityOrder.indexOf(a.type)-entityOrder.indexOf(b.type));
  const counts:Record<string,number>={sourceRecords:snapshot.records.length,sourceWebhooks:snapshot.webhooks.length,unresolvedFiles:unresolvedFiles.length};for(const type of entityOrder)counts[type]=units.filter(u=>u.type===type).length;
  const snapshotHash=hash(snapshot),planHash=hash({snapshotHash,orgId,options,units});
  return {valid:!issues.length,orgId,allowSourceUpdates:options.allowSourceUpdates===true,snapshot,snapshotHash,planHash,counts,issues,warnings,unresolvedFiles,units};
}

export function summarizeLegacyPlan(plan: LegacyPlan) { return {valid:plan.valid,allowSourceUpdates:plan.allowSourceUpdates,snapshotId:plan.snapshot.snapshotId,snapshotHash:plan.snapshotHash,planHash:plan.planHash,counts:plan.counts,issues:plan.issues,warnings:plan.warnings,unresolvedFiles:plan.unresolvedFiles,totalUnits:plan.units.length,cutoverReady:false,cutoverRequirements:['Verify imported counts and files','Freeze and drain source writers, apply a final snapshot and verify zero tail','Validate all production channels and obtain cutover approval'],tailPolicy:'Explicit allowSourceUpdates permits newer source revisions only when changed fields still match their imported baseline. CRM-owned fields, remapped identities and hard deletions require manual reconciliation.'}; }

async function targetContext(orgId:string):Promise<TargetContext>{return {
  identities:(await database.query('SELECT * FROM social_identities WHERE org_id=$1',[orgId])).rows,
  messages:(await database.query('SELECT p.provider,p.account_id,p.provider_message_id,p.message_id,m.content,m.conversation_id FROM social_message_provenance p JOIN messages m ON m.org_id=p.org_id AND m.id=p.message_id WHERE p.org_id=$1',[orgId])).rows,
  mappings:(await database.query('SELECT * FROM crm_bridge_import_mappings WHERE org_id=$1 AND source_system=$2',[orgId,'rrs-sale-office'])).rows,
  baselines:(await database.query('SELECT * FROM crm_legacy_target_baselines WHERE org_id=$1',[orgId])).rows,
  tombstones:(await database.query('SELECT * FROM social_tombstones WHERE org_id=$1',[orgId])).rows,
};}

async function insertNative(connection:Executor,table:string,row:Row,identityColumns:string[]=['org_id','id']){
  const existing=(await connection.query(`SELECT * FROM ${table} WHERE ${identityColumns.map((c,i)=>`${c}=$${i+1}`).join(' AND ')}`,identityColumns.map(c=>row[c]))).rows[0];
  if(existing)return false;const columns=Object.keys(row);
  await connection.query(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map((_,i)=>'$'+(i+1)).join(',')})`,columns.map(c=>row[c]));return true;
}

const nativeDefinitions = {
  lead:{table:'leads',keys:['org_id','id'],mutable:['name','phone','email','contact_consent_at','contact_consent_version'],fixed:['id','org_id','facts','created_at']},
  conversation:{table:'conversations',keys:['org_id','id'],mutable:[],fixed:['id','org_id','lead_id','created_at']},
  identity:{table:'social_identities',keys:['org_id','id'],mutable:['opt_out'],fixed:['id','org_id','provider','account_id','remote_id','lead_id','conversation_id']},
  message:{table:'messages',keys:['org_id','id'],mutable:['content','role','source_owner_only'],fixed:['id','org_id','conversation_id','created_at']},
  provenance:{table:'social_message_provenance',keys:['org_id','message_id'],mutable:['provider_message_id','delivery_status','metadata','removed_at'],fixed:['org_id','message_id','provider','account_id','remote_id','direction']},
  attachment:{table:'social_message_attachments',keys:['org_id','id'],mutable:['metadata','storage_state','removed_at'],fixed:['id','org_id','message_id','provider','account_id','provider_ref']},
  tombstone:{table:'social_tombstones',keys:['org_id','provider','account_id','remote_id','provider_message_id'],mutable:[],fixed:['org_id','provider','account_id','remote_id','provider_message_id']},
} as const;
type NativeType=keyof typeof nativeDefinitions;
type Baseline={source:Row;owned:string[];revision:number};
const nativeId=(unit:Unit)=>unit.type==='provenance'?unit.row.message_id:unit.type==='tombstone'?key(unit.row.provider,unit.row.account_id,unit.row.remote_id,unit.row.provider_message_id):unit.row.id;
const parsed=(value:unknown)=>typeof value==='string'?JSON.parse(value):value;
const comparable=(field:string,value:unknown)=>['metadata','facts'].includes(field)&&typeof value==='string'?JSON.parse(value):value??null;
const equal=(field:string,a:unknown,b:unknown)=>canonical(comparable(field,a))===canonical(comparable(field,b));
async function nativeRow(connection:Executor,unit:Unit){const d=nativeDefinitions[unit.type as NativeType];return (await connection.query(`SELECT * FROM ${d.table} WHERE ${d.keys.map((column,i)=>`${column}=$${i+1}`).join(' AND ')}`,d.keys.map(column=>unit.row[column]))).rows[0];}

/** Compare only fields whose desired source value changed since the prior import. */
function deltaPatch(plan:LegacyPlan,unit:Unit,baseline:Baseline,current:Row){
  const d=nativeDefinitions[unit.type as NativeType],patch:Row={};
  for(const field of d.fixed)if(!equal(field,baseline.source[field],unit.row[field]))throw new BridgeError(409,`Source ${unit.type} identity changed; explicit mapping reconciliation is required`);
  for(const field of d.mutable){
    const before=baseline.source[field],desired=unit.row[field];
    if(equal(field,before,desired))continue;
    if(!plan.allowSourceUpdates)throw new BridgeError(409,'Source updates require allowSourceUpdates=true');
    if(field==='source_owner_only'&&before===1&&desired!==1)throw new BridgeError(409,'Source message permissions cannot be broadened by import');
    if(unit.type==='attachment'&&field==='storage_state'){
      if(desired!=='removed')throw new BridgeError(409,'A removed source attachment cannot be restored by history import');
      if(!baseline.owned.includes(field))throw new BridgeError(409,'Cannot revoke an attachment not owned by this source import');
      patch.storage_state='removed';continue;
    }
    if(field==='metadata'){
      const oldMetadata=(comparable(field,before)||{}) as Row,nextMetadata=(comparable(field,desired)||{}) as Row,actual=(comparable(field,current[field])||{}) as Row;
      const merged={...actual};
      for(const name of new Set([...Object.keys(oldMetadata),...Object.keys(nextMetadata)])){
        if(equal(name,oldMetadata[name],nextMetadata[name]))continue;
        if(name==='sourceOwnerOnly'&&oldMetadata[name]===true&&nextMetadata[name]!==true)throw new BridgeError(409,'Source file/message permissions cannot be broadened by import');
        if(!equal(name,actual[name],nextMetadata[name])&&(!baseline.owned.includes(field)||!equal(name,actual[name],oldMetadata[name])))throw new BridgeError(409,`CRM ${unit.type} metadata changed concurrently`);
        if(nextMetadata[name]===undefined)delete merged[name];else merged[name]=nextMetadata[name];
      }
      patch.metadata=JSON.stringify(merged);continue;
    }
    if(unit.type==='provenance'&&field==='delivery_status'){
      const rank:Row={received:0,queued:0,sending:0,unknown:0,submitted:1,sent:2,failed:2,delivered:3,read:4,cancelled:5};
      if((rank[desired]??0)<(rank[before]??0))throw new BridgeError(409,'Source receipt would move delivery state backwards');
    }
    if(equal(field,current[field],desired))continue;
    if(!baseline.owned.includes(field)||!equal(field,current[field],before))throw new BridgeError(409,`CRM ${unit.type}.${field} changed concurrently or is not source-owned`);
    patch[field]=desired??null;
  }
  return patch;
}

async function saveBaseline(connection:Executor,plan:LegacyPlan,unit:Unit,owned:string[]){
  await connection.query(`INSERT INTO crm_legacy_target_baselines(org_id,workspace,entity,target_id,source_json,owned_fields,source_revision,snapshot_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT(org_id,workspace,entity,target_id) DO UPDATE SET source_json=excluded.source_json,owned_fields=excluded.owned_fields,source_revision=excluded.source_revision,snapshot_id=excluded.snapshot_id`,
  [plan.orgId,plan.snapshot.workspace,unit.type,nativeId(unit),canonical(unit.row),JSON.stringify(owned),plan.snapshot.revision,plan.snapshot.snapshotId]);
}

async function reconcileNative(connection:Executor,plan:LegacyPlan,unit:Unit,baselines:Map<string,Baseline>,current?:Row){
  const d=nativeDefinitions[unit.type as NativeType],baseline=baselines.get(key(unit.type,nativeId(unit)));current??=await nativeRow(connection,unit);
  if(!current)return false;
  if(baseline){
    const patch=deltaPatch(plan,unit,baseline,current),columns=Object.keys(patch);
    if(columns.length)await connection.query(`UPDATE ${d.table} SET ${columns.map((column,i)=>`${column}=$${i+1}`).join(',')} WHERE ${d.keys.map((column,i)=>`${column}=$${i+columns.length+1}`).join(' AND ')}`,[...columns.map(column=>patch[column]),...d.keys.map(column=>unit.row[column])]);
    await saveBaseline(connection,plan,unit,baseline.owned);
  }else{
    if(unit.type==='message'&&(current.content!==unit.row.content||current.conversation_id!==unit.row.conversation_id))throw new BridgeError(409,'Existing CRM message cannot be claimed by this import');
    await saveBaseline(connection,plan,unit,[]);
  }
  return true;
}

async function preflightLegacy(connection:Executor,plan:LegacyPlan){
  const s=plan.snapshot;
  const histories=(await connection.query('SELECT snapshot_id,revision,status,source_tail_sequence FROM crm_legacy_snapshots WHERE org_id=$1 AND workspace=$2',[plan.orgId,s.workspace])).rows;
  if(histories.some(r=>r.snapshot_id!==s.snapshotId&&r.status==='importing'))throw new BridgeError(409,'Finish the active source snapshot before importing another');
  const newer=histories.find(r=>r.snapshot_id!==s.snapshotId&&Number(r.revision)>s.revision);
  if(newer)throw new BridgeError(409,'Source snapshot revision is stale');
  const tails=histories.filter(r=>r.snapshot_id!==s.snapshotId&&r.source_tail_sequence!==null);
  if(tails.some(r=>s.tailSequence===undefined||Number(r.source_tail_sequence)>s.tailSequence))throw new BridgeError(409,'Source tail watermark is missing or stale');
  const auxHeads=(await connection.query('SELECT * FROM crm_legacy_auxiliary_heads WHERE org_id=$1 AND workspace=$2',[plan.orgId,s.workspace])).rows;
  const auxiliaries=new Map((s.auxiliary||[]).map(row=>[key(row.table,row.id),row]));
  for(const previous of auxHeads){const row=auxiliaries.get(key(previous.source_table,previous.source_id));if(!row)throw new BridgeError(409,'Full snapshot omitted previously archived auxiliary evidence');if(previous.content_hash!==hash(row.record)&&(!plan.allowSourceUpdates||s.tailSequence===undefined||previous.source_tail_sequence!==null&&s.tailSequence<=Number(previous.source_tail_sequence)))throw new BridgeError(409,'Changed auxiliary evidence requires allowSourceUpdates and a newer captured tailSequence');}
  const heads=(await connection.query('SELECT * FROM crm_legacy_source_heads WHERE org_id=$1 AND workspace=$2',[plan.orgId,s.workspace])).rows;
  const bySource=new Map(heads.map(row=>[key(row.kind,row.source_id),row]));
  const sourceUnits=plan.units.filter(unit=>unit.type==='archive'),sourceKeys=new Set(sourceUnits.map(unit=>sourceKey(unit.row.record)));
  if(heads.some(head=>!sourceKeys.has(key(head.kind,head.source_id))))throw new BridgeError(409,'Full snapshot removed a source record; supply an explicit tombstone reconciliation');
  const oldMappings=(await connection.query('SELECT * FROM crm_bridge_import_mappings WHERE org_id=$1 AND source_system=$2 AND source_workspace=$3',[plan.orgId,s.sourceSystem,s.workspace])).rows;
  const mappings=new Map(oldMappings.map(row=>[key(row.entity_kind,row.source_id),row]));
  for(const unit of sourceUnits){
    const r=unit.row.record,old=mappings.get(sourceKey(r)),head=bySource.get(sourceKey(r));
    if(old&&old.target_id!==unit.row.target_id)throw new BridgeError(409,'Source entity mapping changed; reconcile explicitly');
    if(old&&old.content_hash!==unit.row.content_hash){
      if(!plan.allowSourceUpdates)throw new BridgeError(409,'Source updates require allowSourceUpdates=true');
      if(!head||s.revision<=Number(head.source_revision))throw new BridgeError(409,'Changed source record requires a strictly newer snapshot revision');
      if(head.source_updated&&r.updated&&Date.parse(r.updated)<Date.parse(head.source_updated))throw new BridgeError(409,'Source record timestamp moved backwards');
    }
  }
  const rows=(await connection.query('SELECT * FROM crm_legacy_target_baselines WHERE org_id=$1 AND workspace=$2',[plan.orgId,s.workspace])).rows;
  const baselines=new Map<string,Baseline>(rows.map(row=>[key(row.entity,row.target_id),{source:parsed(row.source_json),owned:parsed(row.owned_fields),revision:Number(row.source_revision)}]));
  // Validate every planned change before writing any part of this batch, even if
  // that entity is in a later dependency phase. CAS retries re-check this evidence.
  for(const unit of plan.units.filter(unit=>unit.type in nativeDefinitions)){
    const baseline=baselines.get(key(unit.type,nativeId(unit)));if(!baseline)continue;
    const d=nativeDefinitions[unit.type as NativeType];
    if(![...d.fixed,...d.mutable].some(field=>!equal(field,baseline.source[field],unit.row[field])))continue;
    const current=await nativeRow(connection,unit);if(!current)throw new BridgeError(409,'Previously imported CRM entity is missing');
    deltaPatch(plan,unit,baseline,current);
  }
  return baselines;
}

/** Each call commits one dependency phase, at most 25 units. All data is supplied by the operator. */
export async function applyLegacyPlan(orgId:string,plan:LegacyPlan,cursor=0,limit=25){
  if(plan.orgId!==orgId)throw new BridgeError(403,'Legacy plan belongs to a different organization');
  if(!plan.valid)throw new BridgeError(422,'Legacy plan has unresolved identity or integrity errors');
  if(!Number.isSafeInteger(cursor)||cursor<0||cursor>plan.units.length||!Number.isSafeInteger(limit)||limit<1||limit>25)throw new BridgeError(400,'Invalid import batch cursor/limit');
  const s=plan.snapshot;
  return transaction(orgId,async connection=>{
    const existing=(await connection.query('SELECT * FROM crm_legacy_snapshots WHERE org_id=$1 AND workspace=$2 AND snapshot_id=$3',[orgId,s.workspace,s.snapshotId])).rows[0];
    if(existing&&(existing.snapshot_hash!==plan.snapshotHash||existing.plan_hash!==plan.planHash))throw new BridgeError(409,'Snapshot ID or plan changed; import is immutable');
    if(existing&&Number(existing.cursor)>cursor)return {cursor:Number(existing.cursor),totalUnits:plan.units.length,complete:existing.status==='complete',replayed:true};
    if(cursor!==(existing?Number(existing.cursor):0))throw new BridgeError(409,'Import cursor must resume the committed batch');
    const baselines=await preflightLegacy(connection,plan);
    if(!existing)await connection.query('INSERT INTO crm_legacy_snapshots(org_id,source_system,workspace,snapshot_id,revision,snapshot_hash,plan_hash,total_units,source_record_count,source_webhook_count,source_auxiliary_count,source_tail_sequence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[orgId,s.sourceSystem,s.workspace,s.snapshotId,s.revision,plan.snapshotHash,plan.planHash,plan.units.length,s.records.length,s.webhooks.length,s.auxiliary?.length||0,s.tailSequence??null]);
    const phase=plan.units[cursor]?.type;let end=cursor;while(end<plan.units.length&&end-cursor<limit&&plan.units[end].type===phase)end++;
    const sequences=new Map<string,number>();
    const sideData=async(unit:Unit)=>{
      if(await reconcileNative(connection,plan,unit,baselines))return;
      const d=nativeDefinitions[unit.type as NativeType];
      await insertNative(connection,d.table,unit.row,[...d.keys]);
      await saveBaseline(connection,plan,unit,[...d.mutable]);
    };
    for(const unit of plan.units.slice(cursor,end)){
      const row=unit.row;
      if(unit.type==='archive'){
        const r=row.record;await connection.query('INSERT OR IGNORE INTO crm_legacy_records(org_id,workspace,snapshot_id,source_id,kind,content_hash,raw_json) VALUES($1,$2,$3,$4,$5,$6,$7)',[orgId,s.workspace,s.snapshotId,r.id,r.kind,row.content_hash,canonical(r)]);
        await connection.query('INSERT OR IGNORE INTO crm_bridge_import_mappings(org_id,source_system,source_workspace,entity_kind,source_id,target_id,content_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',[orgId,s.sourceSystem,s.workspace,r.kind,r.id,row.target_id,row.content_hash]);
        await connection.query('UPDATE crm_bridge_import_mappings SET content_hash=$6 WHERE org_id=$1 AND source_system=$2 AND source_workspace=$3 AND entity_kind=$4 AND source_id=$5',[orgId,s.sourceSystem,s.workspace,r.kind,r.id,row.content_hash]);
        await connection.query(`INSERT INTO crm_legacy_source_heads(org_id,workspace,kind,source_id,target_id,content_hash,source_revision,source_updated,snapshot_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT(org_id,workspace,kind,source_id) DO UPDATE SET content_hash=excluded.content_hash,source_revision=excluded.source_revision,source_updated=excluded.source_updated,snapshot_id=excluded.snapshot_id`,[orgId,s.workspace,r.kind,r.id,row.target_id,row.content_hash,s.revision,typeof r.updated==='string'?r.updated:'',s.snapshotId]);
      }else if(unit.type==='webhook')await connection.query('INSERT OR IGNORE INTO crm_legacy_webhooks(org_id,workspace,snapshot_id,id,time) VALUES($1,$2,$3,$4,$5)',[orgId,s.workspace,s.snapshotId,row.id,row.time]);
      else if(unit.type==='auxiliary'){
        await connection.query('INSERT OR IGNORE INTO crm_legacy_auxiliary(org_id,workspace,snapshot_id,source_table,source_id,content_hash,raw_json) VALUES($1,$2,$3,$4,$5,$6,$7)',[orgId,s.workspace,s.snapshotId,row.table,row.id,hash(row.record),canonical(row.record)]);
        await connection.query(`INSERT INTO crm_legacy_auxiliary_heads(org_id,workspace,source_table,source_id,content_hash,source_tail_sequence,snapshot_id) VALUES($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT(org_id,workspace,source_table,source_id) DO UPDATE SET content_hash=excluded.content_hash,source_tail_sequence=excluded.source_tail_sequence,snapshot_id=excluded.snapshot_id`,[orgId,s.workspace,row.table,row.id,hash(row.record),s.tailSequence??null,s.snapshotId]);
      }
      else if(unit.type==='lead'){
        const existingLead=await nativeRow(connection,unit);
        if(!existingLead){await insertNative(connection,'leads',row);await saveBaseline(connection,plan,unit,[...nativeDefinitions.lead.mutable]);}
        else{
          if(row.facts){const incoming=JSON.parse(row.facts).rrs_sale_office,prior=existingLead.facts?.rrs_sale_office;if(prior&&canonical(prior)!==canonical(incoming))throw new BridgeError(409,'CRM lead already has a different source contact mapping');if(!prior)await connection.query('UPDATE leads SET facts=$3 WHERE org_id=$1 AND id=$2',[orgId,row.id,JSON.stringify({...existingLead.facts,rrs_sale_office:incoming})]);}
          await reconcileNative(connection,plan,unit,baselines,existingLead);
        }
      }
      else if(unit.type==='conversation'){if(!(await connection.query('SELECT id FROM leads WHERE org_id=$1 AND id=$2',[orgId,row.lead_id])).rows.length)throw new BridgeError(409,'Import lead dependency is missing');await sideData(unit);}
      else if(unit.type==='identity'){
        const old=(await connection.query('SELECT * FROM social_identities WHERE org_id=$1 AND provider=$2 AND account_id=$3 AND remote_id=$4',[orgId,row.provider,row.account_id,row.remote_id])).rows[0];
        if(old&&(old.lead_id!==row.lead_id||old.conversation_id!==row.conversation_id))throw new BridgeError(409,'Channel identity changed during import; rebuild plan');
        if(old&&!baselines.has(key(unit.type,nativeId(unit)))&&row.opt_out&&!old.opt_out)await connection.query('UPDATE social_identities SET opt_out=1 WHERE org_id=$1 AND id=$2',[orgId,old.id]);
        await sideData(unit);
      }else if(unit.type==='message'){
        const old=await nativeRow(connection,unit);
        const conversation=(await connection.query('SELECT customer_message_seq FROM conversations WHERE org_id=$1 AND id=$2',[orgId,row.conversation_id])).rows[0];if(!conversation)throw new BridgeError(409,'Import conversation dependency is missing');
        const message={...row};
        if(row.role==='user'&&(!old||old.role!=='user'&&old.customer_seq==null)){
          const seq=(sequences.get(row.conversation_id)??Number(conversation.customer_message_seq))+1;sequences.set(row.conversation_id,seq);message.customer_seq=seq;
          await connection.query('UPDATE conversations SET customer_message_seq=$3 WHERE org_id=$1 AND id=$2',[orgId,row.conversation_id,seq]);
          if(old)await connection.query('UPDATE messages SET customer_seq=$3 WHERE org_id=$1 AND id=$2',[orgId,row.id,seq]);
        }
        if(old)await reconcileNative(connection,plan,unit,baselines,old);
        else{await insertNative(connection,'messages',message);await saveBaseline(connection,plan,unit,[...nativeDefinitions.message.mutable]);}
        // Body/tombstone/private attachment revocation are one transaction. A
        // consumer cannot observe a cancelled message with readable old files.
        const provenance=plan.units.find(u=>u.type==='provenance'&&u.row.message_id===row.id);
        if(provenance)await sideData(provenance);
        for(const child of plan.units.filter(u=>u.type==='attachment'&&u.row.message_id===row.id))await sideData(child);
        if(provenance)for(const tombstone of plan.units.filter(u=>u.type==='tombstone'&&u.row.provider===provenance.row.provider&&u.row.account_id===provenance.row.account_id&&u.row.remote_id===provenance.row.remote_id&&u.row.provider_message_id===provenance.row.provider_message_id))await sideData(tombstone);
      }else await sideData(unit);
    }
    const complete=end===plan.units.length;
    await connection.query("UPDATE crm_legacy_snapshots SET cursor=$4,status=$5,completed_at=CASE WHEN $5='complete' THEN (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') ELSE NULL END WHERE org_id=$1 AND workspace=$2 AND snapshot_id=$3",[orgId,s.workspace,s.snapshotId,end,complete?'complete':'importing']);
    return {cursor:end,totalUnits:plan.units.length,complete,replayed:false};
  });
}

export async function handleLegacyImport(orgId:string,body:unknown){
  if(!body||typeof body!=='object'||Array.isArray(body))throw new BridgeError(400,'Invalid import request');const input=body as Row;
  if(Object.keys(input).some(k=>!['snapshot','options','dryRun','cursor','limit'].includes(k))||typeof input.dryRun!=='boolean')throw new BridgeError(400,'Import requires explicit dryRun');
  const plan=planLegacyImport(input.snapshot,orgId,input.options||{},await targetContext(orgId));
  for(const targetId of Object.values((input.options||{}).contactLeadMap||{}))if(!(await database.query('SELECT id FROM leads WHERE org_id=$1 AND id=$2',[orgId,targetId])).rows.length)throw new BridgeError(403,'Explicit contact mapping must reference an existing lead in this organization');
  if(input.dryRun){
    if(plan.valid)try{await transaction(orgId,async connection=>{await preflightLegacy(connection,plan);});}
    catch(error){if(error instanceof BridgeError)return {...summarizeLegacyPlan(plan),valid:false,issues:[...plan.issues,{code:'TARGET_RECONCILIATION_CONFLICT',sourceId:'',message:error.message}]};throw error;}
    return summarizeLegacyPlan(plan);
  }
  const progress=await applyLegacyPlan(orgId,plan,input.cursor??0,input.limit??25);
  return {...summarizeLegacyPlan(plan),progress,...progress.complete?{verification:await verifyLegacyImport(orgId,plan)}:{}};
}

/** Count verification covers records/references only; it never claims attachment byte verification. */
export async function verifyLegacyImport(orgId:string,plan:LegacyPlan){
  const s=plan.snapshot,counts:Record<string,number>={};
  counts.archive=Number((await database.query('SELECT count(*) AS n FROM crm_legacy_records WHERE org_id=$1 AND workspace=$2 AND snapshot_id=$3',[orgId,s.workspace,s.snapshotId])).rows[0].n);
  counts.webhook=Number((await database.query('SELECT count(*) AS n FROM crm_legacy_webhooks WHERE org_id=$1 AND workspace=$2 AND snapshot_id=$3',[orgId,s.workspace,s.snapshotId])).rows[0].n);
  counts.auxiliary=Number((await database.query('SELECT count(*) AS n FROM crm_legacy_auxiliary WHERE org_id=$1 AND workspace=$2 AND snapshot_id=$3',[orgId,s.workspace,s.snapshotId])).rows[0].n);
  for(const [type,table,column] of [['lead','leads','id'],['conversation','conversations','id'],['identity','social_identities','id'],['message','messages','id'],['provenance','social_message_provenance','message_id'],['attachment','social_message_attachments','id']] as const){
    const ids=[...new Set(plan.units.filter(unit=>unit.type===type).map(unit=>unit.row[column]))];counts[type]=0;
    for(let index=0;index<ids.length;index+=50){const part=ids.slice(index,index+50);counts[type]+=Number((await database.query(`SELECT count(*) AS n FROM ${table} WHERE org_id=$1 AND ${column} IN (${part.map((_,i)=>'$'+(i+2)).join(',')})`,[orgId,...part])).rows[0].n);}
  }
  return {matched:Object.entries(counts).every(([kind,count])=>count===plan.counts[kind]),counts,expected:plan.counts,attachmentBytesVerified:false,sourceTailVerified:false};
}
