import { loadEnvFile } from 'node:process';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { migrateDatabase, seedDemo, closeDatabase, database, transaction, demoMode } from '../src/lib/db';
import { hashPassword } from '../src/lib/auth';

for(const file of ['.env.local','.env'])if(existsSync(file))loadEnvFile(file);
async function main() {
  const command=process.argv[2];
  if(command==='migrate') {await migrateDatabase();console.log('Database migration complete.');}
  else if(command==='seed') {await migrateDatabase();await seedDemo();console.log('Demo organizations and accounts ready. No customer data seeded.');}
  else if(command==='provision') {
    if(demoMode())throw new Error('Production provisioning requires DEMO_MODE=false');
    const email=process.env.PROVISION_ADMIN_EMAIL?.trim().toLowerCase();const password=process.env.PROVISION_ADMIN_PASSWORD;
    const name=process.env.PROVISION_ADMIN_NAME||'Administrator';const slug=process.env.PUBLIC_ORG_SLUG||'rrs';
    if(!email||!password||password.length<16||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error('Set PROVISION_ADMIN_EMAIL and a unique PROVISION_ADMIN_PASSWORD of at least 16 characters in the environment.');
    await transaction(async connection=>{
      const existing=await connection.query('SELECT id FROM organizations WHERE slug=$1',[slug]);
      if(existing.rows.length)throw new Error('Organization already exists. Provisioning will not overwrite accounts.');
      const orgId=randomUUID();
      await connection.query('INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)',[orgId,slug,process.env.ORGANIZATION_NAME||'RRS รุ่งเรืองดั๊มพ์ 101']);
      await connection.query("INSERT INTO members(id,org_id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5,'Admin')",[randomUUID(),orgId,name,email,hashPassword(password)]);
    });
    console.log('Organization and initial administrator created. Remove provisioning variables after use.');
  } else if(command==='cleanup') {
    await database.query('DELETE FROM staff_sessions WHERE expires_at<now()');
    await database.query('DELETE FROM visitors WHERE expires_at<now()');
    await database.query('DELETE FROM rate_buckets WHERE reset_at<now()');
    console.log('Expired sessions and rate buckets removed. Customer records were not deleted.');
  } else throw new Error('Usage: tsx scripts/db.ts migrate | seed | provision | cleanup');
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Database command failed');process.exitCode=1;}).finally(closeDatabase);
