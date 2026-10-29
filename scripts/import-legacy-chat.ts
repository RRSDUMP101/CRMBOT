/** Operator tool. Default is an offline plan; --apply explicitly writes to the configured CRM bridge. */
import { readFile } from 'node:fs/promises';
import { planLegacyImport, summarizeLegacyPlan } from '../src/lib/legacy-chat-import';
import { signBridgeRequest } from '../src/lib/bridge-protocol';

async function main() {
  const argumentsList = process.argv.slice(2);
  const option = (name: string) => { const at=argumentsList.indexOf(name);return at<0?undefined:argumentsList[at+1]; };
  const file = option('--snapshot'), optionsFile = option('--options');
  const apply = argumentsList.includes('--apply'), remote = apply || argumentsList.includes('--remote-plan');
  if (!file) throw Error('Usage: node --import tsx scripts/import-legacy-chat.ts --snapshot <file.json> [--options <file.json>] [--allow-source-updates] [--remote-plan | --apply]');
  const bytes=await readFile(file);if(bytes.byteLength>7*1024*1024)throw Error('Snapshot exceeds the 7 MiB operator limit; prepare a reviewed larger-export transport instead of truncating records');
  const snapshot=JSON.parse(bytes.toString('utf8')),options=optionsFile?JSON.parse(await readFile(optionsFile,'utf8')):{};
  if(!options||typeof options!=='object'||Array.isArray(options))throw Error('Import options must be a JSON object');
  if(argumentsList.includes('--allow-source-updates'))options.allowSourceUpdates=true;
  const orgId=process.env.CRM_BRIDGE_ORG_ID||'';if(!orgId)throw Error('Set CRM_BRIDGE_ORG_ID for the intended CRM organization');
  if(!remote){const summary=summarizeLegacyPlan(planLegacyImport(snapshot,orgId,options));process.stdout.write(JSON.stringify(summary,null,2)+'\n');if(!summary.valid)process.exitCode=1;return;}
  const origin=process.env.CRM_BRIDGE_ORIGIN||'',secret=process.env.CRM_BRIDGE_SECRET||'';
  const parsed=new URL(origin);if(parsed.pathname!=='/'||parsed.search||parsed.hash||parsed.username||parsed.password)throw Error('CRM_BRIDGE_ORIGIN must be an origin without credentials, path, query or fragment');
  const url=parsed.origin+'/api/bridge/import';
  async function call(value: unknown) {
    const body=JSON.stringify(value);if(Buffer.byteLength(body)>8*1024*1024)throw Error('Signed import request exceeds 8 MiB');
    const response=await fetch(url,{method:'POST',headers:await signBridgeRequest(url,{method:'POST',body,secret,orgId}),body,redirect:'error',signal:AbortSignal.timeout(60000)});
    const result=await response.json();if(!response.ok)throw Error(`CRM import rejected (${response.status}): ${typeof result.error==='string'?result.error:'check the operator report'}`);return result;
  }
  const preview=await call({snapshot,options,dryRun:true});process.stdout.write(JSON.stringify(preview,null,2)+'\n');
  if(!apply)return;if(!preview.valid)throw Error('Import plan has validation errors; no data was applied');
  let cursor=0;
  for(let batches=0;batches<10000;batches++){
    const result=await call({snapshot,options,dryRun:false,cursor,limit:25});
    process.stdout.write(JSON.stringify({progress:result.progress,verification:result.verification})+'\n');
    if(result.progress.complete){if(!result.verification?.matched)throw Error('Imported row counts did not verify');return;}
    if(result.progress.cursor<=cursor)throw Error('Import made no progress; inspect the committed cursor before retry');
    cursor=result.progress.cursor;
  }
  throw Error('Batch limit reached; rerun the same immutable snapshot to resume safely');
}
main().catch(error=>{process.stderr.write((error instanceof Error?error.message:'Legacy import failed')+'\n');process.exitCode=1;});
