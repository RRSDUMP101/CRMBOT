import {ApiError,staffSession} from '@/lib/auth';
import {automationHealth} from '@/lib/automation-health';
export const dynamic='force-dynamic';
export async function GET(request:Request){const headers={'Cache-Control':'private, no-store'};try{return Response.json(await automationHealth((await staffSession(request))!),{headers});}catch(e){return Response.json({error:e instanceof ApiError?e.message:'อ่านสถานะระบบไม่สำเร็จ'},{status:e instanceof ApiError?e.status:503,headers});}}
