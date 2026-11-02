import {createHmac,timingSafeEqual,randomUUID} from 'node:crypto';
import {ApiError,fields,uuid,requireAdmin,type Staff} from './auth';
import {database,transaction,type Row,type Executor} from './db';
import {boundedBytes} from './ai-lifecycle';
import {connectorAudit,connectorToken,hash,loadConnector,providerJson,safeApiUrl,stamp,type ConnectorOptions} from './external-connectors';
import {fetchMarketplacePage} from './external-marketplaces';
const json=(v:any)=>typeof v==='string'?JSON.parse(v):v;
type Resource={kind:'contact'|'deal'|'customer'|'order';id:string;data:Row;updatedAt:string;deleted?:boolean};
const instant=(v:unknown)=>Number.isFinite(Date.parse(String(v)))?new Date(String(v)).toISOString():stamp();
export function safeResource(provider:string,kind:Resource['kind'],raw:Row):Resource{
 let id=String(raw.admin_graphql_api_id||raw.id||'');if(!id||id.length>200)throw new ApiError(422,'resource_id_invalid');if(provider==='shopify'&&/^\d+$/.test(id))id=`gid://shopify/${kind==='order'?'Order':'Customer'}/${id}`;
 const props=provider==='hubspot'?raw.properties||{}:raw;
 const allowed=kind==='order'?['name','email','financial_status','fulfillment_status','displayFinancialStatus','displayFulfillmentStatus','total_price','currency','totalPriceSet','customer']:kind==='deal'?['dealname','amount','dealstage','pipeline','closedate']:['email','phone','first_name','last_name','firstName','lastName','firstname','lastname'];
 const data:Row={};for(const key of allowed)if(props[key]!==undefined&&JSON.stringify(props[key]).length<=10000)data[key]=props[key];
 if(kind==='order'&&data.customer)data.customer={id:String(data.customer.id||'')};
 return {kind,id,data,updatedAt:instant(raw.updatedAt||raw.updated_at||props.hs_lastmodifieddate||props.lastmodifieddate),deleted:!!raw.archived};
}
export async function fetchCommercePage(account:Row,token:string,o:ConnectorOptions={}){
 if(account.provider==='lazada'||account.provider==='tiktokshop')return fetchMarketplacePage(account,token,o);
 const cursor=json(account.cursor),env=o.env||process.env;
 if(account.provider==='hubspot'){
  const kind=cursor.kind==='deals'?'deals':'contacts',url=new URL('https://api.hubspot.com/crm/v3/objects/'+kind);url.searchParams.set('limit','50');url.searchParams.set('properties',kind==='contacts'?'email,firstname,lastname,phone,lastmodifieddate':'dealname,amount,dealstage,pipeline,closedate,hs_lastmodifieddate');if(cursor.after)url.searchParams.set('after',String(cursor.after));
  if(cursor.archived)url.searchParams.set('archived','true');
  const page=await providerJson(safeApiUrl('hubspot',account.account_key,url.href),{headers:{Authorization:'Bearer '+token}},o);if(!Array.isArray(page.results)||page.results.length>100)throw new ApiError(502,'hubspot_page_invalid');const after=page.paging?.next?.after;
  return {resources:page.results.map((raw:Row)=>safeResource('hubspot',kind==='contacts'?'contact':'deal',raw)),cursor:after?{kind,archived:!!cursor.archived,after:String(after)}:!cursor.archived?{kind,archived:true}:kind==='contacts'?{kind:'deals'}:{kind:'contacts'},more:!!after||!cursor.archived||kind==='contacts'};
 }
 const kind=cursor.kind==='customers'?'customers':'orders',version=env.SHOPIFY_API_VERSION||'2026-10';if(!/^20\d{2}-(01|04|07|10)$/.test(version))throw new ApiError(503,'shopify_version_invalid');
 const selection=kind==='orders'?'id name updatedAt displayFinancialStatus displayFulfillmentStatus totalPriceSet { shopMoney { amount currencyCode } } customer { id }':'id firstName lastName email phone updatedAt';
 const body={query:`query ReadPage($after:String) { ${kind}(first:25,after:$after,sortKey:UPDATED_AT) { nodes { ${selection} } pageInfo { hasNextPage endCursor } } }`,variables:{after:cursor.after||null}};
 const page=await providerJson(`https://${account.account_key}/admin/api/${version}/graphql.json`,{method:'POST',headers:{'content-type':'application/json','X-Shopify-Access-Token':token},body:JSON.stringify(body)},o);if(page.errors?.length)throw new ApiError(502,'shopify_graphql_error');const list=page.data?.[kind];if(!Array.isArray(list?.nodes)||list.nodes.length>100)throw new ApiError(502,'shopify_page_invalid');
 return {resources:list.nodes.map((raw:Row)=>safeResource('shopify',kind==='orders'?'order':'customer',raw)),cursor:list.pageInfo.hasNextPage?{kind,after:list.pageInfo.endCursor}:kind==='orders'?{kind:'customers'}:{kind:'orders'},more:list.pageInfo.hasNextPage||kind==='orders'};
}
export async function persistResources(c:Executor,account:Row,resources:Resource[]){
 for(const resource of resources)await c.query('INSERT INTO external_resources(org_id,account_id,kind,remote_id,payload,remote_updated_at,deleted_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(org_id,account_id,kind,remote_id) DO UPDATE SET payload=excluded.payload,remote_updated_at=excluded.remote_updated_at,deleted_at=excluded.deleted_at WHERE excluded.remote_updated_at>=external_resources.remote_updated_at',[account.org_id,account.id,resource.kind,resource.id,JSON.stringify(resource.data),resource.updatedAt,resource.deleted?stamp():null]);
}
export async function shopifyWebhook(accountId:string,request:Request,o:ConnectorOptions={}){
 const env=o.env||process.env;if(env.EXTERNAL_CONNECTORS_ENABLED!=='true')throw new ApiError(503,'connectors_disabled');const account=(await database.query("SELECT * FROM external_accounts WHERE id=$1 AND provider='shopify'",[uuid(accountId)])).rows[0];if(!account)throw new ApiError(404,'shop_not_connected');
 const bytes=await boundedBytes(request.body,1_000_000),signature=request.headers.get('x-shopify-hmac-sha256')||'',expected=createHmac('sha256',env.SHOPIFY_CLIENT_SECRET||'').update(bytes).digest('base64');
 if(!env.SHOPIFY_CLIENT_SECRET||signature.length!==expected.length||!timingSafeEqual(Buffer.from(signature),Buffer.from(expected))||request.headers.get('x-shopify-shop-domain')!==account.account_key)throw new ApiError(403,'shopify_signature_invalid');
 const topic=request.headers.get('x-shopify-topic')||'',eventId=request.headers.get('x-shopify-event-id')||request.headers.get('x-shopify-webhook-id')||'';if(!eventId||eventId.length>200)throw new ApiError(400,'webhook_event_id_required');
 const topics=['orders/create','orders/updated','orders/paid','orders/cancelled','orders/delete','customers/create','customers/update','customers/delete','app/uninstalled','customers/redact','shop/redact','customers/data_request'];if(!topics.includes(topic))throw new ApiError(400,'shopify_topic_unsupported');
 let raw:Row;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new ApiError(400,'invalid_json');}const digest=hash(bytes);
 return transaction(account.org_id,async c=>{const fresh=await loadConnector(account.org_id,account.id,c);if(fresh.revision!==account.revision||(!fresh.enabled&&!['shop/redact','customers/redact','customers/data_request'].includes(topic)))throw new ApiError(409,'shop_connection_changed');const prior=(await c.query('SELECT body_hash FROM external_webhook_receipts WHERE account_id=$1 AND event_id=$2',[account.id,eventId])).rows[0];if(prior){if(prior.body_hash!==digest)throw new ApiError(409,'webhook_replay_mismatch');return {duplicate:true};}
  await c.query('INSERT INTO external_webhook_receipts(account_id,event_id,body_hash,topic,created_at) VALUES($1,$2,$3,$4,$5)',[account.id,eventId,digest,topic,stamp()]);
  if(topic==='customers/redact'){
   const customer=String(raw.customer?.id||'');if(!/^\d+$/.test(customer))throw new ApiError(422,'redaction_customer_invalid');
   await c.query("DELETE FROM external_resources WHERE org_id=$1 AND account_id=$2 AND ((kind='customer' AND remote_id=$3) OR (kind='order' AND (json_extract(payload,'$.customer.id')=$4 OR json_extract(payload,'$.customer.id')=$3)))",[account.org_id,account.id,'gid://shopify/Customer/'+customer,customer]);
  }else if(topic==='shop/redact'){await c.query('DELETE FROM external_resources WHERE org_id=$1 AND account_id=$2',[account.org_id,account.id]);await c.query("UPDATE external_accounts SET enabled=0,send_enabled=0,state='disconnected',credential='',revision=revision+1 WHERE org_id=$1 AND id=$2",[account.org_id,account.id]);}
  else if(topic==='customers/data_request'){await connectorAudit(c,account.org_id,'provider','privacy_export_requested',account.id,{requestId:String(raw.data_request?.id||eventId)});}
  else if(topic==='app/uninstalled')await c.query("UPDATE external_accounts SET enabled=0,send_enabled=0,state='disconnected',credential='',revision=revision+1,updated_at=$3 WHERE org_id=$1 AND id=$2",[account.org_id,account.id,stamp()]);
  else {const resource=safeResource('shopify',topic.startsWith('orders/')?'order':'customer',raw);if(topic.endsWith('/delete')){resource.deleted=true;resource.data={};}await persistResources(c,account,[resource]);await c.query("UPDATE external_accounts SET state='ready',last_sync_at=$3,last_error='' WHERE org_id=$1 AND id=$2",[account.org_id,account.id,stamp()]);}
  await connectorAudit(c,account.org_id,'provider','webhook_received',account.id,{topic});return {duplicate:false};
 });
}
export async function connectorResources(staff:Staff,id:string){requireAdmin(staff);await loadConnector(staff.orgId,id);const resources=(await database.query('SELECT kind,remote_id,payload,remote_updated_at,deleted_at FROM external_resources WHERE org_id=$1 AND account_id=$2 ORDER BY remote_updated_at DESC LIMIT 200',[staff.orgId,id])).rows;return {resources:resources.map(row=>({...row,data:json(row.payload),payload:undefined})),ownership:'ข้อมูลอ้างอิงจากระบบภายนอก ไม่เปลี่ยนยอดเงินหรือสถานะงานขายใน Sale'};}
export async function subscribeShopify(staff:Staff,input:Record<string,unknown>,o:ConnectorOptions={}){
 requireAdmin(staff);fields(input,['id','confirm']);if(input.confirm!==true)throw new ApiError(400,'confirm_webhook_subscription');const account=await loadConnector(staff.orgId,uuid(input.id)),env=o.env||process.env;if(env.EXTERNAL_CONNECTORS_ENABLED!=='true'||account.provider!=='shopify'||!account.enabled)throw new ApiError(409,'shop_not_ready');
 const origin=env.APP_ORIGIN||'',version=env.SHOPIFY_API_VERSION||'2026-10';if(!/^https:\/\/[^/]+$/.test(origin)||!/^20\d{2}-(01|04|07|10)$/.test(version))throw new ApiError(503,'shopify_configuration_invalid');const uri=origin+'/api/connectors/shopify/'+account.id,token=await connectorToken(account,o),url=`https://${account.account_key}/admin/api/${version}/graphql.json`,headers={'content-type':'application/json','X-Shopify-Access-Token':token};
 const topics=['ORDERS_CREATE','ORDERS_UPDATED','ORDERS_PAID','ORDERS_CANCELLED','ORDERS_DELETE','CUSTOMERS_CREATE','CUSTOMERS_UPDATE','CUSTOMERS_DELETE','APP_UNINSTALLED'];
 const existing=await providerJson(url,{method:'POST',headers,body:JSON.stringify({query:'query($uri:String!){webhookSubscriptions(first:100,uri:$uri){nodes{id topic uri} pageInfo{hasNextPage}}}',variables:{uri}})},o);if(existing.errors||existing.data?.webhookSubscriptions?.pageInfo?.hasNextPage)throw new ApiError(409,'subscription_review_required');const found=new Set((existing.data?.webhookSubscriptions?.nodes||[]).filter((n:Row)=>n.uri===uri).map((n:Row)=>n.topic));let created=0;
 for(const topic of topics){if(found.has(topic))continue;await transaction(staff.orgId,async c=>{const fresh=await loadConnector(staff.orgId,account.id,c);if(!fresh.enabled||fresh.revision!==account.revision||fresh.state==='expired')throw new ApiError(409,'subscription_fenced');},staff);const result=await providerJson(url,{method:'POST',headers,body:JSON.stringify({query:'mutation($topic:WebhookSubscriptionTopic!,$input:WebhookSubscriptionInput!){webhookSubscriptionCreate(topic:$topic,webhookSubscription:$input){webhookSubscription{id} userErrors{field message}}}',variables:{topic,input:{uri,format:'JSON'}}})},o);if(result.errors||result.data?.webhookSubscriptionCreate?.userErrors?.length||!result.data?.webhookSubscriptionCreate?.webhookSubscription?.id)throw new ApiError(422,'provider_subscription_rejected');created++;}
 await transaction(staff.orgId,c=>connectorAudit(c,staff.orgId,staff.id,'webhooks_subscribed',account.id,{created,uri}),staff);return {created,callback:uri,readiness:'awaiting_verified_delivery'};
}

