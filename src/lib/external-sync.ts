import {randomUUID} from 'node:crypto';
import {database,transaction,withDatabase,type D1Binding} from './db';
import {ApiError,requireAdmin,fields,uuid,type Staff} from './auth';
import {connectorAudit,connectorToken,loadConnector,stamp,ConnectorHttpError,type ConnectorOptions} from './external-connectors';
import {fetchMailPage,persistMailPage,dispatchEmail} from './external-mail';
import {fetchCommercePage,persistResources} from './external-commerce';
import {routeWaitingConversation} from './operators';
export async function syncConnector(org:string,id:string,o:ConnectorOptions={}){
 const env=o.env||process.env;if(env.EXTERNAL_CONNECTORS_ENABLED!=='true')throw new ApiError(503,'connectors_disabled');
 const lease=randomUUID(),account=await transaction(org,async c=>{const row=await loadConnector(org,id,c);if(!row.enabled||['expired','disconnected'].includes(row.state)||row.sync_lease_until>stamp())return null;await c.query('UPDATE external_accounts SET sync_lease=$3,sync_lease_until=$4 WHERE org_id=$1 AND id=$2',[org,id,lease,new Date(Date.now()+360_000).toISOString()]);return row;});
 if(!account)return {status:'not_due'};
 try{const token=await connectorToken(account,o),mail=['gmail','outlook'].includes(account.provider),page=mail?await fetchMailPage(account,token,o):await fetchCommercePage(account,token,o);
  const touched=await transaction(org,async c=>{const fresh=await loadConnector(org,id,c);if(fresh.sync_lease!==lease||fresh.revision!==account.revision||!fresh.enabled)throw new ApiError(409,'sync_superseded');const touched='messages'in page?await persistMailPage(c,account,page.messages):[];if('resources'in page)await persistResources(c,account,page.resources);
   await c.query("UPDATE external_accounts SET cursor=$4,sync_lease='',sync_lease_until='',state='ready',last_sync_at=$5,next_sync_at=$6,last_error='' WHERE org_id=$1 AND id=$2 AND sync_lease=$3",[org,id,lease,JSON.stringify(page.cursor),stamp(),new Date(Date.now()+(page.more?30_000:300_000)).toISOString()]);await connectorAudit(c,org,'system','synced',id,{count:'messages'in page?page.messages.length:page.resources.length});return touched;
  });for(const conversationId of new Set(touched))await routeWaitingConversation(org,conversationId);return {status:'synced',more:page.more};
 }catch(error){const retry=error instanceof ConnectorHttpError?error.retrySeconds:300,code=error instanceof ApiError?error.message:'sync_failed';
  await transaction(org,async c=>{const fresh=await loadConnector(org,id,c);if(fresh.revision!==account.revision||!fresh.enabled){await c.query("UPDATE external_accounts SET sync_lease='',sync_lease_until='' WHERE org_id=$1 AND id=$2 AND sync_lease=$3",[org,id,lease]);return;}const staleHistory=account.provider==='gmail'&&code==='gmail_history_expired';await c.query(`UPDATE external_accounts SET sync_lease='',sync_lease_until='',state=CASE WHEN state='expired' THEN state ELSE 'degraded' END,last_error=$4,next_sync_at=$5${staleHistory?",cursor='{}'":''} WHERE org_id=$1 AND id=$2 AND sync_lease=$3`,[org,id,lease,code.slice(0,100),new Date(Date.now()+retry*1000).toISOString()]);});return {status:'deferred',error:code};
 }
}
export async function runExternalConnectors(db:D1Binding,env:Record<string,string|undefined>=process.env,o:Omit<ConnectorOptions,'env'>&{orgId?:string}={}){
 if(env.EXTERNAL_CONNECTORS_ENABLED!=='true'||env.EXTERNAL_CONNECTOR_RUNNER_ENABLED!=='true')return {status:'disabled',synced:0};
 return withDatabase(db,async()=>{
  // A crashed send has an unknown outcome. Never put it back in the send queue.
  const stalled=(await database.query("SELECT DISTINCT org_id FROM external_send_commands WHERE status='sending' AND attempted_at<$1",[new Date(Date.now()-600_000).toISOString()])).rows;
  for(const row of stalled)await transaction(row.org_id,async c=>{await c.query("UPDATE messages SET status='interrupted' WHERE org_id=$1 AND id IN (SELECT message_id FROM external_send_commands WHERE org_id=$1 AND status='sending' AND attempted_at<$2)",[row.org_id,new Date(Date.now()-600_000).toISOString()]);await c.query("UPDATE external_send_commands SET status='unknown',error_code='worker_interrupted_no_retry' WHERE org_id=$1 AND status='sending' AND attempted_at<$2",[row.org_id,new Date(Date.now()-600_000).toISOString()]);});
  const accounts=(await database.query(`SELECT org_id,id FROM external_accounts WHERE enabled=1 AND provider<>'lazada' AND state NOT IN ('expired','disconnected') AND next_sync_at<=$1 AND sync_lease_until<=$1 ${o.orgId?'AND org_id=$2':''} ORDER BY next_sync_at,id LIMIT 5`,o.orgId?[stamp(),o.orgId]:[stamp()])).rows;let synced=0;
  for(const account of accounts){const result=await syncConnector(account.org_id,account.id,{...o,env});if(result.status==='synced')synced++;}
  if(env.EMAIL_SEND_ENABLED==='true'){const queued=(await database.query(`SELECT org_id,id FROM external_send_commands WHERE status='queued' ${o.orgId?'AND org_id=$1':''} ORDER BY created_at LIMIT 5`,o.orgId?[o.orgId]:[])).rows;for(const command of queued)await dispatchEmail(command.org_id,command.id,{...o,env}).catch(async error=>{if(error instanceof ApiError&&[403,409].includes(error.status))await transaction(command.org_id,async c=>{await c.query("UPDATE messages SET status='interrupted' WHERE org_id=$1 AND id IN (SELECT message_id FROM external_send_commands WHERE org_id=$1 AND id=$2 AND status='queued')",[command.org_id,command.id]);await c.query("UPDATE external_send_commands SET status='cancelled',error_code='approval_fenced' WHERE org_id=$1 AND id=$2 AND status='queued'",[command.org_id,command.id]);});});}
  return {status:'ok',synced};
 });
}
export async function manualSyncConnector(staff:Staff,input:Record<string,unknown>){requireAdmin(staff);fields(input,['id']);return syncConnector(staff.orgId,uuid(input.id));}

