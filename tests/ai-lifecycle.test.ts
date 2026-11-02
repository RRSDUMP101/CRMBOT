import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {before,after,test} from 'node:test';
import {zipSync,strToU8} from 'fflate';
import {database,closeDatabase} from '../src/lib/db';
import type {Staff} from '../src/lib/auth';
import {saveSource,reviewSource,saveAiProfile,evaluateAi,activateAi,aiRuntimeContext,crawlSource,scopedKnowledge,deleteSource} from '../src/lib/ai-lifecycle';
import {extractKnowledge} from '../src/lib/knowledge-extract';
const saved={...process.env};let staff:Staff;
before(async()=>{Object.assign(process.env,{DEMO_MODE:'true',RRS_WORKERS:'false',D1_LOCAL_DIR:'.data/ai-lifecycle-'+randomUUID(),AI_PROVIDER:'demo'});const org=randomUUID(),id=randomUUID();await database.query('INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)',[org,org,'Synthetic AI']);await database.query("INSERT INTO members(id,org_id,name,email,password_hash,role) VALUES($1,$2,'Admin',$3,'unused','Admin')",[id,org,id+'@example.invalid']);staff={id,orgId:org,name:'Admin',email:id+'@example.invalid',role:'Admin'};});
after(async()=>{await closeDatabase();for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);});
test('reviewed scopes and immutable versions; editing invalidates activation until another sandbox evaluation',async()=>{
 const created=await saveSource(staff,{title:'Orange',content:'Orange products contain vitamin C and are available in boxes.',scopes:['web']});assert.equal((await scopedKnowledge(staff.orgId,'web')).length,0);
 await reviewSource(staff,{id:created.id,expectedVersion:1,action:'approve',confirm:true});assert.equal((await scopedKnowledge(staff.orgId,'web')).length,1);assert.equal((await scopedKnowledge(staff.orgId,'line:other')).length,0);
 await saveAiProfile(staff,{scope:'web',personality:'Helpful',scenarios:[{name:'Money',keywords:['payment'],handoff:true}]});
 const evaluation=await evaluateAi(staff,{scope:'web',prompt:'Orange',expectedHandoff:false});assert.equal(evaluation.passed,true);assert.equal(evaluation.citations[0].version,1);
 await activateAi(staff,{scope:'web',expectedRevision:1,evaluationId:evaluation.id,action:'activate',confirm:true});assert.equal((await aiRuntimeContext(staff.orgId,'web','Orange')).active,true);assert.equal((await aiRuntimeContext(staff.orgId,'web','payment')).handoff,true);
 await saveSource(staff,{id:created.id,expectedVersion:1,title:'Orange',content:'Updated Orange information',scopes:['web']});assert.equal((await aiRuntimeContext(staff.orgId,'web','Orange')).active,false);
 await assert.rejects(activateAi(staff,{scope:'web',expectedRevision:1,evaluationId:evaluation.id,action:'activate',confirm:true}),/ทดสอบ/);
 const versions=(await database.query('SELECT version,content FROM knowledge_versions WHERE org_id=$1 AND source_id=$2 ORDER BY version',[staff.orgId,created.id])).rows;assert.equal(versions.length,2);assert.match(versions[0].content,/vitamin/);
 await assert.rejects(database.query('UPDATE knowledge_versions SET content=$3 WHERE org_id=$1 AND source_id=$2',[staff.orgId,created.id,'tamper']),/immutable/);
 await assert.rejects(saveSource({...staff,role:'Agent'},{title:'Bad',content:'Bad',scopes:['web']}));
});
test('crawl requires exact allowlist and never follows redirect, drafts content only',async()=>{
 process.env.AI_KNOWLEDGE_ALLOWED_HOSTS='docs.example.invalid';let calls=0;
 const fetcher=(async(_url:unknown,init:RequestInit)=>{calls++;assert.equal(init.redirect,'manual');return new Response('<script>SECRET()</script><p>Useful product facts</p>',{headers:{'content-type':'text/html'}});}) as typeof fetch;
 await assert.rejects(crawlSource(staff,{url:'https://127.0.0.1/',title:'Bad',scopes:['web']},fetcher));assert.equal(calls,0);
 const result=await crawlSource(staff,{url:'https://docs.example.invalid/',title:'Web',scopes:['web']},fetcher);const source=(result.sources as Record<string,any>[]).find(s=>s.id===result.id)!;assert.equal(source.status,'draft');assert.doesNotMatch(source.content,/SECRET/);
 await assert.rejects(crawlSource(staff,{url:'https://docs.example.invalid/',title:'Redirect',scopes:['web']},(async()=>new Response(null,{status:302,headers:{location:'https://127.0.0.1'}})) as typeof fetch));
 const before=Number((await database.query('SELECT COUNT(*) AS n FROM knowledge WHERE org_id=$1',[staff.orgId])).rows[0].n);let cancelled=false;
 const oversized=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(1_000_001));},cancel(){cancelled=true;}});
 await assert.rejects(crawlSource(staff,{url:'https://docs.example.invalid/',title:'Too large',scopes:['web']},async()=>new Response(oversized,{headers:{'content-type':'text/plain'}})),/ขีดจำกัด/);
 assert.equal(cancelled,true);assert.equal(Number((await database.query('SELECT COUNT(*) AS n FROM knowledge WHERE org_id=$1',[staff.orgId])).rows[0].n),before);
 await assert.rejects(crawlSource(staff,{url:'https://docs.example.invalid/',title:'Local default',scopes:['web']}),/Cloudflare/);
});
test('bounded Office parsers extract actual paragraphs/shared strings and reject entities and expansion bombs',async()=>{
 const docx=zipSync({'word/document.xml':strToU8('<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t> world</w:t></w:r></w:p></w:body></w:document>')});assert.equal(await extractKnowledge(docx,'docx'),'Hello world');
 const xlsx=zipSync({'xl/sharedStrings.xml':strToU8('<sst><si><t>Apple</t></si></sst>'),'xl/worksheets/sheet1.xml':strToU8('<worksheet><sheetData><row><c t="s"><v>0</v></c><c><v>42</v></c></row></sheetData></worksheet>')});assert.match(await extractKnowledge(xlsx,'xlsx'),/Apple\t42/);
 const entity=zipSync({'word/document.xml':strToU8('<!DOCTYPE x [<!ENTITY x SYSTEM "file:///private">]><w:document>&x;</w:document>')});await assert.rejects(extractKnowledge(entity,'docx'));
 const bomb=zipSync({'word/document.xml':strToU8('x'.repeat(8_000_001))});await assert.rejects(extractKnowledge(bomb,'docx'));
});
test('source deletion removes immutable source versions and sandbox evidence, deactivating the source set',async()=>{
 const created=await saveSource(staff,{title:'Delete fixture',content:'Delete fixture content',scopes:['web']});await reviewSource(staff,{id:created.id,expectedVersion:1,action:'approve',confirm:true});await deleteSource(staff,{id:created.id,expectedVersion:1,confirm:true});assert.equal((await database.query('SELECT * FROM knowledge WHERE org_id=$1 AND id=$2',[staff.orgId,created.id])).rows.length,0);assert.equal((await database.query('SELECT * FROM knowledge_versions WHERE org_id=$1 AND source_id=$2',[staff.orgId,created.id])).rows.length,0);assert.ok(!(await scopedKnowledge(staff.orgId,'web')).some(x=>x.id===created.id));
});
