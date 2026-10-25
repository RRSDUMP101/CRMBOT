# RRS Connect — AI Chatbot + CRM

เว็บแชตและพื้นที่ทำงานทีมขายสำหรับ RRS รุ่งเรืองดั๊มพ์ 101: ตอบข้อมูลที่อนุมัติ เก็บความต้องการลูกค้าไทย/ส่งออก และส่งต่อเจ้าหน้าที่เพื่อเสนอราคา มีฐานข้อมูล การเข้าสู่ระบบ และ API ที่ตรวจสิทธิ์จริง

**สถานะ: MVP สำหรับตรวจรับก่อนนำขึ้นระบบจริง ยังไม่ Deploy และยังไม่เชื่อม Sale Office, Google Sheets/Drive หรือ social channels** โหมด Demo ใช้ PostgreSQL แบบฝังตัวบนดิสก์และบอตจำลอง ไม่ได้เรียก AI ภายนอก ตัวเลข Dashboard คำนวณจากรายการในฐานข้อมูล รวมถึงรายการที่ผู้ทดลองสร้าง

## เริ่มใช้งาน Demo

ต้องมี Node.js 22 ขึ้นไป (ทดสอบบน 24.19.0) และ pnpm 11.25.0

```sh
corepack enable
corepack prepare pnpm@11.25.0 --activate
pnpm install --frozen-lockfile
```

คัดลอก `.env.example` เป็น `.env.local` โดยคง `DEMO_MODE=true`, `AI_PROVIDER=demo`, `APP_ORIGIN=http://localhost:3000`

```sh
pnpm db:migrate
pnpm db:seed
pnpm dev
```

