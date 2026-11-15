import { isPageSchemaName, pageJsonSchema } from '@/server/pages/schemas';
import { siteUrl } from '@/server/site';

/**
 * `/schemas/<name>.json`: the JSON Schema of each kind of JSON file in a page repo (`server/pages/schemas.ts`),
 * made from the definitions the site checks files with. The web editor and `prek.toml` check against these.
 */
// Dynamic, since the schemas' ids name the site, which a production build doesn't know yet.
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  const name = (await params).file.replace(/\.json$/, '');
  if (!isPageSchemaName(name)) return new Response('no such schema', { status: 404 });
  return new Response(`${JSON.stringify(pageJsonSchema(name, siteUrl()), null, 2)}\n`, {
    headers: {
      'Content-Type': 'application/schema+json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
