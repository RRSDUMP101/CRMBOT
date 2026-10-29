import {createHmac,timingSafeEqual} from 'node:crypto';
import {ApiError} from './errors';
export const mediaArchivePath='/api/internal/media-archive';
const purpose='rrs-native-inbound-media-archive-v1';
function target(origin:string){const url=new URL(origin);if(url.protocol!=='https:'||url.origin!==origin||url.username||url.password)throw new ApiError(503,'Archive runner origin unavailable');return origin+mediaArchivePath;}
const mac=(secret:string,url:string,time:string)=>createHmac('sha256',secret).update([purpose,'POST',url,time,'{}'].join('\n')).digest('hex');
export function mediaArchiveRunnerRequest(origin:string,secret:string,time=Date.now()){
  if(secret.length<32)throw new ApiError(503,'Archive runner key unavailable');const url=target(origin),at=String(time);
  // OpenNext reconstructs NextRequest.url from Host. Internal scheduled calls
  // have no ingress-populated Host, so bind it to the already validated target.
  return new Request(url,{method:'POST',body:'{}',headers:{'Host':new URL(url).host,'Content-Type':'application/json','x-rrs-archive-time':at,'x-rrs-archive-mac':mac(secret,url,at)}});
}
export async function verifyMediaArchiveRunner(request:Request,origin:string,secret:string,time=Date.now()){
  const at=request.headers.get('x-rrs-archive-time')||'',proof=request.headers.get('x-rrs-archive-mac')||'';
  if(secret.length<32||request.method!=='POST'||request.url!==target(origin)||!/^\d{13}$/.test(at)||Math.abs(time-Number(at))>60_000||!/^[a-f0-9]{64}$/.test(proof)||Number(request.headers.get('content-length')||0)>2)throw new ApiError(403,'Invalid archive runner proof');
  const reader=request.body?.getReader();let length=0,body='';if(!reader)throw new ApiError(403,'Invalid archive runner body');
  try{while(true){const next=await reader.read();if(next.done)break;length+=next.value.length;if(length>2){await reader.cancel();throw new ApiError(403,'Invalid archive runner body');}body+=new TextDecoder().decode(next.value);}}finally{reader.releaseLock();}
  if(body!=='{}'||!timingSafeEqual(Buffer.from(proof,'hex'),Buffer.from(mac(secret,request.url,at),'hex')))throw new ApiError(403,'Invalid archive runner proof');
  // Replays can only claim eligible idempotent GET/archive work, never send work.
}
