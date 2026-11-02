// @ts-ignore Generated public build assets only; never include private R2 objects.
import assets from '../.open-next/embedded-assets.mjs';
import {gunzipSync} from 'node:zlib';
// Public build assets only; compression lowers upload/startup size. Browsers
// receive original bytes regardless of their negotiated content encoding.
const decoded=new Map<string,Uint8Array>();
export const bundledAssets={async fetch(request:Request):Promise<Response>{
  if(!['GET','HEAD'].includes(request.method))return new Response(null,{status:405});
  const pathname=new URL(request.url).pathname;const asset=(assets as unknown as Record<string,[string,string,string?]>)[pathname];
  if(!asset)return new Response(null,{status:404});
  let body:Uint8Array|undefined;
  if(request.method!=='HEAD'){body=decoded.get(pathname);if(!body){const bytes=Buffer.from(asset[0],'base64');body=asset[2]==='gzip'?new Uint8Array(gunzipSync(bytes)):new Uint8Array(bytes);decoded.set(pathname,body);}}
  return new Response(body as BodyInit|undefined,{headers:{'Content-Type':asset[1],'Cache-Control':pathname.startsWith('/_next/static/')?'public,max-age=31536000,immutable':'public,max-age=3600','X-Content-Type-Options':'nosniff'}});
}};
