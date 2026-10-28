import { acknowledgeBridge, bootstrapBridge, bridgeConfig, bridgeInteger, readBridgeEvents } from '@/lib/chat-bridge';
import { verifyBridgeRequest, BridgeError } from '@/lib/bridge-protocol';
import { ApiError } from '@/lib/errors';

export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: {
  'Cache-Control': 'private, no-store, no-transform', 'X-Content-Type-Options': 'nosniff',
} });

function objectBody(body: string, allowed: string[]) {
  let value: unknown;
  try { value = JSON.parse(body || '{}'); } catch { throw new BridgeError(400, 'Invalid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new BridgeError(400, 'Invalid bridge request fields');
  return value as Record<string, unknown>;
}

async function handle(request: Request) {
  try {
    const config = bridgeConfig();
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/bridge\//, '');
    const { body } = await verifyBridgeRequest(request, config, path === 'import' ? 8 * 1024 * 1024 : 64_000);
    if (path === 'events' && request.method === 'GET') {
      if ([...url.searchParams.keys()].some(key => !['after', 'limit'].includes(key)) || [...new Set(url.searchParams.keys())].some(key => url.searchParams.getAll(key).length !== 1)) throw new BridgeError(400, 'Invalid event query');
      return json(await readBridgeEvents(config.orgId, bridgeInteger(url.searchParams.get('after') ?? '0', 'cursor'), bridgeInteger(url.searchParams.get('limit') ?? '100', 'limit', 100, 1)));
    }
    if(path.startsWith('attachments/')&&request.method==='GET'){
      if([...url.searchParams.keys()].some(k=>k!=='owner')||url.searchParams.getAll('owner').length>1||url.searchParams.has('owner')&&url.searchParams.get('owner')!=='true')throw new BridgeError(400,'Invalid attachment query');
      const { downloadSocialAttachment }=await import('@/lib/social-media');
      return await downloadSocialAttachment(config.orgId,path.slice('attachments/'.length),fetch,url.searchParams.get('owner')==='true');
    }
    if (url.search) throw new BridgeError(400, 'Unexpected bridge query');
    if(path==='dispatch'&&request.method==='POST'){
      objectBody(body,[]);
      const {dispatchPendingSocialReplies}=await import('@/lib/social-channels');
      return json(await dispatchPendingSocialReplies(config.orgId,10));
    }
    if (path === 'bootstrap' && request.method === 'POST') {
      const input = objectBody(body, ['limit']);
      return json(await bootstrapBridge(config.orgId, bridgeInteger(input.limit ?? 100, 'limit', 100, 1)));
    }
    if (path === 'ack' && request.method === 'POST') {
      const input = objectBody(body, ['consumerId', 'sequence']);
      if (typeof input.consumerId !== 'string') throw new BridgeError(400, 'Invalid consumer ID');
      return json(await acknowledgeBridge(config.orgId, input.consumerId, bridgeInteger(input.sequence, 'sequence')));
    }
    if (path === 'commands' && request.method === 'POST') {
      const { handleBridgeCommand } = await import('@/lib/bridge-commands');
      return json(await handleBridgeCommand(objectBody(body, ['commandId', 'conversationId', 'actorId', 'action', 'text'])));
    }
    if (path === 'import' && request.method === 'POST') {
      const { handleLegacyImport } = await import('@/lib/legacy-chat-import');
      return json(await handleLegacyImport(config.orgId, objectBody(body, ['snapshot', 'options', 'dryRun', 'cursor', 'limit'])));
    }
    return json({ error: 'Bridge route not found' }, 404);
  } catch (error) {
    if (error instanceof BridgeError || error instanceof ApiError) return json({ error: error.message }, error.status);
    console.error('[rrs] bridge_request_failed', { type: error instanceof Error ? error.name : 'Unknown' });
    return json({ error: 'Bridge request failed' }, 500);
  }
}

export const GET = handle;
export const POST = handle;
