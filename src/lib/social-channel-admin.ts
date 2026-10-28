import {randomUUID} from 'node:crypto';
import {ApiError,requireAdmin,type Staff} from './auth';
import {database,transaction,type Executor,type Row} from './db';
import {readSocialConfig,socialConfigFingerprint,socialVerificationReady,type SocialChannelConfig,type SocialProvider} from './social-channels';

type Options={config?:SocialChannelConfig;fetch?:typeof fetch};
const now=()=>new Date().toISOString().replace(/(\.\d{3})Z$/,(_,fraction)=>fraction+'000Z');
const expiry=(ms:number)=>new Date(ms).toISOString().replace(/(\.\d{3})Z$/,(_,fraction)=>fraction+'000Z');
const expectedBusinessPhone='66815441815'; // Existing source's owner-selected RRS business sender.
const code=(message:string,status=409)=>new ApiError(status,message);
function missing(config:SocialChannelConfig){
  const values:Record<string,unknown>={SOCIAL_CHANNELS_ORG_ID:config.orgId,APP_ORIGIN:config.webhookUrl};
  if(config.provider==='line')Object.assign(values,{LINE_BOT_USER_ID:config.accountId,LINE_CHANNEL_SECRET:config.secret,LINE_CHANNEL_ACCESS_TOKEN:config.accessToken});
  else if(config.provider==='whatsapp')Object.assign(values,{WHATSAPP_PHONE_NUMBER_ID:config.accountId,WHATSAPP_WABA_ID:config.wabaId,WHATSAPP_APP_ID:config.appId,WHATSAPP_APP_SECRET:config.secret,WHATSAPP_ACCESS_TOKEN:config.accessToken,WHATSAPP_VERIFY_TOKEN:config.verifyToken,WHATSAPP_API_VERSION:config.apiVersion});
  else Object.assign(values,{META_PAGE_ID:config.accountId,META_APP_SECRET:config.secret,META_PAGE_ACCESS_TOKEN:config.accessToken,META_VERIFY_TOKEN:config.verifyToken,META_API_VERSION:config.apiVersion});
  return Object.keys(values).filter(key=>!values[key]);
}
function validConfig(config:SocialChannelConfig){
  if(missing(config).length)throw code('configuration_missing',503);
  let url:URL;try{url=new URL(config.webhookUrl!);}catch{throw code('callback_configuration_invalid',503);}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/api/channels/'+config.provider)throw code('callback_configuration_invalid',503);
  if(config.provider!=='line'&&(!/^v\d+\.\d+$/.test(config.apiVersion!)||!/^\d{5,40}$/.test(config.accountId)))throw code('account_configuration_invalid',503);
  if(config.provider==='whatsapp'&&(!/^\d{5,40}$/.test(config.appId!)||!/^\d{5,40}$/.test(config.wabaId!)))throw code('account_configuration_invalid',503);
}
async function authorized(staff:Staff){requireAdmin(staff);await transaction(staff.orgId,async()=>{},staff);}
async function audit(c:Executor,staff:Staff,provider:SocialProvider,action:string,detail:Record<string,unknown>={}){
  await c.query('INSERT INTO audit_events(id,org_id,actor_id,action,entity_id,metadata) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),staff.orgId,staff.id,'social_channel.'+action,provider,JSON.stringify(detail)]);
}
async function cancelQueued(c:Executor,orgId:string,provider:SocialProvider){
  await c.query("UPDATE social_message_provenance SET delivery_status='cancelled' WHERE org_id=$1 AND message_id IN (SELECT message_id FROM social_outbound_commands WHERE org_id=$1 AND provider=$2 AND status='queued')",[orgId,provider]);
  await c.query("UPDATE social_outbound_commands SET status='cancelled',error_code='admin_channel_disabled',updated_at=$3 WHERE org_id=$1 AND provider=$2 AND status='queued'",[orgId,provider,now()]);
}
async function control(orgId:string,config:SocialChannelConfig,c:Executor=database){return (await c.query('SELECT * FROM social_channel_controls WHERE org_id=$1 AND provider=$2 AND account_id=$3',[orgId,config.provider,config.accountId])).rows[0];}
export async function socialChannelStatus(staff:Staff,provider:SocialProvider,options:Options={}){
  await authorized(staff);const config=options.config||readSocialConfig(provider),row=await control(staff.orgId,config);
  const absent=missing(config),fp=socialConfigFingerprint(config),scopeMatches=config.orgId===staff.orgId;
  let valid=true;try{validConfig(config);}catch{valid=false;}
  const verified=scopeMatches&&socialVerificationReady(row,config),hook=scopeMatches&&row?.webhook_fingerprint===fp&&!!row?.webhook_verified_at;
  return {provider,accountId:scopeMatches?config.accountId:'',configured:scopeMatches&&valid,missing:absent,expectedWebhookUrl:config.webhookUrl||'',owner:config.owner,inboundEnabled:config.inboundEnabled,environmentLiveEnabled:config.liveEnabled,
    sendMode:row?.send_mode||'disabled',emergencyStop:!row||!!row.emergency_stop,verified,verifiedAt:row?.verified_at||null,verificationExpiresAt:row?.verification_expires_at||null,webhookVerified:hook,lastWebhookAt:row?.webhook_verified_at||null,
    testRecipient:scopeMatches?config.testRecipient||null:null,testPassed:scopeMatches&&!!row?.test_passed_at&&row.test_fingerprint===fp,errorCode:row?.verification_error_code||null};
}
async function providerJson(url:string,token:string,transport:typeof fetch){
  // URLs are assembled only below from a fixed provider host and validated IDs.
  const response=await transport(url,{method:'GET',headers:{Authorization:'Bearer '+token},redirect:'manual',signal:AbortSignal.timeout(15000)});
  if(!response.ok){await response.body?.cancel();throw code(response.status>=300&&response.status<400?'provider_redirect_rejected':response.status===401?'provider_authentication_failed':response.status===403?'provider_permission_denied':'provider_check_failed',502);}
  if(Number(response.headers.get('content-length')||0)>128000){await response.body?.cancel();throw code('provider_response_invalid',502);}
  const reader=response.body?.getReader();if(!reader)throw code('provider_response_invalid',502);let text='',size=0;const decoder=new TextDecoder();
  try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>128000){await reader.cancel();throw code('provider_response_invalid',502);}text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}finally{reader.releaseLock();}
  try{const value=JSON.parse(text);if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value as Record<string,any>;}catch{throw code('provider_response_invalid',502);}
}
async function verifyProvider(config:SocialChannelConfig,transport:typeof fetch){
  validConfig(config);const token=config.accessToken!;
  if(config.provider==='line'){
    const info=await providerJson('https://api.line.me/v2/bot/info',token,transport);
    if(info.userId!==config.accountId)throw code('provider_account_mismatch');
    const endpoint=await providerJson('https://api.line.me/v2/bot/channel/webhook/endpoint',token,transport);
    if(endpoint.active!==true||endpoint.endpoint!==config.webhookUrl)throw code('provider_callback_mismatch');
    return {expires:Date.now()+86400000,detail:{accountMatched:true,callbackMatched:true}};
  }
  const base='https://graph.facebook.com/'+config.apiVersion+'/';
  if(config.provider==='facebook'){
    // Matches the source's Page identity check; signed callback and a controlled
    // test delivery are required separately before this account can go live.
    const page=await providerJson(base+config.accountId+'?fields=id,name',token,transport);
    if(String(page.id)!==config.accountId)throw code('provider_account_mismatch');
    return {expires:Date.now()+86400000,detail:{accountMatched:true,callbackProof:'signed_webhook_required'}};
  }
  const appToken=config.appId+'|'+config.secret;
  const debug=await providerJson(base+'debug_token?input_token='+encodeURIComponent(token),appToken,transport),data=debug.data;
  if(data?.is_valid!==true||String(data.app_id)!==config.appId)throw code('provider_token_app_mismatch');
  if(!Array.isArray(data.scopes)||!['whatsapp_business_messaging','whatsapp_business_management'].every(scope=>data.scopes.includes(scope)))throw code('provider_permission_missing');
  let expires=Date.now()+86400000;
  for(const field of ['expires_at','data_access_expires_at'])if(data[field]!==undefined&&data[field]!==0){const milliseconds=Number(data[field])*1000;if(!Number.isFinite(milliseconds)||milliseconds<=Date.now())throw code('provider_token_expired');expires=Math.min(expires,milliseconds);}
  const numbers=await providerJson(base+config.wabaId+'/phone_numbers?fields=id,display_phone_number,verified_name&limit=100',token,transport);
  const selected=Array.isArray(numbers.data)&&numbers.data.find((phone:any)=>String(phone.id)===config.accountId);
  if(!selected||String(selected.display_phone_number||'').replace(/\D/g,'')!==expectedBusinessPhone)throw code('provider_business_sender_mismatch');
  const phone=await providerJson(base+config.accountId+'?fields=id,display_phone_number,status,platform_type,code_verification_status,is_on_biz_app',token,transport);
  if(String(phone.id)!==config.accountId||String(phone.display_phone_number||'').replace(/\D/g,'')!==expectedBusinessPhone||phone.status!=='CONNECTED'||phone.platform_type!=='CLOUD_API')throw code('provider_phone_not_connected');
  let app:Record<string,any>|undefined,after='';
  for(let page=0;page<5;page++){
    const body=await providerJson(base+config.wabaId+'/subscribed_apps?limit=100'+(after?'&after='+encodeURIComponent(after):''),token,transport);
    if(!Array.isArray(body.data))throw code('provider_response_invalid',502);
    app=body.data.find((item:any)=>String(item.whatsapp_business_api_data?.id)===config.appId)||app;
    if(!body.paging?.next)break;
    after=body.paging?.cursors?.after;if(typeof after!=='string'||!after||after.length>2000||page===4)throw code('provider_subscription_incomplete');
  }
  if(!app||app.override_callback_uri&&app.override_callback_uri!==config.webhookUrl)throw code('provider_waba_subscription_mismatch');
  const subscriptions=await providerJson(base+config.appId+'/subscriptions',appToken,transport);
  const hook=Array.isArray(subscriptions.data)&&subscriptions.data.find((item:any)=>item.object==='whatsapp_business_account');
  if(!hook||hook.active!==true||!Array.isArray(hook.fields)||!hook.fields.some((field:any)=>(typeof field==='string'?field:field?.name)==='messages')||hook.callback_url!==config.webhookUrl&&app.override_callback_uri!==config.webhookUrl)throw code('provider_callback_mismatch');
  return {expires,detail:{accountMatched:true,businessSenderMatched:true,permissionsChecked:true,callbackMatched:true}};
}

