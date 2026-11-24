import {Globe,Mail,MessageSquare} from 'lucide-react';
import {modelTitle,type ModelIdentity} from '../lib/model-identity';

const channels:Record<string,{name:string;asset:string}>={
  whatsapp:{name:'WhatsApp',asset:'whatsapp'},line:{name:'LINE',asset:'line'},
  facebook:{name:'Facebook',asset:'facebook'},instagram:{name:'Instagram',asset:'instagram'},
  gmail:{name:'Gmail',asset:'gmail'},outlook:{name:'Outlook',asset:'microsoftoutlook'}
};
export function ChannelIcon({provider}:{provider?:string|null}) {
  const key=(provider||'').toLowerCase();
  const entry=Object.hasOwn(channels,key)?channels[key]:undefined;
  const label=entry?.name||(key==='web'||key==='website'?'เว็บแชต':key==='email'?'อีเมล':'ช่องทางอื่น');
  return <span className="desk-channel-mark" role="img" aria-label={label} title={label}>{entry?<img src={'/brands/'+entry.asset+'.svg'} width="19" height="19" alt=""/>:key==='email'?<Mail size={15}/>:key==='web'||key==='website'?<Globe size={15}/>:<MessageSquare size={15}/>}</span>;
}
export function ModelBadge({identity}:{identity?:ModelIdentity|null}) {
  if(!identity)return <span className="desk-model"><span>ผู้ช่วย AI</span><b>ยังไม่ทราบรุ่น</b></span>;
  const claude=identity.provider==='anthropic';
  return <span className={'desk-model '+(claude?'is-claude':'is-openai')}><img width="16" height="16" src={'/brands/'+(claude?'claude':'openai')+'.svg'} alt=""/><span>{claude?'Claude':'OpenAI'}</span><b title={identity.model}>{modelTitle(identity)}</b></span>;
}

export function contactName(name?:string|null) {
  return (name||'ลูกค้าใหม่').replace(/^รอยืนยันตัวตน · (?:whatsapp|line|facebook|instagram|gmail|outlook) (.{1,6})$/i,'ผู้ติดต่อ · $1');
}
