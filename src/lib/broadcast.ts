import {randomUUID} from 'node:crypto';
import {ApiError,fields,hashToken,oneOf,requireAdmin,str,uuid,type Staff} from './auth';
import {database,transaction,type Executor,type Row} from './db';
import {dispatchSocialReply,readSocialConfig,socialConfigFingerprint,socialVerificationReady,type SocialChannelConfig} from './social-channels';

/**
 * WhatsApp/LINE broadcast. Safety model:
 * - BROADCAST_ENABLED must be exactly 'true' for any send (test or live); default off.
 * - Recipients are only existing social identities with explicit evidence: WhatsApp needs the
 *   recorded consent fields, LINE needs a current follow event. Opt-outs and suppressions win.
 * - CSV imports are dry-run previews that can only narrow the audience to existing identities.
 * - Every message goes through social_outbound_commands, so the shared outbound guard, live
 *   gates, emergency stop and unknown-outcome quarantine apply. Unknown is never retried.
 */
export type BroadcastProvider='whatsapp'|'line';
export type BroadcastSegment={tags?:string[];markets?:string[];stages?:string[];firstContactFrom?:string;firstContactTo?:string;lastContactFrom?:string;lastContactTo?:string;importId?:string};
export type BroadcastOptions={env?:Record<string,string|undefined>;configs?:Partial<Record<BroadcastProvider,SocialChannelConfig>>;fetch?:typeof fetch};
type TemplatePayload={name:string;language:string;components?:unknown[]};

export const BROADCAST_BATCH_MAX=10;
const IMPORT_ROW_MAX=5000;
const WINDOW_MARGIN_MS=5*60_000;
const providers:BroadcastProvider[]=['whatsapp','line'];
const marketValues=['unknown','domestic','export'],stageValues=['New','Qualified','Follow-up','Won','Lost'];
const maxText:Record<BroadcastProvider,number>={whatsapp:4096,line:2000};
const remotePattern:Record<BroadcastProvider,RegExp>={whatsapp:/^[1-9]\d{7,14}$/,line:/^U[a-f0-9]{32}$/};
const passedStatuses=['submitted','sent','delivered','read'];
const utc=(ms:number)=>new Date(ms).toISOString().replace(/(\.\d{3})Z$/,(_,fraction)=>fraction+'000Z');
const dayStart=(day:string)=>utc(Date.parse(day+'T00:00:00+07:00'));
const dayEnd=(day:string)=>utc(Date.parse(day+'T00:00:00+07:00')+86_400_000);
const bangkokToday=(ms:number)=>dayStart(new Date(ms+7*3_600_000).toISOString().slice(0,10));
const environment=(options:BroadcastOptions)=>options.env||process.env;
export const broadcastEnabled=(env:Record<string,string|undefined>=process.env)=>env.BROADCAST_ENABLED==='true';
function positive(value:string|undefined,fallback:number,maximum:number){const n=Number(value);return value&&Number.isSafeInteger(n)&&n>0?Math.min(n,maximum):fallback;}
const dailyLimit=(env:Record<string,string|undefined>)=>positive(env.BROADCAST_DAILY_LIMIT,200,10_000);
const maxRecipients=(env:Record<string,string|undefined>)=>positive(env.BROADCAST_MAX_RECIPIENTS,1000,5000);
function channelConfig(provider:BroadcastProvider,options:BroadcastOptions){return options.configs?.[provider]||readSocialConfig(provider,environment(options));}
export function maskRemote(provider:string,remote:string){const tail=String(remote||'').slice(-4);return provider==='line'?'U••••'+tail:'••••'+tail;}
function assertEnabled(options:BroadcastOptions){if(!broadcastEnabled(environment(options)))throw new ApiError(503,'บรอดแคสต์ปิดอยู่ (BROADCAST_ENABLED ไม่ได้เปิด) ส่งข้อความไม่ได้');}
function json(value:unknown,fallback:unknown){if(typeof value!=='string')return value??fallback;try{return JSON.parse(value);}catch{return fallback;}}

class Params{values:unknown[]=[];add(value:unknown){this.values.push(value);return '$'+this.values.length;}}

/* ---------------------------------------------------------------- input parsing */
function list(value:unknown,label:string,allowed?:string[]):string[]|undefined{
  if(value===undefined||value===null)return undefined;
  if(!Array.isArray(value)||value.length>20)throw new ApiError(400,`${label}ไม่ถูกต้อง`);
  const items=[...new Set(value.map(item=>str(item,label,40,true)))];
  if(allowed&&items.some(item=>!allowed.includes(item)))throw new ApiError(400,`${label}ไม่ถูกต้อง`);
  return items.length?items:undefined;
}
function day(value:unknown,label:string){
  if(value===undefined||value===null||value==='')return undefined;
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00+07:00')))throw new ApiError(400,`${label}ไม่ถูกต้อง`);
  return value;
}
export function parseSegment(value:unknown):BroadcastSegment{
  if(value===undefined||value===null)return {};
  if(typeof value!=='object'||Array.isArray(value))throw new ApiError(400,'กลุ่มเป้าหมายไม่ถูกต้อง');
  const input=value as Record<string,unknown>;
  fields(input,['tags','markets','stages','firstContactFrom','firstContactTo','lastContactFrom','lastContactTo','importId']);
  const segment:BroadcastSegment={};
  const tags=list(input.tags,'แท็ก'),markets=list(input.markets,'ตลาด',marketValues),stages=list(input.stages,'สถานะลูกค้า',stageValues);
  if(tags)segment.tags=tags;if(markets)segment.markets=markets;if(stages)segment.stages=stages;
  for(const key of ['firstContactFrom','firstContactTo','lastContactFrom','lastContactTo'] as const){const parsed=day(input[key],'วันที่ติดต่อ');if(parsed)segment[key]=parsed;}
  if(segment.firstContactFrom&&segment.firstContactTo&&segment.firstContactFrom>segment.firstContactTo||segment.lastContactFrom&&segment.lastContactTo&&segment.lastContactFrom>segment.lastContactTo)throw new ApiError(400,'ช่วงวันที่ไม่ถูกต้อง');
  if(input.importId!==undefined&&input.importId!==null&&input.importId!=='')segment.importId=uuid(input.importId,'รายการนำเข้า');
  return segment;
}
function parseTemplate(value:unknown){
  if(value===undefined||value===null)return null;
  if(typeof value!=='object'||Array.isArray(value))throw new ApiError(400,'เทมเพลตไม่ถูกต้อง');
  const input=value as Record<string,unknown>;fields(input,['name','language','params']);
  const name=str(input.name,'ชื่อเทมเพลต',512,true),language=str(input.language,'ภาษาเทมเพลต',20,true);
  if(!/^[a-z0-9_]{1,512}$/.test(name)||!/^[a-zA-Z_]{2,20}$/.test(language))throw new ApiError(400,'ชื่อหรือภาษาเทมเพลตไม่ถูกต้อง');
  const params=input.params===undefined?[]:input.params;
  if(!Array.isArray(params)||params.length>20)throw new ApiError(400,'ตัวแปรเทมเพลตไม่ถูกต้อง');
  // WhatsApp rejects parameters with newlines, tabs or more than four consecutive spaces.
  for(const item of params)if(typeof item!=='string'||!item.trim()||item.length>1024||/[\n\t\r]/.test(item)||/ {5,}/.test(item))throw new ApiError(400,'ตัวแปรเทมเพลตต้องเป็นข้อความบรรทัดเดียว 1–1024 ตัวอักษร');
  return {name,language,params:params as string[]};
}
type Draft={name?:string;messageKind?:'text'|'template';messageText?:string;template?:{name:string;language:string;params:string[]}|null;segment?:BroadcastSegment};
function parseDraft(provider:BroadcastProvider,input:Record<string,unknown>):Draft{
  const draft:Draft={};
  if(input.name!==undefined)draft.name=str(input.name,'ชื่อแคมเปญ',120,true);
  if(input.messageKind!==undefined)draft.messageKind=oneOf(input.messageKind,['text','template'],'รูปแบบข้อความ') as 'text'|'template';
  if(input.messageText!==undefined){
    if(typeof input.messageText!=='string'||input.messageText.length>maxText[provider])throw new ApiError(400,`ข้อความต้องยาวไม่เกิน ${maxText[provider]} ตัวอักษร`);
    draft.messageText=input.messageText;
  }
  if(input.template!==undefined)draft.template=parseTemplate(input.template);
  if(input.segment!==undefined)draft.segment=parseSegment(input.segment);
  if(provider==='line'&&(draft.messageKind==='template'||draft.template))throw new ApiError(400,'LINE รองรับเฉพาะข้อความ');
  return draft;
}
function sendable(campaign:Row){
  const provider=campaign.provider as BroadcastProvider;
  if(campaign.message_kind==='template'){
    if(provider!=='whatsapp'||!campaign.template_name||!campaign.template_language)throw new ApiError(409,'กรุณาระบุเทมเพลต WhatsApp ที่อนุมัติแล้ว');
    return;
  }
  const text=String(campaign.message_text||'');
  if(!text.trim()||text.length>maxText[provider])throw new ApiError(409,`กรุณาระบุข้อความ 1–${maxText[provider]} ตัวอักษร`);
}
function expectedVersion(value:unknown){
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1)throw new ApiError(400,'กรุณาโหลดข้อมูลแคมเปญล่าสุดก่อน');
  return value;
}

