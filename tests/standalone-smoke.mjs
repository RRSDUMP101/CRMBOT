import assert from 'node:assert/strict';
import { cpSync } from 'node:fs';
import { spawn } from 'node:child_process';

cpSync('public', '.next/standalone/public', { recursive: true });
cpSync('.next/static', '.next/standalone/.next/static', { recursive: true });
const port = '3082';
const origin = 'http://127.0.0.1:' + port;
const key = 'synthetic-origin-test-key-1234567890';
const server = spawn(process.execPath, ['.next/standalone/server.js'], {
  env: { ...process.env, HOSTNAME: '127.0.0.1', PORT: port, DEMO_MODE: 'false', AI_PROVIDER: 'disabled',
    RRS_EDGE_PROXY_REQUIRED: 'true', EDGE_PROXY_SECRET: key, SESSION_SECRET: key, DATABASE_URL: '', APP_ORIGIN: origin },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
server.stdout.on('data', b => { logs += b; });
server.stderr.on('data', b => { logs += b; });
try {
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { if ((await fetch(origin + '/login')).status === 503) { ready = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(ready, 'standalone server did not start: ' + logs);
  for (const path of ['/login', '/', '/api/admin/snapshot', '/api/health']) {
    assert.equal((await fetch(origin + path)).status, 503, path + ' exposed without origin key');
    assert.equal((await fetch(origin + path, { headers: { 'x-rrs-edge-key': 'forged' } })).status, 503);
  }
  const headers = { 'x-rrs-edge-key': key };
  const response = await fetch(origin + '/login', { headers });
  assert.equal(response.status, 200);
  const html = await response.text();
  const asset = html.match(/src="([^"]*\/_next\/static\/[^"]+\.js)"/)?.[1];
  assert.ok(asset, 'standalone login has no JavaScript asset');
  assert.equal((await fetch(origin + asset, { headers })).status, 200, 'static asset missing from standalone');
  assert.equal((await fetch(origin + '/login?next=%2F', { headers })).status, 200, 'login refresh failed');
  const health = await fetch(origin + '/api/health', { headers });
  assert.equal(health.status, 503, 'unconfigured database must not be ready');
  assert.deepEqual(await health.json(), { status: 'not_ready' });
  console.log('Standalone smoke passed: origin protection, login refresh, bundled asset, readiness fails closed.');
} finally {
  server.kill('SIGTERM');
}
