import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readdir,readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {seedDemoDatabase} from '../src/lib/seed-demo';
const origin='http://127.0.0.1:8787';
const mf=new Miniflare(convertV4MiniflareOptions({
  host:'127.0.0.1',port:8787,modules:true,scriptPath:'.wrangler/bundle/worker.js',
  compatibilityDate:'2026-10-28',compatibilityFlags:['nodejs_compat','global_fetch_strictly_public'],
  bindings:{APP_ORIGIN:origin,RRS_WORKERS:'true',DEMO_MODE:'false',PUBLIC_ORG_SLUG:'rrs',AI_PROVIDER:'demo',AI_DAILY_CALL_LIMIT:'1000',SESSION_SECRET:'synthetic-local-worker-secret-never-use-in-production',TRUSTED_IP_HEADER:'cf-connecting-ip'},
  d1Databases:['DB'],r2Buckets:['BUCKET'],
}));
async function run(file:string){await new Promise<void>((resolve,reject)=>{
  const child=spawn(process.execPath,['--import','tsx','--test',file],{stdio:'inherit',env:{...process.env,BASE_URL:origin,TEST_WORKER_LOCAL:'1'}});
  child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`${file} failed with ${code}`)));
});}
async function main(){try {
  await mf.ready;const db=await mf.getD1Database('DB');
  for(const name of (await readdir('migrations/d1')).filter(n=>n.endsWith('.sql')).sort()){
    const sql=await readFile('migrations/d1/'+name,'utf8');await db.batch(sql.split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
  }
  await seedDemoDatabase(db as any);
  const health=await mf.dispatchFetch(origin+'/api/health');if(health.status!==200)throw new Error(`Worker health: ${health.status} ${await health.text()}`);
  const page=await mf.dispatchFetch(origin+'/login');if(page.status!==200)throw new Error(`Worker login page: ${page.status}`);
  const html=await page.text();const assets=[...html.matchAll(/(?:src|href)="([^" ]+\.(?:js|css|woff2))"/g)].map(m=>m[1]);
  if(!assets.length)throw new Error('No static asset URLs in login page');
  for(const asset of assets){const response=await mf.dispatchFetch(new URL(asset,origin));if(response.status!==200)throw new Error(`Broken asset ${asset}`);}
  console.log(`Worker health, login HTML and ${assets.length} static assets passed.`);
  await run('tests/api.test.ts');await run('tests/helpdesk.test.ts');await run('tests/files-api.test.ts');
} finally {await mf.dispose();}}
main().catch(error=>{console.error(error);process.exitCode=1;});
