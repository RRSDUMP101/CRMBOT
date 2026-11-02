import { ApiError, assertOrigin, fields, rateLimit, readJson, requireAdmin, staffSession, uuid } from '@/lib/auth';
import { addInternalNote, heartbeat, linkContactIdentity, markMentionSeen, mergeContacts, unmergeContacts, operatorConversation, operatorSnapshot, previewTemplate, routeWaitingConversation, saveDraft, saveFieldDefinition, saveFieldValue, saveOperatorTemplate, saveTeam, saveView, viewInbox } from '@/lib/operators';
import { downloadOperatorAsset, uploadOperatorAsset } from '@/lib/operator-assets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
async function handle(request: Request, context: { params: Promise<{ path: string[] }> }) {
  try {
    const staff = (await staffSession(request))!;
    const { path } = await context.params;
    const [resource, id, action] = path;
    if (request.method === 'GET') {
      if (path.length === 1 && resource === 'snapshot') return json(await operatorSnapshot(staff));
      if (path.length === 1 && resource === 'inbox') return json(await viewInbox(staff, new URL(request.url)));
      if (path.length === 2 && resource === 'conversations') return json(await operatorConversation(staff, uuid(id)));
      if (path.length === 2 && resource === 'assets') return await downloadOperatorAsset(staff, uuid(id));
    } else {
      assertOrigin(request);
      await rateLimit(`operator:${staff.orgId}:${staff.id}`, 240, 60);
      if (resource === 'assets' && path.length === 1) return json(await uploadOperatorAsset(staff, request), 201);
      const body = await readJson(request);
      if (path.length === 1) {
        if (resource === 'views') return json(await saveView(staff, body));
        if (resource === 'teams') return json(await saveTeam(staff, body));
        if (resource === 'fields') return json(await saveFieldDefinition(staff, body));
        if (resource === 'templates') return json(await saveOperatorTemplate(staff, body));
        if (resource === 'merge') return json(await mergeContacts(staff, body));
        if (resource === 'unmerge') return json(await unmergeContacts(staff, body));
        if (resource === 'identities') return json(await linkContactIdentity(staff, body));
      }
      if (path.length === 2 && resource === 'mentions') { fields(body, []); return json(await markMentionSeen(staff, uuid(id))); }
      if (path.length === 3 && resource === 'conversations') {
        uuid(id);
        if (action === 'draft') return json(await saveDraft(staff, id, body));
        if (action === 'presence') return json(await heartbeat(staff, id, body));
        if (action === 'note') return json(await addInternalNote(staff, id, body));
        if (action === 'fields') return json(await saveFieldValue(staff, id, body));
        if (action === 'route') { requireAdmin(staff); fields(body, []); return json(await routeWaitingConversation(staff.orgId, id, new Date(), staff)); }
        if (action === 'template') { fields(body, ['templateId']); return json(await previewTemplate(staff, uuid(body.templateId), id)); }
      }
    }
    throw new ApiError(404, 'ไม่พบรายการ');
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.message }, error.status);
    console.error('[rrs] operator_request_failed');
    return json({ error: 'ไม่สามารถทำรายการได้ กรุณาลองใหม่' }, 500);
  }
}
export const GET = handle;
export const POST = handle;
