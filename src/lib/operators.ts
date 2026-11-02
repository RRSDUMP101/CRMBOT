import { createHash, randomUUID } from 'node:crypto';
import { ApiError, fields, isoDate, oneOf, requireAdmin, str, uuid, type Staff } from './auth';
import { camel, database, transaction, type Executor, type Row } from './db';
import { inbox } from './helpdesk';

const now = () => new Date().toISOString();
const json = (value: unknown) => JSON.stringify(value);
const parse = (value: string) => JSON.parse(value);
const positiveVersion = (value: unknown, zero = false) => {
  if (!Number.isSafeInteger(value) || Number(value) < (zero ? 0 : 1)) throw new ApiError(400, 'เวอร์ชันไม่ถูกต้อง');
  return Number(value);
};
const bool = (value: unknown) => { if (typeof value !== 'boolean') throw new ApiError(400, 'ค่าต้องเป็นจริงหรือเท็จ'); return Number(value); };
async function audit(c: Executor, staff: Staff, action: string, id: string, data: unknown = {}) {
  await c.query('INSERT INTO audit_events(id,org_id,actor_id,action,entity_id,metadata) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), staff.orgId, staff.id, 'operator.' + action, id, json(data)]);
}
async function conversation(c: Executor, orgId: string, id: string) {
  const row = (await c.query('SELECT c.*,l.market,l.name,l.phone FROM conversations c JOIN leads l ON l.org_id=c.org_id AND l.id=c.lead_id WHERE c.org_id=$1 AND c.id=$2', [orgId, uuid(id)])).rows[0];
  if (!row) throw new ApiError(404, 'ไม่พบบทสนทนา');
  return row;
}
async function lead(c: Executor, orgId: string, id: string) {
  const row = (await c.query('SELECT * FROM leads WHERE org_id=$1 AND id=$2', [orgId, uuid(id)])).rows[0];
  if (!row) throw new ApiError(404, 'ไม่พบลูกค้า');
  return row;
}
async function member(c: Executor, orgId: string, id: string) {
  const row = (await c.query('SELECT id FROM members WHERE org_id=$1 AND id=$2 AND active=1', [orgId, uuid(id)])).rows[0];
  if (!row) throw new ApiError(400, 'ไม่พบสมาชิกที่ใช้งานอยู่');
}
async function team(c: Executor, orgId: string, id: string) {
  const row = (await c.query('SELECT * FROM operator_teams WHERE org_id=$1 AND id=$2', [orgId, uuid(id)])).rows[0];
  if (!row) throw new ApiError(404, 'ไม่พบทีม');
  return row;
}
async function canRead(c: Executor, staff: Staff, row: Row) {
  if (row.visibility === 'organization' || row.owner_id === staff.id) return true;
  // A personal draft/template is private even from other administrators.
  if (row.visibility !== 'team') return false;
  return staff.role === 'Admin' || !!(await c.query('SELECT 1 FROM operator_team_members WHERE org_id=$1 AND team_id=$2 AND member_id=$3', [staff.orgId, row.team_id, staff.id])).rows.length;
}
async function scope(c: Executor, staff: Staff, visibility: unknown, teamId: unknown) {
  const value = oneOf(visibility, ['personal', 'team', 'organization'], 'ขอบเขต');
  if (value !== 'personal') requireAdmin(staff);
  const id = value === 'team' ? uuid(teamId) : null;
  if (id) await team(c, staff.orgId, id);
  return { visibility: value, teamId: id };
}

export function validateViewFilters(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'ตัวกรองไม่ถูกต้อง');
  const raw = value as Record<string, unknown>;
  fields(raw, ['view', 'q', 'status', 'assignee', 'tag', 'unread', 'provider', 'account']);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(raw)) {
    const text = str(entry, 'ตัวกรอง', key === 'q' ? 200 : 160);
    if (!text) continue;
    if (key === 'view') oneOf(text, ['all', 'mine', 'unassigned', 'waiting', 'closed', 'unread'], 'มุมมอง');
    if (key === 'status') oneOf(text, ['bot_active', 'human_active', 'waiting_human', 'resolved'], 'สถานะ');
    if (key === 'assignee' && !['me', 'unassigned'].includes(text)) uuid(text);
    if (key === 'unread') oneOf(text, ['true', 'false'], 'ยังไม่อ่าน');
    if (key === 'provider') oneOf(text, ['web', 'whatsapp', 'line', 'facebook', 'instagram', 'email', 'gmail', 'outlook'], 'ช่องทาง');
    result[key] = text;
  }
  if (result.account && (!result.provider || result.provider === 'web')) throw new ApiError(400, 'กรุณาเลือกช่องทางของบัญชี');
  return result;
}
export async function saveView(staff: Staff, body: Record<string, unknown>) {
  fields(body, ['id', 'version', 'name', 'visibility', 'filters', 'remove']);
  const id = body.id ? uuid(body.id) : randomUUID();
  return transaction(staff.orgId, async c => {
    const old = (await c.query('SELECT * FROM operator_views WHERE org_id=$1 AND id=$2', [staff.orgId, id])).rows[0];
    if (body.id && !old) throw new ApiError(404, 'ไม่พบมุมมอง');
    if (old && old.owner_id !== staff.id && !(old.visibility === 'organization' && staff.role === 'Admin')) throw new ApiError(403, 'แก้ไขได้เฉพาะมุมมองของตนเอง');
    if (old && positiveVersion(body.version) !== old.version) throw new ApiError(409, 'มุมมองถูกแก้ไขแล้ว กรุณาโหลดใหม่');
    if (body.remove === true) { await c.query('DELETE FROM operator_views WHERE org_id=$1 AND id=$2', [staff.orgId, id]); return { id, removed: true }; }
    const visibility = oneOf(body.visibility, ['personal', 'organization'], 'ขอบเขต');
    if (visibility === 'organization') requireAdmin(staff);
    const filters = validateViewFilters(body.filters), name = str(body.name, 'ชื่อมุมมอง', 80, true);
    if (filters.assignee && !['me', 'unassigned'].includes(filters.assignee)) await member(c, staff.orgId, filters.assignee);
    const count = Number((await c.query('SELECT count(*) AS n FROM operator_views WHERE org_id=$1 AND owner_id=$2', [staff.orgId, staff.id])).rows[0].n);
    if (!old && count >= 50) throw new ApiError(409, 'บันทึกได้ไม่เกิน 50 มุมมองต่อคน');
    if (old) await c.query('UPDATE operator_views SET name=$3,visibility=$4,filters_json=$5,version=version+1 WHERE org_id=$1 AND id=$2', [staff.orgId, id, name, visibility, json(filters)]);
    else await c.query('INSERT INTO operator_views(id,org_id,owner_id,name,visibility,filters_json) VALUES($1,$2,$3,$4,$5,$6)', [id, staff.orgId, staff.id, name, visibility, json(filters)]);
    return { id, version: (old?.version || 0) + 1, name, visibility, filters };
  }, staff);
}
export async function viewInbox(staff: Staff, url: URL) {
  const saved = url.searchParams.get('savedView');
  if (saved) {
    const row = (await database.query('SELECT * FROM operator_views WHERE org_id=$1 AND id=$2 AND (owner_id=$3 OR visibility=\'organization\')', [staff.orgId, uuid(saved), staff.id])).rows[0];
    if (!row) throw new ApiError(404, 'ไม่พบมุมมอง');
    const next = new URL(url); for (const key of [...next.searchParams.keys()]) if (!['cursor', 'limit'].includes(key)) next.searchParams.delete(key);
    for (const [key, value] of Object.entries(validateViewFilters(parse(row.filters_json)))) next.searchParams.set(key, value);
    return inbox(staff, next);
  }
  return inbox(staff, url);
}

