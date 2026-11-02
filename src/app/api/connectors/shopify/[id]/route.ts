import {ApiError,rateLimit} from '@/lib/auth';
import {shopifyWebhook} from '@/lib/external-commerce';
export const dynamic='force-dynamic';export const runtime='nodejs';
export async function POST(request:Request,context:{params:Promise<{id:string}>}){try{const {id}=await context.params;await rateLimit('shopify-webhook:'+id,300,60);return Response.json(await shopifyWebhook(id,request),{headers:{'Cache-Control':'no-store'}});}catch(error){return Response.json({error:error instanceof ApiError?error.message:'webhook_unavailable'},{status:error instanceof ApiError?error.status:503,headers:{'Cache-Control':'no-store'}});}}