/* ---------------------------------------------------------------- views */
function view(row:Row){
  const params=json(row.template_params,[]) as string[];
  return {id:row.id as string,name:row.name as string,provider:row.provider as BroadcastProvider,accountId:row.account_id as string,status:row.status as string,
    messageKind:row.message_kind as 'text'|'template',messageText:row.message_text as string,
    template:row.template_name?{name:row.template_name as string,language:row.template_language as string,params}:null,templateBody:(row.template_body as string)||null,
    segment:json(row.segment,{}) as BroadcastSegment,scheduledAt:row.scheduled_at||null,createdBy:row.created_by,approvedBy:row.approved_by||null,
    launchedAt:row.launched_at||null,launchedCount:row.launched_count??null,launchSummary:json(row.launch_summary,{}),completedAt:row.completed_at||null,cancelledAt:row.cancelled_at||null,
    version:Number(row.version),createdAt:row.created_at,updatedAt:row.updated_at};
}
async function loadCampaign(c:Executor,orgId:string,id:string){
  const row=(await c.query('SELECT * FROM broadcast_campaigns WHERE org_id=$1 AND id=$2',[orgId,id])).rows[0];
  if(!row)throw new ApiError(404,'ไม่พบแคมเปญบรอดแคสต์');
  return row;
}
async function audit(c:Executor,staff:Staff,action:string,entityId:string,metadata:Record<string,unknown>,time:string){
  await c.query('INSERT INTO audit_events(id,org_id,actor_id,action,entity_id,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),staff.orgId,staff.id,'broadcast.'+action,entityId,JSON.stringify(metadata),time]);
}

/* ---------------------------------------------------------------- gates */
async function controlRow(c:Executor,orgId:string,provider:string,accountId:string){
  return (await c.query('SELECT * FROM social_channel_controls WHERE org_id=$1 AND provider=$2 AND account_id=$3',[orgId,provider,accountId])).rows[0];
}
/** Pre-checks mirror the shared outbound guard so failures are explained before anything is queued. */
async function assertChannelGates(c:Executor,orgId:string,campaign:Row,config:SocialChannelConfig,mode:'test'|'live'){
  if(config.provider!==campaign.provider||config.orgId!==orgId||!config.accountId||config.accountId!==campaign.account_id)throw new ApiError(409,'บัญชีช่องทางเปลี่ยนจากตอนสร้างแคมเปญ ส่งไม่ได้');
  if(config.owner!=='crm'||!config.inboundEnabled||!config.liveEnabled)throw new ApiError(503,'ช่องทางนี้ยังไม่เปิดการส่งจริงในการตั้งค่าระบบ');
  const control=await controlRow(c,orgId,campaign.provider,campaign.account_id);
  if(!control||!control.send_enabled||control.emergency_stop)throw new ApiError(503,'ช่องทางนี้หยุดการส่งอยู่ (หยุดฉุกเฉินหรือยังไม่เปิด)');
  if(!socialVerificationReady(control,config)||control.webhook_fingerprint!==socialConfigFingerprint(config))throw new ApiError(503,'ต้องตรวจบัญชีและยืนยันการรับข้อความของช่องทางก่อน');
  if(mode==='live'&&control.send_mode!=='live')throw new ApiError(503,'ช่องทางนี้ยังอยู่ในโหมดทดสอบ ส่งบรอดแคสต์ถึงลูกค้าไม่ได้');
  if(mode==='test'&&!['test','live'].includes(control.send_mode))throw new ApiError(503,'ช่องทางนี้ยังไม่เปิดการส่ง');
  if(mode==='live'&&campaign.provider==='whatsapp'&&config.whatsappAccountMode==='meta-test')throw new ApiError(409,'บัญชีทดสอบ Meta ส่งบรอดแคสต์ถึงลูกค้าไม่ได้');
  return control;
}
async function gates(c:Executor,staff:Staff,options:BroadcastOptions){
  const env=environment(options),channels:Record<string,unknown>={};
  for(const provider of providers){
    const config=channelConfig(provider,options),scoped=config.orgId===staff.orgId&&!!config.accountId;
    const control=scoped?await controlRow(c,staff.orgId,provider,config.accountId):undefined;
    const verified=!!control&&socialVerificationReady(control,config)&&control.webhook_fingerprint===socialConfigFingerprint(config);
    const environmentLive=scoped&&config.owner==='crm'&&config.inboundEnabled&&config.liveEnabled;
    const open=environmentLive&&verified&&!!control?.send_enabled&&!control?.emergency_stop;
    channels[provider]={configured:scoped,accountId:scoped?config.accountId:'',environmentLive,verified,emergencyStop:!control||!!control.emergency_stop,sendMode:control?.send_mode||'disabled',
      live:open&&control?.send_mode==='live'&&!(provider==='whatsapp'&&config.whatsappAccountMode==='meta-test'),
      testReady:open&&['test','live'].includes(control?.send_mode)&&!!config.testRecipient,
      testRecipient:scoped&&config.testRecipient?maskRemote(provider,config.testRecipient):null};
  }
  return {enabled:broadcastEnabled(env),dailyLimit:dailyLimit(env),maxRecipients:maxRecipients(env),batchLimit:BROADCAST_BATCH_MAX,channels};
}

/* ---------------------------------------------------------------- audience */
type AudienceFilter={segment?:BroadcastSegment;identityIds?:string[];launchedAt?:string|null};
/**
 * One SQL definition of eligibility shared by preview, launch materialization, runtime
 * re-checks, test sends and CSV matching. Every candidate gets exactly one reason ('' = eligible).
 * Provider-specific branches are code constants, never user input.
 */
function audienceSql(p:Params,orgId:string,campaign:Row,filter:AudienceFilter,nowMs:number){
  const provider=campaign.provider as BroadcastProvider,s=filter.segment||{};
  const inner=[`i.org_id=${p.add(orgId)}`,`i.provider=${p.add(provider)}`,`i.account_id=${p.add(campaign.account_id)}`];
  if(s.tags?.length)inner.push(`EXISTS(SELECT 1 FROM json_each(l.tags) t WHERE t.value IN (SELECT value FROM json_each(${p.add(JSON.stringify(s.tags))})))`);
  if(s.markets?.length)inner.push(`l.market IN (SELECT value FROM json_each(${p.add(JSON.stringify(s.markets))}))`);
  if(s.stages?.length)inner.push(`l.stage IN (SELECT value FROM json_each(${p.add(JSON.stringify(s.stages))}))`);
  if(s.firstContactFrom)inner.push(`COALESCE(c.first_customer_at,i.created_at)>=${p.add(dayStart(s.firstContactFrom))}`);
  if(s.firstContactTo)inner.push(`COALESCE(c.first_customer_at,i.created_at)<${p.add(dayEnd(s.firstContactTo))}`);
  if(s.importId)inner.push(`i.id IN (SELECT r.matched_identity_id FROM broadcast_import_rows r WHERE r.org_id=i.org_id AND r.campaign_id=${p.add(campaign.id)} AND r.import_id=${p.add(s.importId)} AND r.matched_identity_id IS NOT NULL)`);
  if(filter.identityIds)inner.push(`i.id IN (SELECT value FROM json_each(${p.add(JSON.stringify(filter.identityIds))}))`);
  const outer:string[]=[];
  if(s.lastContactFrom)outer.push(`x.last_inbound>=${p.add(dayStart(s.lastContactFrom))}`);
  if(s.lastContactTo)outer.push(`x.last_inbound<${p.add(dayEnd(s.lastContactTo))}`);
  const format=provider==='whatsapp'?"length(x.remote_id) BETWEEN 8 AND 15 AND x.remote_id NOT GLOB '*[^0-9]*' AND substr(x.remote_id,1,1)<>'0'":"length(x.remote_id)=33 AND substr(x.remote_id,1,1)='U' AND substr(x.remote_id,2) NOT GLOB '*[^0-9a-f]*'";
  const rules=["WHEN x.conversation_lead_id IS NULL OR x.conversation_lead_id<>x.lead_id THEN 'identity_link_changed'","WHEN x.opt_out=1 OR x.lead_opted_out=1 THEN 'opted_out'","WHEN x.suppressed=1 THEN 'suppressed'",`WHEN NOT (${format}) THEN 'invalid_recipient'`];
  if(filter.launchedAt)rules.push(`WHEN x.last_inbound>${p.add(filter.launchedAt)} THEN 'replied'`);
  rules.push(provider==='whatsapp'?"WHEN x.contact_consent_at IS NULL OR COALESCE(x.contact_consent_version,'')='' THEN 'no_consent'":"WHEN COALESCE(x.friendship,'')<>'follow' THEN 'not_followed'");
  // Outside the 24 hour customer-service window WhatsApp allows approved templates only.
  if(provider==='whatsapp'&&campaign.message_kind!=='template')rules.push(`WHEN x.last_inbound IS NULL OR x.last_inbound<${p.add(utc(nowMs-86_400_000+WINDOW_MARGIN_MS))} THEN 'outside_24h_window'`);
  return `SELECT x.*,CASE ${rules.join(' ')} ELSE '' END AS reason FROM (SELECT i.id AS identity_id,i.remote_id,i.lead_id,i.conversation_id,i.opt_out,i.created_at AS identity_created_at,
 l.market,l.stage,l.contact_consent_at,l.contact_consent_version,c.lead_id AS conversation_lead_id,
 (SELECT MAX(m.provider_timestamp) FROM social_message_provenance m WHERE m.org_id=i.org_id AND m.provider=i.provider AND m.account_id=i.account_id AND m.remote_id=i.remote_id AND m.direction='in' AND m.removed_at IS NULL) AS last_inbound,
 (SELECT e.event_kind FROM social_events e WHERE e.org_id=i.org_id AND e.provider=i.provider AND e.account_id=i.account_id AND e.remote_id=i.remote_id AND e.event_kind IN ('follow','unfollow') ORDER BY e.received_at DESC,e.event_id DESC LIMIT 1) AS friendship,
 EXISTS(SELECT 1 FROM social_identities o WHERE o.org_id=i.org_id AND o.lead_id=i.lead_id AND o.provider=i.provider AND o.opt_out=1) AS lead_opted_out,
 EXISTS(SELECT 1 FROM broadcast_suppressions s WHERE s.org_id=i.org_id AND s.provider=i.provider AND s.remote_id=i.remote_id) AS suppressed
 FROM social_identities i JOIN leads l ON l.org_id=i.org_id AND l.id=i.lead_id LEFT JOIN conversations c ON c.org_id=i.org_id AND c.id=i.conversation_id
 WHERE ${inner.join(' AND ')}) x${outer.length?' WHERE '+outer.join(' AND '):''}`;
}
async function audienceCounts(c:Executor,orgId:string,campaign:Row,filter:AudienceFilter,nowMs:number){
  const p=new Params(),sql=audienceSql(p,orgId,campaign,filter,nowMs);
  const rows=(await c.query(`SELECT reason,COUNT(*) AS n FROM (${sql}) y GROUP BY reason`,p.values)).rows;
  const excluded:Record<string,number>={};let matched=0,eligible=0;
  for(const row of rows){const n=Number(row.n);matched+=n;if(row.reason)excluded[row.reason]=n;else eligible=n;}
  return {matched,eligible,excluded};
}
async function reasonsFor(c:Executor,orgId:string,campaign:Row,identityIds:string[],launchedAt:string|null,nowMs:number){
  const p=new Params(),sql=audienceSql(p,orgId,campaign,{identityIds,launchedAt},nowMs);
  return new Map((await c.query(sql,p.values)).rows.map(row=>[row.identity_id as string,row]));
}

/* ---------------------------------------------------------------- read API */
export async function listBroadcasts(staff:Staff,options:BroadcastOptions={}){
  return transaction(staff.orgId,async c=>{
    const rows=(await c.query('SELECT * FROM broadcast_campaigns WHERE org_id=$1 ORDER BY updated_at DESC,id DESC LIMIT 100',[staff.orgId])).rows;
    const counts=(await c.query('SELECT campaign_id,status,COUNT(*) AS n FROM broadcast_recipients WHERE org_id=$1 AND campaign_id IN (SELECT id FROM broadcast_campaigns WHERE org_id=$1 ORDER BY updated_at DESC,id DESC LIMIT 100) GROUP BY campaign_id,status',[staff.orgId])).rows;
    const byCampaign=new Map<string,Record<string,number>>();
    for(const row of counts){const entry=byCampaign.get(row.campaign_id)||{};entry[row.status]=Number(row.n);byCampaign.set(row.campaign_id,entry);}
    const campaigns=rows.map(row=>{const v=view(row);return {id:v.id,name:v.name,provider:v.provider,status:v.status,messageKind:v.messageKind,scheduledAt:v.scheduledAt,launchedAt:v.launchedAt,launchedCount:v.launchedCount,completedAt:v.completedAt,version:v.version,updatedAt:v.updatedAt,recipients:byCampaign.get(v.id)||{}};});
    return {campaigns,gates:await gates(c,staff,options),canManage:staff.role==='Admin'};
  },staff);
}
export async function getBroadcast(staff:Staff,id:string,options:BroadcastOptions={}){
  uuid(id);
  return transaction(staff.orgId,async c=>{
    const campaign=await loadCampaign(c,staff.orgId,id);
    const recipients:Record<string,number>={},skipReasons:Record<string,number>={},delivery:Record<string,number>={};
    for(const row of (await c.query('SELECT status,skip_reason,COUNT(*) AS n FROM broadcast_recipients WHERE org_id=$1 AND campaign_id=$2 GROUP BY status,skip_reason',[staff.orgId,id])).rows){
      recipients[row.status]=(recipients[row.status]||0)+Number(row.n);if(row.status==='skipped')skipReasons[row.skip_reason||'unknown']=Number(row.n);
    }
    for(const row of (await c.query('SELECT o.status,COUNT(*) AS n FROM broadcast_recipients r JOIN social_outbound_commands o ON o.org_id=r.org_id AND o.id=r.outbound_command_id WHERE r.org_id=$1 AND r.campaign_id=$2 GROUP BY o.status',[staff.orgId,id])).rows)delivery[row.status]=Number(row.n);
    const base={campaign:view(campaign),stats:{recipients,skipReasons,delivery},gates:await gates(c,staff,options)};
    if(staff.role!=='Admin')return {...base,canManage:false,testSends:[],imports:[],testPassedForVersion:false};
    const tests=(await c.query('SELECT t.campaign_version,t.remote_id,t.created_at,o.status,o.error_code,o.body FROM broadcast_test_sends t JOIN social_outbound_commands o ON o.org_id=t.org_id AND o.id=t.outbound_command_id WHERE t.org_id=$1 AND t.campaign_id=$2 ORDER BY t.created_at DESC LIMIT 5',[staff.orgId,id])).rows;
    const imports=(await c.query(`SELECT import_id,MIN(created_at) AS created_at,COUNT(*) AS total,SUM(CASE WHEN status='valid' THEN 1 ELSE 0 END) AS valid,SUM(CASE WHEN matched_identity_id IS NOT NULL THEN 1 ELSE 0 END) AS matched,SUM(CASE WHEN matched_identity_id IS NOT NULL AND eligibility='' THEN 1 ELSE 0 END) AS eligible FROM broadcast_import_rows WHERE org_id=$1 AND campaign_id=$2 GROUP BY import_id ORDER BY MIN(created_at) DESC LIMIT 5`,[staff.orgId,id])).rows;
    return {...base,canManage:true,
      testSends:tests.map(t=>({campaignVersion:Number(t.campaign_version),recipient:maskRemote(campaign.provider,t.remote_id),createdAt:t.created_at,status:t.status,errorCode:t.error_code||''})),
      imports:imports.map(row=>({importId:row.import_id,createdAt:row.created_at,total:Number(row.total),valid:Number(row.valid),matched:Number(row.matched),eligible:Number(row.eligible)})),
      testPassedForVersion:tests.some(t=>Number(t.campaign_version)===Number(campaign.version)&&passedStatuses.includes(t.status))};
  },staff);
}

/* ---------------------------------------------------------------- drafts */
export async function createBroadcast(staff:Staff,input:Record<string,unknown>,options:BroadcastOptions={}){
  requireAdmin(staff);fields(input,['name','provider','messageKind','messageText','template','segment']);
  const provider=oneOf(input.provider,providers,'ช่องทาง') as BroadcastProvider;
  if(input.name===undefined)throw new ApiError(400,'กรุณาระบุชื่อแคมเปญ');
  const draft=parseDraft(provider,input);
  if(draft.segment?.importId)throw new ApiError(400,'นำเข้ารายชื่อได้หลังสร้างแคมเปญแล้ว');
  const config=channelConfig(provider,options);
  if(config.orgId!==staff.orgId||!config.accountId)throw new ApiError(409,'ช่องทางนี้ยังไม่ได้ตั้งค่าบัญชีสำหรับองค์กรนี้');
  const id=randomUUID(),time=utc(Date.now()),kind=draft.messageKind||'text';
  await transaction(staff.orgId,async c=>{
    await c.query('INSERT INTO broadcast_campaigns(id,org_id,name,provider,account_id,message_kind,message_text,template_name,template_language,template_params,segment,created_by,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)',
      [id,staff.orgId,draft.name,provider,config.accountId,kind,draft.messageText||'',draft.template?.name||null,draft.template?.language||null,JSON.stringify(draft.template?.params||[]),JSON.stringify(draft.segment||{}),staff.id,time]);
    await audit(c,staff,'created',id,{provider,accountId:config.accountId,messageKind:kind},time);
  },staff);
  return getBroadcast(staff,id,options);
}
export async function updateBroadcast(staff:Staff,id:string,input:Record<string,unknown>,options:BroadcastOptions={}){
  requireAdmin(staff);uuid(id);fields(input,['expectedVersion','name','messageKind','messageText','template','segment']);
  const version=expectedVersion(input.expectedVersion),time=utc(Date.now());
  await transaction(staff.orgId,async c=>{
    const campaign=await loadCampaign(c,staff.orgId,id);
    if(campaign.status!=='draft')throw new ApiError(409,'แก้ไขได้เฉพาะแคมเปญฉบับร่าง');
    if(Number(campaign.version)!==version)throw new ApiError(409,'แคมเปญถูกแก้ไขแล้ว กรุณาโหลดข้อมูลล่าสุด');
    const draft=parseDraft(campaign.provider,input);
    if(draft.segment?.importId&&!(await c.query('SELECT 1 FROM broadcast_import_rows WHERE org_id=$1 AND campaign_id=$2 AND import_id=$3 LIMIT 1',[staff.orgId,id,draft.segment.importId])).rows.length)throw new ApiError(400,'ไม่พบรายการนำเข้าของแคมเปญนี้');
    const kind=draft.messageKind||campaign.message_kind,template=draft.template===undefined?{name:campaign.template_name,language:campaign.template_language,params:json(campaign.template_params,[])}:draft.template;
    await c.query('UPDATE broadcast_campaigns SET name=$4,message_kind=$5,message_text=$6,template_name=$7,template_language=$8,template_params=$9,segment=$10,template_body=NULL,template_verified_at=NULL,version=version+1,updated_at=$11 WHERE org_id=$1 AND id=$2 AND version=$3',
      [staff.orgId,id,version,draft.name??campaign.name,kind,draft.messageText??campaign.message_text,template?.name||null,template?.language||null,JSON.stringify(template?.params||[]),draft.segment?JSON.stringify(draft.segment):campaign.segment,time]);
    await audit(c,staff,'updated',id,{version:version+1,fields:Object.keys(input).filter(key=>key!=='expectedVersion')},time);
  },staff);
  return getBroadcast(staff,id,options);
}

/* ---------------------------------------------------------------- preview */
export async function previewBroadcast(staff:Staff,id:string,options:BroadcastOptions={}){
  requireAdmin(staff);uuid(id);
  const nowMs=Date.now(),limit=maxRecipients(environment(options));
  return transaction(staff.orgId,async c=>{
    const campaign=await loadCampaign(c,staff.orgId,id),segment=parseSegment(json(campaign.segment,{})),provider=campaign.provider as BroadcastProvider;
    const counts=await audienceCounts(c,staff.orgId,campaign,{segment},nowMs);
    const sample=async(eligible:boolean)=>{const p=new Params(),sql=audienceSql(p,staff.orgId,campaign,{segment},nowMs);return (await c.query(`SELECT remote_id,market,stage,reason FROM (${sql}) y WHERE ${eligible?"reason=''":"reason<>''"} ORDER BY identity_created_at,identity_id LIMIT 10`,p.values)).rows;};
    return {campaignId:id,version:Number(campaign.version),status:campaign.status,provider,accountId:campaign.account_id,dryRun:true,computedAt:utc(nowMs),...counts,maxRecipients:limit,overLimit:counts.eligible>limit,
      samples:(await sample(true)).map(row=>({recipient:maskRemote(provider,row.remote_id),market:row.market,stage:row.stage})),
      excludedSamples:(await sample(false)).map(row=>({recipient:maskRemote(provider,row.remote_id),market:row.market,stage:row.stage,reason:row.reason}))};
  },staff);
}

/* ---------------------------------------------------------------- CSV dry-run */
/** RFC 4180 style: comma separated, double-quote escaping, CRLF/LF, optional UTF-8 BOM. */
export function parseCsv(text:string,maxRows=IMPORT_ROW_MAX+1):string[][]{
  const rows:string[][]=[];let row:string[]=[],field='',quoted=false,index=text.charCodeAt(0)===0xfeff?1:0;
  const end=()=>{row.push(field);rows.push(row);row=[];field='';if(rows.length>maxRows)throw new ApiError(413,`นำเข้าได้ไม่เกิน ${IMPORT_ROW_MAX} แถวต่อครั้ง`);};
  for(;index<text.length;index++){
    const ch=text[index];
    if(quoted){if(ch==='"'){if(text[index+1]==='"'){field+='"';index++;}else quoted=false;}else field+=ch;}
    else if(ch==='"'){if(field.length)throw new ApiError(400,'รูปแบบ CSV ไม่ถูกต้อง (เครื่องหมายคำพูด)');quoted=true;}
    else if(ch===',')row.push(field),field='';
    else if(ch==='\n'||ch==='\r'){if(ch==='\r'&&text[index+1]==='\n')index++;end();}
    else field+=ch;
  }
  if(quoted)throw new ApiError(400,'รูปแบบ CSV ไม่ถูกต้อง (เครื่องหมายคำพูดไม่ปิด)');
  if(field.length||row.length)end();
  return rows;
}
/** Never infers a country code: local numbers starting with 0 are rejected, not guessed. */
export function normalizeRemote(provider:BroadcastProvider,raw:string):{value?:string;error?:string}{
  const value=String(raw||'').trim();
  if(!value)return {error:'missing_value'};
  if(provider==='line')return remotePattern.line.test(value)?{value}:{error:'invalid_line_id'};
  let digits=value.replace(/[\s\-().]/g,'');
  if(digits.startsWith('+'))digits=digits.slice(1);
  else if(digits.startsWith('00'))digits=digits.slice(2);
  else if(digits.startsWith('0'))return {error:'phone_requires_country_code'};
  return remotePattern.whatsapp.test(digits)?{value:digits}:{error:'invalid_phone'};
}
export async function importBroadcastCsv(staff:Staff,id:string,input:Record<string,unknown>){
  requireAdmin(staff);uuid(id);fields(input,['csv','column','hasHeader']);
  if(typeof input.csv!=='string'||!input.csv.trim()||input.csv.length>1_000_000)throw new ApiError(400,'กรุณาแนบไฟล์ CSV ขนาดไม่เกิน 1 MB');
  const hasHeader=input.hasHeader!==false,table=parseCsv(input.csv);
  const header=hasHeader?(table.shift()||[]).map(cell=>cell.trim().toLowerCase()):[];
  let column=0;
  if(typeof input.column==='string'&&input.column.trim()){
    if(!hasHeader)throw new ApiError(400,'ระบุคอลัมน์เป็นลำดับเมื่อไฟล์ไม่มีหัวตาราง');
    column=header.indexOf(input.column.trim().toLowerCase());if(column<0)throw new ApiError(400,'ไม่พบคอลัมน์ที่เลือกในหัวตาราง');
  }else if(input.column!==undefined&&input.column!==null&&input.column!==''){
    if(typeof input.column!=='number'||!Number.isSafeInteger(input.column)||input.column<1||input.column>200)throw new ApiError(400,'ลำดับคอลัมน์ไม่ถูกต้อง');
    column=input.column-1;
  }
  const importId=randomUUID(),time=utc(Date.now()),nowMs=Date.now();
  return transaction(staff.orgId,async c=>{
    const campaign=await loadCampaign(c,staff.orgId,id),provider=campaign.provider as BroadcastProvider;
    if(campaign.status!=='draft')throw new ApiError(409,'นำเข้ารายชื่อได้เฉพาะแคมเปญฉบับร่าง');
    type Parsed={n:number;value?:string;s:'valid'|'invalid'|'duplicate';e:string};
    const parsed:Parsed[]=[],seen=new Set<string>();
    table.forEach((cells,offset)=>{
      if(!cells.some(cell=>cell.trim()))return;
      const n=offset+(hasHeader?2:1),result=normalizeRemote(provider,cells[column]??'');
      if(!result.value)parsed.push({n,s:'invalid',e:result.error!});
      else if(seen.has(result.value))parsed.push({n,value:result.value,s:'duplicate',e:'duplicate'});
      else {seen.add(result.value);parsed.push({n,value:result.value,s:'valid',e:''});}
    });
    if(!parsed.length)throw new ApiError(400,'ไม่พบแถวข้อมูลในไฟล์');
    if(parsed.length>IMPORT_ROW_MAX)throw new ApiError(413,`นำเข้าได้ไม่เกิน ${IMPORT_ROW_MAX} แถวต่อครั้ง`);
    const valid=[...seen];
    // Match only exact provider/account identities. Imported rows never create an identity or consent.
    const matches=new Map<string,string>((await c.query('SELECT id,remote_id FROM social_identities WHERE org_id=$1 AND provider=$2 AND account_id=$3 AND remote_id IN (SELECT value FROM json_each($4))',[staff.orgId,provider,campaign.account_id,JSON.stringify(valid)])).rows.map(row=>[row.remote_id as string,row.id as string]));
    const reasons=matches.size?await reasonsFor(c,staff.orgId,campaign,[...matches.values()],null,nowMs):new Map<string,Row>();
    const rows=parsed.map(row=>{
      const identity=row.s==='valid'&&row.value?matches.get(row.value):undefined;
      return {n:row.n,h:row.value?hashToken('broadcast-import:'+provider+':'+row.value):'',m:row.value?maskRemote(provider,row.value):'',s:row.s,e:row.e,i:identity||null,r:identity?String(reasons.get(identity)?.reason??'identity_link_changed'):''};
    });
    await c.query("INSERT INTO broadcast_import_rows(id,org_id,import_id,campaign_id,provider,row_number,remote_hash,remote_masked,status,error_code,matched_identity_id,eligibility,created_by,created_at) SELECT lower(hex(randomblob(16))),$1,$2,$3,$4,json_extract(value,'$.n'),json_extract(value,'$.h'),json_extract(value,'$.m'),json_extract(value,'$.s'),json_extract(value,'$.e'),json_extract(value,'$.i'),json_extract(value,'$.r'),$5,$6 FROM json_each($7)",
      [staff.orgId,importId,id,provider,staff.id,time,JSON.stringify(rows)]);
    const invalidReasons:Record<string,number>={},excluded:Record<string,number>={};let matched=0,eligible=0;
    for(const row of rows){if(row.s==='invalid')invalidReasons[row.e]=(invalidReasons[row.e]||0)+1;if(row.i){matched++;if(row.r)excluded[row.r]=(excluded[row.r]||0)+1;else eligible++;}}
    const summary={importId,campaignId:id,dryRun:true as const,recipientsCreated:0,totalRows:rows.length,valid:valid.length,invalid:rows.filter(row=>row.s==='invalid').length,duplicates:rows.filter(row=>row.s==='duplicate').length,invalidReasons,matched,matchedEligible:eligible,unmatched:valid.length-matched,excluded};
    await audit(c,staff,'import_previewed',id,{...summary,invalidReasons,excluded},time);
    return {...summary,samples:rows.slice(0,20).map(row=>({row:row.n,recipient:row.m,status:row.s,error:row.e,match:row.i?(row.r?'excluded':'eligible'):row.s==='valid'?'not_found':'',reason:row.r}))};
  },staff);
}

/* ---------------------------------------------------------------- WhatsApp templates */
async function boundedJson(response:Response,limit:number){
  const reader=response.body?.getReader();if(!reader)throw new ApiError(502,'ผู้ให้บริการตอบกลับว่าง');
  const decoder=new TextDecoder();let text='',size=0;
  try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>limit){await reader.cancel();throw new ApiError(502,'ข้อมูลจากผู้ให้บริการใหญ่เกินกำหนด');}text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}
  finally{reader.releaseLock();}
  try{return JSON.parse(text) as Row;}catch{throw new ApiError(502,'ข้อมูลจากผู้ให้บริการไม่ถูกต้อง');}
}
/** Only the current APPROVED template with static header/footer and exactly numbered body parameters. */
async function verifiedTemplateBody(config:SocialChannelConfig,campaign:Row,transport:typeof fetch=fetch):Promise<string>{
  if(campaign.provider!=='whatsapp'||campaign.message_kind!=='template')throw new ApiError(400,'แคมเปญนี้ไม่ได้ใช้เทมเพลต');
  if(!config.accessToken||!/^\d{5,40}$/.test(config.wabaId||'')||!/^v\d+\.\d+$/.test(config.apiVersion||''))throw new ApiError(503,'บัญชีเทมเพลต WhatsApp ยังไม่ได้ตั้งค่า');
  const params=json(campaign.template_params,[]) as string[];
  const url=`https://graph.facebook.com/${config.apiVersion}/${config.wabaId}/message_templates?name=${encodeURIComponent(campaign.template_name)}&fields=name,status,language,components&limit=100`;
  let response:Response;
  try{response=await transport(url,{method:'GET',headers:{Authorization:'Bearer '+config.accessToken},redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(10_000)});}
  catch{throw new ApiError(503,'ตรวจสอบเทมเพลตกับ WhatsApp ไม่สำเร็จ');}
  // redirect:'manual' and any non-2xx (including 3xx) is a failure; redirects are never followed.
  if(!response.ok){await response.body?.cancel().catch(()=>{});throw new ApiError(503,'ตรวจสอบเทมเพลตกับ WhatsApp ไม่สำเร็จ');}
  const data=await boundedJson(response,256_000),items=Array.isArray(data.data)?data.data as Row[]:[];
  const template=items.find(item=>item?.name===campaign.template_name&&item?.language===campaign.template_language);
  if(!template||template.status!=='APPROVED')throw new ApiError(409,'เทมเพลตนี้ยังไม่ได้รับอนุมัติจาก WhatsApp หรือไม่พบภาษาที่เลือก');
  let body:string|undefined;
  for(const component of Array.isArray(template.components)?template.components as Row[]:[]){
    const type=String(component?.type||'').toUpperCase(),text=typeof component?.text==='string'?component.text as string:undefined;
    if(type==='BODY'&&text!==undefined&&body===undefined)body=text;
    else if((type==='FOOTER'||type==='HEADER'&&component.format==='TEXT')&&text!==undefined&&!text.includes('{{'))continue;
    else throw new ApiError(409,'รองรับเฉพาะเทมเพลตข้อความ (หัวข้อและท้ายข้อความแบบคงที่) เท่านั้น');
  }
  if(body===undefined)throw new ApiError(409,'เทมเพลตไม่มีเนื้อหาข้อความ');
  const placeholders=[...body.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)].map(match=>match[1]),indices=new Set(placeholders.map(Number));
  if(placeholders.some(item=>!/^[1-9]\d*$/.test(item))||indices.size!==params.length||[...indices].some(n=>n>params.length))throw new ApiError(409,`เทมเพลตต้องใช้ตัวแปร ${indices.size} ค่า แต่แคมเปญระบุ ${params.length} ค่า`);
  const rendered=body.replace(/\{\{\s*(\d+)\s*\}\}/g,(_,n)=>params[Number(n)-1]);
  if(!rendered.trim()||rendered.length>4096)throw new ApiError(409,'เนื้อหาเทมเพลตไม่ถูกต้อง');
  return rendered;
}
function templatePayload(campaign:Row):TemplatePayload|null{
  if(campaign.message_kind!=='template')return null;
  const params=json(campaign.template_params,[]) as string[];
  return {name:campaign.template_name,language:campaign.template_language,...(params.length?{components:[{type:'body',parameters:params.map(text=>({type:'text',text}))}]}:{})};
}

