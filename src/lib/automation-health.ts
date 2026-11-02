import {database,type D1Binding} from './db';
import {requireAdmin,type Staff} from './auth';
/** Durable server heartbeat. A successful HTTP wake is separate from the consumer's committed ACK. */
export async function observeAutomation<T>(env:Record<string,unknown>,worker:string,task:()=>Promise<T>):Promise<T>{
 const started=Date.now();let result:T|undefined,status='error';
 try{result=await task();const raw=(result as Record<string,unknown>|undefined)?.status;status=typeof raw==='string'&&/^[a-z_:-]{1,80}$/.test(raw)?raw:'ok';return result;}
 finally{
  const binding=env.DB as D1Binding|undefined,org=env.CRM_BRIDGE_ORG_ID;if(binding&&typeof org==='string'&&org){
   const details:Record<string,number>={durationMs:Date.now()-started};for(const k of ['httpStatus','events','applied','batches','cycles','sequence','acknowledged','campaigns','dispatched','blocked','sent','failed']){const v=(result as Record<string,unknown>|undefined)?.[k];if(typeof v==='number'&&Number.isFinite(v))details[k]=v;}
   const good=['ok','sent','empty','unchanged','accepted'].includes(status);
   await binding.batch([binding.prepare('INSERT INTO crm_automation_health(org_id,worker,last_run_at,last_success_at,status,details) VALUES(?,?,?,?,?,?) ON CONFLICT(org_id,worker) DO UPDATE SET last_run_at=excluded.last_run_at,last_success_at=COALESCE(excluded.last_success_at,crm_automation_health.last_success_at),status=excluded.status,runs=crm_automation_health.runs+1,details=excluded.details').bind(org,worker,Date.now(),good?Date.now():null,status,JSON.stringify(details))]).catch(()=>console.warn('Automation heartbeat persistence failed'));
  }
 }
}
export async function automationHealth(staff:Staff,env:Record<string,unknown>=process.env){
 requireAdmin(staff);const org=staff.orgId;
 const [head,consumers,context,runners,unknown,dead]=await Promise.all([
 database.query('SELECT sequence FROM crm_bridge_state WHERE org_id=$1',[org]),
 database.query('SELECT consumer_id,acknowledged_sequence,updated_at FROM crm_bridge_consumers WHERE org_id=$1',[org]),
 database.query('SELECT last_sequence,acknowledged_sequence,last_success_at,last_error,updated_at FROM crm_sale_context_cursor WHERE org_id=$1',[org]),
 database.query('SELECT worker,last_run_at,last_success_at,status,runs,details FROM crm_automation_health WHERE org_id=$1',[org]),
 database.query("SELECT provider,account_id,status,COUNT(*) AS count FROM social_outbound_commands WHERE org_id=$1 AND status IN ('unknown','sending','failed') GROUP BY provider,account_id,status",[org]),
 database.query("SELECT status,COUNT(*) AS count FROM crm_public_webhook_deliveries WHERE org_id=$1 AND status IN ('dead','pending','sending') GROUP BY status",[org])]);
 const sequence=Number(head.rows[0]?.sequence||0),now=Date.now();
 const flags=Object.fromEntries(['CRM_BRIDGE_ENABLED','CRM_SALE_SYNC_ENABLED','CRM_SALE_CONTEXT_ENABLED','FLOWS_ENABLED','BROADCAST_ENABLED','BROADCAST_RUNNER_ENABLED','EXTERNAL_CONNECTORS_ENABLED','EXTERNAL_CONNECTOR_RUNNER_ENABLED','CRM_PUBLIC_WEBHOOKS_ENABLED','CRM_PUBLIC_WEBHOOK_RUNNER_ENABLED','EMAIL_SEND_ENABLED'].map(k=>[k,env[k]==='true']));
 return {checkedAt:now,flags,crmToSale:{headSequence:sequence,consumers:consumers.rows.map(r=>({...r,pendingEvents:Math.max(0,sequence-Number(r.acknowledged_sequence))}))},saleToCrm:context.rows[0]||null,runners:runners.rows.map(r=>({...r,ageMs:now-Number(r.last_run_at),details:JSON.parse(r.details)})),outboundAttention:unknown.rows,webhookQueue:dead.rows};
}
