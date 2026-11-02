import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { notifySale, saleSyncConfig, resetSaleSyncForTest } from '../cloudflare/sale-sync';
import { verifyBridgeRequest } from '../src/lib/bridge-protocol';

const secret=randomBytes(32).toString('hex'),orgId='org-fixture',url='https://sale.test/api/rrs/crm/sync';
function database(head:number|null){return {prepare(sql:string){assert.match(sql,/FROM crm_bridge_events WHERE org_id=\?/);return {bind(value:unknown){assert.equal(value,orgId);return {async first<T>(){return {head} as T;}};}};}};}
const enabled=(head:number|null)=>({CRM_BRIDGE_ENABLED:'true',CRM_SALE_SYNC_ENABLED:'true',CRM_BRIDGE_SECRET:secret,CRM_BRIDGE_ORG_ID:orgId,CRM_SALE_SYNC_URL:url,DB:database(head)});

test('Sale sync is default off and rejects unsafe targets', async () => {
  const calls:string[]=[];const fetcher=(async(u:string)=>{calls.push(u);return new Response('{}');}) as unknown as typeof fetch;
  assert.deepEqual(await notifySale({},'reconcile',fetcher),{status:'disabled'});
  assert.deepEqual(await notifySale({...enabled(1),CRM_SALE_SYNC_ENABLED:'false'},'wake',fetcher),{status:'disabled'});
  assert.deepEqual(await notifySale({...enabled(1),CRM_BRIDGE_ENABLED:'false'},'wake',fetcher),{status:'disabled'});
  for(const target of ['http://sale.test/api/rrs/crm/sync','https://sale.test/api/rrs/crm/sync?x=1','https://u:p@sale.test/api/rrs/crm/sync','https://sale.test/api/rrs/crm/other','https://sale.test/api/rrs/crm/sync#x','not a url'])assert.equal(saleSyncConfig({...enabled(1),CRM_SALE_SYNC_URL:target}),null,target);
  assert.equal(saleSyncConfig({...enabled(1),CRM_BRIDGE_SECRET:'short'}),null);
  assert.equal(calls.length,0);
});

test('wake carries the committed head once, retries after failure, and is verifiable by Sale', async () => {
  resetSaleSyncForTest();const bodies:Record<string,unknown>[]=[];let status=500;
  const fetcher=(async(u:string,init:RequestInit)=>{const request=new Request(u,init);assert.equal(request.headers.get('origin'),null);const {body}=await verifyBridgeRequest(request,{secret,orgId},4096);bodies.push(JSON.parse(body));assert.equal(init.redirect,'manual','Workers rejects redirect:error; manual + non-2xx check never follows');return new Response('{}',{status});}) as unknown as typeof fetch;
  assert.deepEqual(await notifySale(enabled(7),'wake',fetcher),{status:'failed',httpStatus:500});
  status=200;assert.deepEqual(await notifySale(enabled(7),'wake',fetcher),{status:'sent',httpStatus:200},'a failed wake is retried on the next commit');
  assert.deepEqual(await notifySale(enabled(7),'wake',fetcher),{status:'unchanged'},'same head is not resent');
  assert.deepEqual(await notifySale(enabled(null),'wake',fetcher),{status:'unchanged'});
  assert.deepEqual(await notifySale(enabled(9),'wake',fetcher),{status:'sent',httpStatus:200});
  assert.deepEqual(await notifySale(enabled(9),'reconcile',fetcher),{status:'sent',httpStatus:200},'reconcile always runs');
  assert.deepEqual(bodies,[{version:1,reason:'wake',headSequence:7},{version:1,reason:'wake',headSequence:7},{version:1,reason:'wake',headSequence:9},{version:1,reason:'reconcile'}]);
});
