import { ApiError, staffSession, visitorSession } from './auth';
import { database } from './db';

/** Revision-only notifications. Every data fetch still passes the ordinary scoped API. */
export async function realtimeResponse(request:Request,kind:'staff'|'visitor') {
  const origin=request.headers.get('origin');
  if(request.headers.get('sec-fetch-site')==='cross-site'||origin&&origin!==new URL(request.url).origin)throw new ApiError(403,'Invalid origin');
  const read=async()=>{
    if(kind==='staff'){
      const staff=(await staffSession(request))!;
      const row=(await database.query('SELECT revision FROM organizations WHERE id=$1',[staff.orgId])).rows[0];
      if(!row)throw new ApiError(403,'Organization unavailable');
      return `${staff.orgId}:${staff.id}:${staff.role}:${row.revision}`;
    }
    const visitor=(await visitorSession(request))!;
    const row=(await database.query('SELECT c.version,c.updated_at,(SELECT COUNT(*) FROM messages m WHERE m.org_id=c.org_id AND m.conversation_id=c.id) AS total FROM conversations c WHERE c.org_id=$1 AND c.id=$2',[visitor.orgId,visitor.conversationId])).rows[0];
    if(!row)throw new ApiError(403,'Conversation unavailable');
    return `${row.version}:${row.updated_at}:${row.total}`;
  };
  let last=await read(),closed=false,timer:ReturnType<typeof setTimeout>|undefined,wake:(()=>void)|undefined;
  const stop=()=>{closed=true;if(timer)clearTimeout(timer);wake?.();request.signal.removeEventListener('abort',stop);};
  const stream=new ReadableStream<Uint8Array>({async start(controller){
    const encoder=new TextEncoder(),start=Date.now();
    const emit=(name:string)=>{if(!closed)controller.enqueue(encoder.encode(`event: ${name}\ndata: {}\n\n`));};
    request.signal.addEventListener('abort',stop,{once:true});if(request.signal.aborted)stop();
    try{emit('change');while(!closed&&Date.now()-start<25000){
      await new Promise<void>(resolve=>{wake=resolve;timer=setTimeout(resolve,500);});wake=undefined;if(closed)break;
      const next=await read();if(next!==last){last=next;emit('change');}
    }}catch(error){if(!closed)emit(error instanceof ApiError&&[401,403].includes(error.status)?'auth-required':'unavailable');}
    finally{stop();try{controller.close();}catch{}}
  },cancel(){stop();}});
  return new Response(stream,{headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'private, no-store, no-transform','X-Accel-Buffering':'no'}});
}
