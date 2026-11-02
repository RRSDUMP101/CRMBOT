import assert from 'node:assert/strict';
import {test} from 'node:test';
import {observeAutomation} from '../src/lib/automation-health';
import type {D1Binding} from '../src/lib/db';

function sink(){const rows:unknown[][]=[];const db={prepare(sql:string){assert.match(sql,/ON CONFLICT\(org_id,worker\)/);return {bind(...values:unknown[]){return {values};}};},async batch(statements:{values:unknown[]}[]){rows.push(...statements.map(v=>v.values));return [];}} as unknown as D1Binding;return {rows,env:{DB:db,CRM_BRIDGE_ORG_ID:'synthetic-org'}};}

test('heartbeat stores only bounded metrics and never treats HTTP wake as a consumer ACK',async()=>{
 const {rows,env}=sink();const result={status:'sent',httpStatus:202,token:'SECRET',body:'PRIVATE',acknowledged:undefined};
 assert.equal(await observeAutomation(env,'sale-wake',async()=>result),result);
 assert.equal(rows.length,1);assert.equal(rows[0][4],'sent');assert.equal(typeof rows[0][3],'number');
 const details=JSON.parse(String(rows[0][5]));assert.equal(details.httpStatus,202);assert.equal(details.acknowledged,undefined);assert.ok(!JSON.stringify(rows).includes('SECRET'));assert.ok(!JSON.stringify(rows).includes('PRIVATE'));
});
test('failed job remains failed and preserves previous success through nullable upsert',async()=>{
 const {rows,env}=sink();const error=new Error('private provider error');await assert.rejects(()=>observeAutomation(env,'flows',async()=>{throw error;}),e=>e===error);
 assert.equal(rows[0][3],null);assert.equal(rows[0][4],'error');assert.ok(!JSON.stringify(rows).includes(error.message));
});
test('disabled and deferred runs cannot refresh the last successful time',async()=>{
 const {rows,env}=sink();for(const status of ['disabled','deferred','failed'])await observeAutomation(env,'connectors',async()=>({status}));assert.ok(rows.every(row=>row[3]===null));
});
