import {ApiError,assertOrigin,rateLimit} from '@/lib/auth';
import {downloadWebAttachment,uploadWebAttachment,webAttachmentActor,webAttachmentCapabilities} from '@/lib/web-chat-attachments';
export const dynamic='force-dynamic';
export const maxDuration=120;
type Context={params:Promise<{id:string;path?:string[]}>};
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
async function handle(request:Request,context:Context){
 try{
  if(request.method==='POST')assertOrigin(request);
  const {id,path=[]}=await context.params,actor=await webAttachmentActor(request,id);
  if(request.method==='GET'&&!path.length)return Response.json(await webAttachmentCapabilities(actor),{headers});
  if(request.method==='GET'&&path.length===1)return await downloadWebAttachment(actor,path[0]);
  if(request.method==='POST'&&!path.length){await rateLimit(`staff-web-file:${actor.orgId}:${actor.sessionHash}`,20,3600);return Response.json(await uploadWebAttachment(actor,request),{status:201,headers});}
  throw new ApiError(404,'ไม่พบ API');
 }catch(error){return Response.json({error:error instanceof ApiError?error.message:'ไม่สามารถจัดการไฟล์ได้ กรุณาลองใหม่'},{status:error instanceof ApiError?error.status:503,headers});}
}
export const GET=handle;export const POST=handle;
