import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
test('PWA does not intercept private API, chat, documents or authenticated pages for caching',()=>{
 const handlers:Record<string,(event:any)=>void>={};runInNewContext(readFileSync(new URL('../public/sw.js',import.meta.url),'utf8'),{self:{location:{origin:'https://crm.example.invalid'},addEventListener(name:string,handler:(event:any)=>void){handlers[name]=handler;}},URL,Set});
 for(const path of ['/','/api/admin/inbox','/api/chat','/chat','/widget','/api/admin/ai','/fonts/file?token=private']){let intercepted=false;handlers.fetch({request:{url:'https://crm.example.invalid'+path,method:'GET'},respondWith(){intercepted=true;}});assert.equal(intercepted,false,path);}
});
