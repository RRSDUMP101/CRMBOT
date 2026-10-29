import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applicationRequest, canonicalRedirect, protectResponse } from '../cloudflare/edge-policy';
import { providerName, generateReply } from '../src/lib/bot';

test('edge request uses actual HTTPS URL and strips forged forwarding without changing signed bytes', async () => {
  const url='https://crm-fixture.test/api/bridge/a%20b?q=%2F&x=1',body='{"synthetic":true}';
  const original=new Request(url,{method:'POST',body,headers:{Host:'forged.invalid','X-Forwarded-Host':'forged.invalid','X-Forwarded-Proto':'http','X-Forwarded-Port':'80',Forwarded:'host=forged.invalid;proto=http','x-middleware-subrequest':'middleware','x-proof-fixture':'unchanged'}});
  const normalized=applicationRequest(original);
  assert.equal(normalized.url,url);assert.equal(normalized.method,'POST');assert.equal(await normalized.text(),body);
  assert.equal(normalized.headers.get('host'),'crm-fixture.test');assert.equal(normalized.headers.get('x-forwarded-host'),'crm-fixture.test');
  assert.equal(normalized.headers.get('x-forwarded-proto'),'https');assert.equal(normalized.headers.get('x-forwarded-port'),'443');
  assert.equal(normalized.headers.has('forwarded'),false);assert.equal(normalized.headers.has('x-middleware-subrequest'),false);assert.equal(normalized.headers.get('x-proof-fixture'),'unchanged');
});

test('edge normalization preserves actual nondefault port and HTTP rather than assuming a configured origin',()=>{
  const normalized=applicationRequest(new Request('http://127.0.0.1:8787/api/health?probe=1',{headers:{'x-forwarded-proto':'https','x-forwarded-host':'other.invalid'}}));
  assert.equal(normalized.url,'http://127.0.0.1:8787/api/health?probe=1');assert.equal(normalized.headers.get('host'),'127.0.0.1:8787');
  assert.equal(normalized.headers.get('x-forwarded-host'),'127.0.0.1:8787');assert.equal(normalized.headers.get('x-forwarded-proto'),'http');assert.equal(normalized.headers.get('x-forwarded-port'),'8787');
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

test('realtime responses keep streaming protection through the Worker edge',()=>{
  const response=protectResponse(new Request('https://rrs-crm-terminal.com/api/admin/events'),new Response('event: change\ndata: {}\n\n',{headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'private, no-store, no-transform'}}));
  assert.equal(response.headers.get('cache-control'),'private, no-store, no-transform');
  assert.equal(response.headers.get('cloudflare-cdn-cache-control'),'no-store');
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
