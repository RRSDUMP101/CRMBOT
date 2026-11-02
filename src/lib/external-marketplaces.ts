import {createHmac} from 'node:crypto';
import {ApiError} from './auth';
import type {Row} from './db';
import {providerJson,type ConnectorOptions} from './external-connectors';
export type Marketplace='lazada'|'tiktokshop';
const countries:Record<string,string>={th:'api.lazada.co.th',sg:'api.lazada.sg',my:'api.lazada.com.my',vn:'api.lazada.vn',ph:'api.lazada.com.ph',id:'api.lazada.co.id'};
const fail=(code:string)=>new ApiError(422,code);
export function marketplaceSelection(p:Marketplace,value:unknown){const selected=String(value||'').trim().toLowerCase();if(p==='lazada'){if(!countries[selected])throw fail('choose_lazada_country');}else if(selected&&!/^\d{1,30}$/.test(selected))throw fail('tiktok_shop_id_invalid');return selected;}
export function marketplaceApp(p:Marketplace,o:ConnectorOptions={}){const env=o.env||process.env,key=env[p.toUpperCase()+'_CLIENT_ID'],secret=env[p.toUpperCase()+'_CLIENT_SECRET'];if(!key||!secret)throw new ApiError(503,'connector_app_not_configured');return {key,secret};}
export function tiktokAuthorization(env:Record<string,string|undefined>){
 let url:URL;try{url=new URL(env.TIKTOKSHOP_AUTHORIZATION_URL||'');}catch{throw new ApiError(503,'tiktok_authorization_url_required');}
 if(url.protocol!=='https:'||!/^services(?:\.[a-z]{2})?\.tiktokshop\.com$/.test(url.hostname)||url.pathname!=='/open/authorize'||url.username||url.password||url.port||url.hash||!url.searchParams.get('service_id')||[...url.searchParams.keys()].some(k=>k!=='service_id'))throw new ApiError(503,'tiktok_authorization_url_invalid');return url.href;
}
/** Lazada's documented HMAC fixture is covered in tests. Never sign an arbitrary remote URL. */
export function lazadaSignature(path:string,params:Record<string,string>,secret:string){return createHmac('sha256',secret).update(path+Object.keys(params).filter(k=>k!=='sign').sort().map(k=>k+params[k]).join('')).digest('hex').toUpperCase();}
export function tiktokSignature(path:string,params:Record<string,string>,body:string,secret:string){const base=path+Object.keys(params).filter(k=>k!=='sign'&&k!=='access_token').sort().map(k=>k+params[k]).join('')+body;return createHmac('sha256',secret).update(secret+base+secret).digest('hex');}
async function lazadaRequest(path:string,params:Record<string,string>,country:string,o:ConnectorOptions={}){
 const app=marketplaceApp('lazada',o),all={...params,app_key:app.key,timestamp:String(Date.now()),sign_method:'sha256'},host=path.startsWith('/auth/')?'auth.lazada.com':countries[country];if(!host)throw fail('lazada_country_invalid');
 const url=new URL('https://'+host+'/rest'+path);for(const [key,value]of Object.entries({...all,sign:lazadaSignature(path,all,app.secret)}))url.searchParams.set(key,value);const result=await providerJson(url.href,{},o);if(String(result.code)!=='0')throw new ApiError(502,'lazada_api_rejected');return result;
}
async function tiktokRequest(path:string,params:Record<string,string>,token:string,body:Row|undefined,o:ConnectorOptions={}){
 const app=marketplaceApp('tiktokshop',o),raw=body===undefined?'':JSON.stringify(body),all={...params,app_key:app.key,timestamp:String(Math.floor(Date.now()/1000))},url=new URL('https://open-api.tiktokglobalshop.com'+path);for(const [key,value]of Object.entries({...all,sign:tiktokSignature(path,all,raw,app.secret)}))url.searchParams.set(key,value);
 const result=await providerJson(url.href,{method:body===undefined?'GET':'POST',headers:{'x-tts-access-token':token,'content-type':'application/json'},...(body===undefined?{}:{body:raw})},o);if(result.code!==0||!result.data)throw new ApiError(502,'tiktok_api_rejected');return result.data as Row;
}
const seconds=(value:unknown)=>{const n=Number(value);if(!Number.isFinite(n)||n<=60||n>3*366*86400)throw fail('marketplace_expiry_invalid');return n;};
function tiktokScopes(raw:unknown){if(!Array.isArray(raw)||!raw.every(s=>typeof s==='string'))throw fail('tiktok_granted_scopes_missing');const combined=raw.includes('seller.fs.order&fufillment.management');if(!combined&&(!raw.includes('seller.order.info')||!raw.includes('seller.authorization.info')))throw fail('tiktok_required_scope_missing');return raw as string[];}
async function tiktokShop(access:string,selection:string,o:ConnectorOptions){const page=await tiktokRequest('/authorization/202309/shops',{},access,undefined,o);if(!Array.isArray(page.shops)||page.shops.length>100)throw fail('tiktok_shops_invalid');const shop=selection?page.shops.find((s:Row)=>String(s.id)===selection):page.shops.length===1?page.shops[0]:null;if(!shop||!/^\d{1,30}$/.test(String(shop.id))||typeof shop.cipher!=='string'||!shop.cipher)throw fail('choose_authorized_tiktok_shop_id');return shop as Row;}
async function tiktokToken(code:string,refresh:boolean,o:ConnectorOptions){const app=marketplaceApp('tiktokshop',o),url=new URL('https://auth.tiktok-shops.com/api/v2/token/'+(refresh?'refresh':'get'));url.search=new URLSearchParams({app_key:app.key,app_secret:app.secret,...(refresh?{refresh_token:code,grant_type:'refresh_token'}:{auth_code:code,grant_type:'authorized_code'})}).toString();const response=await providerJson(url.href,{},o),data=response.data;if(response.code!==0||!data||data.user_type!==0||!data.open_id||typeof data.access_token!=='string'||typeof data.refresh_token!=='string')throw fail('tiktok_seller_token_invalid');
 const now=Math.floor(Date.now()/1000);return {...data,expires_in:seconds(Number(data.access_token_expire_in)-now),refresh_token_expires_in:seconds(Number(data.refresh_token_expire_in)-now),market_scopes:tiktokScopes(data.granted_scopes),subject:String(data.open_id)};
}
export async function marketplaceGrant(p:Marketplace,selection:string,code:string,o:ConnectorOptions={}){
 if(p==='tiktokshop'){const token=await tiktokToken(code,false,o),shop=await tiktokShop(token.access_token,selection,o);return {key:String(shop.id),display:String(shop.name||shop.id),granted:token.market_scopes,token};}
 const token=await lazadaRequest('/auth/token/create',{code},selection,o),seller=Array.isArray(token.country_user_info)?token.country_user_info.find((s:Row)=>s.country===selection):null;if(!seller?.seller_id||!token.access_token||!token.refresh_token)throw fail('lazada_seller_identity_missing');
 if(token.country_user_info.length!==1)throw fail('lazada_cross_border_shared_grant_not_supported');
 return {key:selection+':'+String(seller.seller_id),display:String(token.account||seller.seller_id)+' ('+selection.toUpperCase()+')',granted:[] as string[],token:{...token,expires_in:seconds(token.expires_in),refresh_token_expires_in:seconds(token.refresh_expires_in),subject:selection+':'+String(seller.seller_id)}};
}
export async function refreshMarketplace(p:Marketplace,key:string,current:Row,o:ConnectorOptions={}){
 if(p==='tiktokshop'){const token=await tiktokToken(current.refresh,true,o);if(token.subject!==current.subject)throw fail('tiktok_identity_changed');await tiktokShop(token.access_token,key,o);return token;}
 const [country,sellerId]=key.split(':'),token=await lazadaRequest('/auth/token/refresh',{refresh_token:current.refresh},country,o);if(!Array.isArray(token.country_user_info)||token.country_user_info.length!==1||!token.country_user_info.some((s:Row)=>s.country===country&&String(s.seller_id)===sellerId)||!token.access_token||!token.refresh_token)throw fail('lazada_identity_changed');return {...token,expires_in:seconds(token.expires_in),refresh_token_expires_in:seconds(token.refresh_expires_in),subject:key};
}
export async function fetchMarketplacePage(account:Row,token:string,o:ConnectorOptions={}){
 const cursor=typeof account.cursor==='string'?JSON.parse(account.cursor):account.cursor,now=Math.floor(Date.now()/1000);
 if(account.provider==='tiktokshop'){
  tiktokScopes(typeof account.scopes==='string'?JSON.parse(account.scopes):account.scopes);const shop=await tiktokShop(token,account.account_key,o),start=Number(cursor.start||cursor.watermark||now-30*86400),end=Number(cursor.end||now-30);if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||end<=start)throw fail('marketplace_cursor_invalid');
  const page=await tiktokRequest('/order/202309/orders/search',{shop_cipher:shop.cipher,page_size:'50',sort_field:'update_time',sort_order:'ASC',...(cursor.page?{page_token:String(cursor.page)}:{})},token,{update_time_ge:start,update_time_lt:end},o);if(!Array.isArray(page.orders)||page.orders.length>100)throw fail('tiktok_orders_invalid');
  const resources=page.orders.map((raw:Row)=>{if(!raw.id||!Number.isSafeInteger(raw.update_time))throw fail('tiktok_order_invalid');return {kind:'order' as const,id:String(raw.id),updatedAt:new Date(raw.update_time*1000).toISOString(),data:{status:String(raw.status||''),currency:String(raw.payment?.currency||''),sub_total:String(raw.payment?.sub_total||'')}};});
  return {resources,cursor:page.next_page_token?{start,end,page:String(page.next_page_token)}:{watermark:end-120},more:!!page.next_page_token};
 }
 // Lazada forbids using GetOrders as a continuous monitor. Only a bounded initial/manual import runs here.
 const country=String(account.account_key).split(':')[0],start=String(cursor.start||new Date(Date.now()-30*86400_000).toISOString()),end=String(cursor.end||new Date(Date.now()-30_000).toISOString()),offset=Number(cursor.offset||0);if(!Number.isInteger(offset)||offset<0||offset>5000||!Number.isFinite(Date.parse(start))||!Number.isFinite(Date.parse(end))||Date.parse(end)<=Date.parse(start))throw fail('marketplace_cursor_invalid');
 const result=await lazadaRequest('/orders/get',{access_token:token,created_after:start,created_before:end,sort_by:'created_at',sort_direction:'ASC',status:'all',limit:'100',offset:String(offset)},country,o),page=result.data;if(!Array.isArray(page?.orders)||page.orders.length>100||!Number.isFinite(Number(page.countTotal)))throw fail('lazada_orders_invalid');
 const resources=page.orders.map((raw:Row)=>{const updated=Date.parse(String(raw.updated_at||raw.created_at));if(!raw.order_id||!Number.isFinite(updated))throw fail('lazada_order_invalid');return {kind:'order' as const,id:String(raw.order_id),updatedAt:new Date(updated).toISOString(),data:{statuses:Array.isArray(raw.statuses)?raw.statuses.map(String):[],price:String(raw.price||''),shipping_fee:String(raw.shipping_fee||'')}};});
 const more=offset+page.orders.length<Number(page.countTotal);if(more&&(!page.orders.length||offset+page.orders.length>5000))throw fail('lazada_history_window_too_large');return {resources,cursor:more?{start,end,offset:offset+page.orders.length}:{},more};
}