/* ---------------------------------------------------------------- outbound integration */
async function stageOutbound(c:Executor,input:{orgId:string;campaign:Row;identity:Row;conversationVersion:number;body:string;approvedBy:string;time:string;metadata:Record<string,unknown>}){
  const messageId=randomUUID(),commandId=randomUUID(),{orgId,identity,time}=input;
  await c.query("INSERT INTO messages(id,org_id,conversation_id,role,content,created_at) VALUES($1,$2,$3,'agent',$4,$5)",[messageId,orgId,identity.conversation_id,input.body,time]);
  await c.query('INSERT INTO social_outbound_commands(id,org_id,identity_id,conversation_id,message_id,provider,account_id,remote_id,body,conversation_version,approved_by,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)',
    [commandId,orgId,identity.identity_id??identity.id,identity.conversation_id,messageId,input.campaign.provider,input.campaign.account_id,identity.remote_id,input.body,input.conversationVersion,input.approvedBy,time]);
  await c.query("INSERT INTO social_message_provenance(org_id,message_id,provider,account_id,remote_id,provider_type,direction,delivery_status,provider_timestamp,metadata) VALUES($1,$2,$3,$4,$5,$6,'out','queued',$7,$8)",
    [orgId,messageId,input.campaign.provider,input.campaign.account_id,identity.remote_id,input.campaign.message_kind==='template'?'template':'text',time,JSON.stringify({...input.metadata,campaignId:input.campaign.id,commandId,approvedBy:input.approvedBy})]);
  return {messageId,commandId};
}
async function broadcastLink(c:Executor,orgId:string,commandId:string){
  const recipient=(await c.query('SELECT * FROM broadcast_recipients WHERE org_id=$1 AND outbound_command_id=$2',[orgId,commandId])).rows[0];
  const test=recipient?undefined:(await c.query('SELECT * FROM broadcast_test_sends WHERE org_id=$1 AND outbound_command_id=$2',[orgId,commandId])).rows[0];
  const row=recipient||test;if(!row)return null;
  const campaign=(await c.query('SELECT * FROM broadcast_campaigns WHERE org_id=$1 AND id=$2',[orgId,row.campaign_id])).rows[0];
  return {kind:recipient?'campaign' as const:'test' as const,row,campaign};
}
/** Template payload for the provider request, read at claim time from the durable campaign. */
export async function broadcastTemplate(c:Executor,orgId:string,commandId:string){
  const link=await broadcastLink(c,orgId,commandId);
  return link?.campaign?templatePayload(link.campaign):null;
}
/**
 * Hook inside the shared outbound guard (claim, pre-send re-check and in-flight monitor).
 * Returns null for non-broadcast commands. A broadcast command replaces the human-claim
 * requirement with: flag on, campaign still sending (or a current test), Admin approver,
 * no suppression or opt-out, LINE follow evidence and no reply since launch.
 */
