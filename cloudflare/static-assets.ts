// @ts-ignore Generated public build assets only; never include private R2 objects.
import assets from '../.open-next/embedded-assets.mjs';
export const bundledAssets={async fetch(request:Request):Promise<Response>{
  if(!['GET','HEAD'].includes(request.method))return new Response(null,{status:405});
  const pathname=new URL(request.url).pathname;const asset=(assets as unknown as Record<string,[string,string]>)[pathname];
  if(!asset)return new Response(null,{status:404});
  return new Response(request.method==='HEAD'?null:Buffer.from(asset[0],'base64'),{headers:{'Content-Type':asset[1],'Cache-Control':pathname.startsWith('/_next/static/')?'public,max-age=31536000,immutable':'public,max-age=3600','X-Content-Type-Options':'nosniff'}});
}};