export async function saveDraft(staff: Staff, conversationId: string, body: Record<string, unknown>) {
  fields(body, ['kind', 'text', 'version']);
  const kind = oneOf(body.kind, ['reply', 'note'], 'ประเภทข้อความ'), text = str(body.text, 'ร่างข้อความ', 6000), expected = positiveVersion(body.version, true);
  return transaction(staff.orgId, async c => {
    await conversation(c, staff.orgId, conversationId);
    const row = (await c.query('SELECT version FROM operator_drafts WHERE org_id=$1 AND conversation_id=$2 AND member_id=$3 AND kind=$4', [staff.orgId, conversationId, staff.id, kind])).rows[0];
    if ((row?.version || 0) !== expected) throw new ApiError(409, 'ร่างถูกแก้ไขจากหน้าต่างอื่นแล้ว กรุณาโหลดใหม่ก่อนบันทึก');
    await c.query('INSERT INTO operator_drafts(org_id,conversation_id,member_id,kind,content,version,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(org_id,conversation_id,member_id,kind) DO UPDATE SET content=excluded.content,version=excluded.version,updated_at=excluded.updated_at', [staff.orgId, conversationId, staff.id, kind, text, expected + 1, now()]);
    return { kind, text, version: expected + 1 };
  }, staff);
}
export async function heartbeat(staff: Staff, id: string, body: Record<string, unknown>) {
  fields(body, ['typing']); const typing = bool(body.typing);
  return transaction(staff.orgId, async c => {
    await conversation(c, staff.orgId, id);
    const expires = new Date(Date.now() + 45_000).toISOString();
    await c.query('DELETE FROM operator_presence WHERE org_id=$1 AND expires_at<=$2', [staff.orgId, now()]);
    await c.query('INSERT INTO operator_presence(org_id,conversation_id,member_id,typing,expires_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(org_id,conversation_id,member_id) DO UPDATE SET typing=excluded.typing,expires_at=excluded.expires_at', [staff.orgId, id, staff.id, typing, expires]);
    return { expiresAt: expires };
  }, staff);
}
export async function addInternalNote(staff: Staff, id: string, body: Record<string, unknown>) {
  fields(body, ['text', 'mentions', 'clientId']);
  const text = str(body.text, 'บันทึกภายใน', 6000, true), clientId = uuid(body.clientId);
  if (!Array.isArray(body.mentions) || body.mentions.length > 20) throw new ApiError(400, 'ระบุสมาชิกได้ไม่เกิน 20 คน');
  const mentions = [...new Set(body.mentions.map(x => uuid(x)))].sort(), hash = createHash('sha256').update(json({ id, text, mentions })).digest('hex');
  return transaction(staff.orgId, async c => {
    await conversation(c, staff.orgId, id);
    const prior = (await c.query('SELECT message_id,payload_hash FROM operator_note_requests WHERE org_id=$1 AND member_id=$2 AND client_id=$3', [staff.orgId, staff.id, clientId])).rows[0];
    if (prior) { if (prior.payload_hash !== hash) throw new ApiError(409, 'รหัสบันทึกนี้ใช้กับเนื้อหาอื่นแล้ว'); return { id: prior.message_id }; }
    for (const target of mentions) await member(c, staff.orgId, target);
    const messageId = randomUUID();
    await c.query("INSERT INTO messages(id,org_id,conversation_id,role,content,author_member_id,author_type) VALUES($1,$2,$3,'note',$4,$5,'human')", [messageId, staff.orgId, id, text, staff.id]);
    for (const target of mentions) await c.query('INSERT INTO operator_mentions(org_id,message_id,member_id) VALUES($1,$2,$3)', [staff.orgId, messageId, target]);
    await c.query('INSERT INTO operator_note_requests(org_id,member_id,client_id,conversation_id,message_id,payload_hash) VALUES($1,$2,$3,$4,$5,$6)', [staff.orgId, staff.id, clientId, id, messageId, hash]);
    await c.query("UPDATE conversations SET updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') WHERE org_id=$1 AND id=$2", [staff.orgId, id]);
    await audit(c, staff, 'note', messageId, { conversationId: id, mentions });
    return { id: messageId };
  }, staff);
}
export async function markMentionSeen(staff: Staff, id: string) {
  return transaction(staff.orgId, async c => {
    await c.query('UPDATE operator_mentions SET seen_at=COALESCE(seen_at,$4) WHERE org_id=$1 AND message_id=$2 AND member_id=$3', [staff.orgId, uuid(id), staff.id, now()]); return { ok: true };
  }, staff);
}

