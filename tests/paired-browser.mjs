// Local-only review harness: actual CRM route/service + SQLite, actual Sale APIs + D1,
// actual React components from both repositories. All identities and messages are synthetic.
import http from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
const crm=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(!process.env.RRS_SALE_CHECKOUT)throw Error('Set RRS_SALE_CHECKOUT to the companion Sale Office checkout with dependencies installed');
const sale=path.resolve(process.env.RRS_SALE_CHECKOUT),here=path.join(crm,'.data','paired-browser-'+Date.now());
await mkdir(here,{recursive:true});
process.chdir(crm);
// The loopback adapter below simulates this internal HTTPS origin and injects test
// cookies. It does not validate real browser HTTPS, host cookies or a provider connection.
Object.assign(process.env,{DEMO_MODE:'true',AI_PROVIDER:'demo',APP_ORIGIN:'https://crm.test',D1_LOCAL_DIR:path.join(here,'crm-data-'+Date.now()),SESSION_SECRET:randomBytes(40).toString('hex'),CRM_BRIDGE_ENABLED:'true',CRM_BRIDGE_SECRET:randomBytes(40).toString('hex'),CRM_BRIDGE_ALLOWED_MEMBER_IDS:'[]',OPENAI_API_KEY:'',SOCIAL_CHANNELS_JSON:'[]'});
const crmRequire=createRequire(path.join(crm,'package.json')),saleRequire=createRequire(path.join(sale,'package.json')),{build}=crmRequire('esbuild'),{Miniflare}=saleRequire(createRequire(saleRequire.resolve('wrangler/package.json')).resolve('miniflare'));
const databaseModule=await import(pathToFileURL(path.join(crm,'src/lib/db.ts')).href),crmDatabase=databaseModule.database;
const crmRoute=await import(pathToFileURL(path.join(crm,'src/app/api/[...path]/route.ts')).href),crmBridgeRoute=await import(pathToFileURL(path.join(crm,'src/app/api/bridge/[...path]/route.ts')).href),crmService=await import(pathToFileURL(path.join(crm,'src/lib/service.ts')).href),crmBridge=await import(pathToFileURL(path.join(crm,'src/lib/chat-bridge.ts')).href);
const crmSocialAdminRoute=await import(pathToFileURL(path.join(crm,'src/app/api/admin/social-channels/[provider]/route.ts')).href),crmConsentRoute=await import(pathToFileURL(path.join(crm,'src/app/api/admin/whatsapp-consent/[conversationId]/route.ts')).href);
const org=(await crmDatabase.query("SELECT id FROM organizations WHERE slug='rrs'")).rows[0],member=(await crmDatabase.query("SELECT id FROM members WHERE org_id=$1 AND email='admin@rrs.demo'",[org.id])).rows[0];
Object.assign(process.env,{CRM_BRIDGE_ORG_ID:org.id,CRM_BRIDGE_ALLOWED_MEMBER_IDS:JSON.stringify([member.id])});
const visitor=await crmService.createVisitor();
await databaseModule.transaction(org.id,async tx=>{const conversation=(await tx.query('SELECT lead_id FROM conversations WHERE id=$1',[visitor.visitor.conversationId])).rows[0];await tx.query("UPDATE leads SET name='ลูกค้าทดสอบ CRM → Sale',market='export',source='website' WHERE id=$1",[conversation.lead_id]);});
const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("local fixture")}}',d1Databases:['DB'],r2Buckets:['BUCKET'],cf:false});
const saleDatabase=await mf.getD1Database('DB'),password=randomBytes(24).toString('hex'),env={DB:saleDatabase,BUCKET:await mf.getR2Bucket('BUCKET'),ADMIN_USERNAME:'qa-owner',ADMIN_PASSWORD_HASH:await saleRequire('bcryptjs').hash(password,12),SESSION_SECRET:randomBytes(40).toString('hex'),RRS_CRM_BRIDGE_ENABLED:'true',RRS_CRM_ORG_ID:org.id,RRS_CRM_BRIDGE_SECRET:process.env.CRM_BRIDGE_SECRET,RRS_CRM_ORIGIN:'https://crm.test',RRS_CRM_SALE_WORKSPACE:'live',RRS_CRM_ACTOR_MAP_JSON:JSON.stringify({'qa-owner':member.id})};
for(const file of(await readdir(path.join(sale,'drizzle'))).filter(f=>f.endsWith('.sql')).sort())for(const sql of(await readFile(path.join(sale,'drizzle',file),'utf8')).split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean))await saleDatabase.prepare(sql).run();
globalThis.__CHAT_E2E_ENV=env;
const serverBundle=await build({absWorkingDir:sale,stdin:{contents:`export * as route from './app/api/rrs/crm/route';export * as events from './app/api/rrs/crm/events/route';export * as commands from './app/api/rrs/crm/commands/route';export * as mapping from './app/api/rrs/crm/mapping/route';export * as attachments from './app/api/rrs/crm/attachments/route';export * as auth from './lib/rrs/auth';export * as bridge from './lib/rrs/crm-bridge';`,resolveDir:sale},bundle:true,write:false,format:'esm',platform:'node',target:'node24',plugins:[{name:'fixture-env',setup(b){b.onResolve({filter:/^cloudflare:workers$/},()=>({path:'env',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const env=globalThis.__CHAT_E2E_ENV;'}));}}]});
const source=await import('data:text/javascript;base64,'+Buffer.from(serverBundle.outputFiles[0].text).toString('base64'));
const login=await source.auth.login(new Request('https://sale.test/api/auth/login',{method:'POST',headers:{Origin:'https://sale.test','Content-Type':'application/json'},body:JSON.stringify({username:'qa-owner',password})}));
if(login.status!==200)throw Error('Fixture Sale login failed '+await login.text());const saleCookie=login.headers.get('set-cookie').split(';')[0];
const crmLogin=await crmRoute.POST(new Request('https://crm.test/api/auth/login',{method:'POST',headers:{Origin:'https://crm.test','Content-Type':'application/json'},body:JSON.stringify({email:'admin@rrs.demo',password:'Demo-only-2026!'})}));
if(crmLogin.status!==200)throw Error('Fixture CRM login failed '+await crmLogin.text());const crmCookie=crmLogin.headers.get('set-cookie').split(';')[0];
let bridgeOffline=false,reconnectAt=null;
const nativeFetch=globalThis.fetch;
globalThis.fetch=async(input,init)=>{const req=new Request(input,init),url=new URL(req.url);if(url.origin==='https://crm.test'){if(bridgeOffline)throw Error('Local fixture bridge outage');return crmBridgeRoute[req.method](req);}if(url.hostname==='127.0.0.1'||url.hostname==='localhost')return nativeFetch(input,init);throw Error('External network disabled in local fixture: '+url.origin);};
while(!(await crmBridge.bootstrapBridge(org.id,100)).bootstrapComplete){}
await source.bridge.pullCrmEvents();
await mkdir(here,{recursive:true});
async function client(name,root,component){
  const result=await build({absWorkingDir:root,stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import Component from ${JSON.stringify(component)};createRoot(document.getElementById('app')).render(React.createElement(Component,${name==='sale'?'{mode:"live"}':'{}'}));`,resolveDir:root,loader:'tsx'},bundle:true,write:false,format:'esm',platform:'browser',target:'chrome120',jsx:'automatic',outdir:here,define:{'process.env.NODE_ENV':'"development"'}});
  for(const file of result.outputFiles)await writeFile(path.join(here,name+(file.path.endsWith('.css')?'.css':'.js')),file.contents);
}
await client('sale',sale,path.join(sale,'components/rrs/crm-chat.tsx'));await client('crm',crm,path.join(crm,'src/components/workspace.tsx'));
let crmCss=(await readFile(path.join(crm,'src/app/globals.css'),'utf8')).replace(/^@import[^\n]+\n/,'').replace(/^@theme[^\n]+\n/m,'');try{crmCss+='\n'+await readFile(path.join(here,'crm.css'),'utf8');}catch{}await writeFile(path.join(here,'crm.css'),crmCss);
const metrics=[];let lastPayload=null;
async function inject(input={}){
  const payload=input.duplicate&&lastPayload?lastPayload:{text:input.text||'ทดสอบเรียลไทม์ '+new Date().toLocaleTimeString('th-TH'),clientId:'fixture_'+randomUUID().replaceAll('-','')};lastPayload=payload;
  const response=await crmService.messageStream(visitor.visitor,payload,new AbortController().signal),recordedAt=Date.now();await response.text();
  const row=(await crmDatabase.query("SELECT id,created_at,content FROM messages WHERE conversation_id=$1 AND client_id=$2 AND role='user'",[visitor.visitor.conversationId,payload.clientId])).rows[0];
  const result={text:row.content,messageId:row.id,conversationId:visitor.visitor.conversationId,recordedAt,createdAt:row.created_at,clientId:payload.clientId,testCase:input.duplicate?'duplicate':bridgeOffline?'offline':'normal'};metrics.push({type:'injected',...result});return result;
}
const fixturePanel=`<section style="padding:12px;background:#fff4cf;border-bottom:1px solid #aaa;font:14px Arial" id="fixture-controls"><b>Local synthetic test · Actual source components/APIs</b> <button id="qa-inject">ส่งข้อความลูกค้าทดสอบ</button> <button id="qa-duplicate">ส่ง event เดิมซ้ำ</button> <button id="qa-offline">ตัดการเชื่อม bridge</button> <button id="qa-online">ต่อ bridge กลับ</button> <a href="http://127.0.0.1:39171/" target="_blank">เปิด CRM Terminal</a><p>ข้อมูลจำลอง · HTTPS ภายในและคุกกี้ทดสอบถูกจำลองโดยตัวทดสอบ · ไม่เชื่อมผู้ให้บริการจริง</p><p id="qa-metric" role="status">หน้าโหลด 1 ครั้ง · ยังไม่ทดสอบ</p></section>`;
const crmFixtureNotice='<aside style="padding:8px;background:#fff4cf;font:13px Arial">Local synthetic test · HTTPS origin และคุกกี้จำลอง · ไม่มีการเชื่อมช่องทางจริง</aside>';
const fixtureScript=`const metric=document.getElementById('qa-metric');let expected=null,observed=null;const observer=new MutationObserver(()=>{if(expected&&document.querySelector('.crm-message-log')?.textContent.includes(expected.text)&&!observed){observed=Date.now();finish();}});observer.observe(document.getElementById('app'),{childList:true,subtree:true,characterData:true});function finish(){if(expected?.recordedAt&&observed){const ms=observed-expected.recordedAt;metric.textContent='หน้าโหลด 1 ครั้ง · บันทึกใน CRM → ปรากฏใน Sale '+ms+' ms · '+expected.text;fetch('/fixture/metrics',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'browser-visible',testCase:expected.testCase,text:expected.text,recordedAt:expected.recordedAt,observedAt:observed,latencyMs:ms,reconnectAt:expected.reconnectAt??null,catchupMs:expected.reconnectAt?observed-expected.reconnectAt:null,navigationCount:performance.getEntriesByType('navigation').length})});}}async function send(duplicate=false){observed=null;const text='ข้อความทดสอบ '+new Date().toISOString();if(!duplicate)expected={text};metric.textContent='กำลังบันทึกข้อความใน CRM';const r=await fetch('/fixture/inject',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,duplicate})});const data=await r.json();expected=data;if(document.querySelector('.crm-message-log')?.textContent.includes(data.text)&&!observed)observed=Date.now();finish();}document.getElementById('qa-inject').onclick=()=>send();document.getElementById('qa-duplicate').onclick=()=>send(true);document.getElementById('qa-offline').onclick=()=>fetch('/fixture/offline',{method:'POST'}).then(()=>metric.textContent='Bridge offline; CRM ยังบันทึกข้อความได้');document.getElementById('qa-online').onclick=()=>fetch('/fixture/online',{method:'POST'}).then(r=>r.json()).then(data=>{if(expected)expected.reconnectAt=data.reconnectAt;metric.textContent='Bridge online; รอตรวจข้อความที่ค้าง';});`;
async function nodeResponse(response,res){res.statusCode=response.status;response.headers.forEach((v,k)=>{if(k!=='set-cookie')res.setHeader(k,v);});const cookies=response.headers.getSetCookie();if(cookies.length)res.setHeader('Set-Cookie',cookies);if(!response.body){res.end();return;}const reader=response.body.getReader();res.on('close',()=>reader.cancel().catch(()=>{}));try{while(!res.destroyed){const chunk=await reader.read();if(chunk.done)break;res.write(chunk.value);}res.end();}catch{res.end();}}
function server(name,port){return http.createServer(async(req,res)=>{try{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks),url=new URL(req.url,'http://127.0.0.1:'+port);
  if(url.pathname==='/fixture/metrics'){if(req.method==='POST')metrics.push(JSON.parse(body.toString()));res.setHeader('Content-Type','application/json');res.end(JSON.stringify(metrics));return;}
  if(url.pathname==='/fixture/inject'&&req.method==='POST'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await inject(body.length?JSON.parse(body.toString()):{})));return;}
  if(url.pathname==='/fixture/offline'||url.pathname==='/fixture/online'){bridgeOffline=url.pathname.endsWith('offline');reconnectAt=bridgeOffline?null:Date.now();res.setHeader('Content-Type','application/json');res.end(JSON.stringify({bridgeOffline,reconnectAt}));return;}
  if(url.pathname==='/fixture/state'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({conversationId:visitor.visitor.conversationId,bridgeOffline,crmMessages:(await crmDatabase.query('SELECT id,role,content,created_at FROM messages WHERE conversation_id=$1 ORDER BY created_at,id',[visitor.visitor.conversationId])).rows,sale:(await source.bridge.crmSnapshot({id:'fixture',email:'qa-owner',role:'owner',workspace:'live',demo:false},visitor.visitor.conversationId)),metrics}));return;}
  if(url.pathname.endsWith('.js')||url.pathname.endsWith('.css')){const extension=url.pathname.endsWith('.css')?'css':'js';res.setHeader('Content-Type',extension==='css'?'text/css':'text/javascript');res.end(await readFile(path.join(here,name+'.'+extension)));return;}
  if(!url.pathname.startsWith('/api/')){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><html lang="th"><head><meta charset="utf-8"><link rel="stylesheet" href="/${name}.css"></head><body>${name==='sale'?fixturePanel:crmFixtureNotice}<div id="app"></div><script type="module" src="/${name}.js"></script>${name==='sale'?'<script>'+fixtureScript+'</script>':''}</body></html>`);return;}
  const abort=new AbortController();res.on('close',()=>abort.abort());let response;
  if(name==='sale'){
    const headers=new Headers(req.headers);headers.set('Cookie',saleCookie);if(headers.has('origin'))headers.set('Origin','https://sale.test');
    const request=new Request('https://sale.test'+url.pathname+url.search,{method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:body,signal:abort.signal});
    const route=url.pathname.endsWith('/events')?source.events:url.pathname.endsWith('/commands')?source.commands:url.pathname.endsWith('/mapping')?source.mapping:url.pathname.endsWith('/attachments')?source.attachments:source.route;response=await route[req.method](request);
  }else{
    const headers=new Headers(req.headers);headers.set('Cookie',crmCookie);if(req.method==='POST'||headers.has('Origin'))headers.set('Origin',process.env.APP_ORIGIN);
    const request=new Request('https://crm.test'+url.pathname+url.search,{method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:body,signal:abort.signal});
    const social=url.pathname.match(/^\/api\/admin\/social-channels\/([^/]+)$/),consent=url.pathname.match(/^\/api\/admin\/whatsapp-consent\/([^/]+)$/);
    if(social)response=await crmSocialAdminRoute[req.method](request,{params:Promise.resolve({provider:decodeURIComponent(social[1])})});
    else if(consent)response=await crmConsentRoute[req.method](request,{params:Promise.resolve({conversationId:decodeURIComponent(consent[1])})});
    else response=await crmRoute[req.method](request);
  }await nodeResponse(response,res);
}catch(e){console.error(name,e);if(!res.headersSent){res.statusCode=500;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:e.message}));}else res.end();}}).listen(port,'127.0.0.1');}
const servers=[server('sale',39170),server('crm',39171)];
await writeFile(path.join(here,'ready.json'),JSON.stringify({sale:'http://127.0.0.1:39170/',crm:'http://127.0.0.1:39171/',state:'http://127.0.0.1:39170/fixture/state',inject:'http://127.0.0.1:39170/fixture/inject',metrics:'http://127.0.0.1:39170/fixture/metrics',conversationId:visitor.visitor.conversationId,orgId:org.id,memberId:member.id},null,2));
console.log('READY '+JSON.stringify({sale:'http://127.0.0.1:39170/',crm:'http://127.0.0.1:39171/',conversationId:visitor.visitor.conversationId}));
async function shutdown(){for(const s of servers)s.close();await mf.dispose();process.exit(0);}process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
