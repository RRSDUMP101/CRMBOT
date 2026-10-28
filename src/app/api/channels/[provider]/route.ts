import { ApiError } from '@/lib/errors';
import { rateLimit } from '@/lib/auth';
import { ingestSocialWebhook, readSocialBody, readSocialConfig, socialProvider, socialVerificationChallenge } from '@/lib/social-channels';

export const dynamic = 'force-dynamic';
const headers = {'Cache-Control':'private, no-store','X-Robots-Tag':'noindex, nofollow'};
type Context = {params: Promise<{provider:string}>};
function failure(error: unknown) {
  return Response.json({error:error instanceof ApiError ? error.message : 'Webhook processing unavailable'}, {status:error instanceof ApiError ? error.status : 503,headers});
}
export async function GET(request: Request,context: Context) {
  try {const provider=socialProvider((await context.params).provider);await rateLimit('social-verification:'+provider,120,60);return new Response(socialVerificationChallenge(request,readSocialConfig(provider)),{headers:{...headers,'Content-Type':'text/plain; charset=utf-8'}});}
  catch(error) {return failure(error);}
}
export async function POST(request: Request,context: Context) {
  try {
    if(new URL(request.url).protocol !== 'https:') throw new ApiError(400,'HTTPS required');
    const provider=socialProvider((await context.params).provider);
    await rateLimit('social-webhook:'+provider,provider === 'whatsapp' ? 600 : 300,60);
    const result=await ingestSocialWebhook(provider,await readSocialBody(request),request.headers,readSocialConfig(provider));
    return Response.json({ok:true,...result},{headers});
  } catch(error) {return failure(error);}
}
