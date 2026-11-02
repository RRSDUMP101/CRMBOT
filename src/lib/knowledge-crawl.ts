import { ApiError } from './errors';

const hostnamePattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const localName = /(?:^|\.)(?:localhost|local|internal|lan|home|onion|arpa)$/i;

/** An exact hostname allowlist is additional policy, not a DNS/SSRF boundary. */
export function knowledgeUrl(value: string | URL): URL {
  let url: URL;
  try {
    if (/[\x00-\x20\x7f\\]/.test(String(value))) throw new Error('Invalid URL');
    url = new URL(String(value));
  } catch { throw new ApiError(400, 'URLไม่ถูกต้อง'); }
  const host = url.hostname.toLowerCase();
  const allowed = String(process.env.AI_KNOWLEDGE_ALLOWED_HOSTS || '').split(',').map(x => x.trim().toLowerCase());
  // URL canonicalization also turns hexadecimal/octal/short IPv4 into an IP.
  // Reject ALL IP literals, single-label names and special local DNS suffixes,
  // even when an administrator accidentally adds them to the allowlist.
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
      !hostnamePattern.test(host) || localName.test(host) || !allowed.includes(host)) {
    throw new ApiError(403, 'เว็บไซต์นี้ไม่ได้อยู่ในรายการสาธารณะที่ผู้ดูแลอนุญาต');
  }
  return url;
}

export const knowledgeFetchOptions = (): RequestInit => ({
  method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store',
  signal: AbortSignal.timeout(10_000), headers: { Accept: 'text/html,text/plain' },
});

/**
 * Only the Worker global fetch may perform real crawling. Cloudflare's public
 * network blocks private resolved destinations at connection time; the deployed
 * global_fetch_strictly_public flag also prevents a same-zone origin bypass.
 * Never replace this with DNS-check-then-fetch, a VPC/service binding, resolve
 * override, or Node fetch (which can reach the developer/server's private LAN).
 * Local Node fails closed. Local workerd must use the same public-only outbound
 * network as production (see the real workerd regression fixture).
 */
export async function fetchPublicKnowledge(value: URL): Promise<Response> {
  const url = knowledgeUrl(value);
  if (process.env.RRS_WORKERS !== 'true' ||
      typeof navigator === 'undefined' || navigator.userAgent !== 'Cloudflare-Workers') {
    throw new ApiError(503, 'การอ่านเว็บไซต์ต้องทำผ่านระบบ Cloudflare ที่จำกัดเครือข่ายสาธารณะ');
  }
  return globalThis.fetch(url, knowledgeFetchOptions());
}