เปิด [พื้นที่ทีมงาน](http://localhost:3000) และ [แชตลูกค้า](http://localhost:3000/chat) ใช้ hostname ให้ตรง `APP_ORIGIN` หากเปิดผ่าน `127.0.0.1` แทน `localhost` ต้องปรับค่าด้วย ไม่เช่นนั้นระบบจะปฏิเสธคำขอแก้ข้อมูล

| บัญชี Demo | บทบาท |
| --- | --- |
| `admin@rrs.demo` | Admin องค์กร RRS |
| `agent@rrs.demo` | Agent องค์กร RRS |
| `outsider@other.demo` | Admin องค์กร B สำหรับทดสอบการแยกข้อมูล |

รหัสผ่าน Demo ทุกบัญชี: `Demo-only-2026!` เป็นข้อมูลตัวอย่างสาธารณะเท่านั้น การ seed จะถูกปฏิเสธเมื่อปิด Demo ไม่มีข้อมูลลูกค้าจริงใน seed

Demo เก็บข้อมูลใน `PGLITE_DIR` (ค่าเริ่มต้น `.data/rrs-demo`) หลัง refresh และ restart ข้อมูลยังอยู่ ใช้ได้เพียง **หนึ่ง process ต่อ directory** หยุดเซิร์ฟเวอร์ก่อนรันคำสั่งฐานข้อมูล ห้ามวาง PGlite บน serverless filesystem หรือใช้เป็นฐานข้อมูลหลาย replica

## ฟีเจอร์ที่ทำงาน

- แชตมือถือ/เดสก์ท็อป: SSE streaming, loading, retry ด้วย message ID เดิม, ประวัติผูก visitor cookie แบบ HttpOnly, ปุ่มส่งต่อคน, แบบฟอร์มยินยอมเก็บช่องทางติดต่อ
- ภาษาไทย/อังกฤษ: แยกตลาดไทย/ส่งออก เก็บรุ่นรถ ปี cab จำนวนและประเทศ รองรับการแก้ข้อมูลเดิม ถามข้อมูลที่ยังขาดทีละเรื่อง กฎราคา/ส่วนลด/สต็อก/น้ำหนักบรรทุกไม่ใช้คำตอบคาดเดา
- Inbox: ค้นหาและกรองแชต รับช่วง/คืนให้บอต ตอบลูกค้า บันทึกภายใน สรุปข้อมูลที่ลูกค้าแจ้งแยกเรื่องรอตรวจสอบ และแหล่งข้อมูลพร้อมรุ่นเอกสาร
- CRM: โปรไฟล์ แท็ก ความสนใจ ผู้รับผิดชอบ Pipeline 5 สถานะ งานติดตาม และประวัติการเปลี่ยนแปลง
- นัดหมาย: ลูกค้าตรวจวันเวลาและรายละเอียดก่อนส่งคำขอ สถานะยังเป็น pending จนเจ้าหน้าที่ยืนยัน ไม่มีการตัดสินใจจองอัตโนมัติหรือเชื่อมปฏิทินภายนอก
- Knowledge Base: FAQ/ข้อความ draft/published รุ่นเอกสาร สถานะ ready/error แหล่งข้อมูล วันหมดอายุ แก้/ลบมีผลกับการค้นครั้งถัดไปทันที เก็บสำเนาหลักฐานเก่าในประวัติข้อความ
- Dashboard: ข้อมูลจริง ช่วงวันที่ Asia/Bangkok Pipeline งานครบกำหนด อัตราส่งต่อ เวลาตอบ AI/พนักงาน โทเคนและค่าใช้จ่ายเมื่อมีข้อมูล
- Admin/Agent: ตรวจสิทธิ์ฝั่งเซิร์ฟเวอร์ทุกคำขอ แยกองค์กรด้วย query scope และ composite foreign keys ไม่เชื่อ tenant ID ที่ browser ส่งมา

## เชื่อม PostgreSQL และ AI จริง

1. จัดเตรียม PostgreSQL ที่เข้าถึงได้จาก Node server และตั้ง `DATABASE_URL` เป็น connection string ของบัญชีแอป ใช้ TLS ของผู้ให้บริการ ไม่ปิด certificate verification
2. ตั้ง `DEMO_MODE=false`, `APP_ORIGIN=https://โดเมนของคุณ`, `SESSION_SECRET` เป็นค่าที่สุ่มอย่างปลอดภัยอย่างน้อย 32 ตัวอักษร และ `PUBLIC_ORG_SLUG=rrs` ห้ามใช้ฐานข้อมูล Demo เป็น production
3. รัน `pnpm db:migrate` ตั้ง `PROVISION_ADMIN_EMAIL`, `PROVISION_ADMIN_NAME`, `PROVISION_ADMIN_PASSWORD` (อย่างน้อย 16 ตัวอักษร) เป็น environment ชั่วคราว แล้วรัน `pnpm exec tsx scripts/db.ts provision` ลบค่า provisioning หลังสำเร็จ คำสั่งไม่เขียนทับองค์กรเดิม
4. เข้าสู่ระบบ เพิ่มสมาชิกและเผยแพร่ KB ที่เจ้าของอนุมัติเอง Seed สาธิตจะไม่ถูกนำเข้า production อัตโนมัติ
5. ตั้ง `AI_PROVIDER=openai`, `OPENAI_API_KEY` ที่เซิร์ฟเวอร์เท่านั้น และ `OPENAI_MODEL` ที่บัญชีของคุณเข้าถึงได้ ตัวอย่างเริ่มต้น `gpt-6-luna` เปลี่ยนผู้ให้บริการได้ใน `src/lib/bot.ts`
6. หากต้องการประมาณค่าใช้จ่าย ให้ตั้ง `AI_INPUT_USD_PER_MILLION` และ `AI_OUTPUT_USD_PER_MILLION` ตามราคาปัจจุบันของโมเดล/สัญญาของคุณ ระบบใช้ usage จาก provider; ไม่มีข้อมูลจะแสดง “ไม่มีข้อมูล” ไม่มีการแต่งจำนวนโทเคน
7. `pnpm build` แล้ว `pnpm start` หลังผ่านการตรวจรับและได้รับคำสั่ง Deploy ตั้ง reverse proxy รองรับ SSE ไม่ buffer และ timeout มากกว่า 120 วินาที

OpenAI adapter ใช้ Responses API ฝั่งเซิร์ฟเวอร์ `stream:true`, `store:false` แยกคำสั่งระบบออกจากเอกสารและข้อความผู้ใช้ `store:false` ไม่ใช่การรับรองว่า provider ไม่มีการเก็บ log ทุกประเภท ต้องตรวจเงื่อนไขบริการจริงก่อนใช้ข้อมูลส่วนบุคคล

`AI_DAILY_CALL_LIMIT` ค่าเริ่มต้น 500 จองสิทธิ์ตอบในฐานข้อมูลต่อองค์กรต่อวันไทย เมื่อครบจะส่งต่อคน อัตรานี้รวมคำตอบ Demo/กฎด้วยเพื่อให้ทดสอบได้ **เป็นเพดานจำนวนครั้ง ไม่ใช่เพดานเงินบาท** งบ 2,000 บาท/เดือนยังขึ้นกับโมเดล โทเคน hosting ฐานข้อมูลและค่าช่องทาง ตั้ง spend limit ฝั่ง provider และเลือกโครงสร้างพื้นฐานก่อนเปิดจริง ไม่มีการสมัครบริการเสียเงินในงานนี้

หากใช้ proxy ให้ตั้ง `TRUSTED_IP_HEADER` เฉพาะ header ที่ proxy ลบค่าจากผู้ใช้และเขียนใหม่เสมอ มิฉะนั้นคงว่าง (ใช้ rate bucket รวมสำหรับการสร้าง session/login ซึ่งอาจจำกัดผู้ใช้หลายคนร่วมกัน)

## ทดสอบ

```sh
pnpm typecheck
pnpm test
pnpm build
```

เมื่อเซิร์ฟเวอร์ Demo เปิดอยู่ที่ localhost:3000 ให้รันอีก terminal:

```sh
pnpm test:api
```

ใช้ `BASE_URL` เพื่อเปลี่ยน URL เป้าหมาย ชุด API ทดสอบจะสร้าง/แก้ข้อมูลตัวอย่างจริง **รันเฉพาะฐานข้อมูล Demo สำหรับทดสอบ** ถ้าทดสอบซ้ำจนชน rate limit ให้ใช้ directory Demo ใหม่หลังหยุด server ห้ามลบข้อมูลใช้งานจริงเพื่อรันทดสอบ

ดูผลตรวจรับและข้อจำกัดที่ `docs/VERIFICATION.md` ไม่มีการกล่าวอ้างว่าทดสอบ OpenAI บัญชีจริงหรือ managed PostgreSQL หากยังไม่ได้ทำ

## แบบจำลองและความปลอดภัย

```mermaid
flowchart LR
  C[Customer web chat] --> API[Next.js API: session + origin + validation]
  W[Staff workspace] --> API
  API --> DB[(PostgreSQL / Demo PGlite)]
  API --> KB[Published non-expired tenant KB]
  KB --> B[Policy rules + provider adapter]
  B --> L[OpenAI Responses API optional]
  B --> E[Epoch guard + SSE + persisted transcript]
  E --> C
```

ตารางหลัก: `organizations`, `members`, `staff_sessions`, `visitors`, `leads`, `conversations`, `messages`, `tasks`, `knowledge`, `audit_events`, `rate_buckets`, `ai_daily_usage` migration อยู่ใน `migrations/` ทุก entity ของลูกค้าผูก `org_id`; foreign key คู่ `(org_id,id)` ป้องกันการอ้างข้ามองค์กร บัญชีใช้ salted scrypt และ cookie token เก็บเป็น HMAC hash ที่ฐานข้อมูล ไม่มี localStorage access token

การรับช่วงเปลี่ยน status และ version ภายใน transaction การส่งแต่ละ chunk และการบันทึกคำตอบตรวจ version โดยล็อกแถวเดียวกับการ claim พนักงานจึงหยุด generation เก่าได้ ฝั่งลูกค้าตรวจ version/status เพิ่มอีกชั้น คำตอบที่ถูกขัดจังหวะไม่ถูกใช้เป็นประวัติหลักฐานให้ AI ต่อ

ความจำความต้องการเป็นข้อมูลที่ลูกค้าแจ้งเอง ไม่ใช่การอนุมัติสเปก ส่วนชื่อ/เบอร์/อีเมลมีแบบฟอร์มขอความยินยอมและบันทึก consent version/time ไม่ถือเป็นความยินยอมทางการตลาด การพิมพ์ข้อมูลส่วนบุคคลในแชตยังทำให้ข้อมูลนั้นอยู่ใน transcript ต้องกำหนด privacy notice และระยะเก็บก่อนใช้จริง

Session เจ้าหน้าที่มีอายุ 12 ชั่วโมง; visitor 30 วัน รัน `pnpm exec tsx scripts/db.ts cleanup` เพื่อล้าง session/rate bucket ที่หมดอายุ ข้อมูลลูกค้าไม่ถูกลบอัตโนมัติใน MVP ให้กำหนด retention, กระบวนการส่งออก/ลบข้อมูลและสำรอง/กู้คืนตามนโยบายองค์กรก่อนรับข้อมูลจริง การใช้ application scope นี้ไม่ได้อ้างว่าเปิด PostgreSQL RLS แล้ว

## ขอบเขตที่ยังต้องทำก่อนขยาย

- เชื่อม Sale Office/Sheets/Drive ต้องยืนยัน API และผู้เป็นเจ้าของข้อมูล ใช้ฐานข้อมูลนี้เป็นแหล่งหลักแชต/สถานะ แล้วส่ง projection ผ่าน outbox ที่มี idempotency/retry; **ยังไม่ได้ implement sync** ไม่มีการเขียนระบบ Sale Office เดิม
- LINE OA/Facebook/WhatsApp ยังไม่เชื่อม ต้องเพิ่ม channel identity, webhook signature/replay checks และข้อกำหนดการส่งข้อความก่อนเปิด
- Demo Adapter รองรับ intent/คำแก้เฉพาะที่ทดสอบ ไม่ใช่ LLM จริง สรุป facts เป็นโค้ดแบบกำหนดผลลัพธ์ ไม่ได้อ้างว่าโมเดลวิเคราะห์ทุกข้อความ
- ไม่รวม upload/OCR, vector embeddings, MFA/SSO, email invitation/reset password, calendar conflict checking, ใบเสนอราคาอัตโนมัติ หรือการรวมลูกค้าข้ามอุปกรณ์โดยใช้เบอร์ที่ยังไม่ยืนยัน
- Dashboard cohort นับการเปิด chat session เป็นบทสนทนา/ลีดใหม่ ยังไม่ใช่ยอดผู้ให้ข้อมูลติดต่อที่ผ่านการคัดกรอง Pipeline เป็นสถานะปัจจุบันของ cohort; due tasks เป็นงานเปิดทั้งหมดที่ครบกำหนด ณ ตอนนี้; usage กรองตามเวลา message
- ต้องทดสอบ backup/restore, PostgreSQL แบบหลาย process, browser อื่นและ load test ตามจำนวนผู้ใช้พร้อมกันก่อนใช้จริง Inbox แสดง 1,000 บทสนทนาล่าสุด และ CRM/งาน 2,000 รายการล่าสุด การค้น/กรองใน UI ครอบคลุมรายการที่โหลด ส่วน Dashboard คำนวณจากข้อมูลทั้งหมดในช่วงที่เลือก ต้องเพิ่ม pagination และการค้นฝั่งเซิร์ฟเวอร์สำหรับประวัติระยะยาว

## เอกสารทางการที่ตรวจสอบ

ตรวจวันที่ **25 ตุลาคม 2026** เวอร์ชันที่ติดตั้งยืนยันจาก npm registry และล็อกใน `pnpm-lock.yaml`

- [Next.js installation](https://nextjs.org/docs/app/getting-started/installation) — Next.js 16.4.3 / React 19.3.1, Node requirement
- [shadcn/ui Next.js](https://ui.shadcn.com/docs/installation/next) — component-source pattern, Radix Slot และ CVA; components อยู่ใน repository และปรับสไตล์เอง
- [Tailwind Next.js guide](https://tailwindcss.com/docs/installation/framework-guides/nextjs) — Tailwind/PostCSS 4.3.3
- [PGlite getting started](https://pglite.dev/docs/) — embedded PostgreSQL พร้อม disk persistence สำหรับ Demo
- [node-postgres](https://node-postgres.com/features/queries) — parameterized SQL สำหรับฐานข้อมูลจริง
- [OpenAI streaming](https://developers.openai.com/api/docs/guides/streaming-responses) — server-side streaming events; [data controls](https://developers.openai.com/api/docs/guides/your-data)

ไม่มีการรับรองราคาผู้ให้บริการหรือความสอดคล้องกฎหมายจากการติดตั้งโค้ดนี้เพียงอย่างเดียว
