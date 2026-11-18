import type {Message} from './data';
import {WebChatFiles} from './web-chat-attachments';
const delivery:Record<string,string>={received:'รับแล้ว',queued:'รอส่งจาก CRM',preparing:'กำลังเตรียมไฟล์',sending:'กำลังส่ง',submitted:'ช่องทางรับคำขอแล้ว',sent:'ส่งแล้ว',delivered:'ถึงผู้รับแล้ว',read:'อ่านแล้ว',failed:'ส่งไม่สำเร็จ',unknown:'ยังไม่ทราบผล · รอตรวจสอบ',cancelled:'ยกเลิกแล้ว'};
const archival:Record<string,string>={queued:'รอสำรองไฟล์',working:'กำลังสำรองไฟล์',retry:'รอลองสำรองไฟล์ใหม่',blocked:'รอตรวจการเชื่อมต่อเพื่อสำรองไฟล์',archived:'สำรองไฟล์แล้ว',failed:'สำรองไฟล์ไม่สำเร็จ · ให้ผู้ดูแลตรวจสอบ',cancelled:'ยกเลิกการสำรองไฟล์'};
export function SocialMessageMetadata({message}:{message:Message}){
  const classification:Record<string,string>={legitimate:'คำถามลูกค้า',unclear:'รอข้อมูลเพิ่ม',off_topic:'นอกเรื่องสินค้า',suspected_spam:'เข้าข่ายสแปม',flood:'ส่งข้อความซ้ำ',unsafe_attachment_or_link:'ไฟล์หรือลิงก์ต้องตรวจ',complaint_or_support:'ร้องเรียนหรือขอความช่วยเหลือ',opt_out:'ขอหยุดติดต่อ',prompt_injection:'ข้อความต้องให้คนตรวจ'};
  return <><WebChatFiles files={message.webAttachments} staff/>{message.provider&&<small className="muted">{message.provider} · {delivery[message.deliveryStatus||'']||message.deliveryStatus}
    {message.triage&&' · '+(classification[message.triage.category]||message.triage.category)}</small>}
    {message.attachments?.map(file=><div key={file.id}>
      {file.archiveState==='quarantined'?<strong>พักไฟล์เพื่อตรวจสอบความปลอดภัย</strong>:<><a href={'/api/admin/social-attachments/'+encodeURIComponent(file.id)}>{file.name||file.type} · ดาวน์โหลดไฟล์แนบ</a>
        {file.deliveryStatus&&<small className="muted"> · {delivery[file.deliveryStatus]||file.deliveryStatus}</small>}
        <small className="muted"> · {file.state==='archived'?'สำรองไฟล์แล้ว':archival[file.archiveState||'']||'รอสำรองไฟล์จากช่องทาง'}</small></>}
    </div>)}</>;
}
