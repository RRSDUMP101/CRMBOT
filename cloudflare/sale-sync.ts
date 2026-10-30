import {signBridgeRequest} from '../src/lib/bridge-protocol';
type Env=Record<string,unknown>;
type Statement={bind(...values:unknown[]):{first<T>():Promise<T|null>}};
type Database={prepare(sql:string):Statement};
/** Highest sequence already accepted by Sale from this isolate. Sale also ignores stale wakes. */
let notified=0;
/**
 * Server-only notifier for the Sale Office background consumer. It never sits on
 * the inbound path: callers use waitUntil, and the minute cron reconciles misses.
 */
export function saleSyncConfig(env:Env){
  if(env.CRM_SALE_SYNC_ENABLED!=='true'||env.CRM_BRIDGE_ENABLED!=='true')return null;
  const secret=env.CRM_BRIDGE_SECRET,orgId=env.CRM_BRIDGE_ORG_ID,target=env.CRM_SALE_SYNC_URL;
  if(typeof secret!=='string'||secret.length<32||typeof orgId!=='string'||!orgId||typeof target!=='string')return null;
  let url:URL;try{url=new URL(target);}catch{return null;}
  if(url.protocol!=='https:'||url.search||url.hash||url.username||url.password||url.pathname!=='/api/rrs/crm/sync'||url.href!==target)return null;
  return {secret,orgId,url:url.href};
}
export async function notifySale(env:Env,reason:'wake'|'reconcile',fetcher:typeof fetch=fetch){
  const config=saleSyncConfig(env);if(!config)return {status:'disabled'} as const;
  let headSequence:number|undefined;
  if(reason==='wake'){
    const row=await (env.DB as Database).prepare('SELECT MAX(sequence) AS head FROM crm_bridge_events WHERE org_id=?').bind(config.orgId).first<{head:number|null}>();
    headSequence=Number(row?.head??0);if(!Number.isSafeInteger(headSequence)||headSequence<=notified)return {status:'unchanged'} as const;
  }
  const body=JSON.stringify(headSequence===undefined?{version:1,reason}:{version:1,reason,headSequence});
  const response=await fetcher(config.url,{method:'POST',headers:await signBridgeRequest(config.url,{secret:config.secret,orgId:config.orgId,method:'POST',body}),body,redirect:'error',signal:AbortSignal.timeout(25000)});
  await response.body?.cancel();
  // A failed wake is not remembered, so the next commit or the cron tries again.
  if(response.ok&&headSequence!==undefined)notified=Math.max(notified,headSequence);
  return {status:response.ok?'sent':'failed',httpStatus:response.status} as const;
}
export function resetSaleSyncForTest(){notified=0;}
