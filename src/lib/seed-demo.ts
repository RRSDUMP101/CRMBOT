import {randomUUID} from 'node:crypto';
import {hashPassword} from './auth';
import {statement,type D1Binding,type D1Statement} from './db';
export async function seedDemoDatabase(binding:D1Binding) {
  const pending:D1Statement[]=[];
  async function rawQuery(sql:string,params:unknown[]=[]) {
    if(sql==='BEGIN'||sql==='ROLLBACK')return {rows:[]};
    if(sql==='COMMIT'){await binding.batch(pending);return {rows:[]};}
    if(sql.startsWith('SELECT'))return {rows:(await statement(binding,sql,params).all()).results||[]};
    pending.push(statement(binding,sql,params));return {rows:[]};
  }
    const existing = await rawQuery('SELECT id FROM organizations WHERE slug=$1', ['rrs']);
    if (existing.rows.length) return;
    const org = randomUUID(); const other = randomUUID();
    const password = await hashPassword('Demo-only-2026!');
    const seeds = [
      { title: 'ข้อมูลธุรกิจและการขอใบเสนอราคา', tags: ['ทั่วไป', 'ราคา', 'ใบเสนอราคา'], content: 'RRS รุ่งเรืองดั๊มพ์ 101 ให้ข้อมูลสินค้ากลุ่มชุดดั๊มพ์และงานดั๊มพ์สำหรับรถบรรทุก สำหรับลูกค้าไทยและลูกค้าส่งออก รายละเอียดรถ รุ่น ปี ลักษณะงาน จำนวน และพื้นที่จัดส่งจะช่วยให้ทีมขายตรวจสอบและเสนอราคาได้เหมาะสม ราคา สต็อก ระยะเวลาผลิต ส่วนลด และการรับประกันรอทีมงานยืนยันเป็นรายกรณี' },
      { title: 'ลูกค้าในประเทศและข้อมูลรถ', tags: ['ไทย', 'ในประเทศ', 'รุ่นรถ', 'ชุดดั๊มพ์'], content: 'การสอบถามชุดดั๊มพ์หรืองานติดตั้งสำหรับลูกค้าในประเทศไทย เริ่มจากรุ่นรถ ปีรถ รูปแบบการใช้งาน จำนวน และจังหวัดปลายทาง ทีมงานจะตรวจสอบความเข้ากันได้และรายละเอียดทางเทคนิคก่อนยืนยัน ข้อมูลน้ำหนักบรรทุกและการใช้งานต้องตรวจสอบตามรถจริง' },
      { title: 'ลูกค้าส่งออกและปลายทาง', tags: ['ส่งออก', 'export', 'shipping', 'ต่างประเทศ'], content: 'การสอบถามส่งออกใช้ข้อมูลประเทศและเมืองปลายทาง สินค้าที่สนใจ รุ่นรถหรือข้อมูลการใช้งาน และจำนวน เพื่อให้ทีมขายตรวจสอบต่อ เงื่อนไขจัดส่ง เอกสารนำเข้า ภาษี ระยะเวลา และราคาต้องรอทีมขายยืนยัน' },
      { title: 'การติดต่อและนัดหมาย', tags: ['ติดต่อ', 'นัดหมาย', 'เจ้าหน้าที่'], content: 'คุณสามารถกดขอคุยกับเจ้าหน้าที่ผ่านแชตได้ และเลือกให้ข้อมูลติดต่อเพื่อให้ทีมขายติดต่อกลับ การส่งคำขอนัดหมายจะอยู่ในสถานะรอทีมงานยืนยัน ยังไม่ใช่การยืนยันเวลานัด ผู้ช่วย AI ไม่รับชำระเงิน และรายละเอียดส่วนลดหรือสต็อกจะให้ทีมงานตรวจสอบ' }
    ];
    await rawQuery('BEGIN');
    try {
      await rawQuery('INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3),($4,$5,$6)', [org,'rrs','RRS รุ่งเรืองดั๊มพ์ 101 — Demo',other,'other','องค์กรตัวอย่าง B']);
      for (const [email, name, role, tenant] of [['admin@rrs.demo','ผู้ดูแล RRS','Admin',org],['agent@rrs.demo','ทีมขาย RRS','Agent',org],['outsider@other.demo','ทีมองค์กร B','Admin',other]]) {
        await rawQuery('INSERT INTO members(id,org_id,name,email,password_hash,role,username) VALUES($1,$2,$3,$4,$5,$6,$7)', [randomUUID(),tenant,name,email,password,role,email.split('@')[0]+'_demo']);
      }
      for (const item of seeds) await rawQuery("INSERT INTO knowledge(id,org_id,title,content,tags,status,source_url) VALUES($1,$2,$3,$4,$5,'published',$6)",[randomUUID(),org,item.title,item.content,JSON.stringify(item.tags),'https://rungruengdump101.com/']);
      for(const item of [
        {title:'ขอข้อมูลรถ',shortcut:'/vehicle',content:'ขอทราบรุ่นรถและปีรถที่ต้องการใช้งานหน่อยค่ะ เพื่อให้ทีมตรวจสอบรายละเอียดต่อ',category:'คัดกรอง'},
        {title:'รับเรื่องขอใบเสนอราคา',shortcut:'/quote',content:'รับความต้องการแล้วค่ะ ทีมจะตรวจสเปกและรายละเอียดจัดส่งก่อนจัดทำใบเสนอราคา',category:'เสนอราคา'},
        {title:'ส่งออก',shortcut:'/export',content:'ต้องการส่งสินค้าไปประเทศและเมืองไหนคะ ทีมจะใช้ข้อมูลนี้ตรวจสอบเงื่อนไขจัดส่งต่อค่ะ',category:'ส่งออก'}
      ])await rawQuery('INSERT INTO reply_templates(id,org_id,title,shortcut,content,category) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),org,item.title,item.shortcut,item.content,item.category]);
      await rawQuery('COMMIT');
    } catch (error) { await rawQuery('ROLLBACK'); throw error; }
}
