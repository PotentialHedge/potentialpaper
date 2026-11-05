import { methodNotAllowed } from '@/server/api/http';
import { answerGitRequest } from '@/server/pages/clone';

export const dynamic = 'force-dynamic';

const NOT_CACHED = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };

/**
 * An object's id is the hash of its content, so its address never changes meaning, and the edge can keep
 * it (a Cloudflare cache rule covers these addresses). Only the edge: redacting a page (DESIGN.md §4.7)
 * has to be able to purge what's kept, and nobody can purge a browser.
 */
const CACHED_OBJECT = { 'Cache-Control': 'public, max-age=0, s-maxage=31536000', 'X-Robots-Tag': 'noindex, nofollow' };

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const answer = await answerGitRequest(url.pathname);
  switch (answer.kind) {
    case 'text':
      return new Response(answer.body, { headers: { ...NOT_CACHED, 'Content-Type': 'text/plain; charset=utf-8' } });
    case 'object':
      return new Response(new Uint8Array(answer.body), {
        headers: { ...CACHED_OBJECT, 'Content-Type': 'application/x-git-loose-object' },
      });
    case 'redirect':
      // Git works out the new address by finding what it asked for at the end of this, query included.
      return new Response(null, { status: 308, headers: { ...NOT_CACHED, Location: answer.to + url.search } });
    case 'missing':
      return new Response('Not found\n', {
        status: 404,
        headers: { ...NOT_CACHED, 'Content-Type': 'text/plain; charset=utf-8' },
      });
  }
}

export const { POST, PUT, PATCH, DELETE } = methodNotAllowed('GET');
