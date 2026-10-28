import { database, demoMode } from '@/lib/db';

export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    if(demoMode())throw new Error('Production health check does not accept Demo');
    const result = await database.query('SELECT id FROM organizations WHERE slug=$1', [process.env.PUBLIC_ORG_SLUG||'rrs']);
    if(!result.rows.length)throw new Error('Organization is not provisioned');
    return Response.json({status:'ok'}, {headers:{'Cache-Control':'no-store'}});
  } catch {
    return Response.json({status:'not_ready'}, {status:503,headers:{'Cache-Control':'no-store'}});
  }
}
