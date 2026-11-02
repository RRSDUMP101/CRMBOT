import {ApiError,assertOrigin,fields,readJson,requireAdmin,rateLimit,staffSession,uuid} from '@/lib/auth';
import {beginConnectorOAuth,completeConnectorOAuth,connectorOverview,controlConnector} from '@/lib/external-connectors';
import {connectorResources,subscribeShopify} from '@/lib/external-commerce';
import {manualSyncConnector} from '@/lib/external-sync';
import {dispatchEmail,queueEmailSelfTest,reconcileEmail} from '@/lib/external-mail';
export const dynamic='force-dynamic';export const runtime='nodejs';export const maxDuration=300;
type Context={params:Promise<{path?:string[]}>};const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
async function handle(request:Request,context:Context){try{
 const staff=(await staffSession(request))!,path=(await context.params).path||[],url=new URL(request.url);
 if(path.join('/')==='oauth/callback'&&request.method==='GET'){await completeConnectorOAuth(staff,url);return Response.redirect(new URL('/?connector=connected',url.origin),303);}
 if(request.method==='GET'&&!path.length)return Response.json(await connectorOverview(staff),{headers});
 if(request.method==='GET'&&path.length===2&&path[1]==='resources')return Response.json(await connectorResources(staff,uuid(path[0])),{headers});
 if(request.method!=='POST'||path.length!==1)throw new ApiError(404,'ไม่พบคำสั่ง');assertOrigin(request);requireAdmin(staff);await rateLimit(`connectors:${staff.orgId}:${staff.id}`,20,60);const input=await readJson(request,10000);
 let result:unknown;if(path[0]==='authorize')result=await beginConnectorOAuth(staff,input);else if(path[0]==='control')result=await controlConnector(staff,input);else if(path[0]==='reconcile')result=await reconcileEmail(staff,input);else if(path[0]==='subscribe')result=await subscribeShopify(staff,input);else if(path[0]==='sync')result=await manualSyncConnector(staff,input);else if(path[0]==='self-test'){const queued=await queueEmailSelfTest(staff,input);result={...queued,...await dispatchEmail(staff.orgId,queued.commandId)};}else throw new ApiError(404,'ไม่พบคำสั่ง');return Response.json(result,{headers});
 }catch(error){return Response.json({error:error instanceof ApiError?error.message:'connector_unavailable'},{status:error instanceof ApiError?error.status:503,headers});}}
export const GET=handle;export const POST=handle;
