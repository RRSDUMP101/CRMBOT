import {readdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
// These three exercise HTTP and are run against the compiled Worker by test:worker.
const workerTests=new Set(['api.test.ts','helpdesk.test.ts','files-api.test.ts']);
const files=(await readdir(new URL('../tests/',import.meta.url))).filter(name=>name.endsWith('.test.ts')&&!workerTests.has(name)).sort().map(name=>'tests/'+name);
const child=spawn(process.execPath,['--import','tsx','--test','--test-concurrency=2',...files],{stdio:'inherit'});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
