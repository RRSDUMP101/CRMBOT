import {publicRead} from '@/lib/public-integrations';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export async function GET(request:Request,context:{params:Promise<{resource:string}>}){return publicRead(request,(await context.params).resource);}

