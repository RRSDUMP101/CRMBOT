# RRS Connect — Chatbot + CRM on Cloudflare

ระบบเว็บแชตและพื้นที่ทำงานทีมขาย พร้อม Login, Inbox, ลูกค้า, งานติดตาม, คลังความรู้, ข้อความตอบสำเร็จรูป และไฟล์ลูกค้าแบบส่วนตัว

Production ใช้ **Cloudflare Workers + D1 + R2** ผ่าน Next.js/OpenNext ไม่มี Neon หรือ Google Cloud ในเส้นทางทำงานของแอป รายละเอียดการวางระบบและข้อจำกัดอยู่ใน [deployment guide](docs/deployment-cloudflare.md)

## Runtime

- Workers รันทั้งหน้าเว็บและ API บน origin เดียวกัน
- D1 เก็บข้อมูล CRM, สมาชิก, session, ประวัติ, งาน และ metadata ไฟล์ แยกฐานข้อมูลจากแอปอื่น
- R2 เก็บ PDF/JPG/PNG แบบ private; API ตรวจ login และองค์กรก่อนดาวน์โหลด ไม่มี public bucket URL
- Password ใช้ PBKDF2-SHA256 600,000 รอบพร้อม random salt; session token สุ่มและเก็บเฉพาะ HMAC ใน D1
- ทุก business mutation ใช้ D1 atomic batch กับ organization revision เพื่อตรวจการแก้ไขพร้อมกันและ retry เฉพาะ conflict ที่ rollback แน่นอน
- เมื่อ AI ยังไม่มี credential ใช้ `AI_PROVIDER=disabled` และส่งข้อความเข้าคิวให้ทีมรับช่วง ไม่มีบอต Demo ใน production

## Local Demo

ต้องใช้ Node.js 24 และ pnpm 11.25.0

```sh
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm db:seed
pnpm dev
```

เปิด http://localhost:3000 และ http://localhost:3000/chat โดยให้ hostname ตรงกับ `APP_ORIGIN`

| บัญชีตัวอย่าง | บทบาท |
| --- | --- |
| admin@rrs.demo หรือ admin_demo | Admin ขององค์กรตัวอย่าง RRS |
| agent@rrs.demo หรือ agent_demo | Agent ขององค์กรตัวอย่าง RRS |
| outsider@other.demo | Admin อีกองค์กร สำหรับทดสอบการแยกข้อมูล |

รหัสผ่านตัวอย่าง: `Demo-only-2026!` ใช้เฉพาะข้อมูลสังเคราะห์ การ seed ถูกจำกัดไว้ในเครื่องและไม่ถูกรวมใน Worker production

Demo ใช้ SQLite ใน `D1_LOCAL_DIR` และไฟล์ใน subdirectory `files` เพื่อพัฒนาเท่านั้น ห้ามใช้ local filesystem เป็น production database

## งานที่รองรับ

- Inbox แยกคิวของฉัน / ยังไม่มอบหมาย / รอคน / ยังไม่อ่าน / ปิดแล้ว ค้นชื่อลูกค้าและประวัติด้วยข้อความภาษาไทยยาวได้
- สถานะอ่านแยกสมาชิกและไม่ย้อนกลับเมื่อมีข้อความเข้าพร้อมกัน
- รับช่วง / ตอบ / บันทึกภายใน / คืนให้บอต / ปิดบทสนทนา พร้อม generation fence ป้องกันคำตอบเก่าทับคำตอบใหม่
- ลูกค้าและ Pipeline พร้อมข้อมูลติดต่อแบบยินยอม งานติดตามและคำขอนัดที่ต้องรอคนยืนยัน
- คลังความรู้เผยแพร่/ร่าง/วันหมดอายุ พร้อม version และแหล่งอ้างอิง
- จัดการสมาชิก Admin/Agent, ยกเลิก session และป้องกันลบสิทธิ์ผู้ดูแลคนสุดท้าย
- แนบไฟล์ลูกค้า PDF/JPG/PNG สูงสุด 10 MiB ตรวจชนิดเนื้อหาและจำกัดโควตา 1 GiB ต่อองค์กรเป็นค่าเริ่มต้น
- Website widget พร้อม allowed origins และ visitor cookie แยกจาก staff cookie

Public visitor ไม่ได้รับบันทึกภายใน แท็ก Pipeline หรือรายละเอียดสมาชิก ข้อมูล CRM/API ไม่เข้า shared cache

## Tests

```sh
pnpm typecheck
pnpm test
pnpm test:migrations
pnpm test:integrity
pnpm test:deployment
pnpm cf:build
pnpm test:worker
```

`test:worker` รัน bundle จริงบน workerd/Miniflare พร้อม D1 และ R2 ชั่วคราว ใช้ข้อมูลสังเคราะห์และ AI จำลอง ตรวจหน้า login/static assets และ HTTP acceptance รวมการแยกองค์กร การแก้พร้อมกัน วิดเจ็ต และไฟล์ ห้ามเปลี่ยน URL ให้ทดสอบกับ production

`test:api` และ `test:helpdesk` ใช้กับ local Demo ที่เปิดอยู่ได้โดยกำหนด `BASE_URL` ให้ตรง origin; รันตามลำดับ

## Deploy

```sh
pnpm cf:build
# Use an ignored deployment config with verified D1 identifiers.
pnpm exec wrangler deploy --config .wrangler/deploy.jsonc
```

การ deploy ผ่าน Cloudflare MCP สามารถใช้ `.wrangler/bundle/worker.js` ซึ่งรวม public build assets แล้ว เนื่องจาก connector ไม่รองรับ custom authorization header ที่ Static Assets upload ต้องใช้ การ deploy ด้วย Wrangler ตามปกติใช้ ASSETS binding ได้ อย่านำไฟล์ส่วนตัวใน R2 มารวมใน bundle

`wrangler.jsonc` มี database ID ตัวอย่างเท่านั้น ห้าม commit secret หรือ resource identifier ของบัญชีจริง ตั้ง `SESSION_SECRET` และ optional `OPENAI_API_KEY` ผ่าน Cloudflare Secrets

## ขอบเขต

ยังไม่มี receiver ของ LINE, Messenger หรือ WhatsApp ใน CRM นี้ และไม่ย้าย webhook ของ Sale Office/WhatsApp Hub โดยอัตโนมัติ การรับเว็บแชตที่ผ่านการทดสอบไม่ได้พิสูจน์ว่า social webhook ทำงานแล้ว

การเชื่อมช่องทางภายนอกต้องตรวจลายเซ็น, บันทึก/เข้าคิวอย่างทนทานก่อนตอบรับ, กัน event ซ้ำ และแยกการเรียก AI ออกจาก HTTP webhook เพื่อไม่ให้รอจน timeout การไม่มี Neon/Cloud Run ตัดการรอปลุกสองบริการนั้น แต่ไม่ใช่การรับประกัน uptime หรือไม่มี cold start ทุกกรณี

AI จริง, load test ตามปริมาณใช้งาน, recovery drill, retention policy และการทดสอบ webhook จริงต้องรายงานแยกจากผลทดสอบ local เสมอ
