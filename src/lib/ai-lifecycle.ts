import { createHash, randomUUID } from 'node:crypto';
import { ApiError, fields, requireAdmin, str, uuid, type Staff } from './auth';
import { database, transaction, type Executor, type Row } from './db';
import { selectKnowledge, generateReply, providerName, type KnowledgeLite } from './bot';
import { fetchPublicKnowledge, knowledgeFetchOptions, knowledgeUrl } from './knowledge-crawl';

const MAX_TEXT = 100_000, MAX_FILE = 5 * 1024 * 1024;
const at = () => new Date().toISOString();
const parse = (value:unknown) => typeof value === 'string' ? JSON.parse(value) : value;
export async function boundedBytes(body:ReadableStream<Uint8Array>|null,max=MAX_FILE){
  if(!body)throw new ApiError(400,'ไม่มีเนื้อหา');const reader=body.getReader(),parts:Uint8Array[]=[];let size=0;
  try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>max)throw new ApiError(413,'ไฟล์ใหญ่เกินขีดจำกัด');parts.push(next.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return bytes;
}
export async function crawlSource(staff:Staff,input:Record<string,unknown>,fetcher:(url:URL,init:RequestInit)=>Promise<Response>=fetchPublicKnowledge){
  requireAdmin(staff);fields(input,['url','title','scopes','expiresAt']);
  const url=knowledgeUrl(str(input.url,'URL',2000,true));
  // The optional transport is a trusted test seam, never request input. Routes
  // always use the public-network Worker transport, including in local Node.
  const response=await fetcher(url,knowledgeFetchOptions());
  if(!response.ok||response.status>=300){await response.body?.cancel();throw new ApiError(422,'อ่านหน้าเว็บไม่ได้ ไม่ติดตามลิงก์เปลี่ยนเส้นทาง');}
  const type=response.headers.get('content-type')||'';if(!/^(text\/html|text\/plain)/i.test(type)){await response.body?.cancel();throw new ApiError(415,'รองรับหน้าHTMLหรือข้อความเท่านั้น');}
  const bytes=await boundedBytes(response.body,1_000_000);let content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  if(type.startsWith('text/html'))content=content.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/\s+/g,' ').trim();
  return saveSource(staff,{title:input.title,content,scopes:input.scopes,expiresAt:input.expiresAt,sourceType:'website',sourceUrl:url.href});
}
/** Text upload path is explicit; binary extraction adapters validate their own archive limits. */
export async function uploadSource(staff:Staff,request:Request){
  requireAdmin(staff);const filename=decodeURIComponent(request.headers.get('x-file-name')||''),ext=filename.split('.').at(-1)?.toLowerCase();
  if(!ext||!['txt','csv','pdf','docx','xlsx'].includes(ext))throw new ApiError(415,'รองรับTXT CSV PDF DOCX XLSX');
  if(Number(request.headers.get('content-length')||0)>MAX_FILE)throw new ApiError(413,'ไฟล์ต้องไม่เกิน5MB');
  const bytes=await boundedBytes(request.body);if(!bytes.length)throw new ApiError(400,'ไฟล์ว่าง');
  const content=ext==='txt'||ext==='csv'?new TextDecoder('utf-8',{fatal:true}).decode(bytes):await (await import('./knowledge-extract')).extractKnowledge(bytes,ext);
  let allowed:unknown;try{allowed=JSON.parse(request.headers.get('x-source-scopes')||'[]');}catch{throw new ApiError(400,'ช่องทางไม่ถูกต้อง');}
  return saveSource(staff,{title:decodeURIComponent(request.headers.get('x-source-title')||filename),content,scopes:allowed,sourceType:ext});
}
function scope(value:unknown) {
  const s=str(value,'ช่องทาง',220,true);
  if(s!=='web'&&!/^(whatsapp|line|facebook|instagram):[A-Za-z0-9_.:-]{1,180}$/.test(s))throw new ApiError(400,'ช่องทางไม่ถูกต้อง');
  return s;
}
function scopes(value:unknown):string[]{
  if(!Array.isArray(value)||!value.length||value.length>30)throw new ApiError(400,'เลือกช่องทางอย่างน้อยหนึ่งช่องทาง');
  return [...new Set(value.map(scope))];
}
async function assertScopes(c:Executor,orgId:string,values:string[]){
  for(const key of values){
    if(key==='web')continue;
    const [provider,...parts]=key.split(':'),id=parts.join(':');
    const found=(await c.query('SELECT id FROM social_accounts WHERE org_id=$1 AND provider=$2 AND account_id=$3',[orgId,provider,id])).rows;
    if(!found.length)throw new ApiError(400,'ไม่พบบัญชีช่องทางในองค์กร');
  }
}
async function audit(c:Executor,staff:Staff,action:string,id:string){await c.query('INSERT INTO audit_events(id,org_id,actor_id,action,entity_id) VALUES($1,$2,$3,$4,$5)',[randomUUID(),staff.orgId,staff.id,action,id]);}
export async function scopedKnowledge(orgId:string,key:string,c:Executor=database):Promise<KnowledgeLite[]>{
  const rows=(await c.query("SELECT id,title,content,tags,version,source_url FROM knowledge WHERE org_id=$1 AND status='published' AND processing_status='ready' AND reviewed_version=version AND (expires_at IS NULL OR expires_at>$2) AND EXISTS(SELECT 1 FROM json_each(scope_json) WHERE value='*' OR value=$3)",[orgId,at(),key])).rows;
  return rows.map(row=>({id:row.id,title:row.title,content:row.content,tags:parse(row.tags)||[],version:Number(row.version),sourceUrl:row.source_url||undefined}));
}
const fingerprint=(sources:KnowledgeLite[])=>createHash('sha256').update(JSON.stringify([providerName(),process.env.OPENAI_MODEL||'',sources.map(x=>[x.id,x.version]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))])).digest('hex');
export async function aiOverview(staff:Staff){
  const [sources,profiles,evaluations,accounts]=await Promise.all([
    database.query('SELECT id,title,content,version,status,processing_status,scope_json,source_type,source_url,expires_at,reviewed_version,updated_at FROM knowledge WHERE org_id=$1 ORDER BY updated_at DESC',[staff.orgId]),
    database.query('SELECT * FROM ai_profiles WHERE org_id=$1 ORDER BY scope',[staff.orgId]),
    database.query('SELECT id,scope,revision,passed,handoff,error_code,created_at FROM ai_evaluations WHERE org_id=$1 ORDER BY created_at DESC LIMIT 50',[staff.orgId]),
    database.query('SELECT provider,account_id,display_name FROM social_accounts WHERE org_id=$1 ORDER BY provider,display_name',[staff.orgId]),
  ]);
  return {canManage:staff.role==='Admin',enabled:process.env.AI_LIFECYCLE_ENABLED==='true',socialPolicyBridgeEnabled:process.env.CRM_AI_POLICY_BRIDGE_ENABLED==='true',provider:providerName(),formats:['txt','csv','pdf','docx','xlsx'],maxFileBytes:MAX_FILE,maxCharacters:MAX_TEXT,sources:sources.rows.map(x=>({...x,scopes:parse(x.scope_json)})),profiles:profiles.rows.map(x=>({...x,scenarios:parse(x.scenarios)})),evaluations:evaluations.rows,scopes:[{key:'web',label:'Website / Widget'},...accounts.rows.map(x=>({key:x.provider+':'+x.account_id,label:x.display_name||x.provider}))]};
}
export async function saveSource(staff:Staff,input:Record<string,unknown>){
  requireAdmin(staff);fields(input,['id','expectedVersion','title','content','scopes','expiresAt','sourceType','sourceUrl']);
  const id=input.id?uuid(input.id):randomUUID(),title=str(input.title,'หัวข้อ',200,true),content=str(input.content,'เนื้อหา',MAX_TEXT,true),allowed=scopes(input.scopes);
  if(input.expiresAt&&!Number.isFinite(Date.parse(String(input.expiresAt))))throw new ApiError(400,'วันหมดอายุไม่ถูกต้อง');
  const expires=input.expiresAt?new Date(String(input.expiresAt)).toISOString():null;
  if(expires&&Date.parse(expires)<=Date.now())throw new ApiError(400,'วันหมดอายุต้องอยู่ในอนาคต');
  const sourceType=str(input.sourceType||'manual','ประเภท',20,true),url=str(input.sourceUrl,'แหล่งข้อมูล',2000);
  if(!['manual','txt','csv','pdf','docx','xlsx','website'].includes(sourceType))throw new ApiError(400,'ประเภทแหล่งข้อมูลไม่ถูกต้อง');
  await transaction(staff.orgId,async c=>{
    await assertScopes(c,staff.orgId,allowed);
    const old=(await c.query('SELECT version FROM knowledge WHERE org_id=$1 AND id=$2',[staff.orgId,id])).rows[0];
    if(input.id&&(!old||old.version!==input.expectedVersion))throw new ApiError(409,'แหล่งข้อมูลเปลี่ยนแล้ว กรุณาโหลดใหม่');
    const version=Number(old?.version||0)+1,stamp=at();
    if(old)await c.query("UPDATE knowledge SET title=$3,content=$4,scope_json=$5,source_type=$6,source_url=$7,expires_at=$8,version=$9,status='draft',processing_status='ready',reviewed_version=NULL,reviewed_by=NULL,reviewed_at=NULL,error=NULL,updated_at=$10 WHERE org_id=$1 AND id=$2",[staff.orgId,id,title,content,JSON.stringify(allowed),sourceType,url,expires,version,stamp]);
    else await c.query("INSERT INTO knowledge(id,org_id,title,content,scope_json,source_type,source_url,expires_at,version,status,processing_status,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft','ready',$10)",[id,staff.orgId,title,content,JSON.stringify(allowed),sourceType,url,expires,version,stamp]);
    await c.query('INSERT INTO knowledge_versions(org_id,source_id,version,title,content,scope_json,source_url,source_type,expires_at,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[staff.orgId,id,version,title,content,JSON.stringify(allowed),url,sourceType,expires,staff.id,stamp]);
    await audit(c,staff,'ai.source.draft',id);
  },staff);
  return {id,...await aiOverview(staff)};
}
export async function reviewSource(staff:Staff,input:Record<string,unknown>){
  requireAdmin(staff);fields(input,['id','expectedVersion','action','confirm']);const id=uuid(input.id);
  if(!['approve','archive'].includes(String(input.action))||input.confirm!==true)throw new ApiError(400,'ยืนยันการตรวจแหล่งข้อมูล');
  await transaction(staff.orgId,async c=>{
    const source=(await c.query('SELECT * FROM knowledge WHERE org_id=$1 AND id=$2',[staff.orgId,id])).rows[0];
    if(!source||source.version!==input.expectedVersion)throw new ApiError(409,'แหล่งข้อมูลเปลี่ยนแล้ว กรุณาโหลดใหม่');
    if(input.action==='approve'&&(source.processing_status!=='ready'||source.expires_at&&Date.parse(source.expires_at)<=Date.now()))throw new ApiError(409,'แหล่งข้อมูลยังไม่พร้อมหรือหมดอายุ');
    await c.query('UPDATE knowledge SET status=$3,reviewed_version=$4,reviewed_by=$5,reviewed_at=$6,updated_at=$6 WHERE org_id=$1 AND id=$2',[staff.orgId,id,input.action==='approve'?'published':'draft',input.action==='approve'?source.version:null,staff.id,at()]);
    await audit(c,staff,'ai.source.'+input.action,id);
  },staff);return aiOverview(staff);
}
export async function deleteSource(staff:Staff,input:Record<string,unknown>){
 requireAdmin(staff);fields(input,['id','expectedVersion','confirm']);const id=uuid(input.id);if(input.confirm!==true)throw new ApiError(400,'ยืนยันลบแหล่งข้อมูลและประวัติรุ่น');
 await transaction(staff.orgId,async c=>{
  const source=(await c.query('SELECT version FROM knowledge WHERE org_id=$1 AND id=$2',[staff.orgId,id])).rows[0];if(!source||source.version!==input.expectedVersion)throw new ApiError(409,'แหล่งข้อมูลเปลี่ยนแล้ว');
  await c.query("UPDATE ai_profiles SET status='draft',active_evaluation_id=NULL,source_fingerprint='' WHERE org_id=$1 AND active_evaluation_id IN (SELECT e.id FROM ai_evaluations e,json_each(e.citations) item WHERE e.org_id=$1 AND json_extract(item.value,'$.id')=$2)",[staff.orgId,id]);
  await c.query("DELETE FROM ai_evaluations WHERE org_id=$1 AND EXISTS(SELECT 1 FROM json_each(citations) WHERE json_extract(value,'$.id')=$2)",[staff.orgId,id]);
  await c.query("UPDATE messages SET sources=(SELECT json_group_array(json(CASE WHEN json_extract(value,'$.id')=$2 THEN json_remove(value,'$.content') ELSE value END)) FROM json_each(messages.sources)) WHERE org_id=$1 AND EXISTS(SELECT 1 FROM json_each(sources) WHERE json_extract(value,'$.id')=$2)",[staff.orgId,id]);
  await c.query('DELETE FROM knowledge_versions WHERE org_id=$1 AND source_id=$2',[staff.orgId,id]);await c.query('DELETE FROM knowledge WHERE org_id=$1 AND id=$2',[staff.orgId,id]);await audit(c,staff,'ai.source.deleted',id);
 },staff);return aiOverview(staff);
}
export async function aiAnalysis(staff:Staff){
 const since=new Date(Date.now()-30*86400_000).toISOString();
 const totals=(await database.query("SELECT COUNT(*) AS responses,SUM(status='complete') AS complete,SUM(status='interrupted') AS interrupted,SUM(status='failed') AS failed,SUM(input_tokens) AS input_tokens,SUM(output_tokens) AS output_tokens,SUM(estimated_cost_usd) AS provider_cost_usd,COUNT(estimated_cost_usd) AS cost_samples FROM messages WHERE org_id=$1 AND role='assistant' AND created_at>=$2",[staff.orgId,since])).rows[0];
 const handoffs=(await database.query("SELECT COUNT(*) AS total FROM audit_events WHERE org_id=$1 AND created_at>=$2 AND action IN ('ai.lifecycle.handoff','ai.daily_cap.handoff','ai.disabled.handoff')",[staff.orgId,since])).rows[0];
 return {since,until:at(),timezone:'UTC',totals,handoffs:Number(handoffs.total),definitions:{responses:'ข้อความ AI ที่บันทึกใน 30 วันที่ผ่านมา ไม่รวมข้อความจากพนักงานและข้อความทดสอบ',cost:'ค่าใช้จ่ายประมาณการจาก usage ที่ผู้ให้บริการรายงาน ค่า null หมายถึงไม่มีข้อมูล',handoff:'จำนวนเหตุการณ์ส่งต่อจากนโยบาย AI ไม่ใช่จำนวนลูกค้าที่ไม่ซ้ำ',quality:'ผลทดสอบ sandbox ตรวจตามสถานการณ์ที่ตั้งไว้ ไม่ใช่คะแนนความพึงพอใจของลูกค้า',roi:'ประมาณการเท่านั้น: คำตอบที่สำเร็จ × นาทีที่คาดว่าจะประหยัด ÷ 60 × ต้นทุนต่อชั่วโมง − ต้นทุน AI ที่ทราบ ยังไม่ยืนยันเวลาที่ประหยัดจริง'}};
}
type Scenario={name:string;keywords:string[];handoff:boolean};
function scenarios(value:unknown):Scenario[]{
  if(!Array.isArray(value)||value.length>20)throw new ApiError(400,'กำหนดสถานการณ์ไม่เกิน20รายการ');
  return value.map(raw=>{if(!raw||typeof raw!=='object')throw new ApiError(400,'สถานการณ์ไม่ถูกต้อง');fields(raw,['name','keywords','handoff']);if(!Array.isArray(raw.keywords)||!raw.keywords.length||raw.keywords.length>20||raw.handoff!==true)throw new ApiError(400,'สถานการณ์ต้องมีคำสำคัญและส่งต่อเจ้าหน้าที่');return {name:str(raw.name,'ชื่อ',100,true),keywords:raw.keywords.map((x:unknown)=>str(x,'คำสำคัญ',100,true)),handoff:true};});
}
export async function saveAiProfile(staff:Staff,input:Record<string,unknown>){
  requireAdmin(staff);fields(input,['scope','expectedRevision','personality','scenarios']);const key=scope(input.scope),personality=str(input.personality,'บุคลิก',1500,true),rules=scenarios(input.scenarios||[]);
  await transaction(staff.orgId,async c=>{await assertScopes(c,staff.orgId,[key]);const old=(await c.query('SELECT revision FROM ai_profiles WHERE org_id=$1 AND scope=$2',[staff.orgId,key])).rows[0];if(old&&old.revision!==input.expectedRevision)throw new ApiError(409,'บุคลิกถูกแก้แล้ว กรุณาโหลดใหม่');await c.query("INSERT INTO ai_profiles(org_id,scope,personality,scenarios,updated_by,updated_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(org_id,scope) DO UPDATE SET personality=excluded.personality,scenarios=excluded.scenarios,revision=ai_profiles.revision+1,status='draft',active_evaluation_id=NULL,source_fingerprint='',updated_by=excluded.updated_by,updated_at=excluded.updated_at",[staff.orgId,key,personality,JSON.stringify(rules),staff.id,at()]);await audit(c,staff,'ai.profile.draft',key);},staff);return aiOverview(staff);
}
export async function aiRuntimeContext(orgId:string,key:string,text:string,c:Executor=database){
  const profile=(await c.query('SELECT * FROM ai_profiles WHERE org_id=$1 AND scope=$2',[orgId,key])).rows[0];
  const sources=await scopedKnowledge(orgId,key,c),hash=fingerprint(sources);
  const rule=profile&&scenarios(parse(profile.scenarios)).find(x=>x.keywords.some(k=>text.toLowerCase().includes(k.toLowerCase())));
  const active=profile?.status==='active'&&profile.source_fingerprint===hash;
  return {active:!!active,handoff:!!rule||!active||!sources.length,personality:String(profile?.personality||''),sources,fingerprint:hash,reason:rule?'scenario_handoff':!active?'not_activated':!sources.length?'no_approved_sources':''};
}
export async function evaluateAi(staff:Staff,input:Record<string,unknown>){
  requireAdmin(staff);fields(input,['scope','prompt','expectedHandoff']);const key=scope(input.scope),prompt=str(input.prompt,'คำถามทดสอบ',2000,true);
  if(typeof input.expectedHandoff!=='boolean')throw new ApiError(400,'ระบุผลส่งต่อที่คาดหวัง');
  const profile=(await database.query('SELECT * FROM ai_profiles WHERE org_id=$1 AND scope=$2',[staff.orgId,key])).rows[0];if(!profile)throw new ApiError(409,'บันทึกบุคลิกก่อนทดสอบ');
  const all=await scopedKnowledge(staff.orgId,key),hash=fingerprint(all),selected=selectKnowledge(prompt,all),rule=scenarios(parse(profile.scenarios)).find(x=>x.keywords.some(k=>prompt.toLowerCase().includes(k.toLowerCase())));
  const handoff=!!rule||!selected.length;let answer='',error='';
  if(handoff)answer='ส่งต่อเจ้าหน้าที่เพื่อยืนยันข้อมูล';
  else if(providerName()==='disabled')error='ai_provider_disabled';
  else try{for await(const chunk of generateReply({history:[{role:'user',content:prompt}],facts:{},knowledge:selected,settings:{botName:'RRS',personality:profile.personality,businessHours:'',handoffRule:'ส่งต่อให้ผู้มีสิทธิ์อนุมัติราคา ส่วนลด การชำระเงิน และวันส่งมอบ',aiEnabled:true},signal:AbortSignal.timeout(15000)})){if(chunk.text)answer+=chunk.text;if(answer.length>10000)throw new Error('too_long');}}catch{error='evaluation_failed';}
  const passed=!error&&!!answer&&handoff===input.expectedHandoff,id=randomUUID(),citations=selected.map(x=>({id:x.id,version:x.version,title:x.title}));
  await transaction(staff.orgId,async c=>{const fresh=(await c.query('SELECT revision FROM ai_profiles WHERE org_id=$1 AND scope=$2',[staff.orgId,key])).rows[0];if(fresh?.revision!==profile.revision||fingerprint(await scopedKnowledge(staff.orgId,key,c))!==hash)throw new ApiError(409,'ข้อมูลเปลี่ยนระหว่างทดสอบ กรุณาทดสอบอีกครั้ง');await c.query('INSERT INTO ai_evaluations(id,org_id,scope,revision,source_fingerprint,prompt,answer,citations,handoff,passed,error_code,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',[id,staff.orgId,key,profile.revision,hash,prompt,answer,JSON.stringify(citations),handoff,passed,error,staff.id,at()]);await audit(c,staff,'ai.evaluation',id);},staff);
  return {id,answer,citations,handoff,passed,error,mode:'sandbox',provider:providerName()};
}
export async function activateAi(staff:Staff,input:Record<string,unknown>){
  requireAdmin(staff);fields(input,['scope','evaluationId','expectedRevision','action','confirm']);const key=scope(input.scope);if(input.confirm!==true||!['activate','pause'].includes(String(input.action)))throw new ApiError(400,'ยืนยันสถานะ AI');
  await transaction(staff.orgId,async c=>{const profile=(await c.query('SELECT * FROM ai_profiles WHERE org_id=$1 AND scope=$2',[staff.orgId,key])).rows[0];if(!profile||profile.revision!==input.expectedRevision)throw new ApiError(409,'บุคลิกเปลี่ยนแล้ว');let hash='';if(input.action==='activate'){const evaluation=(await c.query('SELECT * FROM ai_evaluations WHERE org_id=$1 AND id=$2 AND scope=$3',[staff.orgId,uuid(input.evaluationId),key])).rows[0];hash=fingerprint(await scopedKnowledge(staff.orgId,key,c));if(!evaluation?.passed||evaluation.revision!==profile.revision||evaluation.source_fingerprint!==hash||Date.now()-Date.parse(evaluation.created_at)>24*3600_000)throw new ApiError(409,'ต้องทดสอบฉบับปัจจุบันให้ผ่านภายใน24ชั่วโมง');}await c.query('UPDATE ai_profiles SET status=$3,source_fingerprint=$4,active_evaluation_id=$5,updated_by=$6,updated_at=$7 WHERE org_id=$1 AND scope=$2',[staff.orgId,key,input.action==='activate'?'active':'paused',hash,input.action==='activate'?input.evaluationId:null,staff.id,at()]);await audit(c,staff,'ai.profile.'+input.action,key);},staff);return aiOverview(staff);
}

