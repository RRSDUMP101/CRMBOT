import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applicationRequest, canonicalRedirect, protectResponse } from '../cloudflare/edge-policy';
import { providerName, generateReply } from '../src/lib/bot';
import {configureMediaArchiveSchedule,checkMediaArchiveSchedule} from '../scripts/media-archive-deployment.mjs';

test('minute cron serves each independent automation gate while archive remains disabled',()=>{
  const base={vars:{SOCIAL_MEDIA_ARCHIVE_ENABLED:'false'},triggers:{crons:['15 3 * * *']},d1_databases:[{binding:'DB',database_id:'fixture'}],r2_buckets:[{binding:'BUCKET',bucket_name:'fixture'}],services:[{binding:'SALE_SERVICE',service:'sale-fixture'}]};
  const gates=[{CRM_BRIDGE_ENABLED:'true',CRM_SALE_SYNC_ENABLED:'true'},{CRM_BRIDGE_ENABLED:'true',CRM_SALE_CONTEXT_ENABLED:'true'},{FLOWS_ENABLED:'true'},{BROADCAST_ENABLED:'true',BROADCAST_RUNNER_ENABLED:'true'},{CRM_PUBLIC_WEBHOOKS_ENABLED:'true',CRM_PUBLIC_WEBHOOK_RUNNER_ENABLED:'true'},{EXTERNAL_CONNECTORS_ENABLED:'true',EXTERNAL_CONNECTOR_RUNNER_ENABLED:'true'}];
  for(const gate of gates){
    const input={...base,vars:{...base.vars,...gate}},configured=configureMediaArchiveSchedule(input);
    assert.deepEqual(configured.triggers.crons,['15 3 * * *','* * * * *']);
    assert.deepEqual(checkMediaArchiveSchedule(configured),{enabled:false,cronConfigured:true});
    assert.deepEqual(configureMediaArchiveSchedule(configured),configured);
    assert.deepEqual(configured.d1_databases,base.d1_databases);assert.deepEqual(configured.r2_buckets,base.r2_buckets);assert.deepEqual(configured.services,base.services);
    assert.deepEqual(input.triggers.crons,['15 3 * * *'],'does not mutate input');
    for(const key of Object.keys(gate))assert.deepEqual(configureMediaArchiveSchedule({...configured,vars:{...configured.vars,[key]:'false'}}).triggers.crons,['15 3 * * *']);
  }
});

test('archive ownership validation stays strict and stopping one runner preserves the others',()=>{
  const base={vars:{SOCIAL_MEDIA_ARCHIVE_ENABLED:'false',FLOWS_ENABLED:'true',CRM_BRIDGE_ENABLED:'true',CRM_SALE_SYNC_ENABLED:'true'},triggers:{crons:['* * * * *','* * * * *','0 0 * * *']}};
  assert.deepEqual(configureMediaArchiveSchedule(base).triggers.crons,['0 0 * * *','* * * * *']);
  assert.deepEqual(configureMediaArchiveSchedule({...base,vars:{...base.vars,FLOWS_ENABLED:'false'}}).triggers.crons,['0 0 * * *','* * * * *']);
  assert.throws(()=>configureMediaArchiveSchedule({...base,vars:{...base.vars,SOCIAL_MEDIA_ARCHIVE_ENABLED:'true',SOCIAL_CHANNELS_OWNER:'sale'}}),/ownership/);
  assert.throws(()=>checkMediaArchiveSchedule({...base,triggers:{crons:[]}}),/Minute cron/);
  for(const vars of [{BROADCAST_RUNNER_ENABLED:'true'},{CRM_PUBLIC_WEBHOOK_RUNNER_ENABLED:'true'},{EXTERNAL_CONNECTOR_RUNNER_ENABLED:'true'},{CRM_SALE_SYNC_ENABLED:'true'}])assert.deepEqual(configureMediaArchiveSchedule({vars,triggers:{crons:[]}}).triggers.crons,[]);
});

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