export async function broadcastCommandGuard(c:Executor,command:Row,config:SocialChannelConfig):Promise<null|{template:TemplatePayload|null}>{
  const link=await broadcastLink(c,command.org_id,command.id);if(!link)return null;
  if(process.env.BROADCAST_ENABLED!=='true')throw new ApiError(503,'Broadcast sending is disabled');
  const {campaign,row}=link;
  if(!campaign||campaign.provider!==command.provider||campaign.account_id!==command.account_id||row.identity_id!==command.identity_id||row.remote_id!==command.remote_id)throw new ApiError(409,'Broadcast linkage changed');
  if(link.kind==='campaign'){
    if(campaign.status!=='sending')throw new ApiError(409,'Broadcast campaign is not sending');
    if(campaign.approved_by!==command.approved_by)throw new ApiError(409,'Broadcast approval changed');
    if((campaign.message_kind==='template'?campaign.template_body:campaign.message_text)!==command.body)throw new ApiError(409,'Broadcast message changed');
    if((await c.query("SELECT 1 FROM social_message_provenance WHERE org_id=$1 AND provider=$2 AND account_id=$3 AND remote_id=$4 AND direction='in' AND removed_at IS NULL AND provider_timestamp>$5 LIMIT 1",[command.org_id,command.provider,command.account_id,command.remote_id,campaign.launched_at||''])).rows.length)throw new ApiError(409,'Recipient replied after the broadcast launched');
  }else{
    if(['cancelled','completed'].includes(campaign.status)||Number(campaign.version)!==Number(row.campaign_version))throw new ApiError(409,'Broadcast test is stale');
    if(!config.testRecipient||command.remote_id!==config.testRecipient)throw new ApiError(409,'Broadcast tests allow only the configured test recipient');
  }
  if((await c.query('SELECT 1 FROM broadcast_suppressions WHERE org_id=$1 AND provider=$2 AND remote_id=$3',[command.org_id,command.provider,command.remote_id])).rows.length)throw new ApiError(409,'Recipient is suppressed');
  if((await c.query('SELECT 1 FROM social_identities i JOIN social_identities o ON o.org_id=i.org_id AND o.lead_id=i.lead_id AND o.provider=i.provider WHERE i.org_id=$1 AND i.id=$2 AND o.opt_out=1 LIMIT 1',[command.org_id,command.identity_id])).rows.length)throw new ApiError(409,'Recipient opted out');
  if(command.provider==='line'){
    const friendship=(await c.query("SELECT event_kind FROM social_events WHERE org_id=$1 AND provider='line' AND account_id=$2 AND remote_id=$3 AND event_kind IN ('follow','unfollow') ORDER BY received_at DESC,event_id DESC LIMIT 1",[command.org_id,command.account_id,command.remote_id])).rows[0];
    if(friendship?.event_kind!=='follow')throw new ApiError(409,'LINE follow evidence required for broadcast');
  }
  const member=(await c.query('SELECT role,active FROM members WHERE org_id=$1 AND id=$2',[command.org_id,command.approved_by])).rows[0];
  if(!member?.active||member.role!=='Admin')throw new ApiError(409,'Broadcast approver is no longer an active Admin');
  return {template:templatePayload(campaign)};
}

