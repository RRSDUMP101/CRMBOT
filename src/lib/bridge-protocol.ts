/** Versioned server-to-server authentication; never import from a client component. */
export class BridgeError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = 'BridgeError'; }
}
export type BridgeCredentials = { secret: string; orgId: string; keys?: Record<string,string>; currentKeyId?: string; allowLegacy?: boolean;
  claimNonce?: (keyId:string,nonce:string,expiresAt:number)=>Promise<boolean> };
const KEY_ID=/^[A-Za-z0-9_.-]{1,32}$/;
/** Explicit configuration; invalid key rings fail closed rather than falling back to v1. */
export function bridgeKeyConfig(env:Record<string,unknown>,prefix='CRM_BRIDGE'):Pick<BridgeCredentials,'keys'|'currentKeyId'|'allowLegacy'>{
  const raw=env[prefix+'_KEYS'],current=env[prefix+'_KEY_CURRENT'];
  if(raw===undefined&&current===undefined)return {};
  let keys:unknown;try{keys=JSON.parse(String(raw));}catch{throw new BridgeError(503,'Bridge key ring is invalid');}
  if(!keys||typeof keys!=='object'||Array.isArray(keys)||Object.keys(keys).length>8||!Object.keys(keys).length||typeof current!=='string'||!KEY_ID.test(current))throw new BridgeError(503,'Bridge key ring is invalid');
  const ring=keys as Record<string,string>;
  if(Object.entries(ring).some(([id,key])=>!KEY_ID.test(id)||typeof key!=='string'||key.length<32||key.length>4096)||!Object.hasOwn(ring,current))throw new BridgeError(503,'Bridge key ring is invalid');
  return {keys:ring,currentKeyId:current,allowLegacy:env[prefix+'_ALLOW_LEGACY']==='true'};
}
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
async function signature(url: string, method: string, body: string, time: string, value: BridgeCredentials,keyId?:string,nonce?:string) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(keyId?value.keys![keyId]:value.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const canonical = keyId?['rrs-bridge-v2',method.toUpperCase(),target(url),value.orgId,time,keyId,nonce!,await digest(body)].join('\n'):['rrs-bridge-v1', method.toUpperCase(), target(url), value.orgId, time, await digest(body)].join('\n');
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(canonical)));
}
export async function signBridgeRequest(url: string, value: BridgeCredentials & { method?: string; body?: string; now?: number }): Promise<Headers> {
  credentials(value);
  const time = String(value.now ?? Date.now());
  if(value.keys){
    const keyId=value.currentKeyId;if(!keyId||!KEY_ID.test(keyId)||!Object.hasOwn(value.keys,keyId))throw new BridgeError(503,'Bridge signing key is unavailable');
    const nonce=hex(crypto.getRandomValues(new Uint8Array(16)).buffer);
    return new Headers({'Content-Type':'application/json','X-RRS-Bridge-Org':value.orgId,'X-RRS-Bridge-Time':time,'X-RRS-Bridge-Version':'2','X-RRS-Bridge-Key-Id':keyId,'X-RRS-Bridge-Nonce':nonce,'X-RRS-Bridge-Signature':await signature(url,value.method??'GET',value.body??'',time,value,keyId,nonce)});
  }
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
  const version=request.headers.get('x-rrs-bridge-version'),keyId=request.headers.get('x-rrs-bridge-key-id'),nonce=request.headers.get('x-rrs-bridge-nonce');
  const v2=version==='2';
  if(v2){
    if(!keyId||!KEY_ID.test(keyId)||!nonce||!/^[a-f0-9]{32}$/.test(nonce)||!value.keys||!Object.hasOwn(value.keys,keyId))throw new BridgeError(401,'Invalid bridge authentication');
    if(!value.claimNonce)throw new BridgeError(503,'Bridge replay protection is unavailable');
  }else if((version!==null&&version!=='1')||keyId!==null||nonce!==null||(value.keys&&!value.allowLegacy))throw new BridgeError(401,'Invalid bridge authentication');
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
  const expected = await signature(request.url, request.method, body, time, value,v2?keyId!:undefined,v2?nonce!:undefined);
  let different = 0; for (let i = 0; i < 64; i++) different |= received.charCodeAt(i) ^ expected.charCodeAt(i);
  if (different !== 0) throw new BridgeError(401, 'Invalid bridge authentication');
  if(v2&&!await value.claimNonce!(keyId!,nonce!,Number(time)+300000))throw new BridgeError(401,'Bridge request already used');
  return { body };
}
export async function bridgePayloadHash(body: string): Promise<string> { return digest(body); }

