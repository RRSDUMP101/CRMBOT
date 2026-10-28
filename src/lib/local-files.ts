import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import type {PrivateBucket} from './files';
export function localBucket():PrivateBucket {
  const directory=path.resolve(process.env.D1_LOCAL_DIR||process.env.PGLITE_DIR||'.data/rrs-demo-d1','files');
  function target(key:string){if(!/^[0-9a-f-]+\/[0-9a-f-]+$/.test(key))throw new Error('Invalid private object key');return path.join(directory,key.replace('/','_'));}
  return {
    async put(key,value){await mkdir(directory,{recursive:true});await writeFile(target(key),value,{mode:0o600,flag:'wx'});},
    async get(key){try{const bytes=await readFile(target(key));return {body:new Response(bytes).body!};}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}},
  };
}
