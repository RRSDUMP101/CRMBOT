/** Versioned server-to-server authentication; never import from a client component. */
export class BridgeError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = 'BridgeError'; }
}
export type BridgeCredentials = { secret: string; orgId: string };
const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
function credentials(value: BridgeCredentials) {
  if (value.secret.length < 32 || !value.orgId || value.orgId.length > 128 || /[\r\n]/.test(value.orgId))
    throw new BridgeError(503, 'Bridge credentials are not configured');
}
function target(value: string) {
  const url = new URL(value);
  if (url.username || url.password || url.hash || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    throw new BridgeError(400, 'Invalid bridge URL');
  return url.origin + url.pathname + url.search;
}
async function digest(body: string) { return hex(await crypto.subtle.digest('SHA-256', encoder.encode(body))); }
async function signature(url: string, method: string, body: string, time: string, value: BridgeCredentials) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(value.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const canonical = ['rrs-bridge-v1', method.toUpperCase(), target(url), value.orgId, time, await digest(body)].join('\n');
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(canonical)));
}
export async function signBridgeRequest(url: string, value: BridgeCredentials & { method?: string; body?: string; now?: number }): Promise<Headers> {
  credentials(value);
  const time = String(value.now ?? Date.now());
  return new Headers({
    'Content-Type': 'application/json', 'X-RRS-Bridge-Org': value.orgId,
    'X-RRS-Bridge-Time': time, 'X-RRS-Bridge-Signature': await signature(url, value.method ?? 'GET', value.body ?? '', time, value),
  });
}
export async function verifyBridgeRequest(request: Request, value: BridgeCredentials, maxBytes = 1024 * 1024): Promise<{ body: string }> {
  credentials(value);
  if (request.headers.has('origin') || request.headers.get('sec-fetch-site') === 'cross-site') throw new BridgeError(403, 'Server authentication required');
  const org = request.headers.get('x-rrs-bridge-org'), time = request.headers.get('x-rrs-bridge-time') ?? '';
  const received = request.headers.get('x-rrs-bridge-signature') ?? '';
  if (org !== value.orgId || !/^\d{13}$/.test(time) || Math.abs(Date.now() - Number(time)) > 300000 || !/^[a-f0-9]{64}$/.test(received))
    throw new BridgeError(401, 'Invalid bridge authentication');
  if (Number(request.headers.get('content-length') ?? 0) > maxBytes) throw new BridgeError(413, 'Bridge payload too large');
  const reader = request.body?.getReader(); let size = 0; const parts: Uint8Array[] = [];
  if (reader) { try {
    while (true) { const { done, value: chunk } = await reader.read(); if (done) break; size += chunk.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new BridgeError(413, 'Bridge payload too large'); } parts.push(chunk); }
  } finally { reader.releaseLock(); } }
  const bytes = new Uint8Array(size); let at = 0; for (const part of parts) { bytes.set(part, at); at += part.byteLength; }
  let body: string; try { body = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new BridgeError(400, 'Invalid UTF-8'); }
  const expected = await signature(request.url, request.method, body, time, value);
  let different = 0; for (let i = 0; i < 64; i++) different |= received.charCodeAt(i) ^ expected.charCodeAt(i);
  if (different !== 0) throw new BridgeError(401, 'Invalid bridge authentication');
  return { body };
}
export async function bridgePayloadHash(body: string): Promise<string> { return digest(body); }

