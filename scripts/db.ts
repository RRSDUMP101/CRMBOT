import { loadEnvFile } from 'node:process';
import { existsSync } from 'node:fs';
import { migrateDatabase, seedDemo, closeDatabase, demoMode } from '../src/lib/db';
for(const file of ['.env.local','.env'])if(existsSync(file))loadEnvFile(file);
async function main() {
  if(!demoMode())throw new Error('Local database commands require DEMO_MODE=true. Apply production migrations through Cloudflare D1.');
  const command=process.argv[2];
  if(command==='migrate')await migrateDatabase();
  else if(command==='seed'){await migrateDatabase();await seedDemo();}
  else throw new Error('Usage: node --import tsx scripts/db.ts migrate | seed');
  console.log('Local Demo database ready.');
}
main().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(closeDatabase);
