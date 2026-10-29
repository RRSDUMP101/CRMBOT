import {ApiError,assertOrigin,rateLimit,readJson,staffSession} from '@/lib/auth';
import {reviewWhatsAppConsent,whatsappConsentStatus} from '@/lib/social-consent';

export const dynamic='force-dynamic';
type Context={params:Promise<{conversationId:string}>};
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
async function handle(request:Request,context:Context){
  try{
    if(new URL(request.url).protocol!=='https:')throw new ApiError(400,'HTTPS required');
    const staff=(await staffSession(request))!,{conversationId}=await context.params;
    if(request.method==='GET')return Response.json(await whatsappConsentStatus(staff,conversationId),{headers});
    assertOrigin(request);const body=await readJson(request);
    await rateLimit(`whatsapp-consent:${staff.orgId}:${staff.id}`,30,60);
    return Response.json(await reviewWhatsAppConsent(staff,conversationId,body),{headers});
  }catch(error){return Response.json({error:error instanceof ApiError?error.message:'ไม่สามารถตรวจสอบความยินยอมได้'},{status:error instanceof ApiError?error.status:503,headers});}
}
export const GET=handle;
export const POST=handle;
