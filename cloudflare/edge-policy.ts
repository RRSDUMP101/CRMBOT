export function canonicalRedirect(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.hostname === 'www.rrs-crm-terminal.com') {
    url.hostname = 'rrs-crm-terminal.com';
    url.protocol = 'https:';
    url.port = '';
    return new Response(null, { status: 308, headers: { Location: url.href, 'Cache-Control': 'no-store' } });
  }
  if (url.hostname === 'rrs-crm-terminal.com' && url.protocol !== 'https:') {
    url.protocol = 'https:';
    return new Response(null, { status: 308, headers: { Location: url.href, 'Cache-Control': 'no-store' } });
  }
  return null;
}

export function protectResponse(request: Request, response: Response): Response {
  const result = new Response(response.body, response);
  const path = new URL(request.url).pathname;
  // Only content-addressed build assets and public font files may be cached.
  if (!(path.startsWith('/_next/static/') || path.startsWith('/fonts/')) || result.headers.has('set-cookie')) {
    result.headers.set('Cache-Control', result.headers.get('content-type')?.startsWith('text/event-stream')?'private, no-store, no-transform':'private, no-store');
    result.headers.set('CDN-Cache-Control', 'no-store');
    result.headers.set('Cloudflare-CDN-Cache-Control', 'no-store');
  }
  result.headers.set('X-Content-Type-Options', 'nosniff');
  result.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return result;
}
