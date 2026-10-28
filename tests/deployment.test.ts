import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalRedirect, protectResponse } from '../cloudflare/edge-policy';
import { providerName, generateReply } from '../src/lib/bot';
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
