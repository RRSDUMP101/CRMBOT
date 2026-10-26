/** Real HTTP tests for the helpdesk and embeddable widget. Use a disposable Demo database. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

const base = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const appOrigin = new URL(base).origin;
const widgetOrigin = "https://rrs-widget-test.example";
const forbiddenOrigin = "https://not-approved.example";
const runId = randomUUID().slice(0, 8);
const password = "Demo-only-2026!";
type Json = Record<string, any>;
type Options = { method?: string; body?: unknown; origin?: string | null; widget?: boolean; headers?: Record<string, string> };

class Client {
  cookies = new Map<string, string>();
  async request(path: string, options: Options = {}) {
    const method = options.method ?? (options.body === undefined ? "GET" : "POST");
    const headers = new Headers({ Accept: "application/json", ...options.headers });
    if (this.cookies.size) headers.set("Cookie", [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "));
    if (options.widget) headers.set("x-rrs-widget", "1");
    if (options.origin !== null && (options.origin !== undefined || method !== "GET")) headers.set("Origin", options.origin ?? appOrigin);
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    const response = await fetch(`${base}${path}`, {
      method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: "manual", signal: AbortSignal.timeout(30_000),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";", 1)[0];
      const split = pair.indexOf("=");
      if (split < 1) continue;
      const key = pair.slice(0, split), value = pair.slice(split + 1);
      if (!value || /max-age=0/i.test(cookie)) this.cookies.delete(key);
      else this.cookies.set(key, value);
    }
    return response;
  }
  async json(path: string, options: Options = {}) {
    const response = await this.request(path, options);
    const body = await response.text();
    let data: Json;
    try { data = JSON.parse(body); }
    catch { assert.fail(`${path}: expected JSON, got ${response.status}: ${body.slice(0, 240)}`); }
    return { response, data };
  }
  async ok(path: string, options: Options = {}) {
    const { response, data } = await this.json(path, options);
    assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(data)}`);
    return data;
  }
  async post(path: string, body: unknown = {}, options: Options = {}) { return this.ok(path, { ...options, method: "POST", body }); }
  async inbox(query: Record<string, string> = {}) { return this.ok(`/api/admin/inbox?${new URLSearchParams(query)}`); }
  async history(options: Options = {}) { return this.ok("/api/chat", options); }
  async message(text: string, clientId = randomUUID(), options: Options = {}) {
    const response = await this.request("/api/chat/message", { ...options, method: "POST", body: { text, clientId } });
    assert.equal(response.status, 200, `message returned ${response.status}`);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const events = (await response.text()).split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)));
    assert.ok(events.some(event => ["done", "cancelled"].includes(event.type)), "SSE terminal event missing");
    assert.ok(!events.some(event => event.type === "error"), `SSE error: ${JSON.stringify(events)}`);
    return { clientId, events };
  }
}

function denied(status: number, label: string) {
  assert.ok([401, 403, 404].includes(status), `${label}: expected access denial, got ${status}`);
}
function invalid(status: number, label: string) {
  assert.ok([400, 422].includes(status), `${label}: expected validation rejection, got ${status}`);
}
async function makeVisitor(label: string, handoff = true) {
  const client = new Client();
  await client.post("/api/chat/session");
  await client.post("/api/chat/contact", { name: label, phone: "0812345678", email: "", consent: true });
  if (handoff) await client.post("/api/chat/handoff");
  const data = await client.history();
  return { client, id: data.conversation.id as string, leadId: data.lead.id as string, label };
}
async function inboxItem(client: Client, visitor: { id: string; label: string }) {
  const result = await client.inbox({ q: visitor.label, view: "all" });
  const item = result.items.find((row: Json) => row.id === visitor.id);
  assert.ok(item, `conversation ${visitor.id} missing from inbox`);
  return item as Json;
}
async function lastUserId(client: Client) {
  const user = (await client.history()).messages.filter((message: Json) => message.role === "user").at(-1);
  assert.ok(user?.id);
  return user.id as string;
}

const admin = new Client(), agent = new Client(), outsider = new Client();
let adminId: string, agentId: string;
let template: Json;
let originalWidget: Json | undefined;
let configuredWidget: Json;
let unreadVisitor: Awaited<ReturnType<typeof makeVisitor>>;
let firstUnreadMessageId: string;
const searchVisitors: Awaited<ReturnType<typeof makeVisitor>>[] = [];
const searchName = `ลูกค้าค้นหา-${runId}`;
const historyNeedle = `ประวัติเฉพาะ-${runId}`;

describe("RRS helpdesk and widget HTTP acceptance", { concurrency: false }, () => {
  before(async () => {
    const bootstrap = await new Client().ok("/api/bootstrap");
    assert.equal(bootstrap.demo, true, "Safety: use explicit DEMO_MODE with synthetic data");
    assert.equal(bootstrap.provider, "demo", "Acceptance tests must not call a billable LLM");
    const administrator = await admin.post("/api/auth/login", { email: "admin@rrs.demo", password });
    const salesperson = await agent.post("/api/auth/login", { email: "agent@rrs.demo", password });
    await outsider.post("/api/auth/login", { email: "outsider@other.demo", password });
    adminId = administrator.user.id;
    agentId = salesperson.user.id;
    originalWidget = structuredClone((await admin.ok("/api/admin/widget")).config);
    configuredWidget = { ...originalWidget, enabled: true, title: `RRS ทดสอบ ${runId}`, greeting: "สอบถามข้อมูลสินค้าและขอให้ทีมติดต่อกลับได้ค่ะ", accentColor: "#254DDE", position: "right", allowedOrigins: [widgetOrigin] };
    await admin.post("/api/admin/widget", { config: configuredWidget });
    configuredWidget = (await admin.ok("/api/admin/widget")).config;
    unreadVisitor = await makeVisitor(`ตรวจอ่าน-${runId}`);
    for (let i = 0; i < 4; i++) {
      const item = await makeVisitor(`${searchName} คนที่ ${i + 1}`);
      await item.client.message(`${historyNeedle} รายการ ${i + 1}`);
      await item.client.message(`ข้อความใหม่หลังประวัติ ${i + 1}`);
      searchVisitors.push(item);
    }
  });
  after(async () => {
    if (originalWidget) await admin.post("/api/admin/widget", { config: originalWidget });
  });

  test("Admin creates, edits and versions shared reply templates", async () => {
    await admin.post("/api/admin/action", { action: "saveReplyTemplate", values: { title: `ขอสเปกรถ ${runId}`, shortcut: `/vehicle-${runId}`, content: "ขอรุ่นรถและปีที่ผลิตเพื่อให้ทีมตรวจสอบก่อนเสนอราคาค่ะ", category: "งานขาย" } });
    template = (await admin.ok("/api/admin/reply-templates")).templates.find((item: Json) => item.shortcut === `/vehicle-${runId}`);
    assert.ok(template?.id);
    assert.equal(template.version, 1);
    assert.equal(template.category, "งานขาย");
    await admin.post("/api/admin/action", { action: "saveReplyTemplate", id: template.id, values: { title: template.title, shortcut: template.shortcut, content: "ขอรุ่นรถ ปี และรูปตัวรถเพื่อให้ทีมตรวจสเปกค่ะ", category: "งานขาย", version: template.version } });
    const updated = (await agent.ok("/api/admin/reply-templates")).templates.find((item: Json) => item.id === template.id);
    assert.equal(updated.version, template.version + 1);
    assert.match(updated.content, /รูปตัวรถ/);
    const stale = await admin.json("/api/admin/action", { body: { action: "saveReplyTemplate", id: template.id, values: { title: template.title, shortcut: template.shortcut, content: "stale content", category: "งานขาย", version: template.version } } });
    assert.equal(stale.response.status, 409, "stale edits must not overwrite the latest version");
    template = updated;
  });

  test("Agent reads templates without sending; an explicit staff reply sends the selected text", async () => {
    const visitor = await makeVisitor(`คำตอบสำเร็จรูป-${runId}`);
    const before = await visitor.client.history();
    const list = await agent.ok("/api/admin/reply-templates");
    const selected = list.templates.find((item: Json) => item.id === template.id);
    assert.ok(selected);
    assert.deepEqual((await visitor.client.history()).messages, before.messages, "reading templates must not automatically send messages");
    await agent.post(`/api/admin/conversations/${visitor.id}/claim`);
    await agent.post(`/api/admin/conversations/${visitor.id}/reply`, { text: selected.content });
    const after = await visitor.client.history();
    assert.equal(after.messages.filter((message: Json) => message.role === "agent" && message.content === selected.content).length, 1);
  });

  test("reply templates enforce role, organization and authenticated access", async () => {
    denied((await new Client().json("/api/admin/reply-templates")).response.status, "anonymous templates");
    assert.ok(!(await outsider.ok("/api/admin/reply-templates")).templates.some((item: Json) => item.id === template.id));
    const values = { title: template.title, shortcut: template.shortcut, content: template.content, category: template.category, version: template.version };
    denied((await agent.json("/api/admin/action", { body: { action: "saveReplyTemplate", id: template.id, values } })).response.status, "Agent editing template");
    denied((await outsider.json("/api/admin/action", { body: { action: "saveReplyTemplate", id: template.id, values } })).response.status, "cross-tenant template update");
    denied((await agent.json("/api/admin/action", { body: { action: "deleteReplyTemplate", id: template.id, values: { version: template.version } } })).response.status, "Agent deleting template");
    denied((await outsider.json("/api/admin/action", { body: { action: "deleteReplyTemplate", id: template.id, values: { version: template.version } } })).response.status, "cross-tenant template delete");
  });

  test("template deletion checks version and removes the shared reply", async () => {
    const stale = await admin.json("/api/admin/action", { body: { action: "deleteReplyTemplate", id: template.id, values: { version: template.version - 1 } } });
    assert.equal(stale.response.status, 409);
    await admin.post("/api/admin/action", { action: "deleteReplyTemplate", id: template.id, values: { version: template.version } });
    assert.ok(!(await agent.ok("/api/admin/reply-templates")).templates.some((item: Json) => item.id === template.id));
  });

  test("unread state is per member and duplicate client IDs do not inflate it", async () => {
    const clientId = randomUUID();
    await unreadVisitor.client.message(`ข้อความยังไม่อ่าน-${runId}`, clientId);
    firstUnreadMessageId = await lastUserId(unreadVisitor.client);
    assert.equal((await inboxItem(admin, unreadVisitor)).unreadCount, 1);
    assert.equal((await inboxItem(agent, unreadVisitor)).unreadCount, 1);
    await unreadVisitor.client.message(`ข้อความยังไม่อ่าน-${runId}`, clientId);
    assert.equal((await inboxItem(admin, unreadVisitor)).unreadCount, 1);
    await admin.post(`/api/admin/conversations/${unreadVisitor.id}/read`, { throughMessageId: firstUnreadMessageId });
    assert.equal((await inboxItem(admin, unreadVisitor)).unreadCount, 0);
    assert.equal((await inboxItem(agent, unreadVisitor)).unreadCount, 1, "one member cannot mark another member's inbox read");
    assert.equal((await inboxItem(admin, unreadVisitor)).lastCustomerMessageId, firstUnreadMessageId);
  });

  test("an older read watermark does not clear a message that arrived later", async () => {
    await unreadVisitor.client.message(`ข้อความใหม่หลังเปิดแชต-${runId}`);
    const newer = await lastUserId(unreadVisitor.client);
    assert.notEqual(newer, firstUnreadMessageId);
    await agent.post(`/api/admin/conversations/${unreadVisitor.id}/read`, { throughMessageId: firstUnreadMessageId });
    assert.equal((await inboxItem(agent, unreadVisitor)).unreadCount, 1);
    assert.equal((await inboxItem(admin, unreadVisitor)).unreadCount, 1);
    await agent.post(`/api/admin/conversations/${unreadVisitor.id}/read`, { throughMessageId: newer });
    assert.equal((await inboxItem(agent, unreadVisitor)).unreadCount, 0);
    await agent.post(`/api/admin/conversations/${unreadVisitor.id}/read`, { throughMessageId: firstUnreadMessageId });
    assert.equal((await inboxItem(agent, unreadVisitor)).unreadCount, 0, "stale requests must not move a watermark backwards");
  });

  test("read watermarks reject another conversation, another tenant and non-customer messages", async () => {
    const foreignMessage = await lastUserId(searchVisitors[0].client);
    denied((await agent.json(`/api/admin/conversations/${unreadVisitor.id}/read`, { body: { throughMessageId: foreignMessage } })).response.status, "message from another conversation");
    denied((await outsider.json(`/api/admin/conversations/${unreadVisitor.id}/read`, { body: { throughMessageId: firstUnreadMessageId } })).response.status, "cross-tenant read marker");
    await agent.post(`/api/admin/conversations/${unreadVisitor.id}/note`, { text: `บันทึกภายใน ${runId}` });
    const notes = await agent.ok(`/api/admin/conversations/${unreadVisitor.id}`);
    const noteId = notes.messages.find((message: Json) => message.role === "note" && message.content === `บันทึกภายใน ${runId}`).id;
    denied((await agent.json(`/api/admin/conversations/${unreadVisitor.id}/read`, { body: { throughMessageId: noteId } })).response.status, "internal note is not a customer watermark");
  });

  test("inbox searches full customer names and older message history across cursor pages", async () => {
    const exact = await admin.inbox({ q: searchVisitors[1].label, view: "all" });
    assert.equal(exact.total, 1);
    assert.equal(exact.items[0].id, searchVisitors[1].id);
    const found: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const result = await admin.inbox({ q: historyNeedle, view: "all", limit: "2", ...(cursor ? { cursor } : {}) });
      assert.equal(result.total, 4, "total counts all matches before pagination");
      assert.ok(result.items.length <= 2);
      found.push(...result.items.map((item: Json) => item.id));
      cursor = result.nextCursor;
      pages++;
      assert.ok(pages <= 3, "cursor must make progress");
    } while (cursor);
    assert.equal(pages, 2);
    assert.equal(new Set(found).size, 4, "pages must not duplicate or omit conversations");
    assert.deepEqual(found.slice().sort(), searchVisitors.map(item => item.id).sort());
    assert.equal((await outsider.inbox({ q: historyNeedle, view: "all" })).total, 0);
  });

  test("work queues, tags and owners filter records while counts describe the whole inbox", async () => {
    await admin.post(`/api/admin/conversations/${searchVisitors[0].id}/claim`);
    await agent.post(`/api/admin/conversations/${searchVisitors[1].id}/claim`);
    await admin.post(`/api/admin/conversations/${searchVisitors[2].id}/resolve`);
    await admin.post("/api/admin/action", { action: "updateLead", id: searchVisitors[0].leadId, values: { tags: [`ด่วน-${runId}`] } });
    assert.equal((await admin.inbox({ q: searchName, view: "all" })).total, 3);
    const mine = await admin.inbox({ q: searchName, view: "mine" });
    assert.deepEqual(mine.items.map((item: Json) => item.id), [searchVisitors[0].id]);
    assert.deepEqual((await agent.inbox({ q: searchName, view: "mine" })).items.map((item: Json) => item.id), [searchVisitors[1].id]);
    assert.deepEqual((await admin.inbox({ q: searchName, view: "unassigned" })).items.map((item: Json) => item.id), [searchVisitors[3].id]);
    assert.deepEqual((await admin.inbox({ q: searchName, view: "waiting" })).items.map((item: Json) => item.id), [searchVisitors[3].id]);
    assert.deepEqual((await admin.inbox({ q: searchName, view: "closed" })).items.map((item: Json) => item.id), [searchVisitors[2].id]);
    assert.deepEqual((await admin.inbox({ q: searchName, view: "all", assignee: agentId })).items.map((item: Json) => item.id), [searchVisitors[1].id]);
    const tagged = await admin.inbox({ q: searchName, tag: `ด่วน-${runId}` });
    assert.deepEqual(tagged.items.map((item: Json) => item.id), [searchVisitors[0].id]);
    const full = await admin.inbox();
    assert.deepEqual(tagged.counts, full.counts, "queue counts do not change with search/tag filters");
    assert.deepEqual((await admin.ok("/api/admin/inbox/summary")).counts, full.counts);
    const unread = await admin.inbox({ q: searchName, view: "unread" });
    assert.equal(unread.total, 3);
    assert.ok(unread.items.every((item: Json) => item.unreadCount > 0 && item.status !== "resolved"));
  });

  test("inbox validates cursors and rejects unauthorized access", async () => {
    denied((await new Client().json("/api/admin/inbox")).response.status, "anonymous inbox");
    denied((await new Client().json("/api/admin/inbox/summary")).response.status, "anonymous inbox summary");
    for (const query of ["cursor=not-a-valid-cursor", "view=invalid-view", "limit=-1", "assignee=not-a-uuid"]) {
      invalid((await admin.json(`/api/admin/inbox?${query}`)).response.status, `invalid inbox query ${query}`);
    }
  });

  test("new messages reopen resolved chats for staff while duplicate messages leave them closed", async () => {
    const visitor = await makeVisitor(`เปิดเคสใหม่-${runId}`);
    const oldClientId = randomUUID();
    await visitor.client.message("ข้อมูลก่อนปิดเคส", oldClientId);
    await admin.post(`/api/admin/conversations/${visitor.id}/resolve`);
    const closed = await visitor.client.history();
    assert.equal(closed.conversation.status, "resolved");
    await visitor.client.message("ข้อมูลก่อนปิดเคส", oldClientId);
    const replayed = await visitor.client.history();
    assert.equal(replayed.conversation.status, "resolved");
    assert.equal(replayed.conversation.version, closed.conversation.version);
    assert.equal(replayed.messages.length, closed.messages.length);
    const reopened = await visitor.client.message("มีข้อมูลเพิ่มเติมหลังปิดเคสครับ");
    assert.ok(!reopened.events.some(event => event.type === "token"), "new inbound must not silently resume the AI");
    const history = await visitor.client.history();
    assert.equal(history.conversation.status, "waiting_human");
    assert.equal(history.messages.filter((message: Json) => message.role === "user").length, 2);
    assert.equal(history.messages.filter((message: Json) => message.role === "assistant").length, 0);
    const queue = await admin.inbox({ q: visitor.label, view: "waiting" });
    assert.equal(queue.items[0]?.id, visitor.id);
    assert.equal(queue.items[0]?.unreadCount, 2);
  });

  test("widget settings require Admin and validate colors and exact origins", async () => {
    denied((await agent.json("/api/admin/widget", { body: { config: configuredWidget } })).response.status, "Agent changing widget settings");
    denied((await new Client().json("/api/admin/widget")).response.status, "anonymous private widget settings");
    for (const config of [
      { ...configuredWidget, accentColor: "red" },
      { ...configuredWidget, accentColor: "#12345" },
      { ...configuredWidget, allowedOrigins: ["*"] },
      { ...configuredWidget, allowedOrigins: ["https://example.com/not-an-origin"] },
      { ...configuredWidget, allowedOrigins: ["javascript:alert(1)"] },
      { ...configuredWidget, allowedOrigins: ["http://external.example"] },
    ]) invalid((await admin.json("/api/admin/widget", { body: { config } })).response.status, "invalid widget config");
    assert.deepEqual((await admin.ok("/api/admin/widget")).config, configuredWidget);
    const other = await outsider.ok("/api/admin/widget");
    assert.notEqual(other.config.title, configuredWidget.title, "widget configuration must be tenant scoped");
  });

  test("public widget config is redacted and CORS is limited to configured origins", async () => {
    const publicConfig = await new Client().ok("/api/widget/config", { origin: null });
    assert.equal(publicConfig.config.title, configuredWidget.title);
    assert.equal(publicConfig.config.accentColor.toUpperCase(), configuredWidget.accentColor.toUpperCase());
    assert.equal(Object.hasOwn(publicConfig.config, "allowedOrigins"), false);
    assert.doesNotMatch(JSON.stringify(publicConfig), /"(?:orgId|personality|handoffRule|allowedOrigins)"\s*:/);
    const allowed = await new Client().json("/api/widget/config", { origin: widgetOrigin });
    assert.equal(allowed.response.status, 200);
    assert.equal(allowed.response.headers.get("access-control-allow-origin"), widgetOrigin);
    assert.match(allowed.response.headers.get("vary") ?? "", /origin/i);
    const rejected = await new Client().json("/api/widget/config", { origin: forbiddenOrigin });
    assert.equal(rejected.response.status, 403);
    assert.equal(rejected.response.headers.get("access-control-allow-origin"), null);
    const preflight = await new Client().request("/api/chat/session", { method: "OPTIONS", widget: true, origin: widgetOrigin, headers: { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,x-rrs-widget" } });
    assert.equal(preflight.headers.get("access-control-allow-origin"), null, "embedding allowlist does not grant cross-origin chat API access");
    assert.equal(preflight.headers.get("access-control-allow-credentials"), null);
    const forbiddenPreflight = await new Client().request("/api/chat/session", { method: "OPTIONS", widget: true, origin: forbiddenOrigin, headers: { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,x-rrs-widget" } });
    assert.equal(forbiddenPreflight.headers.get("access-control-allow-origin"), null);
    const crossOriginMutation = await new Client().json("/api/chat/session", { body: {}, widget: true, origin: widgetOrigin });
    assert.equal(crossOriginMutation.response.status, 403, "chat mutations originate inside the same-origin iframe, never the embedding page");
    const widgetPage = await new Client().request("/widget");
    assert.equal(widgetPage.status, 200);
    const widgetPolicy = widgetPage.headers.get("content-security-policy") ?? "";
    assert.match(widgetPolicy, /frame-ancestors\s+'self'/);
    assert.ok(widgetPolicy.includes(widgetOrigin), "widget frame policy must include the configured website");
    assert.doesNotMatch(widgetPolicy, /frame-ancestors\s+'none'/, "global headers must not override the widget embedding policy");
    assert.doesNotMatch(widgetPage.headers.get("x-frame-options") ?? "", /deny/i);
    const workspacePage = await new Client().request("/");
    assert.equal(workspacePage.status, 200);
    assert.match(workspacePage.headers.get("content-security-policy") ?? "", /frame-ancestors\s+'none'/, "the CRM itself must remain protected from framing");
  });

  test("embedded and regular chat sessions have separate cookies and visitor contexts", async () => {
    const combined = new Client();
    const regular = await combined.json("/api/chat/session", { body: {} });
    assert.ok(regular.response.ok);
    const regularCookie = regular.response.headers.getSetCookie().find(value => value.startsWith("rrs_visitor="));
    assert.ok(regularCookie);
    assert.match(regularCookie, /HttpOnly/i);
    assert.match(regularCookie, /SameSite=Lax/i);
    assert.doesNotMatch(regularCookie, /Partitioned/i);
    const normalHistory = await combined.history();
    const normalId = normalHistory.conversation.id;
    denied((await combined.json("/api/chat", { widget: true, origin: appOrigin })).response.status, "regular visitor cookie cannot authorize embedded chat");
    const embedded = await combined.json("/api/chat/session", { body: {}, widget: true, origin: appOrigin });
    assert.ok(embedded.response.ok, `embedded session returned ${embedded.response.status}`);
    const widgetCookie = embedded.response.headers.getSetCookie().find(value => value.startsWith("rrs_widget_visitor="));
    assert.ok(widgetCookie);
    for (const flag of [/HttpOnly/i, /SameSite=None/i, /(?:^|;\s*)Secure(?:;|$)/i, /Partitioned/i]) assert.match(widgetCookie, flag);
    const embeddedHistory = await combined.history({ widget: true, origin: appOrigin });
    assert.notEqual(embeddedHistory.conversation.id, normalId);
    assert.equal((await combined.history()).conversation.id, normalId);
    const onlyWidget = new Client();
    onlyWidget.cookies.set("rrs_widget_visitor", combined.cookies.get("rrs_widget_visitor")!);
    denied((await onlyWidget.json("/api/chat")).response.status, "widget cookie cannot authorize regular chat");
    const forbiddenSession = await new Client().json("/api/chat/session", { body: {}, widget: true, origin: forbiddenOrigin });
    assert.equal(forbiddenSession.response.status, 403);
    assert.equal(forbiddenSession.response.headers.getSetCookie().length, 0);
  });

  test("disabling the widget stops embedded chat while regular website chat keeps working", async () => {
    const embedded = new Client();
    await embedded.post("/api/chat/session", {}, { widget: true, origin: appOrigin });
    const normal = await makeVisitor(`วิดเจ็ตปิด-${runId}`);
    await admin.post("/api/admin/widget", { config: { ...configuredWidget, enabled: false } });
    try {
      assert.equal((await new Client().request("/widget")).status, 403, "disabled widget document must not render an active chat");
      const fresh = await new Client().json("/api/chat/session", { body: {}, widget: true, origin: appOrigin });
      assert.equal(fresh.response.status, 403);
      const old = await embedded.json("/api/chat", { widget: true, origin: appOrigin });
      assert.equal(old.response.status, 403);
      const message = await embedded.json("/api/chat/message", { body: { text: "ข้อความขณะวิดเจ็ตปิด", clientId: randomUUID() }, widget: true, origin: appOrigin });
      assert.equal(message.response.status, 403);
      await normal.client.message("เว็บไซต์หลักยังรับข้อความได้");
      assert.ok((await normal.client.history()).messages.some((item: Json) => item.content === "เว็บไซต์หลักยังรับข้อความได้"));
      const otherNormal = new Client();
      await otherNormal.post("/api/chat/session");
      assert.ok((await otherNormal.history()).conversation.id);
    } finally {
      await admin.post("/api/admin/widget", { config: configuredWidget });
    }
  });
});
