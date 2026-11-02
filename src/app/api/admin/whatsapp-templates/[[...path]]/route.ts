import {ApiError,assertOrigin,staffSession,rateLimit,readJson,requireAdmin} from '@/lib/auth';
import {listWhatsappTemplates,saveWhatsappTemplate,submitWhatsappTemplate,refreshWhatsappTemplate} from '@/lib/wa-templates';
export const dynamic='force-dynamic';
type Context={params:Promise<{path?:string[]}>};
async function handle(request:Request,context:Context){
 const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
 try{const staff=(await staffSession(request))!;requireAdmin(staff);const path=(await context.params).path||[];
  if(request.method==='GET'&&!path.length)return Response.json(await listWhatsappTemplates(staff),{headers});
  assertOrigin(request);await rateLimit(`wa-templates:${staff.orgId}:${staff.id}`,30,60);const body=await readJson(request,12000);
  if(!path.length)return Response.json(await saveWhatsappTemplate(staff,body),{headers});
  if(path.length===2&&path[1]==='submit')return Response.json(await submitWhatsappTemplate(staff,path[0],body),{headers});
  if(path.length===2&&path[1]==='refresh'&&!Object.keys(body).length)return Response.json(await refreshWhatsappTemplate(staff,path[0]),{headers});
  throw new ApiError(404,'ไม่พบคำสั่ง');
 }catch(e){return Response.json({error:e instanceof ApiError?e.message:'จัดการเทมเพลตไม่ได้ในขณะนี้'},{status:e instanceof ApiError?e.status:503,headers});}
}
export const GET=handle;export const POST=handle;
