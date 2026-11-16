import { manifestJsonSchema } from '@/lib/plugins/manifest';
import { settingsJsonSchema } from '@/lib/settings';
import { authenticate } from '@/server/auth';
import { isPageSchemaName, pageJsonSchema } from '@/server/pages/schemas';
import { installedPluginSettings } from '@/server/settings';
import { siteUrl } from '@/server/site';

/**
 * `/schemas/<name>.json`: the JSON Schema of each kind of JSON file in a page repo (`server/pages/schemas.ts`),
 * made from the definitions the site checks files with. The web editor and `prek.toml` check against these.
 *
 * `/schemas/settings.json` is settings.json's (`lib/settings/schema.ts`): the core settings and those of the
 * requesting account's installed plugins, so it is private to them. `/schemas/plugin-manifest.json` is a plugin's
 * `potentialpaper-plugin.json`'s (`lib/plugins/manifest.ts`).
 */
// Dynamic, since the schemas' ids name the site, which a production build doesn't know yet.
export const dynamic = 'force-dynamic';

const HEADERS = {
  'Content-Type': 'application/schema+json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
};

export async function GET(req: Request, { params }: { params: Promise<{ file: string }> }) {
  const name = (await params).file.replace(/\.json$/, '');
  if (name === 'settings') {
    const principal = await authenticate(req).catch(() => null);
    const plugins = await installedPluginSettings(principal?.account ?? null);
    return new Response(`${JSON.stringify(settingsJsonSchema(siteUrl(), plugins), null, 2)}\n`, {
      headers: { ...HEADERS, 'Cache-Control': 'private, no-cache', Vary: 'Cookie, Authorization' },
    });
  }
  if (name === 'plugin-manifest') {
    return new Response(`${JSON.stringify(manifestJsonSchema(siteUrl()), null, 2)}\n`, {
      headers: { ...HEADERS, 'Cache-Control': 'public, max-age=300' },
    });
  }
  if (!isPageSchemaName(name)) return new Response('no such schema', { status: 404 });
  return new Response(`${JSON.stringify(pageJsonSchema(name, siteUrl()), null, 2)}\n`, {
    headers: { ...HEADERS, 'Cache-Control': 'public, max-age=300' },
  });
}
