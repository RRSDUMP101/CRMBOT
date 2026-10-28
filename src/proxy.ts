import { NextResponse, type NextRequest } from 'next/server';
import { validEdgeKey } from './lib/edge-access';

// Origin protection only. CRM session/tenant authorization stays in the API.
export function proxy(request: NextRequest) {
  if (process.env.RRS_EDGE_PROXY_REQUIRED !== 'true') return NextResponse.next();
  if (process.env.DEMO_MODE === 'true' || !validEdgeKey(request.headers.get('x-rrs-edge-key'), process.env.EDGE_PROXY_SECRET)) {
    return new NextResponse('Service unavailable', { status: 503, headers: { 'Cache-Control': 'private, no-store' } });
  }
  const headers = new Headers(request.headers);
  headers.delete('x-rrs-edge-key');
  const response = NextResponse.next({ request: { headers } });
  if (!request.nextUrl.pathname.startsWith('/_next/static/') && !request.nextUrl.pathname.startsWith('/fonts/')) response.headers.set('Cache-Control', 'private, no-store');
  return response;
}
