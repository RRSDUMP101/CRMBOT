import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const cron='* * * * *';
// One Worker scheduled handler serves several independent jobs. Turning archive
// off must never remove the clock for an enabled bridge or another durable runner.
function needsMinuteSchedule(vars={}){
  const on=key=>vars[key]==='true';
  return on('SOCIAL_MEDIA_ARCHIVE_ENABLED')||
    on('CRM_BRIDGE_ENABLED')&&(on('CRM_SALE_SYNC_ENABLED')||on('CRM_SALE_CONTEXT_ENABLED'))||
    on('FLOWS_ENABLED')||
    on('BROADCAST_ENABLED')&&on('BROADCAST_RUNNER_ENABLED')||
    on('CRM_PUBLIC_WEBHOOKS_ENABLED')&&on('CRM_PUBLIC_WEBHOOK_RUNNER_ENABLED')||
    on('EXTERNAL_CONNECTORS_ENABLED')&&on('EXTERNAL_CONNECTOR_RUNNER_ENABLED');
}
export function configureMediaArchiveSchedule(config){
  const copy=structuredClone(config),enabled=copy.vars?.SOCIAL_MEDIA_ARCHIVE_ENABLED==='true';
  if(enabled&&(copy.vars.SOCIAL_CHANNELS_OWNER!=='crm'||copy.vars.SOCIAL_INBOUND_ENABLED!=='true'||!/^[a-f0-9-]{36}$/i.test(copy.vars.SOCIAL_CHANNELS_ORG_ID||'')))throw Error('Archive schedule requires explicit CRM inbound ownership and organization');
  copy.triggers={...copy.triggers,crons:[...(copy.triggers?.crons||[]).filter(value=>value!==cron),...needsMinuteSchedule(copy.vars)?[cron]:[]]};return copy;
}
export function checkMediaArchiveSchedule(config){
  const expected=configureMediaArchiveSchedule(config).triggers.crons;
  if(JSON.stringify(expected)!==JSON.stringify(config.triggers?.crons||[]))throw Error('Minute cron does not match the enabled automation jobs');
  return {enabled:config.vars?.SOCIAL_MEDIA_ARCHIVE_ENABLED==='true',cronConfigured:expected.includes(cron)};
}
export function parseDeploymentConfig(text){
  let clean='',quoted=false,escaped=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i];if(quoted){clean+=ch;if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;continue;}
    if(ch==='"'){quoted=true;clean+=ch;continue;}
    if(ch==='/'&&text[i+1]==='/'){while(i<text.length&&text[i]!=='\n')i++;clean+='\n';continue;}
    if(ch==='/'&&text[i+1]==='*'){i+=2;while(i<text.length&&!(text[i]==='*'&&text[i+1]==='/'))i++;if(i>=text.length)throw Error('Invalid deployment comment');i++;clean+=' ';continue;}
    clean+=ch;
  }
  let final='';quoted=false;escaped=false;
  for(let i=0;i<clean.length;i++){const ch=clean[i];if(quoted){final+=ch;if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;continue;}if(ch==='"')quoted=true;if(ch===','&&/^\s*[}\]]/.test(clean.slice(i+1)))continue;final+=ch;}
  return JSON.parse(final);
}
async function readConfig(file){return parseDeploymentConfig(await readFile(file,'utf8'));}
async function main(){
  const [action,input,output]=process.argv.slice(2);if(!input||!['--check','--configure'].includes(action)||action==='--configure'&&!output)throw Error('Use --check <config> or --configure <input> <ignored-output.json>');
  const original=await readConfig(input),config=action==='--configure'?configureMediaArchiveSchedule(original):original;
  if(action==='--configure')await writeFile(output,JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});
  process.stdout.write(JSON.stringify(checkMediaArchiveSchedule(config))+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
