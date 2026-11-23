// An Admin publishes each exact question through Flows. The operator opts a single
// account and immutable published version in by giving its orgId, accountId,
// flowId, version and stepId in RRS_PHASE1_WA_QUALIFICATION_RULES (a JSON array).
export const qualificationQuestions = [
  'ต้องการใช้รถขนวัสดุอะไร และต้องการบรรทุกครั้งละประมาณกี่ตันครับ?',
  'รถที่ต้องการติดตั้งเป็นรุ่นอะไร และเป็นรถปีไหนครับ?',
  'ต้องการจำนวนกี่ชุด และปลายทางจัดส่งอยู่ที่ไหนครับ?',
  'ต้องการรับใบเสนอราคาที่อีเมลใดครับ?',
  'What material will you carry, and approximately how much will each load weigh?',
  'What is the vehicle model and model year?',
  'How many units do you need, and where will they be delivered?',
  'Which email address should receive your quotation?'
] as const;
type Scope = {orgId:string;accountId:string;flowId:string;version:number;stepId:string;provider:string;trigger:string;text:string;status:string;assigned:boolean};
export function scopedQualification(env:Record<string,unknown>, s:Scope){
  if(env.FLOWS_ENABLED!=='true'||s.provider!=='whatsapp'||s.status!=='bot_active'||s.assigned
    ||!['inbound_message','keyword'].includes(s.trigger)||!qualificationQuestions.some(t=>t===s.text))return false;
  try{
    const rules:unknown=JSON.parse(String(env.RRS_PHASE1_WA_QUALIFICATION_RULES||'[]'));
    return Array.isArray(rules)&&rules.some(r=>r&&r.orgId===s.orgId&&r.accountId===s.accountId&&r.flowId===s.flowId&&r.version===s.version&&r.stepId===s.stepId);
  }catch{return false;}
}
