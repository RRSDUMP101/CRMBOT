import {bridgeKeyConfig,signBridgeRequest} from './bridge-protocol';
import {isEnglishCustomerReply} from './customer-language';
import type {BotInput} from './bot';
export type TurnScope={orgId:string;conversationId:string|null;requestId:string;purpose:'customer'|'evaluation'};
export type TurnSummary={summaryTh:string;missing:string[]};
export class CustomerTurnHandoff extends Error{
  constructor(public reason:string){super('CRM staff review required');}
}
export async function customerTurn(input:BotInput,scope:TurnScope,transport:typeof fetch=fetch){
  const env=process.env,secret=env.CRM_BRIDGE_SECRET,origin=env.CRM_CUSTOMER_TURN_ORIGIN||env.CRM_APPROVED_AI_SOURCE_ORIGIN;
  if(env.CRM_BRIDGE_ENABLED!=='true'||scope.orgId!==env.CRM_BRIDGE_ORG_ID||!secret||secret.length<32||!origin||new URL(origin).origin!==origin||!origin.startsWith('https://'))
    throw new CustomerTurnHandoff('bridge_unavailable');
  const url=origin+'/api/rrs/crm/customer-turn';
  const history=input.history.filter(m=>['assistant','user','agent'].includes(m.role)).slice(-12).map(m=>({role:m.role,content:m.content.slice(0,4000)}));
  const facts=Object.fromEntries(Object.entries(input.facts).filter(([k,v])=>['vehicle','product','country','market','quantity','cab','year','material','weight','needBy','useCase'].includes(k)&&typeof v==='string'));
  const knowledge=input.knowledge.slice(0,4).map(({id,title,content,version,sourceUrl})=>({id,title,content:content.slice(0,4000),version,...(sourceUrl?{sourceUrl}:{})}));
  const body=JSON.stringify({channel:'web',purpose:scope.purpose,requestId:scope.requestId,conversationId:scope.conversationId,history,facts,knowledge});
  const headers=await signBridgeRequest(url,{...bridgeKeyConfig(env),orgId:scope.orgId,secret,method:'POST',body});
  const res=await transport(url,{method:'POST',body,headers,redirect:'manual',cache:'no-store',signal:AbortSignal.any([AbortSignal.timeout(65000),...(input.signal?[input.signal]:[])])});
  if(!res.ok||!res.body){await res.body?.cancel();throw new CustomerTurnHandoff('gateway_unavailable');}
  let raw='',size=0;const dec=new TextDecoder('utf-8',{fatal:true}),reader=res.body.getReader();
  try{for(;;){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>32000){await reader.cancel();throw new CustomerTurnHandoff('invalid_response');}raw+=dec.decode(p.value,{stream:true});}raw+=dec.decode();}finally{reader.releaseLock();}
  const x=JSON.parse(raw);
  if(x.status!=='reply'||typeof x.text!=='string'||!x.text.trim()||x.text.length>6000)throw new CustomerTurnHandoff(typeof x.reason==='string'&&/^[a-z0-9_-]{1,80}$/i.test(x.reason)?x.reason:'review_required');
  if(!isEnglishCustomerReply(x.text))throw new CustomerTurnHandoff('language_review');
  const summary:TurnSummary|undefined=typeof x.summaryTh==='string'&&x.summaryTh.length<=2400&&/[ก-๙]/u.test(x.summaryTh)?{summaryTh:x.summaryTh,missing:Array.isArray(x.missing)?x.missing.filter((v:unknown)=>typeof v==='string'&&v.length<=160).slice(0,12):[]}:undefined;
  return {text:x.text as string,summary};
}
