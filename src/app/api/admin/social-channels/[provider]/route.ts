import {ApiError,assertOrigin,rateLimit,readJson,staffSession} from '@/lib/auth';
import {socialProvider} from '@/lib/social-channels';
import {socialChannelAction,socialChannelStatus} from '@/lib/social-channel-admin';

export const dynamic='force-dynamic';
export const maxDuration=120;
type Context={params:Promise<{provider:string}>};
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
async function handle(request:Request,context:Context){
  try{
    if(new URL(request.url).protocol!=='https:')throw new ApiError(400,'HTTPS required');
    const staff=(await staffSession(request))!,provider=socialProvider((await context.params).provider);
    if(request.method==='GET')return Response.json(await socialChannelStatus(staff,provider),{headers});
    assertOrigin(request);const body=await readJson(request);
    await rateLimit(`social-admin:${staff.orgId}:${staff.id}`,body.action==='verify'?6:60,60);
    return Response.json(await socialChannelAction(staff,provider,body),{headers});
  }catch(error){return Response.json({error:error instanceof ApiError?error.message:'channel_control_unavailable'},{status:error instanceof ApiError?error.status:503,headers});}
}
export const GET=handle;
export const POST=handle;
