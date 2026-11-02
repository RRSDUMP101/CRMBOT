import {ApiError,assertOrigin,rateLimit,readJson,requireAdmin,staffSession} from '@/lib/auth';
import {integrationOverview,createApiKey,revokeApiKey,saveWebhook,controlWebhook} from '@/lib/public-integrations';
export const dynamic='force-dynamic';
export const runtime='nodejs';
type Context={params:Promise<{path?:string[]}>};
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
async function handle(request:Request,context:Context){
 try{
  if(new URL(request.url).protocol!=='https:')throw new ApiError(400,'https_required');
  const staff=(await staffSession(request))!;requireAdmin(staff);const path=((await context.params).path||[]).join('/');
  if(request.method==='GET'&&!path)return Response.json(await integrationOverview(staff),{headers});
  if(request.method!=='POST')throw new ApiError(405,'method_not_allowed');
  assertOrigin(request);await rateLimit('public-integrations:'+staff.orgId+':'+staff.id,30,60);
  const input=await readJson(request,8192);
  const handlers:Record<string,()=>Promise<unknown>>={keys:()=>createApiKey(staff,input),'keys/revoke':()=>revokeApiKey(staff,input),webhooks:()=>saveWebhook(staff,input),'webhooks/control':()=>controlWebhook(staff,input)};
  if(!handlers[path])throw new ApiError(404,'not_found');
  return Response.json(await handlers[path](),{headers});
 }catch(e){return Response.json({error:e instanceof ApiError?e.message:'integrations_unavailable'},{status:e instanceof ApiError?e.status:503,headers});}
}
export const GET=handle;
export const POST=handle;

