import {ApiError,assertOrigin,rateLimit,readJson,staffSession} from '@/lib/auth';
import {approveHumanAttachment,downloadHumanAttachment,listHumanAttachments,uploadHumanAttachment} from '@/lib/human-attachments';
export const runtime='nodejs';export const dynamic='force-dynamic';
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
async function handle(request:Request,context:{params:Promise<{id:string;path?:string[]}>}){
  try{
    const staff=(await staffSession(request))!,{id,path=[]}=await context.params;
    if(request.method==='GET'){if(!path.length)return json(await listHumanAttachments(staff,id));if(path.length===1)return await downloadHumanAttachment(staff,id,path[0]);}
    if(request.method==='POST'){assertOrigin(request);await rateLimit('human-attachment:'+staff.orgId+':'+staff.id,30,60);if(!path.length)return json(await uploadHumanAttachment(staff,id,request),201);if(path.length===1&&path[0]==='send')return json(await approveHumanAttachment(staff,id,await readJson(request)));}
    throw new ApiError(404,'ไม่พบรายการ');
  }catch(e){if(e instanceof ApiError)return json({error:e.message},e.status);console.error('[rrs] human_attachment_request_failed');return json({error:'ทำรายการไฟล์แนบไม่สำเร็จ'},500);}
}
export const GET=handle;export const POST=handle;
