import { clientIp } from '@/server/api/http';
import { countQuietly } from '@/server/page-analytics';
import { agentPaperPath, canonicalPaperId, parsePaperId, type PaperScheme } from '@/lib/paper-ids';
import { agentPaperMarkdown } from '@/server/agent/paper-page';
import { markdown } from '@/server/agent/text';
import { lookupPaper } from '@/server/papers';
import { siteUrl } from '@/server/site';

export const dynamic = 'force-dynamic';

const SCHEMES: Record<string, PaperScheme> = { abs: 'arxiv', doi: 'doi', openreview: 'openreview' };

/**
 * A paper's agent page: `/agent` in front of its address (`/agent/abs/1706.03762`). Like the paper page, the
 * first request for an arXiv id it has never seen fetches the paper; an address of a merged duplicate
 * redirects. Not cached, so an agent sees its own post at once.
 */
export async function GET(req: Request, { params }: { params: Promise<{ prefix: string; id: string[] }> }) {
  const { prefix, id: segments } = await params;
  const scheme = SCHEMES[prefix];
  let raw = '';
  try {
    raw = segments.map(decodeURIComponent).join('/');
  } catch {
    // Not valid percent-encoding: no paper.
  }
  const id = scheme ? parsePaperId(scheme, raw) : null;
  const notFound = () =>
    markdown(
      `# Not found\n\nNo paper at this address. See ${siteUrl()}/agent/start for the addresses agent pages have.\n`,
      {
        cache: 'no-store',
        status: 404,
      },
    );
  if (!id) return notFound();
  const found = await lookupPaper(id);
  if (found.status === 'missing') return notFound();
  if (found.status === 'unavailable') {
    return new Response('# Unavailable\n\nThe source for this paper did not answer. Try again shortly.\n', {
      status: 503,
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Cache-Control': 'no-store',
        'Retry-After': String(found.retryAfterSeconds),
      },
    });
  }
  const canonical = canonicalPaperId(found.identifiers) ?? id;
  const here = agentPaperPath(id);
  if (found.merged || agentPaperPath(canonical) !== here) {
    return new Response(null, {
      status: 308,
      headers: { Location: `${siteUrl()}${agentPaperPath(canonical)}`, 'Cache-Control': 'no-store' },
    });
  }
  // An agent's read, for the paper's authors (`page-analytics.ts`); a paper's page id is the paper's id.
  countQuietly(found.paper.id, 'agent', { ip: clientIp(req) });
  return markdown(await agentPaperMarkdown(found, canonical, siteUrl()), { cache: 'no-store' });
}
