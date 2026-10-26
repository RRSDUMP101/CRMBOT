import { getWidgetEmbedConfig } from '@/lib/helpdesk';
import { widgetDocument } from '@/lib/widget-document';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export async function GET() {
  try {
    const config=await getWidgetEmbedConfig();
    if(!config.enabled)return new Response('วิดเจ็ตถูกปิดโดยผู้ดูแล',{status:403,headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"}});
    const frames=["'self'",...config.allowedOrigins];
    return new Response(widgetDocument(config),{headers:{
      'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store',
      'Content-Security-Policy':`default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors ${frames.join(' ')}`,
      'X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin'
    }});
  }catch {return new Response('เปิดแชตไม่สำเร็จ กรุณาลองใหม่',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}});}
}
