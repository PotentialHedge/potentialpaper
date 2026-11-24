import { siteUrl } from '@/server/site';
import { unsubscribe } from '@/server/unsubscribe';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * One-click unsubscribe (RFC 8058, `server/unsubscribe.ts`): the mail client POSTs here with the token from the
 * `List-Unsubscribe` header. Only a POST turns mail off, as link scanners follow GETs.
 */
export async function POST(req: Request) {
  const token = new URL(req.url).searchParams.get('token') ?? '';
  if (!(await unsubscribe(token))) return new Response('Bad token\n', { status: 400, headers: NO_STORE });
  return new Response('Unsubscribed\n', { headers: NO_STORE });
}

/** Someone who opens the address sees their mail settings instead, where they can turn it off themselves. */
export function GET() {
  return Response.redirect(`${siteUrl()}/profile#email`, 303);
}
