import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {test} from 'node:test';
import path from 'node:path';
import {database,closeDatabase} from '../src/lib/db';
import {bridgeLeadProfile} from '../src/lib/lead-profile-bridge';

test('mapped staff edit only the selected CRM lead with version, market and replay protection',async()=>{
  const [org,other,actor,owner,foreign,lead,room]=Array.from({length:7},()=>randomUUID());
  const keys=['DEMO_MODE','D1_LOCAL_DIR','AI_PROVIDER','CRM_BRIDGE_ALLOWED_MEMBER_IDS'] as const;
  const before=keys.map(k=>process.env[k]);
  const dir=path.join(process.cwd(),'.data','lead-profile-'+randomUUID());
  await mkdir(dir,{recursive:true});
  Object.assign(process.env,{DEMO_MODE:'true',AI_PROVIDER:'disabled',D1_LOCAL_DIR:dir,CRM_BRIDGE_ALLOWED_MEMBER_IDS:JSON.stringify([actor])});
  try{
    for(const id of [org,other])await database.query("INSERT INTO organizations(id,slug,name) VALUES($1,$2,'Fixture')",[id,id]);
    for(const [id,tenant] of [[actor,org],[owner,org],[foreign,other]])
      await database.query("INSERT INTO members(id,org_id,name,email,password_hash,role) VALUES($1,$2,'Agent',$3,'test','Agent')",[id,tenant,id+'@example.invalid']);
    await database.query("INSERT INTO leads(id,org_id,name,market,phone) VALUES($1,$2,'Original','export','12345678')",[lead,org]);
    await database.query("INSERT INTO conversations(id,org_id,lead_id) VALUES($1,$2,$3)",[room,org,lead]);
    const scope={actorId:actor,conversationId:room,leadId:lead,market:'export'};
    const read=async()=>await bridgeLeadProfile(org,{...scope,action:'read'}) as {version:number;name:string;assigneeId:string|null;members:{id:string}[]};
    const profile=await read();
    assert(profile.members.some(x=>x.id===owner));assert(!profile.members.some(x=>x.id===foreign));
    const write={...scope,action:'update',commandId:randomUUID(),version:profile.version,changes:{name:'Revised',email:'new@example.invalid',assigneeId:owner}};
    await assert.rejects(()=>bridgeLeadProfile(org,{...write,actorId:owner}));
    await assert.rejects(()=>bridgeLeadProfile(org,{...write,market:'domestic'}));
    await assert.rejects(()=>bridgeLeadProfile(org,{...write,leadId:randomUUID()}));
    await assert.rejects(()=>bridgeLeadProfile(org,{...write,changes:{assigneeId:foreign}}));
    await assert.rejects(()=>bridgeLeadProfile(org,{...write,changes:{market:'domestic'}}));
    await bridgeLeadProfile(org,write);await bridgeLeadProfile(org,write);
    const current=await read();assert.equal(current.name,'Revised');assert.equal(current.assigneeId,owner);assert(current.version>profile.version);
    const stored=(await database.query('SELECT name,email,phone FROM leads WHERE org_id=$1 AND id=$2',[org,lead])).rows[0];
    assert.equal(stored.email,'new@example.invalid');assert.equal(stored.phone,'12345678');
    assert.equal(Number((await database.query("SELECT count(*) n FROM audit_events WHERE org_id=$1 AND entity_id=$2 AND action='updateLead'",[org,lead])).rows[0].n),1);
    await assert.rejects(()=>bridgeLeadProfile(org,{...write,commandId:randomUUID()}),/CRM_LEAD_CHANGED/);
    await assert.rejects(()=>bridgeLeadProfile(org,{...write,changes:{name:'Another'}}),/CRM_COMMAND_ID_CONFLICT/);
    await database.query("UPDATE leads SET market='domestic' WHERE id=$1 AND org_id=$2",[lead,org]);
    await assert.rejects(read,/CRM_LEAD_NOT_FOUND/);
  }finally{await closeDatabase();keys.forEach((key,i)=>{if(before[i]===undefined)delete process.env[key];else process.env[key]=before[i];});}
});
