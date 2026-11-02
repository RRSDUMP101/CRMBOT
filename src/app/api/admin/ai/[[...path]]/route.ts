import {ApiError,assertOrigin,rateLimit,readJson,requireAdmin,staffSession} from '@/lib/auth';
import type {Staff} from '@/lib/auth';
import {activateAi,aiOverview,aiAnalysis,deleteSource,crawlSource,evaluateAi,reviewSource,saveAiProfile,saveSource,uploadSource} from '@/lib/ai-lifecycle';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export const maxDuration=60;
type Context={params:Promise<{path?:string[]}>};
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
async function handle(request:Request,context:Context){
  try{
    const staff=(await staffSession(request))!,path=(await context.params).path||[];
    if(path.length>1)throw new ApiError(404,'ไม่พบหน้า');
    if(request.method==='GET'&&!path.length)return Response.json(await aiOverview(staff),{headers});
    if(request.method==='GET'&&path[0]==='analysis')return Response.json(await aiAnalysis(staff),{headers});
    if(request.method!=='POST')throw new ApiError(405,'ไม่รองรับคำสั่ง');
    assertOrigin(request);requireAdmin(staff);await rateLimit(`ai-lifecycle:${staff.orgId}:${staff.id}`,20,60);
    if(path[0]==='upload')return Response.json(await uploadSource(staff,request),{headers,status:201});
    const body=await readJson(request,350_000);
    const actions:Record<string,(actor:Staff,input:Record<string,unknown>)=>Promise<unknown>>={source:saveSource,review:reviewSource,crawl:crawlSource,profile:saveAiProfile,evaluate:evaluateAi,activate:activateAi,delete:deleteSource};
    const action=actions[path[0]];if(!action)throw new ApiError(404,'ไม่พบคำสั่ง');
    return Response.json(await action(staff,body),{headers});
  }catch(error){return Response.json({error:error instanceof ApiError?error.message:'ai_lifecycle_unavailable'},{status:error instanceof ApiError?error.status:503,headers});}
}
export const GET=handle;
export const POST=handle;
