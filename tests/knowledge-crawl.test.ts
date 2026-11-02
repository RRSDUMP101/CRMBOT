import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions, Runtime, serializeConfig } from 'miniflare';
import { fetchPublicKnowledge, knowledgeUrl } from '../src/lib/knowledge-crawl';

const saved = { ...process.env };
after(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });

test('exact allowlist cannot permit IP literals, canonicalized IPs, private names, credentials or non-HTTPS', () => {
  const blocked = [
    'https://127.0.0.1/', 'https://10.0.0.1/', 'https://169.254.169.254/',
    'https://0x7f000001/', 'https://2130706433/', 'https://0177.0.0.1/', 'https://127.1/',
    'https://[::1]/', 'https://[fd00::1]/', 'https://[fe80::1]/', 'https://[::ffff:127.0.0.1]/',
    'https://[2606:4700:4700::1111]/', 'https://localhost/', 'https://metadata.internal/',
    'https://office.local/', 'https://router.lan/', 'https://router.home.arpa/',
    'http://docs.example.com/', 'https://name:secret@docs.example.com/',
    'https://docs.example.com:8443/', 'https://docs.example.com./', 'https://docs.example.com/#part',
  ];
  for (const value of blocked) {
    process.env.AI_KNOWLEDGE_ALLOWED_HOSTS = new URL(value).hostname;
    assert.throws(() => knowledgeUrl(value), value);
  }
  process.env.AI_KNOWLEDGE_ALLOWED_HOSTS = 'docs.example.com';
  assert.equal(knowledgeUrl('https://DOCS.example.com/facts?q=a').href, 'https://docs.example.com/facts?q=a');
  for (const value of ['https://other.docs.example.com/', 'https://docs.example.com.attacker.com/', 'https://docs.example.com\\@attacker.com/', 'https://docs.example.com/\nsecret']) assert.throws(() => knowledgeUrl(value));
});

test('Node fails closed before outbound fetch even if configured as a Worker', async () => {
  process.env.RRS_WORKERS = 'true'; process.env.AI_KNOWLEDGE_ALLOWED_HOSTS = 'docs.example.com';
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('must not be called'); };
  try { await assert.rejects(fetchPublicKnowledge(new URL('https://docs.example.com/')), /Cloudflare/); assert.equal(calls, 0); }
  finally { globalThis.fetch = original; }
});

async function script(extra = '') {
  const result = await build({ stdin: { contents: `import {fetchPublicKnowledge} from './src/lib/knowledge-crawl'; export default {async fetch(request){try{${extra} const response=await fetchPublicKnowledge(new URL('https://docs.example.com/facts'));return response;}catch(error){return new Response(error.message,{status:error.status||502});}}};`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
  return result.outputFiles[0].text;
}

test('actual workerd crawler uses isolated GET with no caller credentials, redirect following, cache or private binding', async () => {
  const seen: Request[] = []; let redirect = false;
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: await script(), compatibilityDate: '2026-10-28', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'], bindings: { RRS_WORKERS: 'true', AI_KNOWLEDGE_ALLOWED_HOSTS: 'docs.example.com' }, outboundService: request => { seen.push(request as unknown as Request); return redirect ? new Response(null, { status: 302, headers: { location: 'https://private.example.com/secret' } }) : new Response('public facts', { headers: { 'content-type': 'text/plain' } }); } }));
  try {
    const result = await mf.dispatchFetch('https://crawler.invalid/', { headers: { Authorization: 'Bearer private', Cookie: 'session=private' } });
    assert.equal(result.status, 200); assert.equal(await result.text(), 'public facts'); assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://docs.example.com/facts'); assert.equal(seen[0].method, 'GET');
    assert.equal(seen[0].headers.get('authorization'), null); assert.equal(seen[0].headers.get('cookie'), null);
    assert.equal(seen[0].headers.get('accept'), 'text/html,text/plain');
    redirect = true;
    const redirected = await mf.dispatchFetch('https://crawler.invalid/', { redirect: 'manual' });
    assert.equal(redirected.status, 302); assert.equal(seen.length, 2);
    assert.equal(seen[1].url, 'https://docs.example.com/facts');
  } finally { await mf.dispose(); }
});

test('real public-only workerd network rejects DNS-to-loopback at connection time; private control reaches listener', async () => {
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.end('private fixture'); });
  await new Promise<void>(resolve => server.listen(0, 'localhost', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  // localhost is resolved by the runtime, not checked and resolved again in app
  // code. The raw probe isolates the network boundary from URL validation above.
  const probe = `export default {async fetch(){try{return await fetch('http://localhost:${address.port}/private',{signal:AbortSignal.timeout(2000)});}catch{return new Response('blocked',{status:403});}}};`;
  try {
    for (const allowPrivate of [false, true]) {
      const runtime = new Runtime(), abort = new AbortController();
      try {
        const ports = await runtime.updateConfig(serializeConfig({ services: [
          { name: 'crawler', worker: { modules: [{ name: 'worker.js', esModule: probe }], compatibilityDate: '2026-10-28', compatibilityFlags: ['global_fetch_strictly_public'], globalOutbound: { name: 'internet' } } },
          { name: 'internet', network: { allow: allowPrivate ? ['public', 'private'] : ['public'] } },
          { name: 'loopback', external: { address: `127.0.0.1:${address.port}`, http: {} } },
        ], sockets: [{ name: 'entry', address: '127.0.0.1:0', http: {}, service: { name: 'crawler' } }] }), { entryAddress: '127.0.0.1:0', loopbackAddress: `127.0.0.1:${address.port}`, requiredSockets: ['entry'] }, ['crawler'], abort.signal);
        const port=ports?.get('entry'); assert.ok(port);
        const response = await fetch(`http://127.0.0.1:${port}/`);
        assert.equal(response.status, allowPrivate ? 200 : 403); assert.equal(requests, allowPrivate ? 1 : 0);
      } finally { abort.abort(); await runtime.dispose(); }
    }
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('deployment retains the strictly-public global fetch compatibility boundary', async () => {
  const config = await readFile('wrangler.jsonc', 'utf8');
  const flags = JSON.parse(config.match(/"compatibility_flags"\s*:\s*(\[[^\]]*\])/)![1]) as string[];
  assert.ok(flags.includes('global_fetch_strictly_public'));
  assert.ok(!flags.includes('global_fetch_private_origin'));
});
