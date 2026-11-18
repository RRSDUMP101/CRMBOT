# ตรวจรับ WhatsApp และคิวตรวจสแปม

## ฐานซอร์สและระบบที่ตรวจ

GitHub แสดง 10 branch ของ CRMBOT เมื่อ 18 พฤศจิกายน 2026 สาขาที่มีซอร์สล่าสุดคือ `claude/busy-hamilton-bc5h3j` ที่ `e0c46819d3b3cb6ba43d92df253c81c5d47f852e` ลงวันที่ 2 พฤศจิกายน Local baseline `d7d4190` มี Git tree เดียวกันที่ `e0fac11034a0caee7ed6a68b25171c0f0e561cf3` การแก้ไขอยู่ในสาขาแยก `codex/rrs-ai-sales-workflow` [GitHub commit](https://github.com/RRSDUMP101/CRMBOT/commit/e0c46819d3b3cb6ba43d92df253c81c5d47f852e)

Cloudflare ผูก `rrs-crm-terminal.com` และ `www.rrs-crm-terminal.com` กับ Worker `rrs-crm-terminal` เวอร์ชัน `ee588dfe-51ea-4e40-becd-94f05b43fd4d` รับทราฟฟิก 100% ใน deployment วันที่ 14 พฤศจิกายน ข้อความกำกับเวอร์ชันคือ “Prepare authorized WhatsApp CRM replies and test recipient” ทั้ง 10 GitHub branch มีวันที่ก่อน deployment และไม่มี Git SHA ใน annotation ที่ตรวจ ก่อน rollout ให้เจ้าของระบบเทียบ source/build manifest กับเวอร์ชันนี้และยืนยัน Meta callback subscription ของ WABA/phone ID ในบัญชีจริง

## ติดตั้งใน staging

1. ใช้ staging CRM และ Hub ที่มี D1 คนละฐาน ใช้ข้อมูลสังเคราะห์และปิด live-send ของ WhatsApp, LINE และอีเมล ใช้ webhook path, ผู้รับ และบัญชีทดสอบของทีม
2. ใช้ migration runner เดิมกับ staging CRM ให้ถึง `094_sales_knowledge.sql` และ `095_whatsapp_triage.sql` ทั้งคู่สร้างตารางเพิ่ม ฐานเดิมเก็บข้อความ การอนุมัติ และ cursor ตามเดิม
3. เปิด verified ingress ตาม `docs/chat-bridge.md` และเลือก bridge v2 ฝั่ง Hub ให้ตรงองค์กรและ credential ของ staging เปิด `RRS_SALES_KNOWLEDGE_ENABLED=true` เฉพาะเมื่อจะเก็บข้อมูลลูกค้าแบบมีแหล่งที่มา
4. ผู้ดูแล CRM เปิด **สถานะซิงก์และระบบ → ตรวจสแปม WhatsApp** โหมดเริ่มต้นบันทึกผลสังเกต เกณฑ์เริ่มต้นคือข้อความเดิม 5 ครั้งใน 60 วินาทีสำหรับตัวตน WhatsApp ภายในบัญชีเดียว รูปหลายใบและประเทศของผู้ส่งไม่ใช่เกณฑ์พัก ผู้ดูแลบันทึกผลตรวจและปรับโหมดหรือเกณฑ์จากหน้านี้ได้
5. สำหรับ AI ช่วยอ่านเฉพาะข้อความกำกวม เปิด `RRS_SALES_SEMANTIC_SPAM_ENABLED=true` ใน staging ทั้งสองฝั่ง เปิด `RRS_SALES_AI_GATEWAY_ENABLED=true` ใน Hub และตั้ง `RRS_SALES_SPAM_REVIEW_ACTOR` เป็นบัญชีผู้ดูแล Hub ที่มีสิทธิ์ใน workspace นั้น ใช้ `CRM_SERVICE` หรือ origin และ signing config ของ bridge เดิม
6. ใน Hub ประเมินและอนุมัติ route ของ `spam_triage` แยกตาม `whatsapp:<phone_number_id>` และ workspace ใช้ source version `9fb365158f1b7dcdaadb05cdae425a7d21f25d7bf6efa923115c790f0903f7cc` ซึ่งเป็น SHA-256 ของข้อกำหนด `rrs-spam-v1/semantic-review-v1` ทดสอบทั้ง primary และ fallback และตรวจ budget ก่อนอนุมัติการใช้ provider ของทีม
7. งาน reconcile ของ Hub ดึงได้หนึ่งข้อความกำกวมต่อรอบ ผ่าน request ลงนามไปยัง CRM และตรวจ v2 projection ของข้อความ กับ account/workspace ก่อนส่งข้อความไม่เกิน 2,000 อักขระให้โมเดล ผลพร้อมข้อความอ้างอิง ค่า confidence ที่โมเดลประเมิน และรุ่นโมเดลจะปรากฏในคิว CRM ระบบให้พนักงานตัดสินการพักและปล่อยคืน งานที่หมดเวลาหรือโมเดลไม่พร้อมอยู่ให้คนตรวจ

## ตรวจการประมวลผลซ้ำและการปล่อยคืน

คำสั่งจาก checkout ของ CRM ใช้ Node 24 และ dependencies จาก lockfile การทดสอบคู่ใช้ checkout ของ Hub ที่อยู่ติดกัน หรือกำหนด `RRS_SALE_CHECKOUT`

```powershell
node --import tsx --test tests/whatsapp-triage.test.ts tests/social-channels.test.ts tests/media-archive-queue.test.ts tests/migrations.test.ts
node --import tsx tests/rfq-triage-paired.mjs
```

CRM บันทึกการตัดสินใน transaction เดียวกับข้อความ ผ่าน `messageProvenance.record.metadata` ที่เป็น JSON string ให้ Hub อ่าน `rrsSales.version`, `policyVersion`, `category`, `eligible` และ `quotationRequested` จาก signed v2 event การคืนข้อความเดิมเพิ่ม revision ของ provenance แล้วใช้ message ID เดิม การปล่อยคืนหลังมีข้อความใหม่ คนรับช่วง หรือ opt-out จบที่การตรวจโดยคน อ่านประวัติผู้ตรวจ เหตุผล และข้อความก่อนหน้าจากคิวได้

## ถอยรุ่นและกู้คืน

ปิด semantic worker ทั้งสองฝั่ง ปิดงานอัตโนมัติที่ใช้ข้อมูลใหม่และการส่งออกก่อนเปลี่ยนรุ่น เก็บ migration 094/095, ข้อความ, outbox, delivery receipts, review audit และ bridge cursor ไว้ในฐานเดิม นำ binary ที่ยืนยันว่าเข้ากันได้กับ schema กลับมา และตรวจ hash/cursor ของสองฝั่งก่อนเริ่ม worker

ถ้าต้องกู้ snapshot ให้ตรวจว่ามี receipts ของผลภายนอกหลังเวลา backup หรือไม่ กระทบยอดคำสั่ง `sending` หรือ `unknown` กับหลักฐานของ provider และทะเบียนการส่งจริงก่อนอนุญาตงานต่อ ใช้ paired fixture ในฐานแยกตรวจ event replay และเก็บผลซ้อมกู้คืน การทดสอบ fixture ไม่ครอบคลุมการกู้ backup บัญชีจริงหรือการนำส่งจริงไปยังลูกค้า
