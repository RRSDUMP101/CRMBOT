import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Script} from 'node:vm';
import {readFile} from 'node:fs/promises';
import {widgetDocument} from '../src/lib/widget-document';
import {GET} from '../src/app/widget.js/route';
const config={title:'RRS ทีมขาย',greeting:'สอบถามได้เลยค่ะ',accentColor:'#24bfa6',position:'right',enabled:true};
test('widget client JavaScript parses as a standalone browser script',()=>{
 const html=widgetDocument(config);const script=html.match(/<script>([\s\S]*)<\/script>/)?.[1];assert.ok(script);assert.doesNotThrow(()=>new Script(script));
});
test('widget config is JSON data and cannot close a script element',()=>{
 const html=widgetDocument({...config,greeting:'</script><script>window.pwned=true</script>'});
 assert.equal((html.match(/<script>/g)||[]).length,1);assert.equal((html.match(/<\/script>/g)||[]).length,1);
 assert.ok(html.includes('\\u003c/script>'));assert.doesNotThrow(()=>new Script(html.match(/<script>([\s\S]*)<\/script>/)![1]));
});
test('widget document excludes internal configuration fields',()=>{
 const settings={...config,allowedOrigins:['https://private-config.example'],secret:'not-public'};
 const html=widgetDocument(settings);assert.ok(!html.includes('private-config.example'));assert.ok(!html.includes('not-public'));
});
test('widget preserves dollar replacement markers in administrator text',()=>{
 const greeting="Hello $& $' $` </script>";
 const html=widgetDocument({...config,greeting});
 assert.ok(html.includes(JSON.stringify(greeting).replace(/</g,'\\u003c')));
 assert.doesNotThrow(()=>new Script(html.match(/<script>([\s\S]*)<\/script>/)![1]));
});
test('embed loader parses, sends no staff credentials and validates message source',async()=>{
 const response=await GET();const script=await response.text();assert.match(response.headers.get('content-type')!,/javascript/);assert.doesNotThrow(()=>new Script(script));assert.match(script,/credentials:'omit'/);assert.match(script,/e.origin===base&&e.source===frame.contentWindow/);
});
test('both widget font subsets and open-font license ship locally',async()=>{
 for(const subset of ['thai','latin']){const bytes=await readFile(`public/fonts/noto-sans-thai-${subset}-wght-normal.woff2`);assert.equal(bytes.subarray(0,4).toString(),'wOF2')}
 const license=await readFile('public/fonts/OFL-Noto-Sans-Thai.txt','utf8');assert.match(license,/SIL OPEN FONT LICENSE/);
});
