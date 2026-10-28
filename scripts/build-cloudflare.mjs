// Portable build + packaging validation. Deployment remains an explicit command.
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const env={...process.env,RRS_WORKERS_BUILD:'true'};
if(process.platform==='win32'){
  const helper=pathToFileURL(path.join(root,'scripts','windows-build-links.mjs')).href;
  env.NODE_OPTIONS=[env.NODE_OPTIONS,`--import=${helper}`].filter(Boolean).join(' ');
}
async function binary(packageName,name){
  const directory=path.join(root,'node_modules',packageName);
  const metadata=JSON.parse(await readFile(path.join(directory,'package.json'),'utf8'));
  const entry=typeof metadata.bin==='string'?metadata.bin:metadata.bin[name];
  if(typeof entry!=='string')throw new Error(`Missing installed CLI: ${name}`);
  return path.join(directory,entry);
}
async function run(script,args=[]){
  await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[script,...args],{cwd:root,env,stdio:'inherit'});
    child.on('error',reject);child.on('exit',(code,signal)=>code===0?resolve():reject(new Error(`Local packaging failed (${signal||code})`)));
  });
}
await run(await binary('@opennextjs/cloudflare','opennextjs-cloudflare'),['build']);
await run(path.join(root,'scripts','embed-assets.mjs'));
await run(await binary('wrangler','wrangler'),['deploy','--dry-run','--outdir','.wrangler/bundle','--minify']);
