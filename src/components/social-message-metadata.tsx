import type {Message} from './data';
const delivery:Record<string,string>={received:'รับแล้ว',queued:'รอส่งจาก CRM',sending:'กำลังส่ง',submitted:'ช่องทางรับคำขอแล้ว',sent:'ส่งแล้ว',delivered:'ถึงผู้รับแล้ว',read:'อ่านแล้ว',failed:'ส่งไม่สำเร็จ',unknown:'ยังไม่ทราบผล · รอตรวจสอบ',cancelled:'ยกเลิกแล้ว'};
export function SocialMessageMetadata({message}:{message:Message}){
  return <>{message.provider&&<small className="muted">{message.provider} · {delivery[message.deliveryStatus||'']||message.deliveryStatus}</small>}{message.attachments?.map(file=><div key={file.id}><a href={'/api/admin/social-attachments/'+encodeURIComponent(file.id)}>{file.type} · ดาวน์โหลดไฟล์แนบ</a>{file.state!=='archived'&&<small className="muted"> · รอสำรองไฟล์จากช่องทาง</small>}</div>)}</>;
}
