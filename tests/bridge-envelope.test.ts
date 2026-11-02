/** Metadata upgrade on synthetic old history; never opens any configured database. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {bridgeRecordHash} from '../src/lib/bridge-envelope';

test('canonical hash sorts object keys, preserves arrays and raw JSON string columns',async()=>{
 const record={z:1,text:'ทดสอบ',list:[2,1],a:{b:2,a:null}};
 const expected=createHash('sha256').update('{"a":{"a":null,"b":2},"list":[2,1],"text":"ทดสอบ","z":1}').digest('hex');
 assert.equal(await bridgeRecordHash(record),expected);assert.equal(await bridgeRecordHash({...record,a:{a:null,b:2}}),expected);
 assert.notEqual(await bridgeRecordHash({...record,list:[1,2]}),expected);
 assert.notEqual(await bridgeRecordHash({facts:'{"a":1,"b":2}'}),await bridgeRecordHash({facts:'{"b":2,"a":1}'}));
});

test('035 backfills only metadata and future mutations continue each aggregate history',async()=>{
 const sql=new DatabaseSync(':memory:');try{
  sql.exec('PRAGMA foreign_keys=ON');
  for(const file of(await readdir('migrations/d1')).filter(f=>/^\d+_.*\.sql$/.test(f)&&Number(f.split('_')[0])<35).sort())sql.exec(await readFile('migrations/d1/'+file,'utf8'));
  sql.prepare('INSERT INTO organizations(id,slug,name) VALUES(?,?,?)').run('org','org','Synthetic');
  sql.prepare('INSERT INTO leads(id,org_id,name,facts) VALUES(?,?,?,?)').run('lead','org','Before metadata','{"legacy": true}');
  sql.prepare('UPDATE leads SET name=? WHERE id=?').run('Second version','lead');
  sql.prepare('INSERT INTO leads(id,org_id,name) VALUES(?,?,?)').run('other','org','Separate');
  const source=sql.prepare('SELECT * FROM crm_bridge_events ORDER BY sequence').all(),leads=sql.prepare('SELECT * FROM leads ORDER BY id').all(),head=sql.prepare('SELECT * FROM crm_bridge_state').all();
  sql.exec(await readFile('migrations/d1/035_bridge_event_envelopes.sql','utf8'));
  assert.deepEqual(sql.prepare('SELECT * FROM crm_bridge_events ORDER BY sequence').all(),source);
  assert.deepEqual(sql.prepare('SELECT * FROM leads ORDER BY id').all(),leads);assert.deepEqual(sql.prepare('SELECT * FROM crm_bridge_state').all(),head);
  assert.deepEqual(sql.prepare('SELECT aggregate_version FROM crm_bridge_event_envelopes ORDER BY sequence').all().map(row=>row.aggregate_version),[1,2,1]);
  sql.prepare('UPDATE leads SET name=? WHERE id=?').run('After migration','lead');
  const last=sql.prepare('SELECT * FROM crm_bridge_event_envelopes ORDER BY sequence DESC LIMIT 1').get()!;assert.equal(last.aggregate_version,3);assert.equal(last.sequence,4);assert.equal(last.correlation_id,last.event_id);assert.equal(last.causation_id,null);
  assert.throws(()=>sql.exec('UPDATE crm_bridge_event_envelopes SET correlation_id=\'forged\''),/immutable/);
  assert.throws(()=>sql.exec('DELETE FROM crm_bridge_event_envelopes'),/retained/);
  assert.deepEqual(sql.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{sql.close();}
});
