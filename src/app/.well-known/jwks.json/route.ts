import { identityJwks } from '@/server/plugins/identity';

export const dynamic = 'force-dynamic';

/**
 * `/.well-known/jwks.json`: the public keys that sign plugins' identity tokens (`server/plugins/identity.ts`), for
 * plugins' backends to verify them. Every published key is listed, so tokens verify across a rotation; a backend should
 * fetch again when it meets a `kid` it doesn't know.
 */
export async function GET() {
  return Response.json(await identityJwks(), {
    headers: { 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' },
  });
}