export async function socialChannelAction(staff:Staff,provider:SocialProvider,input:Record<string,unknown>,options:Options={}){
  await authorized(staff);
  if(Object.keys(input).some(key=>!['action','confirm'].includes(key))||!['verify','disable','enable-test','enable'].includes(String(input.action)))throw code('invalid_channel_action',400);
  const config={...(options.config||readSocialConfig(provider))};if(config.provider!==provider)throw code('provider_account_mismatch');
  const action=String(input.action),fp=socialConfigFingerprint(config);
  if(action==='disable'){
    await transaction(staff.orgId,async c=>{
      await c.query("UPDATE social_channel_controls SET send_enabled=0,emergency_stop=1,send_mode='disabled',verification_id=NULL,epoch=epoch+1,updated_at=$3 WHERE org_id=$1 AND provider=$2",[staff.orgId,provider,now()]);
      await cancelQueued(c,staff.orgId,provider);await audit(c,staff,provider,'disabled');
    },staff);
    return socialChannelStatus(staff,provider,options);
  }
  if(config.orgId!==staff.orgId)throw code('channel_organization_mismatch',403);
  if(action==='verify'){
    const attempt=randomUUID();
    await transaction(staff.orgId,async c=>{
      await c.query("INSERT INTO social_channel_controls(org_id,provider,account_id,updated_at,verification_id,verification_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(org_id,provider,account_id) DO UPDATE SET send_enabled=0,emergency_stop=1,send_mode='disabled',epoch=epoch+1,verified_at=NULL,verification_fingerprint=NULL,verification_expires_at=NULL,verification_error_code=NULL,verification_id=excluded.verification_id,verification_by=excluded.verification_by,updated_at=excluded.updated_at",[staff.orgId,provider,config.accountId,now(),attempt,staff.id]);
      await cancelQueued(c,staff.orgId,provider);await audit(c,staff,provider,'verification_started');
    },staff);
    try{
      const proof=await verifyProvider(config,options.fetch||fetch);
      if(socialConfigFingerprint(options.config||readSocialConfig(provider))!==fp)throw code('configuration_changed_during_verification');
      await transaction(staff.orgId,async c=>{
        if((await control(staff.orgId,config,c))?.verification_id!==attempt)throw code('verification_cancelled');
        await c.query('UPDATE social_channel_controls SET verified_at=$4,verification_fingerprint=$5,verification_expires_at=$6,verification_error_code=NULL,verification_detail=$7,verification_id=NULL WHERE org_id=$1 AND provider=$2 AND account_id=$3',[staff.orgId,provider,config.accountId,now(),fp,expiry(proof.expires),JSON.stringify(proof.detail)]);
        await audit(c,staff,provider,'verified',{accountId:config.accountId});
      },staff);
    }catch(error){
      const errorCode=error instanceof ApiError?error.message:'provider_check_failed';
      await transaction(staff.orgId,async c=>{
        if((await control(staff.orgId,config,c))?.verification_id!==attempt)return;
        await c.query('UPDATE social_channel_controls SET verification_error_code=$4,verification_id=NULL WHERE org_id=$1 AND provider=$2 AND account_id=$3',[staff.orgId,provider,config.accountId,errorCode]);
        await audit(c,staff,provider,'verification_failed',{errorCode});
      },staff).catch(()=>{});
      throw error instanceof ApiError?error:code('provider_check_failed',502);
    }
  }else{
    if(input.confirm!==true)throw code('explicit_confirmation_required',422);
    validConfig(config);
    if(config.owner!=='crm'||!config.inboundEnabled||!config.liveEnabled)throw code('environment_sender_disabled');
    if(!config.testRecipient||!(provider==='whatsapp'?/^[1-9]\d{7,14}$/:provider==='line'?/^U[a-f0-9]{32}$/:/^\d{5,40}$/).test(config.testRecipient))throw code('test_recipient_not_configured');
    await transaction(staff.orgId,async c=>{
      const row=await control(staff.orgId,config,c);
      if(!socialVerificationReady(row,config)||row.webhook_fingerprint!==fp||!row.webhook_verified_at)throw code('fresh_account_and_signed_webhook_verification_required');
      if(action==='enable'&&(!row.test_passed_at||row.test_fingerprint!==fp))throw code('controlled_test_delivery_required');
      await c.query('UPDATE social_channel_controls SET send_enabled=1,emergency_stop=0,send_mode=$4,test_recipient=$5,epoch=epoch+1,updated_at=$6 WHERE org_id=$1 AND provider=$2 AND account_id=$3',[staff.orgId,provider,config.accountId,action==='enable'?'live':'test',config.testRecipient,now()]);
      await audit(c,staff,provider,action==='enable'?'enabled':'test_enabled',{accountId:config.accountId,testRecipient:config.testRecipient});
    },staff);
  }
  return socialChannelStatus(staff,provider,options);
}
