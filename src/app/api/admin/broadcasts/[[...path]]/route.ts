import {ApiError,assertOrigin,rateLimit,readJson,staffSession,uuid} from '@/lib/auth';
import {addBroadcastSuppression,controlBroadcast,createBroadcast,getBroadcast,importBroadcastCsv,launchBroadcast,listBroadcastSuppressions,listBroadcasts,previewBroadcast,runBroadcastBatch,testSendBroadcast,updateBroadcast} from '@/lib/broadcast';

export const dynamic='force-dynamic';
export const maxDuration=120;
type Context={params:Promise<{path?:string[]}>};
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
const json=(body:unknown,status=200)=>Response.json(body,{status,headers});
/**
 * GET  /api/admin/broadcasts                      list (Admin and Agent, read-only for Agent)
 * GET  /api/admin/broadcasts/:id                  detail (Agent sees counts only)
 * GET  /api/admin/broadcasts/suppressions         Admin
 * POST /api/admin/broadcasts                      create draft
 * POST /api/admin/broadcasts/:id                  update draft {expectedVersion,...}
 * POST /api/admin/broadcasts/:id/{preview|import|test-send|launch|pause|resume|cancel|run}
 * POST /api/admin/broadcasts/suppressions         add suppression
 * Every POST is same-origin, Admin-only and rate limited; sends additionally need the gates in lib/broadcast.
 */
async function handle(request:Request,context:Context){
  try{
    if(new URL(request.url).protocol!=='https:')throw new ApiError(400,'HTTPS required');
    const staff=(await staffSession(request))!,path=(await context.params).path||[];
    if(path.length>2)throw new ApiError(404,'ไม่พบ API ที่ร้องขอ');
    if(request.method==='GET'){
      if(!path.length)return json(await listBroadcasts(staff));
      if(path.length===1&&path[0]==='suppressions')return json(await listBroadcastSuppressions(staff));
      if(path.length===1)return json(await getBroadcast(staff,uuid(path[0])));
      throw new ApiError(404,'ไม่พบ API ที่ร้องขอ');
    }
    assertOrigin(request);
    if(staff.role!=='Admin')throw new ApiError(403,'ต้องใช้สิทธิ์ผู้ดูแลระบบ');
    const action=path.length===2?path[1]:'';
    await rateLimit(`broadcast:${staff.orgId}:${staff.id}`,['test-send','launch','resume','run'].includes(action)?20:60,60);
    const body=await readJson(request,action==='import'?1_500_000:64_000);
    if(!path.length)return json(await createBroadcast(staff,body),201);
    if(path.length===1&&path[0]==='suppressions')return json(await addBroadcastSuppression(staff,body));
    const id=uuid(path[0]);
    if(path.length===1)return json(await updateBroadcast(staff,id,body));
    if(action==='preview'){if(Object.keys(body).length)throw new ApiError(400,'มีฟิลด์ข้อมูลที่ไม่รองรับ');return json(await previewBroadcast(staff,id));}
    if(action==='import')return json(await importBroadcastCsv(staff,id,body));
    if(action==='test-send')return json(await testSendBroadcast(staff,id,body));
    if(action==='launch')return json(await launchBroadcast(staff,id,body));
    if(action==='pause'||action==='resume'||action==='cancel')return json(await controlBroadcast(staff,id,action,body));
    if(action==='run')return json(await runBroadcastBatch(staff,id,body));
    throw new ApiError(404,'ไม่พบ API ที่ร้องขอ');
  }catch(error){return json({error:error instanceof ApiError?error.message:'broadcast_unavailable'},error instanceof ApiError?error.status:503);}
}
export const GET=handle;
export const POST=handle;
