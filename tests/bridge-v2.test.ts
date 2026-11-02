import assert from 'node:assert/strict';
import {test} from 'node:test';
import {bridgeKeyConfig,signBridgeRequest,verifyBridgeRequest,type BridgeCredentials} from '../src/lib/bridge-protocol';
const orgId='fixture-org',url='https://crm.test/api/bridge/events?after=0';
const oldKey='old-fixture-key-not-a-production-secret-000',newKey='new-fixture-key-not-a-production-secret-111';
function credentials(current='new'):BridgeCredentials{const nonces=new Set<string>();return {orgId,secret:oldKey,keys:{old:oldKey,new:newKey},currentKeyId:current,claimNonce:async(k,n)=>{const id=k+':'+n;if(nonces.has(id))return false;nonces.add(id);return true;}};}
async function request(c:BridgeCredentials,target=url,method='GET',body=''){return new Request(target,{method,headers:await signBridgeRequest(target,{...c,method,body}),...(body?{body}:{})});}
test('v2 binds method, URL/query, org, key ID, nonce and body; rejects tampering before claiming nonce',async()=>{
 const c=credentials();const r=await request(c,url,'POST','{"sequence":1}');let claims=0;const receiver={...c,claimNonce:async()=>{claims++;return true;}};
 for(const change of ['url','method','org','key','nonce','body']){const h=new Headers(r.headers);let u=url,m='POST',b='{"sequence":1}';if(change==='url')u+='0';if(change==='method')m='PUT';if(change==='org')h.set('X-RRS-Bridge-Org','other');if(change==='key')h.set('X-RRS-Bridge-Key-Id','old');if(change==='nonce')h.set('X-RRS-Bridge-Nonce','f'.repeat(32));if(change==='body')b='{"sequence":2}';await assert.rejects(()=>verifyBridgeRequest(new Request(u,{method:m,headers:h,body:b}),receiver));}
 assert.equal(claims,0);assert.equal((await verifyBridgeRequest(r,receiver)).body,'{"sequence":1}');assert.equal(claims,1);
});
test('replaying an authenticated GET or POST is rejected; freshly signed retry works',async()=>{
 for(const method of ['GET','POST']){const c=credentials(),r=await request(c,url,method,method==='POST'?'{}':'');await verifyBridgeRequest(r.clone(),c);await assert.rejects(()=>verifyBridgeRequest(r.clone(),c),/already used/);await verifyBridgeRequest(await request(c,url,method,method==='POST'?'{}':''),c);}
});
test('rotation overlap accepts both keys, retirement rejects old key, v1 downgrade explicit only',async()=>{
 const c=credentials(),old=await request({...c,currentKeyId:'old'});await verifyBridgeRequest(old.clone(),c);
 await assert.rejects(()=>verifyBridgeRequest(old.clone(),{...credentials(),keys:{new:newKey}}));
 const legacy={orgId,secret:oldKey},v1=await request(legacy);await assert.rejects(()=>verifyBridgeRequest(v1.clone(),c));await verifyBridgeRequest(v1.clone(),{...c,allowLegacy:true});
});
test('invalid key ring, missing replay ledger, expired signatures and browser Origin fail closed',async()=>{
 assert.throws(()=>bridgeKeyConfig({CRM_BRIDGE_KEYS:'{}',CRM_BRIDGE_KEY_CURRENT:'missing'}));
 assert.throws(()=>bridgeKeyConfig({CRM_BRIDGE_KEYS:'bad',CRM_BRIDGE_KEY_CURRENT:'new'}));
 const c=credentials();assert.deepEqual(bridgeKeyConfig({}),{});
 const noLedger=await request(c);await assert.rejects(()=>verifyBridgeRequest(noLedger,{...c,claimNonce:undefined}));
 const h=await signBridgeRequest(url,{...c,now:Date.now()-300001});await assert.rejects(()=>verifyBridgeRequest(new Request(url,{headers:h}),c));
 const r=await request(c);r.headers.set('Origin','https://crm.test');await assert.rejects(()=>verifyBridgeRequest(r,c));
});