/** Non-destructive explicit grouping: keeps original provider keys, consents and Sale mappings. */
export async function mergeContacts(staff: Staff, body: Record<string, unknown>) {
  requireAdmin(staff); fields(body, ['sourceId', 'targetId', 'reason']);
  const source = uuid(body.sourceId), target = uuid(body.targetId), reason = str(body.reason, 'เหตุผล', 1000, true);
  if (source === target) throw new ApiError(400, 'กรุณาเลือกลูกค้าคนละรายการ');
  return transaction(staff.orgId, async c => {
    const [a, b] = await Promise.all([lead(c, staff.orgId, source), lead(c, staff.orgId, target)]);
    if (a.market !== b.market) throw new ApiError(409, 'ห้ามรวมลูกค้าข้ามตลาด กรุณาตรวจสอบข้อมูลต้นทาง');
    const old = (await c.query('SELECT * FROM operator_contact_links WHERE org_id=$1 AND (source_lead_id=$2 OR source_lead_id=$3 OR canonical_lead_id=$2)', [staff.orgId, source, target])).rows;
    if (old.length) {
      if (old.length === 1 && old[0].source_lead_id === source && old[0].canonical_lead_id === target) return { canonicalId: target, sourceId: source, revision: old[0].revision, alreadyLinked: true };
      throw new ApiError(409, 'รายการนี้อยู่ในกลุ่มลูกค้าแล้ว กรุณาเลือกข้อมูลหลักโดยตรง');
    }
    const revision = randomUUID().replaceAll('-', '');
    await c.query('INSERT INTO operator_contact_links(org_id,source_lead_id,canonical_lead_id,actor_id,reason,created_at,revision) VALUES($1,$2,$3,$4,$5,$6,$7)', [staff.orgId, source, target, staff.id, reason, now(), revision]);
    await audit(c, staff, 'contact.merge', target, { sourceId: source, targetId: target, revision, reason, market: a.market, consentPolicy: 'preserve_each_source' });
    return { canonicalId: target, sourceId: source, revision };
  }, staff);
}
/** Undo one reviewed link, retaining every original contact, identity, consent and Sale mapping. */
export async function unmergeContacts(staff: Staff, body: Record<string, unknown>) {
  requireAdmin(staff); fields(body, ['sourceId', 'targetId', 'revision', 'reason']);
  const source = uuid(body.sourceId), target = uuid(body.targetId), reason = str(body.reason, 'เหตุผล', 1000, true);
  if (typeof body.revision !== 'string' || !/^[a-f0-9]{32}$/.test(body.revision)) throw new ApiError(400, 'กรุณาโหลดข้อมูลกลุ่มล่าสุด');
  const revision = body.revision;
  return transaction(staff.orgId, async c => {
    await lead(c, staff.orgId, source); await lead(c, staff.orgId, target);
    const old = (await c.query('SELECT * FROM operator_contact_links WHERE org_id=$1 AND source_lead_id=$2', [staff.orgId, source])).rows[0];
    if (!old) {
      const receipt = (await c.query("SELECT id FROM audit_events WHERE org_id=$1 AND action='operator.contact.unmerge' AND entity_id=$2 AND json_extract(metadata,'$.sourceId')=$3 AND json_extract(metadata,'$.revision')=$4 LIMIT 1", [staff.orgId, target, source, revision])).rows[0];
      if (receipt) return { sourceId: source, canonicalId: target, alreadyUnlinked: true };
      throw new ApiError(404, 'ไม่พบการรวมกลุ่มนี้');
    }
    if (old.canonical_lead_id !== target || old.revision !== revision) throw new ApiError(409, 'กลุ่มลูกค้าเปลี่ยนแล้ว กรุณาโหลดใหม่ก่อนแยกกลุ่ม');
    await c.query('DELETE FROM operator_contact_links WHERE org_id=$1 AND source_lead_id=$2 AND canonical_lead_id=$3 AND revision=$4', [staff.orgId, source, target, revision]);
    await audit(c, staff, 'contact.unmerge', target, { sourceId: source, targetId: target, revision, reason, originalActorId: old.actor_id, originalReason: old.reason, originalCreatedAt: old.created_at, consentPolicy: 'preserve_each_source' });
    return { sourceId: source, canonicalId: target, alreadyUnlinked: false };
  }, staff);
}
export async function linkContactIdentity(staff: Staff, body: Record<string, unknown>) {
  requireAdmin(staff); fields(body, ['leadId', 'provider', 'accountId', 'remoteId', 'reason']);
  const leadId = uuid(body.leadId), provider = oneOf(body.provider, ['whatsapp', 'line', 'facebook', 'instagram', 'email', 'external'], 'ช่องทาง');
  const account = str(body.accountId, 'บัญชี', 160, true), remote = str(body.remoteId, 'รหัสลูกค้าภายนอก', 255, true), reason = str(body.reason, 'เหตุผล', 1000, true);
  return transaction(staff.orgId, async c => {
    await lead(c, staff.orgId, leadId);
    const social = (await c.query('SELECT lead_id FROM social_identities WHERE org_id=$1 AND provider=$2 AND account_id=$3 AND remote_id=$4', [staff.orgId, provider, account, remote])).rows[0];
    if (social && social.lead_id !== leadId) throw new ApiError(409, 'ตัวตนนี้เชื่อมกับลูกค้ารายอื่นในช่องทางแล้ว');
    const old = (await c.query('SELECT id,lead_id FROM operator_contact_identities WHERE org_id=$1 AND provider=$2 AND account_id=$3 AND remote_id=$4', [staff.orgId, provider, account, remote])).rows[0];
    if (old) { if (old.lead_id !== leadId) throw new ApiError(409, 'ตัวตนนี้เชื่อมกับลูกค้ารายอื่นแล้ว'); return { id: old.id }; }
    const id = randomUUID();
    await c.query('INSERT INTO operator_contact_identities(id,org_id,lead_id,provider,account_id,remote_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, staff.orgId, leadId, provider, account, remote, now()]);
    await audit(c, staff, 'identity.link', leadId, { identityId: id, provider, accountId: account, reason });
    return { id };
  }, staff);
}

export function validateFieldValue(def: Row, value: unknown): unknown {
  if (value === null || value === '') return null; // Partial drafts remain saveable.
  if (def.field_type === 'text') return str(value, def.name, 2000, true);
  if (def.field_type === 'number' && typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e15) return value;
  if (def.field_type === 'boolean' && typeof value === 'boolean') return value;
  if (def.field_type === 'date' && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value) return value;
  if (def.field_type === 'select' && typeof value === 'string' && parse(def.options_json).includes(value)) return value;
  throw new ApiError(400, `รูปแบบ ${def.name} ไม่ถูกต้อง`);
}
export async function saveFieldDefinition(staff: Staff, body: Record<string, unknown>) {
  requireAdmin(staff); fields(body, ['id', 'version', 'name', 'target', 'type', 'options', 'market', 'requiredOnClose', 'active']);
  const id = body.id ? uuid(body.id) : randomUUID(), name = str(body.name, 'ชื่อฟิลด์', 80, true);
  const target = oneOf(body.target, ['contact', 'ticket'], 'ขอบเขตข้อมูล'), type = oneOf(body.type, ['text', 'number', 'boolean', 'date', 'select'], 'ชนิดข้อมูล'), market = oneOf(body.market, ['all', 'unknown', 'domestic', 'export'], 'ตลาด');
  if (!Array.isArray(body.options) || body.options.length > 50) throw new ApiError(400, 'ตัวเลือกไม่ถูกต้อง');
  const options = [...new Set(body.options.map(x => str(x, 'ตัวเลือก', 80, true)))];
  if (type === 'select' && !options.length) throw new ApiError(400, 'กรุณาระบุตัวเลือก');
  const required = bool(body.requiredOnClose), active = bool(body.active);
  return transaction(staff.orgId, async c => {
    const old = (await c.query('SELECT * FROM operator_field_definitions WHERE org_id=$1 AND id=$2', [staff.orgId, id])).rows[0];
    if (body.id && !old) throw new ApiError(404, 'ไม่พบฟิลด์');
    if (old && positiveVersion(body.version) !== old.version) throw new ApiError(409, 'ฟิลด์ถูกแก้ไขแล้ว กรุณาโหลดใหม่');
    if (old && (old.field_type !== type || old.target !== target)) throw new ApiError(409, 'เปลี่ยนชนิดหรือขอบเขตของฟิลด์เดิมไม่ได้ ให้สร้างฟิลด์ใหม่เพื่อรักษาข้อมูล');
    if (old && type === 'select') {
      const used = (await c.query('SELECT value_json FROM operator_field_values WHERE org_id=$1 AND field_id=$2', [staff.orgId, id])).rows;
      if (used.some(x => parse(x.value_json) !== null && !options.includes(parse(x.value_json)))) throw new ApiError(409, 'ตัวเลือกที่กำลังใช้อยู่ไม่สามารถลบได้');
    }
    const duplicate = (await c.query('SELECT id FROM operator_field_definitions WHERE org_id=$1 AND target=$2 AND name=$3 AND id<>$4', [staff.orgId, target, name, id])).rows.length;
    if (duplicate) throw new ApiError(409, 'มีชื่อฟิลด์นี้แล้ว');
    if (old) await c.query('UPDATE operator_field_definitions SET name=$3,options_json=$4,market=$5,required_on_close=$6,active=$7,version=version+1 WHERE org_id=$1 AND id=$2', [staff.orgId, id, name, json(options), market, required, active]);
    else {
      if (Number((await c.query('SELECT count(*) AS n FROM operator_field_definitions WHERE org_id=$1', [staff.orgId])).rows[0].n) >= 100) throw new ApiError(409, 'สร้างได้ไม่เกิน 100 ฟิลด์');
      await c.query('INSERT INTO operator_field_definitions(id,org_id,name,target,field_type,options_json,market,required_on_close,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id, staff.orgId, name, target, type, json(options), market, required, active]);
    }
    await audit(c, staff, 'field.definition', id, { version: (old?.version || 0) + 1 });
    return { id, version: (old?.version || 0) + 1 };
  }, staff);
}
export async function saveFieldValue(staff: Staff, id: string, body: Record<string, unknown>) {
  fields(body, ['fieldId', 'version', 'definitionVersion', 'value']);
  return transaction(staff.orgId, async c => {
    const chat = await conversation(c, staff.orgId, id), fieldId = uuid(body.fieldId);
    const def = (await c.query('SELECT * FROM operator_field_definitions WHERE org_id=$1 AND id=$2 AND active=1', [staff.orgId, fieldId])).rows[0];
    if (!def || (def.market !== 'all' && def.market !== chat.market)) throw new ApiError(404, 'ไม่พบฟิลด์ในขอบเขตนี้');
    if (positiveVersion(body.definitionVersion) !== def.version) throw new ApiError(409, 'ข้อกำหนดฟิลด์เปลี่ยนแล้ว กรุณาโหลดใหม่');
    const entity = def.target === 'contact' ? chat.lead_id : id, value = validateFieldValue(def, body.value);
    const old = (await c.query('SELECT version FROM operator_field_values WHERE org_id=$1 AND field_id=$2 AND entity_id=$3', [staff.orgId, fieldId, entity])).rows[0];
    if (positiveVersion(body.version, true) !== (old?.version || 0)) throw new ApiError(409, 'ข้อมูลถูกแก้ไขแล้ว กรุณาโหลดใหม่');
    await c.query('INSERT INTO operator_field_values(org_id,field_id,entity_id,value_json,version) VALUES($1,$2,$3,$4,$5) ON CONFLICT(org_id,field_id,entity_id) DO UPDATE SET value_json=excluded.value_json,version=excluded.version', [staff.orgId, fieldId, entity, json(value), (old?.version || 0) + 1]);
    await audit(c, staff, 'field.value', entity, { fieldId, version: (old?.version || 0) + 1 });
    return { version: (old?.version || 0) + 1 };
  }, staff);
}
/** Invoke inside the SAME transaction as every transition to resolved. */
export async function validateRequiredFields(c: Executor, orgId: string, conversationId: string): Promise<void> {
  const chat = await conversation(c, orgId, conversationId);
  const definitions = (await c.query("SELECT d.*,v.value_json FROM operator_field_definitions d LEFT JOIN operator_field_values v ON v.org_id=d.org_id AND v.field_id=d.id AND v.entity_id=CASE WHEN d.target='contact' THEN $2 ELSE $3 END WHERE d.org_id=$1 AND d.active=1 AND d.required_on_close=1 AND (d.market='all' OR d.market=$4)", [orgId, chat.lead_id, conversationId, chat.market])).rows;
  const missing = definitions.filter(def => {
    if (def.value_json === null || def.value_json === undefined) return true;
    try { return validateFieldValue(def, parse(def.value_json)) === null; } catch { return true; }
  });
  if (missing.length) throw new ApiError(422, 'กรุณากรอกข้อมูลก่อนปิดบทสนทนา: ' + missing.map(x => x.name).join(', '));
}

type Hours = { day: number; start: number; end: number }[];
export function validateHours(value: unknown): Hours {
  if (!Array.isArray(value) || value.length > 28) throw new ApiError(400, 'เวลาทำการไม่ถูกต้อง');
  return value.map(entry => {
    if (!entry || typeof entry !== 'object') throw new ApiError(400, 'เวลาทำการไม่ถูกต้อง');
    fields(entry, ['day', 'start', 'end']);
    const { day, start, end } = entry;
    if (![day, start, end].every(Number.isInteger) || day < 0 || day > 6 || start < 0 || end > 1440 || start >= end) throw new ApiError(400, 'เวลาทำการไม่ถูกต้อง');
    return { day, start, end };
  });
}
export function withinHours(timezone: string, hours: Hours, at = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const part = (type: string) => parts.find(x => x.type === type)?.value || '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(part('weekday')), minute = Number(part('hour')) * 60 + Number(part('minute'));
  return hours.some(h => h.day === day && minute >= h.start && minute < h.end);
}
export async function saveTeam(staff: Staff, body: Record<string, unknown>) {
  requireAdmin(staff); fields(body, ['id', 'version', 'name', 'timezone', 'hours', 'market', 'provider', 'accountId', 'enabled', 'priority', 'members']);
  const id = body.id ? uuid(body.id) : randomUUID(), name = str(body.name, 'ชื่อทีม', 80, true), timezone = str(body.timezone, 'เขตเวลา', 80, true);
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); } catch { throw new ApiError(400, 'เขตเวลาไม่ถูกต้อง'); }
  const hours = validateHours(body.hours), market = oneOf(body.market, ['all', 'unknown', 'domestic', 'export'], 'ตลาด');
  const provider = oneOf(body.provider, ['', 'web', 'whatsapp', 'line', 'facebook', 'instagram', 'email', 'gmail', 'outlook'], 'ช่องทาง'), account = str(body.accountId, 'บัญชี', 160), enabled = bool(body.enabled);
  if (account && (!provider || provider === 'web')) throw new ApiError(400, 'กรุณาเลือกช่องทางของบัญชี');
  if (!Number.isInteger(body.priority) || Number(body.priority) < 0 || Number(body.priority) > 1000) throw new ApiError(400, 'ลำดับทีมไม่ถูกต้อง');
  if (!Array.isArray(body.members) || body.members.length > 100) throw new ApiError(400, 'สมาชิกทีมไม่ถูกต้อง');
  const members = body.members.map((raw: Record<string, unknown>) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ApiError(400, 'สมาชิกทีมไม่ถูกต้อง');
    fields(raw, ['id', 'capacity', 'available', 'leaveStart', 'leaveEnd']);
    const memberId = uuid(raw.id), capacity = Number(raw.capacity);
    if (!Number.isInteger(raw.capacity) || capacity < 0 || capacity > 100) throw new ApiError(400, 'ความจุต้องอยู่ระหว่าง 0–100');
    const start = raw.leaveStart ? isoDate(raw.leaveStart, 'เริ่มลา') : null, end = raw.leaveEnd ? isoDate(raw.leaveEnd, 'สิ้นสุดลา') : null;
    if (!!start !== !!end || (start && end && start >= end)) throw new ApiError(400, 'ช่วงวันลาไม่ถูกต้อง');
    return { id: memberId, capacity, available: bool(raw.available), start, end };
  });
  if (new Set(members.map(m => m.id)).size !== members.length) throw new ApiError(400, 'สมาชิกซ้ำ');
  return transaction(staff.orgId, async c => {
    const old = body.id ? await team(c, staff.orgId, id) : null;
    if (old && positiveVersion(body.version) !== old.version) throw new ApiError(409, 'ทีมถูกแก้ไขแล้ว กรุณาโหลดใหม่');
    if ((await c.query('SELECT id FROM operator_teams WHERE org_id=$1 AND name=$2 AND id<>$3', [staff.orgId, name, id])).rows.length) throw new ApiError(409, 'มีชื่อทีมนี้แล้ว');
    for (const m of members) await member(c, staff.orgId, m.id);
    if (old) await c.query('UPDATE operator_teams SET name=$3,timezone=$4,hours_json=$5,market=$6,provider=$7,account_id=$8,enabled=$9,priority=$10,version=version+1 WHERE org_id=$1 AND id=$2', [staff.orgId, id, name, timezone, json(hours), market, provider, account, enabled, body.priority]);
    else await c.query('INSERT INTO operator_teams(id,org_id,name,timezone,hours_json,market,provider,account_id,enabled,priority) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [id, staff.orgId, name, timezone, json(hours), market, provider, account, enabled, body.priority]);
    const previous = (await c.query('SELECT * FROM operator_team_members WHERE org_id=$1 AND team_id=$2', [staff.orgId, id])).rows;
    await c.query('DELETE FROM operator_team_members WHERE org_id=$1 AND team_id=$2', [staff.orgId, id]);
    for (const m of members) await c.query('INSERT INTO operator_team_members(org_id,team_id,member_id,capacity,available,leave_start,leave_end,last_assignment) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [staff.orgId, id, m.id, m.capacity, m.available, m.start, m.end, previous.find(p => p.member_id === m.id)?.last_assignment || 0]);
    await audit(c, staff, 'team.save', id, { enabled: !!enabled, members: members.map(m => m.id), version: (old?.version || 0) + 1 });
    return { id, version: (old?.version || 0) + 1 };
  }, staff);
}
/** Runs after committed handoff/flow actions. CAS retries re-evaluate capacity and membership. */
export async function routeWaitingConversation(orgId: string, id: string, at = new Date(), actor?: Staff) {
  return transaction(orgId, async c => {
    const chat = await conversation(c, orgId, id);
    if (chat.status !== 'waiting_human' || chat.assignee_id) return { assigned: false, reason: 'already_owned_or_not_waiting' };
    const identity = (await c.query('SELECT provider,account_id FROM social_identities WHERE org_id=$1 AND conversation_id=$2 UNION ALL SELECT ea.provider,et.account_id FROM external_threads et JOIN external_accounts ea ON ea.org_id=et.org_id AND ea.id=et.account_id WHERE et.org_id=$1 AND et.conversation_id=$2 LIMIT 1', [orgId, id])).rows[0];
    const teams = (await c.query("SELECT * FROM operator_teams WHERE org_id=$1 AND enabled=1 AND (market='all' OR market=$2) AND (provider='' OR provider=$3 OR (provider='email' AND $3 IN ('gmail','outlook'))) AND (account_id='' OR account_id=$4) ORDER BY priority,id", [orgId, chat.market, identity?.provider || 'web', identity?.account_id || ''])).rows;
    let reason = 'no_matching_team';
    for (const t of teams) {
      if (!withinHours(t.timezone, parse(t.hours_json), at)) { reason = 'outside_business_hours'; continue; }
      const candidates = (await c.query("SELECT tm.*, (SELECT count(*) FROM conversations c WHERE c.org_id=tm.org_id AND c.assignee_id=tm.member_id AND c.status<>'resolved') AS workload FROM operator_team_members tm JOIN members m ON m.org_id=tm.org_id AND m.id=tm.member_id WHERE tm.org_id=$1 AND tm.team_id=$2 AND m.active=1 AND tm.available=1 ORDER BY tm.last_assignment,tm.member_id", [orgId, t.id])).rows;
      const selected = candidates.find(m => m.capacity > m.workload && !(m.leave_start && m.leave_end && Date.parse(m.leave_start) <= at.getTime() && at.getTime() < Date.parse(m.leave_end)));
      if (!selected) { reason = 'no_available_capacity'; continue; }
      await c.query('UPDATE operator_teams SET rotation=rotation+1 WHERE org_id=$1 AND id=$2', [orgId, t.id]);
      await c.query('UPDATE operator_team_members SET last_assignment=$4 WHERE org_id=$1 AND team_id=$2 AND member_id=$3', [orgId, t.id, selected.member_id, Number(t.rotation) + 1]);
      await c.query("UPDATE conversations SET assignee_id=$3,version=version+1,updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') WHERE org_id=$1 AND id=$2", [orgId, id, selected.member_id]);
      await c.query("UPDATE leads SET assignee_id=$3,updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') WHERE org_id=$1 AND id=$2", [orgId, chat.lead_id, selected.member_id]);
      await c.query('INSERT INTO audit_events(id,org_id,actor_id,action,entity_id,metadata) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), orgId, 'system', 'operator.team.assigned', id, json({ teamId: t.id, memberId: selected.member_id, previousAssigneeId: null })]);
      return { assigned: true, reason: 'assigned', memberId: selected.member_id, teamId: t.id };
    }
    return { assigned: false, reason };
  }, actor);
}

const variables = ['contact_name', 'contact_phone', 'staff_name'];
export function renderOperatorTemplate(content: string, values: Record<string, string>) {
  if (/\{\{[^}]*$|^[^{]*\}\}/.test(content)) throw new ApiError(400, 'ตัวแปรไม่สมบูรณ์');
  return content.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, key: string) => {
    if (!variables.includes(key)) throw new ApiError(400, 'ตัวแปรที่รองรับ: ' + variables.join(', '));
    return values[key] || '';
  });
}
export async function saveOperatorTemplate(staff: Staff, body: Record<string, unknown>) {
  fields(body, ['id', 'version', 'title', 'shortcut', 'content', 'category', 'visibility', 'teamId', 'assetId', 'remove']);
  const id = body.id ? uuid(body.id) : randomUUID();
  return transaction(staff.orgId, async c => {
    const old = (await c.query('SELECT * FROM operator_templates WHERE org_id=$1 AND id=$2', [staff.orgId, id])).rows[0];
    if (body.id && (!old || !(await canRead(c, staff, old)))) throw new ApiError(404, 'ไม่พบข้อความสำเร็จรูป');
    if (old && old.owner_id !== staff.id && staff.role !== 'Admin') throw new ApiError(403, 'แก้ไขได้เฉพาะข้อความของตนเอง');
    if (old && positiveVersion(body.version) !== old.version) throw new ApiError(409, 'ข้อความถูกแก้ไขแล้ว กรุณาโหลดใหม่');
    if (body.remove === true) { await c.query('DELETE FROM operator_templates WHERE org_id=$1 AND id=$2', [staff.orgId, id]); return { id, removed: true }; }
    const s = await scope(c, staff, body.visibility, body.teamId), title = str(body.title, 'ชื่อ', 120, true), content = str(body.content, 'ข้อความ', 4000, true), category = str(body.category, 'หมวดหมู่', 80, true);
    const shortcut = str(body.shortcut, 'คำลัด', 40, true).toLowerCase();
    if (!/^\/[a-z0-9_-]{1,39}$/.test(shortcut)) throw new ApiError(400, 'คำลัดต้องเริ่มด้วย / ตามด้วย a-z, 0-9, _ หรือ -');
    renderOperatorTemplate(content, {});
    const owner = old?.owner_id || staff.id;
    if ((await c.query('SELECT id FROM operator_templates WHERE org_id=$1 AND owner_id=$2 AND shortcut=$3 AND id<>$4', [staff.orgId, owner, shortcut, id])).rows.length) throw new ApiError(409, 'คำลัดนี้ถูกใช้แล้ว');
    const asset = body.assetId ? uuid(body.assetId) : null;
    if (asset) {
      const file = (await c.query("SELECT * FROM operator_assets WHERE org_id=$1 AND id=$2 AND status='ready'", [staff.orgId, asset])).rows[0];
      if (!file || !(await canRead(c, staff, file))) throw new ApiError(404, 'ไม่พบสื่อที่มีสิทธิ์ใช้งาน');
      // Never broaden the file's audience through a more widely visible template.
      if (file.visibility !== 'organization' && !(file.visibility === s.visibility && (s.visibility === 'personal' ? file.owner_id === owner : file.team_id === s.teamId))) throw new ApiError(403, 'ขอบเขตสื่อไม่ครอบคลุมขอบเขตข้อความ');
    }
    if (old) await c.query('UPDATE operator_templates SET title=$3,shortcut=$4,content=$5,category=$6,visibility=$7,team_id=$8,asset_id=$9,version=version+1 WHERE org_id=$1 AND id=$2', [staff.orgId, id, title, shortcut, content, category, s.visibility, s.teamId, asset]);
    else await c.query('INSERT INTO operator_templates(id,org_id,owner_id,title,shortcut,content,category,visibility,team_id,asset_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [id, staff.orgId, owner, title, shortcut, content, category, s.visibility, s.teamId, asset]);
    await audit(c, staff, 'template.save', id, { version: (old?.version || 0) + 1 });
    return { id, version: (old?.version || 0) + 1 };
  }, staff);
}
export async function previewTemplate(staff: Staff, id: string, conversationId: string) {
  const chat = await conversation(database, staff.orgId, conversationId);
  const row = (await database.query('SELECT * FROM operator_templates WHERE org_id=$1 AND id=$2', [staff.orgId, uuid(id)])).rows[0];
  if (!row || !(await canRead(database, staff, row))) throw new ApiError(404, 'ไม่พบข้อความสำเร็จรูป');
  if (row.asset_id) {
    const file = (await database.query("SELECT * FROM operator_assets WHERE org_id=$1 AND id=$2 AND status='ready'", [staff.orgId, row.asset_id])).rows[0];
    if (!file || !(await canRead(database, staff, file))) throw new ApiError(403, 'ไม่มีสิทธิ์ใช้สื่อ');
  }
  return { text: renderOperatorTemplate(row.content, { contact_name: chat.name, contact_phone: chat.phone, staff_name: staff.name }), assetId: row.asset_id, version: row.version };
}

export async function operatorSnapshot(staff: Staff) {
  const [views, teams, memberships, definitions, members, templates, mentions, assets] = await Promise.all([
    database.query("SELECT * FROM operator_views WHERE org_id=$1 AND (owner_id=$2 OR visibility='organization') ORDER BY name,id", [staff.orgId, staff.id]),
    database.query('SELECT * FROM operator_teams WHERE org_id=$1 ORDER BY name,id', [staff.orgId]),
    database.query('SELECT * FROM operator_team_members WHERE org_id=$1', [staff.orgId]),
    database.query('SELECT * FROM operator_field_definitions WHERE org_id=$1 ORDER BY name,id', [staff.orgId]),
    database.query('SELECT id,name,role FROM members WHERE org_id=$1 AND active=1 ORDER BY name,id', [staff.orgId]),
    database.query('SELECT * FROM operator_templates WHERE org_id=$1 ORDER BY title,id', [staff.orgId]),
    database.query('SELECT m.id,m.conversation_id,m.content,m.created_at,x.seen_at FROM operator_mentions x JOIN messages m ON m.org_id=x.org_id AND m.id=x.message_id WHERE x.org_id=$1 AND x.member_id=$2 ORDER BY m.created_at DESC,m.id DESC LIMIT 100', [staff.orgId, staff.id]),
    database.query("SELECT * FROM operator_assets WHERE org_id=$1 AND status='ready' ORDER BY filename,id", [staff.orgId]),
  ]);
  const visibleTemplates = [], visibleAssets = [];
  for (const t of templates.rows) if (await canRead(database, staff, t)) visibleTemplates.push(camel(t));
  for (const a of assets.rows) if (await canRead(database, staff, a)) { const { object_key: _, ...publicFile } = a; visibleAssets.push(camel(publicFile)); }
  return { user: staff, views: views.rows.map(v => ({ ...camel(v), id: String(v.id), filters: parse(v.filters_json) })), teams: teams.rows.map(t => ({ ...camel(t), hours: parse(t.hours_json), members: memberships.rows.filter(m => m.team_id === t.id).map(camel) })), definitions: definitions.rows.map(d => ({ ...camel(d), options: parse(d.options_json) })), members: members.rows, templates: visibleTemplates, assets: visibleAssets, mentions: mentions.rows.map(camel) };
}
export async function operatorConversation(staff: Staff, id: string) {
  const chat = await conversation(database, staff.orgId, id);
  const linked = (await database.query('SELECT canonical_lead_id FROM operator_contact_links WHERE org_id=$1 AND source_lead_id=$2', [staff.orgId, chat.lead_id])).rows[0];
  const canonicalId = linked?.canonical_lead_id || chat.lead_id;
  const [drafts, presence, definitions, contacts, links] = await Promise.all([
    database.query('SELECT kind,content AS text,version,updated_at FROM operator_drafts WHERE org_id=$1 AND conversation_id=$2 AND member_id=$3', [staff.orgId, id, staff.id]),
    database.query('SELECT p.member_id,m.name,p.typing,p.expires_at FROM operator_presence p JOIN members m ON m.org_id=p.org_id AND m.id=p.member_id WHERE p.org_id=$1 AND p.conversation_id=$2 AND p.expires_at>$3 AND m.active=1', [staff.orgId, id, now()]),
    database.query("SELECT d.*,v.value_json,v.version AS value_version FROM operator_field_definitions d LEFT JOIN operator_field_values v ON v.org_id=d.org_id AND v.field_id=d.id AND v.entity_id=CASE WHEN d.target='contact' THEN $2 ELSE $3 END WHERE d.org_id=$1 AND d.active=1 AND (d.market='all' OR d.market=$4) ORDER BY d.name,d.id", [staff.orgId, chat.lead_id, id, chat.market]),
    database.query('SELECT l.id,l.name,l.phone,l.email,l.market,l.contact_consent_at FROM leads l WHERE l.org_id=$1 AND (l.id=$2 OR l.id IN (SELECT source_lead_id FROM operator_contact_links WHERE org_id=$1 AND canonical_lead_id=$2))', [staff.orgId, canonicalId]),
    database.query('SELECT source_lead_id,canonical_lead_id,revision,created_at FROM operator_contact_links WHERE org_id=$1 AND canonical_lead_id=$2', [staff.orgId, canonicalId]),
  ]);
  const identities = (await database.query('SELECT lead_id,provider,account_id,remote_id FROM operator_contact_identities WHERE org_id=$1 AND (lead_id=$2 OR lead_id IN (SELECT source_lead_id FROM operator_contact_links WHERE org_id=$1 AND canonical_lead_id=$2)) UNION SELECT lead_id,provider,account_id,remote_id FROM social_identities WHERE org_id=$1 AND (lead_id=$2 OR lead_id IN (SELECT source_lead_id FROM operator_contact_links WHERE org_id=$1 AND canonical_lead_id=$2))', [staff.orgId, canonicalId])).rows;
  return { conversation: camel(chat), drafts: drafts.rows.map(camel), presence: presence.rows.map(camel), fields: definitions.rows.map(d => ({ ...camel(d), options: parse(d.options_json), value: d.value_json == null ? null : parse(d.value_json), valueVersion: d.value_version || 0 })), contactGroup: { canonicalId, contacts: contacts.rows.map(camel), identities: identities.map(camel), links: staff.role === 'Admin' ? links.rows.map(camel) : [] } };
}

export { canRead as canReadOperatorItem, scope as validateOperatorScope };
