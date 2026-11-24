import {ApiError,fields,oneOf,str,uuid} from './auth';
import {mappedBridgeMember} from './bridge-commands';
import {inbox,markConversationRead,type SaleInboxScope} from './helpdesk';

export async function saleInbox(input:Record<string,unknown>){
  const staff=await mappedBridgeMember(uuid(input.actorId));
  const workspace=oneOf(input.workspace,['domestic','live'],'พื้นที่งาน');
  if(typeof input.owner!=='boolean')throw new ApiError(400,'Invalid owner scope');
  const scope:SaleInboxScope={market:workspace==='domestic'?'domestic':'export',owner:input.owner && staff.role==='Admin',roomIds:[]};
  if(input.action==='read'){
    fields(input,['action','actorId','owner','workspace','conversationId','throughMessageId']);
    const id=uuid(input.conversationId);scope.roomIds=[id];
    return markConversationRead(staff,id,{throughMessageId:input.throughMessageId},scope);
  }
  if(input.action!=='list')throw new ApiError(400,'Invalid inbox operation');
  fields(input,['action','actorId','owner','workspace','roomIds','q','view','limit','cursor']);
  if(!Array.isArray(input.roomIds)||input.roomIds.length>1000)throw new ApiError(400,'Invalid room scope');
  scope.roomIds=input.roomIds.map(id=>uuid(id));
  const url=new URL('https://crm.invalid/inbox');
  for(const [key,max] of [['q',200],['view',20],['cursor',400],['limit',3]] as const){
    if(input[key]!==undefined)url.searchParams.set(key,str(input[key],key,max));
  }
  const page=await inbox(staff,url,scope);
  return {...page,items:page.items.map(row=>({
    id:row.id,leadId:row.leadId,leadName:row.leadName,provider:row.provider,lastMessage:String(row.lastMessage||'').slice(0,400),
    updatedAt:row.updatedAt,status:row.status,assigneeId:row.assigneeId,unreadCount:row.unreadCount,lastCustomerMessageId:row.lastCustomerMessageId,
  }))};
}
