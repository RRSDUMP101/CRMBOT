import { randomUUID, scryptSync, randomBytes } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';

export type Row = Record<string, any>;
export type QueryResult<T extends Row = Row> = { rows: T[]; rowCount: number };
export type Executor = { query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<QueryResult<T>> };
type Store = { embedded?: PGlite; pool?: Pool; ready?: Promise<void>; tail: Promise<void> };
const globalDb = globalThis as typeof globalThis & { rrsDatabase?: Store };
const store: Store = globalDb.rrsDatabase ??= { tail: Promise.resolve() };

export const demoMode = () => process.env.DEMO_MODE === 'true';

function passwordHash(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

async function open() {
  if (store.embedded || store.pool) return;
  if (demoMode()) {
    // Runtime database storage must never be bundled into a deployment artifact.
    const directory = path.resolve(/* turbopackIgnore: true */ process.env.PGLITE_DIR || '.data/rrs-demo');
    await mkdir(/* turbopackIgnore: true */ directory, { recursive: true });
    store.embedded = new PGlite(directory);
    await store.embedded.waitReady;
  } else {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required outside DEMO_MODE');
    if ((process.env.SESSION_SECRET || '').length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters');
    if (!process.env.APP_ORIGIN) throw new Error('APP_ORIGIN is required outside DEMO_MODE');
    const origin=new URL(process.env.APP_ORIGIN);
    if(origin.origin!==process.env.APP_ORIGIN || (origin.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(origin.hostname)))throw new Error('APP_ORIGIN must be an HTTPS origin, except localhost development');
    store.pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  }
}

async function rawQuery<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
  if (store.embedded) {
    const result = await store.embedded.query<T>(sql, params);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  }
  if (!store.pool) throw new Error('Database not initialized');
  const result = await store.pool.query(sql, params);
  return { rows: result.rows as T[], rowCount: result.rowCount || 0 };
}

async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const previous = store.tail;
  let unlock!: () => void;
  store.tail = new Promise<void>(resolve => { unlock = resolve; });
  await previous;
  try { return await fn(); } finally { unlock(); }
}

async function executeMigration() {
  // Explicit ordered manifest keeps migration files traceable in the deployment artifact.
  const migrations=[
    {version:1,sql:await readFile(path.join(process.cwd(),'migrations/001_initial.sql'),'utf8')},
    {version:2,sql:await readFile(path.join(process.cwd(),'migrations/002_helpdesk.sql'),'utf8')}
  ];
  const client=store.pool?await store.pool.connect():undefined;
  const run=async(sql:string,params:unknown[]=[])=>client?client.query(sql,params):rawQuery(sql,params);
  try {
    if(client)await client.query('SELECT pg_advisory_lock(726726101)');
    await run('CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
    for(const migration of migrations) {
      if((await run('SELECT version FROM schema_migrations WHERE version=$1',[migration.version])).rows.length)continue;
      await run('BEGIN');
      try {
        if(store.embedded)await store.embedded.exec(migration.sql);else await client!.query(migration.sql);
        await run('INSERT INTO schema_migrations(version) VALUES($1) ON CONFLICT(version) DO NOTHING',[migration.version]);
        await run('COMMIT');
      } catch(error) {await run('ROLLBACK');throw error;}
    }
  } finally {
    if(client){try {await client.query('SELECT pg_advisory_unlock(726726101)');} finally {client.release();}}
  }
}

export async function migrateDatabase() {
  await open();
  await exclusive(executeMigration);
}

export async function seedDemo() {
  if (!demoMode()) throw new Error('Demo seed is disabled outside DEMO_MODE');
  await open();
  await exclusive(async () => {
    const existing = await rawQuery('SELECT id FROM organizations WHERE slug=$1', ['rrs']);
    if (existing.rows.length) return;
    const org = randomUUID(); const other = randomUUID();
    const password = passwordHash('Demo-only-2026!');
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
        await rawQuery('INSERT INTO members(id,org_id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(),tenant,name,email,password,role]);
      }
      for (const item of seeds) await rawQuery("INSERT INTO knowledge(id,org_id,title,content,tags,status,source_url) VALUES($1,$2,$3,$4,$5,'published',$6)",[randomUUID(),org,item.title,item.content,JSON.stringify(item.tags),'https://rungruengdump101.com/']);
      for(const item of [
        {title:'ขอข้อมูลรถ',shortcut:'/vehicle',content:'ขอทราบรุ่นรถและปีรถที่ต้องการใช้งานหน่อยค่ะ เพื่อให้ทีมตรวจสอบรายละเอียดต่อ',category:'คัดกรอง'},
        {title:'รับเรื่องขอใบเสนอราคา',shortcut:'/quote',content:'รับความต้องการแล้วค่ะ ทีมจะตรวจสเปกและรายละเอียดจัดส่งก่อนจัดทำใบเสนอราคา',category:'เสนอราคา'},
        {title:'ส่งออก',shortcut:'/export',content:'ต้องการส่งสินค้าไปประเทศและเมืองไหนคะ ทีมจะใช้ข้อมูลนี้ตรวจสอบเงื่อนไขจัดส่งต่อค่ะ',category:'ส่งออก'}
      ])await rawQuery('INSERT INTO reply_templates(id,org_id,title,shortcut,content,category) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),org,item.title,item.shortcut,item.content,item.category]);
      await rawQuery('COMMIT');
    } catch (error) { await rawQuery('ROLLBACK'); throw error; }
  });
}

async function ready() {
  if (!store.ready) store.ready = (async () => {
    await open();
    if (demoMode()) { await executeMigration(); await seedDemo(); }
    else if(!(await rawQuery('SELECT version FROM schema_migrations WHERE version=2')).rows.length)throw new Error('Database migration 002 is required');
  })().catch(error => { store.ready = undefined; throw error; });
  return store.ready;
}

export const database: Executor = {
  async query<T extends Row = Row>(sql: string, params: unknown[] = []) {
    await ready();
    return exclusive(() => rawQuery<T>(sql, params));
  }
};

export async function transaction<T>(fn: (connection: Executor) => Promise<T>): Promise<T> {
  await ready();
  return exclusive(async () => {
    const client = store.pool ? await store.pool.connect() : undefined;
    const query: Executor['query'] = async <R extends Row>(sql: string, params: unknown[] = []) => {
      if (!client) return rawQuery<R>(sql, params);
      const result = await client.query(sql, params);
      return { rows: result.rows as R[], rowCount: result.rowCount || 0 };
    };
    const executor: Executor = { query };
    await query('BEGIN');
    try { const result = await fn(executor); await query('COMMIT'); return result; }
    catch (error) { await query('ROLLBACK'); throw error; }
    finally { client?.release(); }
  });
}

export async function closeDatabase() {
  await store.tail;
  await store.embedded?.close(); await store.pool?.end();
  store.embedded = undefined; store.pool = undefined; store.ready = undefined;
}

export function camel(row: Row): Row {
  const result: Row = {};
  for (const [key, value] of Object.entries(row)) {
    result[key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value instanceof Date ? value.toISOString() : value;
  }
  return result;
}
