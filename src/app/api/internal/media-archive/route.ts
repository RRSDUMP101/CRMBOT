import {ApiError} from '@/lib/errors';
import {verifyMediaArchiveRunner} from '@/lib/media-archive-auth';
import {runMediaArchiveJobs} from '@/lib/media-archive-queue';
import {readSocialConfig} from '@/lib/social-channels';
export const dynamic='force-dynamic';
export const maxDuration=120;
export async function POST(request:Request){
  const headers={'Cache-Control':'private, no-store, no-transform','X-Content-Type-Options':'nosniff'};
  try{
    await verifyMediaArchiveRunner(request,process.env.APP_ORIGIN||'',process.env.SESSION_SECRET||'');
    const config=readSocialConfig('whatsapp');
    if(process.env.SOCIAL_MEDIA_ARCHIVE_ENABLED!=='true'||config.owner!=='crm'||!config.inboundEnabled||!config.orgId)return Response.json({disabled:true,results:[]},{headers});
    return Response.json(await runMediaArchiveJobs(config.orgId,4),{headers});
  }catch(error){return Response.json({error:error instanceof ApiError?error.message:'Archive runner unavailable'},{status:error instanceof ApiError?error.status:503,headers});}
}
