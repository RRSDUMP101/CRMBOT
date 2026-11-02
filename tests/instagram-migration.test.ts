import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,readdir} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

test('034 preserves queued identity foreign keys and outbox history in real workerd D1',async()=>{
  const mf=new Miniflare(convertV4MiniflareOptions({host:'127.0.0.1',port:0,modules:true,script:'export default {fetch(){return new Response("synthetic")}}',cf:false,d1Databases:['DB']}));
  const parser=new DatabaseSync(':memory:');parser.exec('PRAGMA foreign_keys=ON');
  try{
    const db=await mf.getD1Database('DB');
    async function migrate(name:string){
      let remaining=await readFile('migrations/d1/'+name,'utf8');const statements:string[]=[];parser.exec('BEGIN');
      try{
        while((remaining=remaining.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/,''))){const statement=parser.prepare(remaining),source=statement.sourceSQL;assert.ok(source);statement.run();statements.push(source);remaining=remaining.slice(source.length);}
        parser.exec('COMMIT');
      }catch(e){parser.exec('ROLLBACK');throw e;}
      await db.batch(statements.map(sql=>db.prepare(sql)));
    }
    for(const name of(await readdir('migrations/d1')).filter(n=>/^\d+_.*\.sql$/.test(n)&&Number(n.split('_')[0])<34).sort())await migrate(name);
    const statements=[
      "INSERT INTO organizations(id,slug,name) VALUES('org','fixture','Synthetic')",
      "INSERT INTO members(id,org_id,name,email,password_hash,role) VALUES('actor','org','Admin','fixture@example.invalid','no-login','Admin')",
      "INSERT INTO leads(id,org_id,name) VALUES('lead','org','Preserve me')",
      "INSERT INTO conversations(id,org_id,lead_id) VALUES('chat','org','lead')",
      "INSERT INTO messages(id,org_id,conversation_id,role,content) VALUES('msg','org','chat','agent','queued text')",
      "INSERT INTO social_identities(id,org_id,provider,account_id,remote_id,lead_id,conversation_id,created_at,updated_at) VALUES('identity','org','line','account','remote','lead','chat','2026-01-01','2026-01-01')",
      "INSERT INTO social_outbound_commands(id,org_id,identity_id,conversation_id,message_id,provider,account_id,remote_id,body,conversation_version,approved_by,created_at,updated_at) VALUES('command','org','identity','chat','msg','line','account','remote','queued text',1,'actor','2026-01-01','2026-01-01')",
      "INSERT INTO broadcast_campaigns(id,org_id,name,provider,account_id,created_by,created_at,updated_at) VALUES('campaign','org','Preserve campaign','line','account','actor','2026-01-01','2026-01-01')",
      "INSERT INTO broadcast_recipients(id,org_id,campaign_id,identity_id,remote_id,lead_id,conversation_id,idempotency_key,created_at,updated_at) VALUES('recipient','org','campaign','identity','remote','lead','chat','once-only','2026-01-01','2026-01-01')",
      "INSERT INTO broadcast_test_sends(id,org_id,campaign_id,campaign_version,request_id,identity_id,remote_id,outbound_command_id,actor_id,created_at) VALUES('test','org','campaign',1,'request','identity','remote','command','actor','2026-01-01')",
      "INSERT INTO broadcast_suppressions(org_id,provider,remote_id,reason,created_at) VALUES('org','line','blocked','Preserve suppression','2026-01-01')"
    ];
    for(const sql of statements)parser.exec(sql);await db.batch(statements.map(sql=>db.prepare(sql)));
    const tables=['social_identities','social_outbound_commands','broadcast_recipients','broadcast_test_sends','broadcast_suppressions','crm_bridge_events','crm_bridge_state'];
    const snapshot=async()=>Promise.all(tables.map(async table=>(await db.prepare('SELECT * FROM '+table+' ORDER BY 1,2').all()).results));
    const before=await snapshot();await migrate('034_instagram_identity.sql');assert.deepEqual(await snapshot(),before,'all original queued rows, IDs, status and event sequence remain identical');
    assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
    // D1 disallows integrity_check; use its supported foreign_key_check above
    // and the mirrored SQLite migration for structural integrity.
    assert.equal((parser.prepare('PRAGMA integrity_check').get() as {integrity_check:string}).integrity_check,'ok');
    const seq=(await db.prepare("SELECT sequence FROM crm_bridge_state WHERE org_id='org'").first())!.sequence as number;
    await db.prepare("UPDATE social_identities SET opt_out=1 WHERE id='identity'").run();
    assert.equal((await db.prepare("SELECT sequence FROM crm_bridge_state WHERE org_id='org'").first())!.sequence,seq+1,'updated identity emits one event after trigger restoration');
    await assert.rejects(db.prepare("DELETE FROM social_identities WHERE id='identity'").run(),'dependent queued foreign keys still enforce');
    await db.prepare("INSERT INTO leads(id,org_id,name) VALUES('ig-lead','org','IG')").run();
    await db.prepare("INSERT INTO conversations(id,org_id,lead_id) VALUES('ig-chat','org','ig-lead')").run();
    await db.prepare("INSERT INTO social_identities(id,org_id,provider,account_id,remote_id,lead_id,conversation_id,created_at,updated_at) VALUES('ig','org','instagram','179111111','123456','ig-lead','ig-chat','2026-01-01','2026-01-01')").run();
    assert.equal((await db.prepare("SELECT count(*) AS n FROM crm_bridge_events WHERE entity='socialIdentity' AND record_id='ig'").first())!.n,1);
    assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
  }finally{parser.close();await mf.dispose();}
});
