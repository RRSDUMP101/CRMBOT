export type ModelIdentity = {provider:'anthropic'|'openai';model:string};

/** Accept model ids reported by a provider or trusted Sale gateway. */
export function readModelIdentity(value:unknown):ModelIdentity|undefined {
  if(!value || typeof value!=='object')return;
  const {provider,model}=value as Record<string,unknown>;
  if((provider!=='anthropic' && provider!=='openai') || typeof model!=='string' || !/^[a-z0-9][a-z0-9.:_-]{0,119}$/i.test(model))return;
  return {provider,model};
}

export function modelTitle({provider,model}:ModelIdentity) {
  if(provider==='anthropic'){
    // Accept both generations of Anthropic naming, such as 3-5-sonnet and sonnet-4-5.
    const name=model.replace(/^claude-/i,'').replace(/-\d{8}$/,'');
    const match=/^(?:(\d+(?:[-.]\d+)*)-)?(sonnet|opus|haiku)(?:-(\d+(?:[-.]\d+)*))?$/i.exec(name);
    if(match)return [match[2][0].toUpperCase()+match[2].slice(1).toLowerCase(),(match[1]||match[3]||'').replaceAll('-','.')].filter(Boolean).join(' ');
  }
  return model;
}
