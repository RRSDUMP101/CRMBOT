/** SQLite/D1 transaction planner tests. Synthetic tenants only; no provider traffic. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { before, after, test } from 'node:test';
import { database, closeDatabase, transaction } from '../src/lib/db';
import { ApiError, hashToken, type Staff } from '../src/lib/auth';
import { addInternalNote, heartbeat, linkContactIdentity, markMentionSeen, mergeContacts, unmergeContacts, operatorConversation, operatorSnapshot, previewTemplate, routeWaitingConversation, saveDraft, saveFieldDefinition, saveFieldValue, saveOperatorTemplate, saveTeam, saveView, validateRequiredFields, viewInbox, withinHours } from '../src/lib/operators';
import { downloadOperatorAsset, uploadOperatorAsset } from '../src/lib/operator-assets';
import { GET, POST } from '../src/app/api/admin/operators/[...path]/route';

const keys = ['DEMO_MODE', 'RRS_WORKERS', 'D1_LOCAL_DIR', 'AI_PROVIDER', 'APP_ORIGIN', 'OPERATOR_STORAGE_LIMIT_BYTES'] as const;
const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));
const previousFetch = globalThis.fetch;
before(async () => {
  Object.assign(process.env, { DEMO_MODE: 'true', RRS_WORKERS: 'false', D1_LOCAL_DIR: `.data/operators-${randomUUID()}`, AI_PROVIDER: 'disabled', APP_ORIGIN: 'http://localhost:3000' });
  globalThis.fetch = (async () => { throw new Error('No network permitted in operator tests'); }) as typeof fetch;
  await database.query('SELECT 1');
});
after(async () => { globalThis.fetch = previousFetch; await closeDatabase(); for (const k of keys) if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k]; });
async function fixture() {
  const org = randomUUID(); await database.query('INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)', [org, org, 'Synthetic operator org']);
  const people: Staff[] = [];
  for (const role of ['Admin', 'Agent', 'Agent'] as const) {
    const id = randomUUID(), s: Staff = { id, orgId: org, name: role + id.slice(0, 4), email: id + '@example.invalid', role };
    await database.query("INSERT INTO members(id,org_id,name,email,password_hash,role) VALUES($1,$2,$3,$4,'synthetic',$5)", [id, org, s.name, s.email, role]); people.push(s);
  }
  return { org, admin: people[0], a: people[1], b: people[2] };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function chat(f: Fixture, name = 'ลูกค้า 100%_', market = 'domestic') {
  const leadId = randomUUID(), id = randomUUID();
  await database.query('INSERT INTO leads(id,org_id,name,market) VALUES($1,$2,$3,$4)', [leadId, f.org, name, market]);
  await database.query("INSERT INTO conversations(id,org_id,lead_id,status) VALUES($1,$2,$3,'waiting_human')", [id, f.org, leadId]);
  return { id, leadId };
}
const rejected = (code: number) => (e: unknown) => e instanceof ApiError && e.status === code;
const teamBody = (f: Fixture, extra: Record<string, unknown> = {}) => ({ name: 'ทีมไทย', timezone: 'Asia/Bangkok', hours: Array.from({ length: 7 }, (_, day) => ({ day, start: 0, end: 1440 })), market: 'domestic', provider: 'web', accountId: '', enabled: true, priority: 10, members: [f.a, f.b].map(m => ({ id: m.id, capacity: 1, available: true, leaveStart: '', leaveEnd: '' })), ...extra });
const fieldBody = (extra: Record<string, unknown> = {}) => ({ name: 'รุ่นที่สนใจ', target: 'contact', type: 'text', options: [], market: 'domestic', requiredOnClose: true, active: true, ...extra });
const templateBody = (extra: Record<string, unknown> = {}) => ({ title: 'ทักทาย', shortcut: '/hello', content: 'สวัสดี {{contact_name}} จาก {{staff_name}}', category: 'ต้อนรับ', visibility: 'personal', teamId: null, assetId: null, ...extra });

test('F01 personal/shared saved views reload, preserve literal Thai search and provider/account filters', async () => {
  const f = await fixture(), one = await chat(f), two = await chat(f, 'ลูกค้า 100XX');
  const saved = await saveView(f.a, { name: 'เปอร์เซ็นต์', visibility: 'personal', filters: { q: '100%_', provider: 'web' } });
  assert.equal((await operatorSnapshot(f.a)).views[0].id, saved.id);
  assert.equal((await operatorSnapshot(f.b)).views.length, 0);
  const found = await viewInbox(f.a, new URL(`http://localhost:3000/?savedView=${saved.id}`));
  assert.deepEqual(found.items.map(x => x.id), [one.id]);
  await assert.rejects(viewInbox(f.b, new URL(`http://localhost:3000/?savedView=${saved.id}`)), rejected(404));
  await assert.rejects(saveView(f.a, { name: 'shared', visibility: 'organization', filters: {} }), rejected(403));
  await saveView(f.admin, { name: 'ทีม', visibility: 'organization', filters: { assignee: 'unassigned', unread: 'false' } });
  assert.equal((await operatorSnapshot(f.b)).views.length, 1);
  await database.query('INSERT INTO social_identities(id,org_id,provider,account_id,remote_id,lead_id,conversation_id,created_at,updated_at) VALUES($1,$2,\'line\',\'account-a\',\'remote-a\',$3,$4,$5,$5)', [randomUUID(), f.org, two.leadId, two.id, new Date().toISOString()]);
  assert.deepEqual((await viewInbox(f.a, new URL('http://localhost:3000/?provider=line&account=account-a'))).items.map(x => x.id), [two.id]);
  assert.equal((await viewInbox(f.a, new URL('http://localhost:3000/?provider=line&account=account-b'))).total, 0);
  await assert.rejects(saveView(f.a, { id: saved.id, version: 99, name: 'wrong', visibility: 'personal', filters: {} }), rejected(409));
});

test('F01 cursor pagination remains complete for identical timestamps and tenant boundaries', async () => {
  const f = await fixture(), other = await fixture(), rows = await Promise.all([chat(f), chat(f), chat(f)]); await chat(other);
  await database.query("UPDATE conversations SET updated_at='2026-11-02T10:00:00.000001Z' WHERE org_id=$1", [f.org]);
  const first = await viewInbox(f.a, new URL('http://localhost:3000/?limit=2'));
  const next = await viewInbox(f.a, new URL(`http://localhost:3000/?limit=2&cursor=${first.nextCursor}`));
  assert.deepEqual([...first.items, ...next.items].map(x => x.id).sort(), rows.map(x => x.id).sort());
  assert.equal(next.nextCursor, null);
});

test('F02 drafts are per actor and kind; stale tabs cannot overwrite a newer draft', async () => {
  const f = await fixture(), c = await chat(f);
  await saveDraft(f.a, c.id, { kind: 'reply', text: 'draft a', version: 0 });
  await saveDraft(f.b, c.id, { kind: 'reply', text: 'draft b', version: 0 });
  await saveDraft(f.a, c.id, { kind: 'note', text: 'private note draft', version: 0 });
  assert.equal((await operatorConversation(f.a, c.id)).drafts.find(d => d.kind === 'reply')?.text, 'draft a');
  assert.equal((await operatorConversation(f.b, c.id)).drafts.length, 1);
  await assert.rejects(saveDraft(f.a, c.id, { kind: 'reply', text: 'stale', version: 0 }), rejected(409));
  const results = await Promise.allSettled([saveDraft(f.a, c.id, { kind: 'reply', text: 'tab1', version: 1 }), saveDraft(f.a, c.id, { kind: 'reply', text: 'tab2', version: 1 })]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  const foreign = await fixture(); await assert.rejects(operatorConversation(foreign.a, c.id), rejected(404));
});

test('F02 typing presence expires and inactive members disappear without a client disconnect', async () => {
  const f = await fixture(), c = await chat(f);
  await heartbeat(f.a, c.id, { typing: true });
  assert.equal((await operatorConversation(f.b, c.id)).presence[0].typing, 1);
  await database.query("UPDATE operator_presence SET expires_at='2000-01-01T00:00:00.000Z' WHERE org_id=$1", [f.org]);
  assert.equal((await operatorConversation(f.b, c.id)).presence.length, 0);
  await heartbeat(f.a, c.id, { typing: false });
  await database.query('UPDATE members SET active=0 WHERE org_id=$1 AND id=$2', [f.org, f.a.id]);
  assert.equal((await operatorConversation(f.b, c.id)).presence.length, 0);
  await assert.rejects(heartbeat(f.a, c.id, { typing: true }), rejected(403));
});

test('F02 notes+mentions are idempotent and never create a provider outbound command', async () => {
  const f = await fixture(), c = await chat(f), body = { text: 'เรื่องภายใน @ทีม', mentions: [f.b.id], clientId: randomUUID() };
  const [a, b] = await Promise.all([addInternalNote(f.a, c.id, body), addInternalNote(f.a, c.id, body)]);
  assert.equal(a.id, b.id);
  assert.equal((await database.query('SELECT count(*) AS n FROM social_outbound_commands WHERE org_id=$1', [f.org])).rows[0].n, 0);
  const message = (await database.query('SELECT role,content FROM messages WHERE org_id=$1 AND id=$2', [f.org, a.id])).rows[0];
  assert.equal(message.role, 'note');
  assert.equal((await operatorSnapshot(f.a)).mentions.length, 0);
  assert.equal((await operatorSnapshot(f.b)).mentions[0].id, a.id);
  await markMentionSeen(f.b, a.id); assert.ok((await operatorSnapshot(f.b)).mentions[0].seenAt);
  await assert.rejects(addInternalNote(f.a, c.id, { ...body, text: 'different' }), rejected(409));
  const foreign = await fixture(); await assert.rejects(addInternalNote(f.a, c.id, { ...body, clientId: randomUUID(), mentions: [foreign.a.id] }), rejected(400));
});

test('F03 explicit merge is admin-only, audited, non-destructive, same market and replay safe', async () => {
  const f = await fixture(), a = await chat(f, 'same'), b = await chat(f, 'same'), foreign = await fixture(), other = await chat(foreign, 'same'), exp = await chat(f, 'same', 'export');
  await assert.rejects(mergeContacts(f.a, { sourceId: a.leadId, targetId: b.leadId, reason: 'verified' }), rejected(403));
  await assert.rejects(mergeContacts(f.admin, { sourceId: a.leadId, targetId: other.leadId, reason: 'verified' }), rejected(404));
  await assert.rejects(mergeContacts(f.admin, { sourceId: a.leadId, targetId: exp.leadId, reason: 'verified' }), rejected(409));
  await mergeContacts(f.admin, { sourceId: a.leadId, targetId: b.leadId, reason: 'owner confirmed' });
  assert.equal((await mergeContacts(f.admin, { sourceId: a.leadId, targetId: b.leadId, reason: 'retry' })).alreadyLinked, true);
  const detail = await operatorConversation(f.a, a.id); assert.equal(detail.contactGroup.canonicalId, b.leadId); assert.equal(detail.contactGroup.contacts.length, 2);
  assert.equal((await database.query('SELECT lead_id FROM conversations WHERE id=$1', [a.id])).rows[0].lead_id, a.leadId);
  assert.equal((await database.query("SELECT count(*) AS n FROM audit_events WHERE org_id=$1 AND action='operator.contact.merge'", [f.org])).rows[0].n, 1);
  await assert.rejects(mergeContacts(f.admin, { sourceId: b.leadId, targetId: a.leadId, reason: 'cycle' }), rejected(409));
});

test('F03 revision migration preserves existing links and gives rolling old writers fresh revisions', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY); CREATE TABLE operator_contact_links(org_id TEXT,source_lead_id TEXT,canonical_lead_id TEXT,reason TEXT,PRIMARY KEY(org_id,source_lead_id)); INSERT INTO operator_contact_links VALUES('o','a','b','original');");
    db.exec(readFileSync('migrations/d1/091_contact_link_revision.sql', 'utf8'));
    const first = db.prepare('SELECT * FROM operator_contact_links').get()!;
    assert.equal(first.reason, 'original'); assert.equal(first.canonical_lead_id, 'b'); assert.match(String(first.revision), /^[a-f0-9]{32}$/);
    db.exec("INSERT INTO operator_contact_links(org_id,source_lead_id,canonical_lead_id,reason) VALUES('o','c','b','old writer');");
    const second = db.prepare("SELECT revision FROM operator_contact_links WHERE source_lead_id='c'").get()!;
    assert.match(String(second.revision), /^[a-f0-9]{32}$/); assert.notEqual(first.revision, second.revision);
  } finally { db.close(); }
});

test('F03 undo preserves source data and consent, audits once and fences stale re-linked groups', async () => {
  const f = await fixture(), a = await chat(f), b = await chat(f), sibling = await chat(f), foreign = await fixture();
  await database.query("UPDATE leads SET contact_consent_at='2026-01-01T00:00:00Z' WHERE id=$1", [a.leadId]);
  await linkContactIdentity(f.admin, { leadId: a.leadId, provider: 'line', accountId: 'account', remoteId: 'remote', reason: 'verified' });
  const before = (await database.query('SELECT * FROM leads WHERE org_id=$1 ORDER BY id', [f.org])).rows;
  await mergeContacts(f.admin, { sourceId: a.leadId, targetId: b.leadId, reason: 'verified' });
  await mergeContacts(f.admin, { sourceId: sibling.leadId, targetId: b.leadId, reason: 'verified sibling' });
  const link = (await operatorConversation(f.admin, a.id)).contactGroup.links.find(x => x.sourceLeadId === a.leadId)!;
  const body = { sourceId: a.leadId, targetId: b.leadId, revision: link.revision, reason: 'incorrect grouping' };
  assert.equal((await operatorConversation(f.a, a.id)).contactGroup.links.length, 0);
  await assert.rejects(unmergeContacts(f.a, body), rejected(403));
  await assert.rejects(unmergeContacts(foreign.admin, body), rejected(404));
  await assert.rejects(unmergeContacts(f.admin, { ...body, reason: '' }), rejected(400));
  await assert.rejects(unmergeContacts(f.admin, { ...body, revision: '0'.repeat(32) }), rejected(409));
  const outcomes = await Promise.all([unmergeContacts(f.admin, body), unmergeContacts(f.admin, body)]);
  assert.equal(outcomes.filter(x => x.alreadyUnlinked).length, 1);
  assert.equal((await operatorConversation(f.admin, a.id)).contactGroup.contacts.length, 1);
  assert.equal((await operatorConversation(f.admin, b.id)).contactGroup.contacts.length, 2);
  assert.equal((await operatorConversation(f.admin, a.id)).contactGroup.identities.length, 1);
  assert.deepEqual((await database.query('SELECT * FROM leads WHERE org_id=$1 ORDER BY id', [f.org])).rows, before);
  assert.equal((await database.query('SELECT lead_id FROM conversations WHERE id=$1', [a.id])).rows[0].lead_id, a.leadId);
  assert.equal((await database.query("SELECT count(*) AS n FROM audit_events WHERE org_id=$1 AND action='operator.contact.unmerge'", [f.org])).rows[0].n, 1);
  await mergeContacts(f.admin, { sourceId: a.leadId, targetId: b.leadId, reason: 'new reviewed grouping' });
  await assert.rejects(unmergeContacts(f.admin, body), rejected(409));
  const fresh = (await operatorConversation(f.admin, a.id)).contactGroup.links.find(x => x.sourceLeadId === a.leadId)!;
  assert.notEqual(fresh.revision, link.revision);
  await database.query('UPDATE members SET active=0 WHERE org_id=$1 AND id=$2', [f.org, f.admin.id]);
  await assert.rejects(unmergeContacts(f.admin, { ...body, revision: fresh.revision }), rejected(403));
});

test('F03 explicit identity never crosses provider/account keys or rebinds another contact', async () => {
  const f = await fixture(), a = await chat(f), b = await chat(f);
  const input = { leadId: a.leadId, provider: 'line', accountId: 'one', remoteId: 'same', reason: 'verified ID' };
  const first = await linkContactIdentity(f.admin, input); assert.equal((await linkContactIdentity(f.admin, input)).id, first.id);
  await linkContactIdentity(f.admin, { ...input, accountId: 'two', leadId: b.leadId });
  await assert.rejects(linkContactIdentity(f.admin, { ...input, leadId: b.leadId }), rejected(409));
  assert.equal((await operatorConversation(f.a, a.id)).contactGroup.identities.length, 1);
});

test('F04 partial fields save; required close validates in transaction and accepts false/zero', async () => {
  const f = await fixture(), c = await chat(f);
  const a = await saveFieldDefinition(f.admin, fieldBody());
  const b = await saveFieldDefinition(f.admin, fieldBody({ name: 'ยืนยัน', type: 'boolean', target: 'ticket' }));
  await saveFieldValue(f.a, c.id, { fieldId: a.id, version: 0, definitionVersion: 1, value: null });
  await assert.rejects(transaction(f.org, ex => validateRequiredFields(ex, f.org, c.id)), rejected(422));
  await saveFieldValue(f.a, c.id, { fieldId: a.id, version: 1, definitionVersion: 1, value: 'รถ 6 ล้อ' });
  await saveFieldValue(f.a, c.id, { fieldId: b.id, version: 0, definitionVersion: 1, value: false });
  await transaction(f.org, ex => validateRequiredFields(ex, f.org, c.id));
  await assert.rejects(saveFieldValue(f.a, c.id, { fieldId: b.id, version: 1, definitionVersion: 1, value: 'false' }), rejected(400));
  await assert.rejects(saveFieldDefinition(f.admin, fieldBody({ id: a.id, version: 1, type: 'number' })), rejected(409));
  await assert.rejects(saveFieldValue(f.a, c.id, { fieldId: a.id, version: 1, definitionVersion: 1, value: 'stale' }), rejected(409));
});

test('F04 market isolation, valid calendar dates, select versions and preserve in-use options', async () => {
  const f = await fixture(), c = await chat(f), exp = await chat(f, 'export', 'export');
  const date = await saveFieldDefinition(f.admin, fieldBody({ type: 'date' }));
  await assert.rejects(saveFieldValue(f.a, c.id, { fieldId: date.id, version: 0, definitionVersion: 1, value: '2026-02-30' }), rejected(400));
  await assert.rejects(saveFieldValue(f.a, exp.id, { fieldId: date.id, version: 0, definitionVersion: 1, value: '2026-02-28' }), rejected(404));
  const select = await saveFieldDefinition(f.admin, fieldBody({ name: 'ชนิด', type: 'select', options: ['A', 'B'] }));
  await saveFieldValue(f.a, c.id, { fieldId: select.id, version: 0, definitionVersion: 1, value: 'A' });
  await assert.rejects(saveFieldDefinition(f.admin, fieldBody({ id: select.id, version: 1, name: 'ชนิด', type: 'select', options: ['B'] })), rejected(409));
  await assert.rejects(saveFieldValue(f.a, c.id, { fieldId: select.id, version: 1, definitionVersion: 2, value: 'B' }), rejected(409));
});

test('F05/F14 concurrent routing respects capacity atomically and cannot assign twice', async () => {
  const f = await fixture(), chats = await Promise.all([chat(f), chat(f), chat(f)]); await saveTeam(f.admin, teamBody(f));
  const results = await Promise.all(chats.map(c => routeWaitingConversation(f.org, c.id)));
  assert.equal(results.filter(x => x.assigned).length, 2);
  assert.equal(new Set(results.filter(x => x.assigned).map(x => x.memberId)).size, 2);
  for (const c of chats) await routeWaitingConversation(f.org, c.id);
  assert.equal((await database.query("SELECT count(*) AS n FROM audit_events WHERE org_id=$1 AND action='operator.team.assigned'", [f.org])).rows[0].n, 2);
  const waiting = results.findIndex(x => !x.assigned); assert.equal(results[waiting].reason, 'no_available_capacity');
  await database.query("UPDATE conversations SET status='resolved' WHERE org_id=$1 AND id=$2", [f.org, chats.find((_, i) => results[i].assigned)!.id]);
  assert.equal((await routeWaitingConversation(f.org, chats[waiting].id)).assigned, true);
});

test('F05/F14 closed hours, timezone boundary, leave, inactive member and manual owner fall back safely', async () => {
  assert.equal(withinHours('Asia/Bangkok', [{ day: 1, start: 540, end: 1020 }], new Date('2026-11-02T01:59:59Z')), false);
  assert.equal(withinHours('Asia/Bangkok', [{ day: 1, start: 540, end: 1020 }], new Date('2026-11-02T02:00:00Z')), true);
  assert.equal(withinHours('Asia/Bangkok', [{ day: 1, start: 540, end: 1020 }], new Date('2026-11-02T10:00:00Z')), false);
  const f = await fixture(), c = await chat(f);
  const t = await saveTeam(f.admin, teamBody(f, { hours: [] }));
  assert.equal((await routeWaitingConversation(f.org, c.id)).reason, 'outside_business_hours');
  await saveTeam(f.admin, teamBody(f, { id: t.id, version: 1, members: [{ id: f.a.id, capacity: 1, available: true, leaveStart: '2026-11-01T00:00:00Z', leaveEnd: '2026-12-01T00:00:00Z' }, { id: f.b.id, capacity: 1, available: true, leaveStart: '', leaveEnd: '' }] }));
  await database.query('UPDATE members SET active=0 WHERE org_id=$1 AND id=$2', [f.org, f.b.id]);
  assert.equal((await routeWaitingConversation(f.org, c.id, new Date('2026-11-02T03:00:00Z'))).reason, 'no_available_capacity');
  await database.query('UPDATE conversations SET assignee_id=$3 WHERE org_id=$1 AND id=$2', [f.org, c.id, f.admin.id]);
  assert.equal((await routeWaitingConversation(f.org, c.id)).reason, 'already_owned_or_not_waiting');
});

test('F05 team management is role/version guarded and disabled teams perform no routing', async () => {
  const f = await fixture(), c = await chat(f);
  await assert.rejects(saveTeam(f.a, teamBody(f)), rejected(403));
  const t = await saveTeam(f.admin, teamBody(f, { enabled: false }));
  assert.equal((await routeWaitingConversation(f.org, c.id)).reason, 'no_matching_team');
  await assert.rejects(saveTeam(f.admin, teamBody(f, { id: t.id, version: 99 })), rejected(409));
  await database.query("UPDATE members SET role='Agent' WHERE org_id=$1 AND id=$2", [f.org, f.admin.id]);
  await assert.rejects(saveTeam(f.admin, teamBody(f, { id: t.id, version: 1 })), rejected(403));
});

test('F06 personal/team/org template scope, safe variables, duplicate shortcut and optimistic edits', async () => {
  const f = await fixture(), c = await chat(f, '<script>not markup</script>');
  const t = await saveOperatorTemplate(f.a, templateBody());
  assert.equal((await operatorSnapshot(f.b)).templates.length, 0);
  await assert.rejects(previewTemplate(f.b, t.id, c.id), rejected(404));
  const preview = await previewTemplate(f.a, t.id, c.id); assert.ok(preview.text.includes('<script>not markup</script>'));
  await assert.rejects(saveOperatorTemplate(f.a, templateBody({ content: '{{secret}}' })), rejected(400));
  await assert.rejects(saveOperatorTemplate(f.a, templateBody()), rejected(409));
  const results = await Promise.allSettled([saveOperatorTemplate(f.a, templateBody({ id: t.id, version: 1, content: 'one' })), saveOperatorTemplate(f.a, templateBody({ id: t.id, version: 1, content: 'two' }))]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  const team = await saveTeam(f.admin, teamBody(f, { members: [{ id: f.a.id, capacity: 1, available: true }] }));
  await saveOperatorTemplate(f.admin, templateBody({ shortcut: '/team', visibility: 'team', teamId: team.id }));
  assert.equal((await operatorSnapshot(f.a)).templates.length, 2);
  assert.equal((await operatorSnapshot(f.b)).templates.length, 0);
});

test('F06 private media validates bytes and permissions; template cannot broaden media scope', async () => {
  const f = await fixture();
  const upload = (type: string, data: string, visibility = 'personal') => new Request('http://localhost:3000/upload', { method: 'POST', headers: { 'Content-Type': type, 'X-File-Name': 'brochure.pdf', 'X-Visibility': visibility }, body: data });
  await assert.rejects(uploadOperatorAsset(f.a, upload('application/pdf', '<html>')), rejected(400));
  const asset = await uploadOperatorAsset(f.a, upload('application/pdf', '%PDF-1.7\nsynthetic'));
  assert.equal(await (await downloadOperatorAsset(f.a, asset.id)).text(), '%PDF-1.7\nsynthetic');
  await assert.rejects(downloadOperatorAsset(f.b, asset.id), rejected(404));
  await assert.rejects(uploadOperatorAsset(f.a, upload('application/pdf', '%PDF-1.7', 'organization')), rejected(403));
  const adminAsset = await uploadOperatorAsset(f.admin, upload('application/pdf', '%PDF-1.7'));
  await assert.rejects(saveOperatorTemplate(f.admin, templateBody({ visibility: 'organization', assetId: adminAsset.id })), rejected(403));
  await saveOperatorTemplate(f.a, templateBody({ assetId: asset.id }));
  process.env.OPERATOR_STORAGE_LIMIT_BYTES = '1';
  await assert.rejects(uploadOperatorAsset(f.a, upload('application/pdf', '%PDF-1.7')), rejected(409));
  delete process.env.OPERATOR_STORAGE_LIMIT_BYTES;
});

test('HTTP routes require session, same origin and return scoped errors without private data', async () => {
  const f = await fixture(), c = await chat(f), token = randomUUID();
  const context = (path: string[]) => ({ params: Promise.resolve({ path }) });
  assert.equal((await GET(new Request('http://localhost:3000/api/admin/operators/snapshot'), context(['snapshot']))).status, 401);
  await database.query('INSERT INTO staff_sessions(token_hash,org_id,member_id,expires_at) VALUES($1,$2,$3,$4)', [hashToken(token), f.org, f.a.id, '2099-01-01T00:00:00.000000Z']);
  const request = (origin: string) => new Request('http://localhost:3000/api/admin/operators/conversations/' + c.id + '/draft', { method: 'POST', headers: { cookie: 'rrs_staff=' + token, origin, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'reply', version: 0, text: 'http draft' }) });
  assert.equal((await POST(request('https://evil.invalid'), context(['conversations', c.id, 'draft']))).status, 403);
  assert.equal((await POST(request('http://localhost:3000'), context(['conversations', c.id, 'draft']))).status, 200);
  assert.equal((await POST(request('http://localhost:3000'), context(['conversations', c.id, 'draft']))).status, 409);
});

test('email inbox filters and routing retain exact Gmail/Outlook account instead of treating email as web',async()=>{
  const f=await fixture(),gmail=await chat(f,'Gmail conversation'),outlook=await chat(f,'Outlook conversation'),web=await chat(f,'Web conversation');
  const accountIds:string[]=[];
  for(const [provider,c] of [['gmail',gmail],['outlook',outlook]] as const){
    const account=randomUUID();accountIds.push(account);
    await database.query('INSERT INTO external_accounts(id,org_id,provider,account_key,credential,connected_by,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7)',[account,f.org,provider,provider+'@example.invalid','synthetic',f.admin.id,new Date().toISOString()]);
    await database.query('INSERT INTO external_threads(org_id,account_id,thread_id,conversation_id,lead_id,reply_to) VALUES($1,$2,$3,$4,$5,$6)',[f.org,account,randomUUID(),c.id,c.leadId,'synthetic@example.invalid']);
  }
  const read=(query:string)=>viewInbox(f.a,new URL('http://localhost:3000/api/admin/operators/inbox?'+query));
  assert.deepEqual((await read('provider=web')).items.map(r=>r.id),[web.id]);
  assert.equal((await read('provider=email')).total,2);
  const match=(await read('provider=gmail&account='+accountIds[0])).items[0];assert.equal(match.id,gmail.id);assert.equal(match.provider,'gmail');assert.equal(match.accountId,accountIds[0]);
  assert.equal((await read('provider=outlook&account='+accountIds[0])).total,0);
  const view=await saveView(f.a,{name:'Gmail only',visibility:'personal',filters:{provider:'gmail',account:accountIds[0]}});assert.equal((await read('savedView='+view.id)).total,1);
  await saveTeam(f.admin,teamBody(f,{provider:'gmail',accountId:accountIds[0]}));
  assert.equal((await routeWaitingConversation(f.org,gmail.id)).assigned,true);
  assert.equal((await routeWaitingConversation(f.org,outlook.id)).assigned,false);
});
