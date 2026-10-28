import { canonicalRedirect, protectResponse } from './edge-policy';

export type Env = { BACKEND_ORIGIN?: string; EDGE_PROXY_SECRET?: string };

// Only the configured Cloud Run service is reachable. Secrets belong in each
// provider's secret store; the incoming request cannot select an upstream host.
export async function forward(request: Request, env: Env, send: typeof fetch = fetch): Promise<Response> {
  const redirect = canonicalRedirect(request);
  if (redirect) return redirect;
  const unavailable = () => protectResponse(request, new Response('Service unavailable', { status: 503 }));
  let backend: URL;
  try {
    backend = new URL(env.BACKEND_ORIGIN || '');
    if (backend.origin !== env.BACKEND_ORIGIN || backend.protocol !== 'https:' || !backend.hostname.endsWith('.run.app') || backend.username || backend.password) return unavailable();
  } catch { return unavailable(); }
  if ((env.EDGE_PROXY_SECRET || '').length < 32) return unavailable();
  const incoming = new URL(request.url);
  backend.pathname = incoming.pathname;
  backend.search = incoming.search;
  const headers = new Headers(request.headers);
  for (const name of ['host', 'forwarded', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-for', 'x-rrs-edge-key', 'x-rrs-client-ip', 'x-middleware-subrequest']) headers.delete(name);
  headers.set('x-rrs-edge-key', env.EDGE_PROXY_SECRET!);
  headers.set('x-rrs-client-ip', request.headers.get('cf-connecting-ip') || 'unknown');
  headers.set('x-forwarded-host', incoming.host);
  headers.set('x-forwarded-proto', 'https');
  try {
    const response = await send(backend, {
      method: request.method, headers, redirect: 'manual',
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      // SSE streams directly. No upstream traffic is stored in shared cache.
      cache: 'no-store',
      ...(!['GET', 'HEAD'].includes(request.method) ? { duplex: 'half' } : {}),
    } as RequestInit);
    return protectResponse(request, response);
  } catch { return unavailable(); }
}

export default { fetch(request: Request, env: Env) { return forward(request, env); } };
