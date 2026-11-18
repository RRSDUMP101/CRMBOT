import {ApiError,fields,str,uuid,requireAdmin,type Staff} from './auth';
import {extractFacts} from './bot';
import {database,transaction,type Executor} from './db';
export const dimensions=['product','model','vehicle','year','cab','market','useCase','country','conversationId'] as const;
export type Applicability=Partial<Record<typeof dimensions[number],string>>;
export function applicability(value:unknown):Applicability{
  if(value===undefined)return {};
  if(!value||typeof value!=='object'||Array.isArray(value))throw new ApiError(400,'ขอบเขตความรู้ไม่ถูกต้อง');
  const obj=value as Record<string,unknown>;
  fields(obj,[...dimensions]);
  const result:Applicability={};
  for(const key of dimensions){
    if(obj[key]===undefined||obj[key]==='')continue;
    result[key]=key==='conversationId'?uuid(obj[key]):str(obj[key],key,180,true).normalize('NFKC').trim();
  }
  return result;
}
export function scopeMatches(scope:Applicability,context:Applicability){
  return dimensions.every(key=>!scope[key]||!!context[key]&&scope[key]!.normalize('NFKC').toLowerCase()===context[key]!.normalize('NFKC').toLowerCase());
}
export async function recordCustomerFacts(c:Executor,orgId:string,conversationId:string,messageId:string,text:string){
  if(process.env.RRS_SALES_KNOWLEDGE_ENABLED!=='true')return;
  const facts=extractFacts(text,{});
  for(const [key,value] of Object.entries(facts)){
    await c.query(`INSERT INTO sales_customer_facts(org_id,conversation_id,fact_key,revision,value,unit,state,source_message_id,created_at)
      SELECT $1,$2,$3,COALESCE((SELECT MAX(revision)+1 FROM sales_customer_facts WHERE org_id=$1 AND conversation_id=$2 AND fact_key=$3),1),
      $4,$5,'customer_reported',$6,m.created_at FROM messages m
      WHERE m.org_id=$1 AND m.conversation_id=$2 AND m.id=$6 AND m.role='user'
      AND NOT EXISTS(SELECT 1 FROM sales_customer_facts WHERE org_id=$1 AND conversation_id=$2 AND source_message_id=$6 AND fact_key=$3)
      ON CONFLICT DO NOTHING`,[orgId,conversationId,key,value,key==='quantity'?'units':null,messageId]);
  }
}
export async function caseFacts(c:Executor,orgId:string,id:string){
 const rows=await c.query(`SELECT f.fact_key,f.value,f.unit,f.revision,f.state,f.source_message_id,f.created_at FROM sales_customer_facts f
 WHERE f.org_id=$1 AND f.conversation_id=$2
 AND NOT EXISTS(SELECT 1 FROM whatsapp_triage t WHERE t.org_id=f.org_id AND t.message_id=f.source_message_id AND (t.eligible=0 OR t.review_state IN ('held','suppressed','pending')))
 AND f.revision=(SELECT MAX(v.revision) FROM sales_customer_facts v
 WHERE v.org_id=f.org_id AND v.conversation_id=f.conversation_id AND v.fact_key=f.fact_key) ORDER BY fact_key`,[orgId,id]);
 return rows.rows;
}
export async function caseContext(c:Executor,orgId:string,conversationId:string):Promise<Applicability>{
 if(process.env.RRS_SALES_KNOWLEDGE_ENABLED!=='true')return {};
 const rows=await caseFacts(c,orgId,conversationId);
 return {...Object.fromEntries(rows.filter(f=>f.state==='confirmed'&&dimensions.some(k=>k===f.fact_key)&&f.fact_key!=='conversationId').map(f=>[f.fact_key,f.value])),conversationId};
}
export async function reviewCaseFact(staff:Staff,input:Record<string,unknown>){
 requireAdmin(staff);
 fields(input,['conversationId','messageId','key','value','unit','state','expectedRevision']);
 const id=uuid(input.conversationId),message=uuid(input.messageId),key=str(input.key,'ฟิลด์',40,true);
 const state=input.state,value=state==='unknown'?null:str(input.value,'ค่า',180,true),unit=str(input.unit,'หน่วย',30);
 if(key==='conversationId'||![...dimensions,'quantity','email','destination','needBy'].some(k=>k===key)||
    !['unknown','confirmed'].includes(String(state))||!Number.isSafeInteger(input.expectedRevision))throw new ApiError(400,'ข้อมูลยืนยันไม่ถูกต้อง');
 await transaction(staff.orgId,async c=>{
   const proof=(await c.query(`SELECT m.id FROM messages m WHERE m.org_id=$1 AND m.conversation_id=$2 AND m.id=$3 AND m.role IN ('user','agent') AND m.status='complete' AND m.source_owner_only=0
     AND NOT EXISTS(SELECT 1 FROM whatsapp_triage t WHERE t.org_id=m.org_id AND t.message_id=m.id AND (t.eligible=0 OR t.review_state IN ('held','suppressed','pending')))`,[staff.orgId,id,message])).rows[0];
   if(!proof)throw new ApiError(409,'ไม่พบข้อความต้นทางที่ใช้ยืนยัน');
   const previous=(await c.query('SELECT MAX(revision) AS revision FROM sales_customer_facts WHERE org_id=$1 AND conversation_id=$2 AND fact_key=$3',[staff.orgId,id,key])).rows[0];
   const revision=Number(previous?.revision||0);
   if(revision!==input.expectedRevision)throw new ApiError(409,'ข้อมูลลูกค้ามีฉบับใหม่');
   await c.query('INSERT INTO sales_customer_facts(org_id,conversation_id,fact_key,revision,value,unit,state,source_message_id,reviewer_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [staff.orgId,id,key,revision+1,value,unit||null,state,message,staff.id,new Date().toISOString()]);
   await c.query('UPDATE conversations SET version=version+1 WHERE org_id=$1 AND id=$2',[staff.orgId,id]);
 },staff);
 return {facts:await caseFacts(database,staff.orgId,id)};
}
