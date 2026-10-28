import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalRedirect, protectResponse } from '../cloudflare/edge-policy';
import { providerName, generateReply } from '../src/lib/bot';
import { forward } from '../cloudflare/worker';
import { validEdgeKey } from '../src/lib/edge-access';

test('direct origin access rejects missing, short and forged keys', () => {
  const key = 'synthetic-key-for-tests-only-123456789';
  assert.equal(validEdgeKey(null, key), false);
  assert.equal(validEdgeKey('short', 'short'), false);
  assert.equal(validEdgeKey('x'.repeat(key.length), key), false);
  assert.equal(validEdgeKey(key, key), true);
});
test('unconfigured edge fails closed and does not contact any backend', async () => {
  for (const BACKEND_ORIGIN of [undefined, 'http://bad.run.app', 'https://example.com', 'https://test.run.app/path']) {
    const response = await forward(new Request('https://rrs-crm-terminal.com/api/admin/snapshot'), { BACKEND_ORIGIN, EDGE_PROXY_SECRET: 'x'.repeat(32) }, (() => { throw new Error('must not fetch'); }) as typeof fetch);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
});
test('edge overwrites forged proxy identity, preserves path/query and never follows redirects', async () => {
  const request = new Request('https://rrs-crm-terminal.com/api/message?q=a%20b', { method: 'POST', body: 'synthetic', headers: {
    'x-rrs-edge-key': 'forged', 'x-rrs-client-ip': 'forged', 'x-forwarded-for': 'forged', 'cf-connecting-ip': '192.0.2.17', 'x-middleware-subrequest': 'proxy', Origin: 'https://rrs-crm-terminal.com',
  } });
  const response = await forward(request, { BACKEND_ORIGIN: 'https://synthetic.run.app', EDGE_PROXY_SECRET: 'x'.repeat(32) }, (async (input, init) => {
    assert.equal(String(input), 'https://synthetic.run.app/api/message?q=a%20b');
    const h = new Headers(init?.headers);
    assert.equal(h.get('x-rrs-edge-key'), 'x'.repeat(32));
    assert.equal(h.get('x-rrs-client-ip'), '192.0.2.17');
    assert.equal(h.has('x-forwarded-for'), false);
    assert.equal(h.has('x-middleware-subrequest'), false);
    assert.equal(h.get('origin'), 'https://rrs-crm-terminal.com');
    assert.equal(init?.redirect, 'manual');
    assert.equal(init?.cache, 'no-store');
    assert.equal(await new Response(init?.body).text(), 'synthetic');
    return new Response('stream', { headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'stream');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

test('www redirects to HTTPS apex preserving encoded path and query', () => {
  const response = canonicalRedirect(new Request('http://www.rrs-crm-terminal.com/chat/a%20b?q=hello%20world&x=%2F'))!;
  assert.equal(response.status, 308);
  assert.equal(response.headers.get('location'), 'https://rrs-crm-terminal.com/chat/a%20b?q=hello%20world&x=%2F');
});
test('HTTPS apex is not redirected and HTTP apex is upgraded', () => {
  assert.equal(canonicalRedirect(new Request('https://rrs-crm-terminal.com/login')), null);
  assert.equal(canonicalRedirect(new Request('http://rrs-crm-terminal.com/login?next=%2F'))?.headers.get('location'), 'https://rrs-crm-terminal.com/login?next=%2F');
});
test('CRM, API and widget responses cannot be publicly cached', () => {
  for(const path of ['/', '/login', '/api/admin/snapshot', '/widget', '/chat']) {
    const response = protectResponse(new Request('https://rrs-crm-terminal.com'+path),new Response('synthetic',{headers:{'Cache-Control':'public,max-age=3600'}}));
    assert.equal(response.headers.get('cache-control'),'private, no-store');
    assert.equal(response.headers.get('cloudflare-cdn-cache-control'),'no-store');
  }
});
test('only public assets remain cacheable; cookies always disable caching', () => {
  const request=new Request('https://rrs-crm-terminal.com/_next/static/abc.js');
  assert.equal(protectResponse(request,new Response('asset',{headers:{'Cache-Control':'public,max-age=31536000,immutable'}})).headers.get('cache-control'),'public,max-age=31536000,immutable');
  assert.equal(protectResponse(request,new Response('asset',{headers:{'Set-Cookie':'synthetic=x'}})).headers.get('cache-control'),'private, no-store');
});
test('unset or disabled AI never falls back to a Demo bot', async () => {
  const prior=process.env.AI_PROVIDER;
  try {
    delete process.env.AI_PROVIDER;
    assert.equal(providerName(),'disabled');
    process.env.AI_PROVIDER='disabled';
    await assert.rejects(async()=>{ for await(const _ of generateReply({history:[],facts:{},knowledge:[],settings:{botName:'test',personality:'',businessHours:'',handoffRule:'',aiEnabled:true}})) {} },/disabled/);
  } finally { if(prior===undefined)delete process.env.AI_PROVIDER;else process.env.AI_PROVIDER=prior; }
});
