import {randomUUID} from 'node:crypto';
import {ApiError,STAFF_COOKIE,assertOrigin,cookieValue,hashToken,rateLimit,readJson,requireAdmin,staffSession} from '@/lib/auth';
import {completeSocialOAuth,describeSocialAccountError,rotateSocialTokenKeys,saveLineAccount,selectSocialAsset,socialAccountAction,socialAccountDetail,socialAccountsEnabled,socialAccountsOverview,startSocialOAuth} from '@/lib/social-accounts';

export const dynamic='force-dynamic';
export const maxDuration=120;
type Context={params:Promise<{path?:string[]}>};
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The OAuth return lands back on the wizard; the code/state never appear in the redirect or a Referer. */
function backToWizard(request:Request,reason?:string){
  const origin=process.env.APP_ORIGIN||new URL(request.url).origin;
  const target=new URL('/',origin);
  target.searchParams.set('connection',reason?'failed':'returned');
  if(reason&&/^[a-z_]{3,60}$/.test(reason))target.searchParams.set('reason',reason);
  target.hash='social-accounts';
  return new Response(null,{status:303,headers:{...headers,Location:target.toString()}});
}
function failure(error:unknown){
  if(error instanceof ApiError){
    const {message,next}=describeSocialAccountError(error.message);
    return Response.json({error:message,next,code:/^[a-z_]{3,60}$/.test(error.message)?error.message:undefined},{status:error.status,headers});
  }
  const incident=randomUUID();
  console.error('[rrs] social_accounts_failed',{incident,type:error instanceof Error?error.name:'Unknown'});
  return Response.json({error:`ระบบไม่สามารถทำรายการได้ กรุณาลองใหม่ (รหัส ${incident.slice(0,8)})`,next:'ลองอีกครั้ง หรือรีเฟรชหน้า'},{status:503,headers});
}

async function handle(request:Request,context:Context){
  const path=(await context.params).path??[],route=path.join('/'),method=request.method;
  const callback=method==='GET'&&route==='oauth/callback';
  // Default off: the whole surface (including the OAuth return) is absent unless explicitly enabled.
  if(!socialAccountsEnabled())return Response.json({error:'ไม่พบ API ที่ร้องขอ'},{status:404,headers});
  try{
    if(new URL(request.url).protocol!=='https:')throw new ApiError(400,'https_required');
    const staff=await staffSession(request,!callback);
    if(!staff)throw new ApiError(401,'login_required');
    requireAdmin(staff);
    // The session token hash binds an OAuth state to this exact login, not just this member.
    const token=cookieValue(request,STAFF_COOKIE),sessionKey=token?hashToken(token):'';
    if(method==='GET'){
      if(callback){
        await rateLimit(`social-accounts-callback:${staff.orgId}:${staff.id}`,20,600);
        const result=await completeSocialOAuth(staff,sessionKey,new URL(request.url).searchParams);
        return backToWizard(request,result.status==='awaiting_selection'?undefined:result.errorCode||'provider_check_failed');
      }
      if(!route)return Response.json(await socialAccountsOverview(staff,sessionKey),{headers});
      if(path.length===1&&UUID.test(path[0]))return Response.json(await socialAccountDetail(staff,path[0]),{headers});
      throw new ApiError(404,'not_found');
    }
    if(method!=='POST')throw new ApiError(404,'not_found');
    assertOrigin(request);
    const body=await readJson(request);
    await rateLimit(`social-accounts:${staff.orgId}:${staff.id}`,30,60);
    if(route==='oauth/start'){await rateLimit(`social-accounts-oauth:${staff.orgId}:${staff.id}`,10,600);return Response.json(await startSocialOAuth(staff,sessionKey,body),{headers});}
    if(route==='select'){await rateLimit(`social-accounts-provider:${staff.orgId}:${staff.id}`,12,60);return Response.json(await selectSocialAsset(staff,sessionKey,body),{headers});}
    if(route==='line')return Response.json(await saveLineAccount(staff,body),{headers});
    if(route==='rotate-keys')return Response.json(await rotateSocialTokenKeys(staff),{headers});
    if(path.length===1&&UUID.test(path[0])){
      if(['validate','verify','disconnect'].includes(String(body.action)))await rateLimit(`social-accounts-provider:${staff.orgId}:${staff.id}`,12,60);
      return Response.json(await socialAccountAction(staff,path[0],body),{headers});
    }
    throw new ApiError(404,'not_found');
  }catch(error){
    if(callback){
      const reason=!(error instanceof ApiError)?'provider_check_failed':/^[a-z_]{3,60}$/.test(error.message)?error.message:error.status===401?'login_required':error.status===403?'admin_required':'provider_check_failed';
      return backToWizard(request,reason);
    }
    return failure(error);
  }
}
export const GET=handle;
export const POST=handle;