/* ---------------------------------------------------------------- test send */
export async function testSendBroadcast(staff:Staff,id:string,input:Record<string,unknown>,options:BroadcastOptions={}){
  requireAdmin(staff);uuid(id);fields(input,['requestId']);
  const requestId=uuid(input.requestId,'รหัสคำขอทดสอบ');assertEnabled(options);
  const initial=await loadCampaign(database,staff.orgId,id),provider=initial.provider as BroadcastProvider;
  if(['cancelled','completed'].includes(initial.status))throw new ApiError(409,'แคมเปญนี้ปิดแล้ว');
  sendable(initial);
  const config=channelConfig(provider,options),recipient=config.testRecipient||'';
  if(!remotePattern[provider].test(recipient))throw new ApiError(409,`ยังไม่ได้กำหนดผู้รับทดสอบของช่องทางนี้ (${provider==='whatsapp'?'WHATSAPP_TEST_RECIPIENT':'LINE_TEST_RECIPIENT'})`);
  await assertChannelGates(database,staff.orgId,initial,config,'test');
  const body=initial.message_kind==='template'?await verifiedTemplateBody(config,initial,options.fetch):String(initial.message_text);
  const nowMs=Date.now(),time=utc(nowMs);
  const prepared=await transaction(staff.orgId,async c=>{
    const existing=(await c.query('SELECT * FROM broadcast_test_sends WHERE org_id=$1 AND request_id=$2',[staff.orgId,requestId])).rows[0];
    if(existing){if(existing.campaign_id!==id)throw new ApiError(409,'รหัสคำขอนี้ถูกใช้แล้ว');return existing.outbound_command_id as string;}
    const campaign=await loadCampaign(c,staff.orgId,id);
    if(Number(campaign.version)!==Number(initial.version))throw new ApiError(409,'แคมเปญถูกแก้ไขระหว่างเตรียมทดสอบ กรุณาลองใหม่');
    await assertChannelGates(c,staff.orgId,campaign,config,'test');
    const identity=(await c.query('SELECT * FROM social_identities WHERE org_id=$1 AND provider=$2 AND account_id=$3 AND remote_id=$4',[staff.orgId,provider,campaign.account_id,recipient])).rows[0];
    if(!identity)throw new ApiError(409,'ผู้รับทดสอบต้องเคยส่งข้อความหรือเพิ่มเพื่อนกับช่องทางนี้ก่อน');
    const reason=(await reasonsFor(c,staff.orgId,campaign,[identity.id],null,nowMs)).get(identity.id)?.reason??'identity_link_changed';
    if(reason)throw new ApiError(409,'ผู้รับทดสอบยังไม่ผ่านเงื่อนไขการส่ง: '+reason);
    const conversation=(await c.query('SELECT version FROM conversations WHERE org_id=$1 AND id=$2',[staff.orgId,identity.conversation_id])).rows[0];
    const staged=await stageOutbound(c,{orgId:staff.orgId,campaign,identity,conversationVersion:Number(conversation.version),body,approvedBy:staff.id,time,metadata:{approval:'broadcast_test',campaignVersion:Number(campaign.version)}});
    await c.query('INSERT INTO broadcast_test_sends(id,org_id,campaign_id,campaign_version,request_id,identity_id,remote_id,outbound_command_id,actor_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[randomUUID(),staff.orgId,id,campaign.version,requestId,identity.id,identity.remote_id,staged.commandId,staff.id,time]);
    await audit(c,staff,'test_sent',id,{campaignVersion:Number(campaign.version),recipient:maskRemote(provider,recipient),commandId:staged.commandId},time);
    return staged.commandId;
  },staff);
  let result:{commandId:string;status:string;error?:string};
  try{result=await dispatchSocialReply(staff.orgId,prepared,{config,fetch:options.fetch});}
  catch(error){
    if(!(error instanceof ApiError))throw error;
    // Rejected before any claim, so no provider attempt exists: retire the test intent instead of leaving it queued.
    await transaction(staff.orgId,async c=>{
      await c.query("UPDATE social_message_provenance SET delivery_status='cancelled' WHERE org_id=$1 AND message_id=(SELECT message_id FROM social_outbound_commands WHERE org_id=$1 AND id=$2 AND status='queued')",[staff.orgId,prepared]);
      await c.query("UPDATE social_outbound_commands SET status='cancelled',error_code='broadcast_test_rejected',updated_at=$3 WHERE org_id=$1 AND id=$2 AND status='queued'",[staff.orgId,prepared,utc(Date.now())]);
    });
    result={commandId:prepared,status:'blocked',error:error.message};
  }
  return {...result,recipient:maskRemote(provider,recipient),passed:passedStatuses.includes(result.status)};
}

/* ---------------------------------------------------------------- launch and control */
export async function launchBroadcast(staff:Staff,id:string,input:Record<string,unknown>,options:BroadcastOptions={}){
  requireAdmin(staff);uuid(id);fields(input,['confirm','expectedVersion','expectedRecipients','scheduledAt']);
  if(input.confirm!==true)throw new ApiError(422,'กรุณายืนยันการส่งบรอดแคสต์อย่างชัดเจน');
  const version=expectedVersion(input.expectedVersion);
  if(typeof input.expectedRecipients!=='number'||!Number.isSafeInteger(input.expectedRecipients)||input.expectedRecipients<1)throw new ApiError(400,'กรุณาดูตัวอย่างกลุ่มผู้รับก่อนยืนยัน');
  const nowMs=Date.now(),time=utc(nowMs);
  let scheduledAt:string|null=null;
  if(input.scheduledAt!==undefined&&input.scheduledAt!==null&&input.scheduledAt!==''){
    const parsed=typeof input.scheduledAt==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(input.scheduledAt)?Date.parse(input.scheduledAt):NaN;
    if(!Number.isFinite(parsed)||parsed<nowMs+60_000||parsed>nowMs+30*86_400_000)throw new ApiError(400,'เวลาส่งต้องอยู่ระหว่าง 1 นาทีถึง 30 วันข้างหน้า');
    scheduledAt=utc(parsed);
  }
  assertEnabled(options);
  const env=environment(options),limit=maxRecipients(env),initial=await loadCampaign(database,staff.orgId,id);
  sendable(initial);
  const config=channelConfig(initial.provider,options);
  await assertChannelGates(database,staff.orgId,initial,config,'live');
  const body=initial.message_kind==='template'?await verifiedTemplateBody(config,initial,options.fetch):String(initial.message_text);
  await transaction(staff.orgId,async c=>{
    const campaign=await loadCampaign(c,staff.orgId,id);
    if(campaign.status!=='draft')throw new ApiError(409,'แคมเปญนี้ยืนยันส่งไปแล้วหรือถูกยกเลิก');
    if(Number(campaign.version)!==version||Number(campaign.version)!==Number(initial.version))throw new ApiError(409,'แคมเปญถูกแก้ไขหลังดูตัวอย่าง กรุณาดูตัวอย่างและยืนยันอีกครั้ง');
    await assertChannelGates(c,staff.orgId,campaign,config,'live');
    // The exact text/template body of this version must have reached the test recipient.
    const tested=(await c.query(`SELECT 1 FROM broadcast_test_sends t JOIN social_outbound_commands o ON o.org_id=t.org_id AND o.id=t.outbound_command_id WHERE t.org_id=$1 AND t.campaign_id=$2 AND t.campaign_version=$3 AND o.body=$4 AND o.status IN ('submitted','sent','delivered','read') LIMIT 1`,[staff.orgId,id,version,body])).rows.length;
    if(!tested)throw new ApiError(409,'ต้องทดสอบส่งข้อความฉบับนี้ถึงผู้รับทดสอบให้สำเร็จก่อนยืนยันส่ง');
    const segment=parseSegment(json(campaign.segment,{})),counts=await audienceCounts(c,staff.orgId,campaign,{segment},nowMs);
    if(counts.eligible!==input.expectedRecipients)throw new ApiError(409,`จำนวนผู้รับเปลี่ยนเป็น ${counts.eligible} ราย (ยืนยันไว้ ${input.expectedRecipients} ราย) กรุณาดูตัวอย่างและยืนยันอีกครั้ง`);
    if(counts.eligible>limit)throw new ApiError(409,`ผู้รับเกินขีดจำกัด ${limit} รายต่อแคมเปญ`);
    const p=new Params(),sql=audienceSql(p,staff.orgId,campaign,{segment},nowMs),org=p.add(staff.orgId),campaignId=p.add(id),at=p.add(time);
    // Same eligibility SQL as the count above; the org revision guard makes both see one state.
    await c.query(`INSERT INTO broadcast_recipients(id,org_id,campaign_id,identity_id,remote_id,lead_id,conversation_id,status,skip_reason,idempotency_key,created_at,updated_at) SELECT lower(hex(randomblob(16))),${org},${campaignId},y.identity_id,y.remote_id,y.lead_id,y.conversation_id,'pending','',${campaignId}||':'||y.identity_id,${at},${at} FROM (${sql}) y WHERE y.reason=''`,p.values);
    const summary={matched:counts.matched,eligible:counts.eligible,excluded:counts.excluded,computedAt:time};
    await c.query('UPDATE broadcast_campaigns SET status=$4,scheduled_at=$5,approved_by=$6,launched_at=$7,launched_count=$8,launch_summary=$9,template_body=$10,template_verified_at=$11,version=version+1,updated_at=$7 WHERE org_id=$1 AND id=$2 AND version=$3',
      [staff.orgId,id,version,scheduledAt?'scheduled':'sending',scheduledAt,staff.id,time,counts.eligible,JSON.stringify(summary),campaign.message_kind==='template'?body:null,campaign.message_kind==='template'?time:null]);
    await audit(c,staff,scheduledAt?'scheduled':'launched',id,{version:version+1,provider:campaign.provider,accountId:campaign.account_id,messageKind:campaign.message_kind,templateName:campaign.template_name||null,recipients:counts.eligible,excluded:counts.excluded,scheduledAt},time);
  },staff);
  return getBroadcast(staff,id,options);
}
async function cancelQueued(c:Executor,orgId:string,id:string,code:string,time:string,includeTests:boolean){
  const scope=`SELECT outbound_command_id FROM broadcast_recipients WHERE org_id=$1 AND campaign_id=$2 AND outbound_command_id IS NOT NULL${includeTests?' UNION ALL SELECT outbound_command_id FROM broadcast_test_sends WHERE org_id=$1 AND campaign_id=$2':''}`;
  await c.query(`UPDATE social_message_provenance SET delivery_status='cancelled' WHERE org_id=$1 AND message_id IN (SELECT message_id FROM social_outbound_commands WHERE org_id=$1 AND status='queued' AND id IN (${scope}))`,[orgId,id]);
  await c.query(`UPDATE social_outbound_commands SET status='cancelled',error_code=$3,updated_at=$4 WHERE org_id=$1 AND status='queued' AND id IN (${scope})`,[orgId,id,code,time]);
}
export async function controlBroadcast(staff:Staff,id:string,action:'pause'|'resume'|'cancel',input:Record<string,unknown>,options:BroadcastOptions={}){
  requireAdmin(staff);uuid(id);fields(input,['expectedVersion','confirm']);
  const version=expectedVersion(input.expectedVersion);
  if(action!=='pause'&&input.confirm!==true)throw new ApiError(422,'กรุณายืนยันคำสั่งอย่างชัดเจน');
  let config:SocialChannelConfig|undefined;
  if(action==='resume'){
    assertEnabled(options);
    const initial=await loadCampaign(database,staff.orgId,id);config=channelConfig(initial.provider,options);
    await assertChannelGates(database,staff.orgId,initial,config,'live');
    if(initial.message_kind==='template'&&await verifiedTemplateBody(config,initial,options.fetch)!==initial.template_body)throw new ApiError(409,'เทมเพลตที่อนุมัติเปลี่ยนไปจากตอนยืนยันส่ง ต้องยกเลิกและสร้างแคมเปญใหม่');
  }
  const time=utc(Date.now());
  await transaction(staff.orgId,async c=>{
    const campaign=await loadCampaign(c,staff.orgId,id);
    if(Number(campaign.version)!==version)throw new ApiError(409,'สถานะแคมเปญเปลี่ยนแล้ว กรุณาโหลดข้อมูลล่าสุด');
    if(action==='pause'){
      if(!['sending','scheduled'].includes(campaign.status))throw new ApiError(409,'หยุดชั่วคราวได้เฉพาะแคมเปญที่กำลังส่งหรือตั้งเวลาไว้');
      await syncRecipients(c,staff.orgId,id,time);
      await cancelQueued(c,staff.orgId,id,'broadcast_paused',time,false);
      // Never-attempted intents return to pending; anything claimed stays receipt-driven.
      await c.query("UPDATE broadcast_recipients SET status='pending',outbound_command_id=NULL,message_id=NULL,queued_at=NULL,updated_at=$3 WHERE org_id=$1 AND campaign_id=$2 AND status='queued' AND EXISTS(SELECT 1 FROM social_outbound_commands o WHERE o.org_id=broadcast_recipients.org_id AND o.id=broadcast_recipients.outbound_command_id AND o.status='cancelled' AND o.error_code='broadcast_paused')",[staff.orgId,id,time]);
      await c.query("UPDATE broadcast_campaigns SET status='paused',runner_lease_id=NULL,runner_lease_until=NULL,version=version+1,updated_at=$3 WHERE org_id=$1 AND id=$2",[staff.orgId,id,time]);
    }else if(action==='resume'){
      if(campaign.status!=='paused')throw new ApiError(409,'ส่งต่อได้เฉพาะแคมเปญที่หยุดชั่วคราว');
      await assertChannelGates(c,staff.orgId,campaign,config!,'live');
      const next=campaign.scheduled_at&&Date.parse(campaign.scheduled_at)>Date.now()?'scheduled':'sending';
      await c.query('UPDATE broadcast_campaigns SET status=$3,approved_by=$4,version=version+1,updated_at=$5 WHERE org_id=$1 AND id=$2',[staff.orgId,id,next,staff.id,time]);
    }else{
      if(['completed','cancelled'].includes(campaign.status))throw new ApiError(409,'แคมเปญนี้ปิดแล้ว');
      await syncRecipients(c,staff.orgId,id,time);
      await cancelQueued(c,staff.orgId,id,'broadcast_cancelled',time,true);
      await c.query("UPDATE broadcast_recipients SET status='skipped',skip_reason='campaign_cancelled',updated_at=$3 WHERE org_id=$1 AND campaign_id=$2 AND (status='pending' OR status='queued' AND EXISTS(SELECT 1 FROM social_outbound_commands o WHERE o.org_id=broadcast_recipients.org_id AND o.id=broadcast_recipients.outbound_command_id AND o.status='cancelled' AND o.error_code='broadcast_cancelled'))",[staff.orgId,id,time]);
      await c.query("UPDATE broadcast_campaigns SET status='cancelled',cancelled_at=$3,runner_lease_id=NULL,runner_lease_until=NULL,version=version+1,updated_at=$3 WHERE org_id=$1 AND id=$2",[staff.orgId,id,time]);
    }
    await audit(c,staff,action==='pause'?'paused':action==='resume'?'resumed':'cancelled',id,{previousStatus:campaign.status,version:version+1},time);
  },staff);
  return getBroadcast(staff,id,options);
}

/* ---------------------------------------------------------------- runner */
/** Recipient state follows its outbound command; unknown is terminal and is never re-enqueued. */
async function syncRecipients(c:Executor,orgId:string,id:string,time:string){
  const command=(statuses:string)=>`EXISTS(SELECT 1 FROM social_outbound_commands o WHERE o.org_id=broadcast_recipients.org_id AND o.id=broadcast_recipients.outbound_command_id AND o.status IN (${statuses}))`;
  await c.query(`UPDATE broadcast_recipients SET status='submitted',updated_at=$3 WHERE org_id=$1 AND campaign_id=$2 AND status='queued' AND ${command("'submitted','sent','delivered','read'")}`,[orgId,id,time]);
  await c.query(`UPDATE broadcast_recipients SET status='failed',updated_at=$3 WHERE org_id=$1 AND campaign_id=$2 AND status IN ('queued','submitted') AND ${command("'failed'")}`,[orgId,id,time]);
  await c.query(`UPDATE broadcast_recipients SET status='unknown',updated_at=$3 WHERE org_id=$1 AND campaign_id=$2 AND status='queued' AND ${command("'unknown'")}`,[orgId,id,time]);
  await c.query(`UPDATE broadcast_recipients SET status='skipped',skip_reason='cancelled_before_send',updated_at=$3 WHERE org_id=$1 AND campaign_id=$2 AND status='queued' AND ${command("'cancelled'")}`,[orgId,id,time]);
}
export async function runBroadcastBatch(staff:Staff,id:string,input:Record<string,unknown>,options:BroadcastOptions={}){
  requireAdmin(staff);uuid(id);fields(input,['limit']);
  const limit=input.limit===undefined?5:input.limit;
  if(typeof limit!=='number'||!Number.isSafeInteger(limit)||limit<1||limit>BROADCAST_BATCH_MAX)throw new ApiError(400,`จำนวนต่อชุดต้องอยู่ระหว่าง 1–${BROADCAST_BATCH_MAX}`);
  assertEnabled(options);
  const env=environment(options),initial=await loadCampaign(database,staff.orgId,id);
  if(!['sending','scheduled'].includes(initial.status))throw new ApiError(409,'แคมเปญนี้ไม่ได้อยู่ในสถานะส่ง');
  const config=channelConfig(initial.provider,options);
  await assertChannelGates(database,staff.orgId,initial,config,'live');
  if(initial.message_kind==='template'&&await verifiedTemplateBody(config,initial,options.fetch)!==initial.template_body)throw new ApiError(409,'เทมเพลตที่อนุมัติเปลี่ยนไปจากตอนยืนยันส่ง กรุณาหยุดชั่วคราว');
  const nowMs=Date.now(),time=utc(nowMs),lease=randomUUID();
  const plan=await transaction(staff.orgId,async c=>{
    const campaign=await loadCampaign(c,staff.orgId,id);
    if(Number(campaign.version)!==Number(initial.version))throw new ApiError(409,'แคมเปญเปลี่ยนระหว่างเตรียมส่ง กรุณาลองใหม่');
    if(campaign.status==='scheduled'&&(!campaign.scheduled_at||Date.parse(campaign.scheduled_at)>nowMs))throw new ApiError(409,'ยังไม่ถึงเวลาส่งที่ตั้งไว้');
    if(campaign.runner_lease_until&&campaign.runner_lease_until>time)throw new ApiError(409,'กำลังส่งชุดก่อนหน้าอยู่ กรุณารอสักครู่');
    await assertChannelGates(c,staff.orgId,campaign,config,'live');
    const approver=(await c.query('SELECT role,active FROM members WHERE org_id=$1 AND id=$2',[staff.orgId,campaign.approved_by])).rows[0];
    if(!approver?.active||approver.role!=='Admin')throw new ApiError(409,'ผู้อนุมัติการส่งไม่มีสิทธิ์แล้ว กรุณาหยุดชั่วคราวแล้วให้ผู้ดูแลระบบยืนยันส่งต่อ');
    await syncRecipients(c,staff.orgId,id,time);
    const used=Number((await c.query('SELECT (SELECT COUNT(*) FROM broadcast_recipients WHERE org_id=$1 AND queued_at>=$2)+(SELECT COUNT(*) FROM broadcast_test_sends WHERE org_id=$1 AND created_at>=$2) AS n',[staff.orgId,bangkokToday(nowMs)])).rows[0].n);
    const budget=Math.max(0,dailyLimit(env)-used);
    // Recovery: intents queued but never claimed (for example a gate closed mid-batch) are dispatched through
    // the full guard again; an expired 'sending' lease is only settled as unknown by the shared dispatcher, never resent.
    const stuck=(await c.query("SELECT r.outbound_command_id AS id FROM broadcast_recipients r JOIN social_outbound_commands o ON o.org_id=r.org_id AND o.id=r.outbound_command_id WHERE r.org_id=$1 AND r.campaign_id=$2 AND r.status='queued' AND (o.status='queued' OR o.status='sending' AND o.lease_expires_at<$4) ORDER BY r.queued_at,r.id LIMIT $3",[staff.orgId,id,limit,time])).rows.map(row=>String(row.id));
    const remaining=Number((await c.query("SELECT COUNT(*) AS n FROM broadcast_recipients WHERE org_id=$1 AND campaign_id=$2 AND status='pending'",[staff.orgId,id])).rows[0].n);
    const take=Math.min(limit-stuck.length,budget);
    if(remaining&&!stuck.length&&take<=0)throw new ApiError(429,'ครบโควตาการส่งบรอดแคสต์ของวันนี้แล้ว');
    const pending=take>0?(await c.query("SELECT * FROM broadcast_recipients WHERE org_id=$1 AND campaign_id=$2 AND status='pending' ORDER BY created_at,id LIMIT $3",[staff.orgId,id,take])).rows:[];
    const checks=pending.length?await reasonsFor(c,staff.orgId,campaign,pending.map(row=>row.identity_id),campaign.launched_at,nowMs):new Map<string,Row>();
    const versions=new Map<string,number>(pending.length?(await c.query('SELECT id,version FROM conversations WHERE org_id=$1 AND id IN (SELECT value FROM json_each($2))',[staff.orgId,JSON.stringify(pending.map(row=>row.conversation_id))])).rows.map(row=>[row.id as string,Number(row.version)]):[]);
    const body=String(campaign.message_kind==='template'?campaign.template_body:campaign.message_text),commandIds=[...stuck],skipped:Record<string,number>={};
    for(const recipient of pending){
      const found=checks.get(recipient.identity_id),version=versions.get(recipient.conversation_id);
      const reason=!found||found.remote_id!==recipient.remote_id||found.lead_id!==recipient.lead_id||found.conversation_id!==recipient.conversation_id||version===undefined?'identity_link_changed':String(found.reason||'');
      if(reason){
        await c.query("UPDATE broadcast_recipients SET status='skipped',skip_reason=$3,updated_at=$4 WHERE org_id=$1 AND id=$2 AND status='pending'",[staff.orgId,recipient.id,reason,time]);
        skipped[reason]=(skipped[reason]||0)+1;continue;
      }
      const staged=await stageOutbound(c,{orgId:staff.orgId,campaign,identity:found!,conversationVersion:version!,body,approvedBy:campaign.approved_by,time,metadata:{approval:'broadcast',recipientId:recipient.id}});
      await c.query("UPDATE broadcast_recipients SET status='queued',outbound_command_id=$3,message_id=$4,queued_at=$5,updated_at=$5 WHERE org_id=$1 AND id=$2 AND status='pending'",[staff.orgId,recipient.id,staged.commandId,staged.messageId,time]);
      commandIds.push(staged.commandId);
    }
    await c.query("UPDATE broadcast_campaigns SET status='sending',runner_lease_id=$3,runner_lease_until=$4,version=version+CASE WHEN status='scheduled' THEN 1 ELSE 0 END,updated_at=$5 WHERE org_id=$1 AND id=$2",[staff.orgId,id,lease,utc(nowMs+120_000),time]);
    return {commandIds,recovered:stuck.length,enqueued:commandIds.length-stuck.length,skipped,budgetRemaining:budget-(commandIds.length-stuck.length)};
  },staff);
  const results:Array<{commandId:string;status:string}>=[];
  try{
    // Sequential: one provider call at a time. Each call re-runs the full shared guard.
    for(const commandId of plan.commandIds){
      if((await database.query('SELECT status FROM broadcast_campaigns WHERE org_id=$1 AND id=$2',[staff.orgId,id])).rows[0]?.status!=='sending')break;
      try{results.push(await dispatchSocialReply(staff.orgId,commandId,{config,fetch:options.fetch}));}
      catch(error){
        if(!(error instanceof ApiError))throw error;
        results.push({commandId,status:error.status===503?'blocked':'guard_rejected'});
        if(error.status===503)break;
      }
    }
  }finally{
    const settled=utc(Date.now());
    await transaction(staff.orgId,async c=>{
      for(const result of results.filter(item=>item.status==='guard_rejected')){
        // Rejected before any claim: no provider attempt exists, so cancelling is exact.
        await c.query("UPDATE social_message_provenance SET delivery_status='cancelled' WHERE org_id=$1 AND message_id=(SELECT message_id FROM social_outbound_commands WHERE org_id=$1 AND id=$2 AND status='queued')",[staff.orgId,result.commandId]);
        await c.query("UPDATE broadcast_recipients SET status='skipped',skip_reason='guard_rejected',updated_at=$3 WHERE org_id=$1 AND outbound_command_id=$2 AND status='queued' AND EXISTS(SELECT 1 FROM social_outbound_commands o WHERE o.org_id=$1 AND o.id=$2 AND o.status='queued')",[staff.orgId,result.commandId,settled]);
        await c.query("UPDATE social_outbound_commands SET status='cancelled',error_code='broadcast_guard_rejected',updated_at=$3 WHERE org_id=$1 AND id=$2 AND status='queued'",[staff.orgId,result.commandId,settled]);
      }
      await syncRecipients(c,staff.orgId,id,settled);
      await c.query('UPDATE broadcast_campaigns SET runner_lease_id=NULL,runner_lease_until=NULL WHERE org_id=$1 AND id=$2 AND runner_lease_id=$3',[staff.orgId,id,lease]);
      await c.query("UPDATE broadcast_campaigns SET status='completed',completed_at=$3,version=version+1,updated_at=$3 WHERE org_id=$1 AND id=$2 AND status='sending' AND NOT EXISTS(SELECT 1 FROM broadcast_recipients WHERE org_id=$1 AND campaign_id=$2 AND status IN ('pending','queued'))",[staff.orgId,id,settled]);
      await c.query("INSERT INTO audit_events(id,org_id,actor_id,action,entity_id,metadata,created_at) SELECT $1,$2,$3,'broadcast.completed',$4,'{}',$5 WHERE EXISTS(SELECT 1 FROM broadcast_campaigns WHERE org_id=$2 AND id=$4 AND status='completed' AND completed_at=$5)",[randomUUID(),staff.orgId,staff.id,id,settled]);
      const outcome:Record<string,number>={};for(const result of results)outcome[result.status]=(outcome[result.status]||0)+1;
      await audit(c,staff,'batch',id,{enqueued:plan.enqueued,recovered:plan.recovered,skipped:plan.skipped,outcome},settled);
    });
  }
  const outcome:Record<string,number>={};for(const result of results)outcome[result.status]=(outcome[result.status]||0)+1;
  return {batch:{enqueued:plan.enqueued,recovered:plan.recovered,skipped:plan.skipped,dispatched:results.length,outcome,budgetRemaining:plan.budgetRemaining},detail:await getBroadcast(staff,id,options)};
}

/* ---------------------------------------------------------------- suppressions */
export async function listBroadcastSuppressions(staff:Staff){
  requireAdmin(staff);
  return transaction(staff.orgId,async c=>{
    const counts=Object.fromEntries((await c.query('SELECT provider,COUNT(*) AS n FROM broadcast_suppressions WHERE org_id=$1 GROUP BY provider',[staff.orgId])).rows.map(row=>[row.provider,Number(row.n)]));
    const recent=(await c.query('SELECT provider,remote_id,reason,created_at FROM broadcast_suppressions WHERE org_id=$1 ORDER BY created_at DESC LIMIT 20',[staff.orgId])).rows;
    return {counts,recent:recent.map(row=>({provider:row.provider,recipient:maskRemote(row.provider,row.remote_id),reason:row.reason,createdAt:row.created_at}))};
  },staff);
}
/** Durable do-not-broadcast entry (for example a request received outside the channel). Never removed here. */
export async function addBroadcastSuppression(staff:Staff,input:Record<string,unknown>){
  requireAdmin(staff);fields(input,['provider','remoteId','reason','confirm']);
  const provider=oneOf(input.provider,providers,'ช่องทาง') as BroadcastProvider,normalized=normalizeRemote(provider,str(input.remoteId,'ผู้รับ',200,true));
  if(!normalized.value)throw new ApiError(400,'รูปแบบผู้รับไม่ถูกต้อง');
  const reason=str(input.reason,'เหตุผล',200,true);if(reason.length<3)throw new ApiError(400,'กรุณาระบุเหตุผล');
  if(input.confirm!==true)throw new ApiError(422,'กรุณายืนยันการระงับการส่ง');
  const time=utc(Date.now());
  await transaction(staff.orgId,async c=>{
    await c.query('INSERT OR IGNORE INTO broadcast_suppressions(org_id,provider,remote_id,reason,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6)',[staff.orgId,provider,normalized.value,reason,staff.id,time]);
    await audit(c,staff,'suppression_added',provider,{provider,recipient:maskRemote(provider,normalized.value!)},time);
  },staff);
  return listBroadcastSuppressions(staff);
}
