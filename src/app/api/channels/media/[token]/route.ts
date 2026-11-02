import {downloadHumanAttachmentGrant} from '@/lib/human-attachments';
import {downloadBroadcastMediaGrant,hasBroadcastMediaGrant} from '@/lib/broadcast-media';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function GET(_request:Request,context:{params:Promise<{token:string}>}){
  try{const token=(await context.params).token;return await(await hasBroadcastMediaGrant(token)?downloadBroadcastMediaGrant(token):downloadHumanAttachmentGrant(token));}catch{return new Response('Media unavailable',{status:404,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});}
}
export async function HEAD(request:Request,context:{params:Promise<{token:string}>}){const response=await GET(request,context);await response.body?.cancel();return new Response(null,{status:response.status,headers:response.headers});}
