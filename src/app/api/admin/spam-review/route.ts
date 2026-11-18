import {ApiError, assertOrigin, rateLimit, readJson, staffSession} from '@/lib/auth';
import {configureSpam, reviewSpam, spamHistory, spamQueue} from '@/lib/whatsapp-triage';

export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
async function handle(request:Request) {
  try {
    const url=new URL(request.url);
    if(url.protocol!=='https:')throw new ApiError(400,'HTTPS required');
    const staff=(await staffSession(request))!;
    if(request.method==='GET'&&url.searchParams.has('messageId'))return Response.json(await spamHistory(staff,url.searchParams.get('messageId')||''),{headers});
    if(request.method==='GET')return Response.json(await spamQueue(staff,url.searchParams.get('filter')||'pending',Number(url.searchParams.get('before')||Number.MAX_SAFE_INTEGER),url.searchParams.get('afterId')||''),{headers});
    assertOrigin(request);
    await rateLimit('spam-review:'+staff.orgId+':'+staff.id,60,60);
    const body=await readJson(request);
    return Response.json(await ('mode' in body?configureSpam(staff,body):reviewSpam(staff,body)),{headers});
  } catch(error) {
    return Response.json({error:error instanceof ApiError?error.message:'ไม่สามารถเปิดคิวตรวจข้อความได้'},{status:error instanceof ApiError?error.status:503,headers});
  }
}
export const GET=handle;
export const POST=handle;
