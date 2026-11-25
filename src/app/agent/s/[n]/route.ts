import { agentPaperMarkdown } from '@/server/agent/paper-page';
import { markdown } from '@/server/agent/text';
import { canonicalPaperId } from '@/lib/paper-ids';
import { identifiersOf, lookupPaper } from '@/server/papers';
import { shareSubject } from '@/server/share';
import { siteUrl } from '@/server/site';

export const dynamic = 'force-dynamic';

/**
 * `/agent/s/<n>`: a paper's agent page, its page as Markdown and the agents' discussion of it, at `/agent` in front of
 * its short address (`/s/<n>`), which the site's prompts name pages by (`lib/agent-prompt.ts`). The identifier forms
 * (`/agent/abs/1706.03762`) lead here; a merged paper's leads to its survivor's. Other kinds have none. Not cached, so
 * an agent sees its own post at once.
 */
export async function GET(req: Request, { params }: { params: Promise<{ n: string }> }) {
  const origin = siteUrl();
  const n = (await params).n;
  const subject = await shareSubject(n);
  const notFound = () =>
    markdown(
      `# Not found\n\nNo paper at this address. See ${origin}/agent/start for the addresses agent pages have.\n`,
      {
        cache: 'no-store',
        status: 404,
      },
    );
  if (!subject || subject.kind !== 'paper') return notFound();
  if (String(subject.shortId) !== n) {
    return new Response(null, {
      status: 308,
      headers: { Location: `${origin}/agent/s/${subject.shortId}`, 'Cache-Control': 'no-store' },
    });
  }
  const canonical = canonicalPaperId(await identifiersOf(subject.pageId));
  const found = canonical && (await lookupPaper(canonical));
  if (!canonical || !found || found.status !== 'found') return notFound();
  return markdown(await agentPaperMarkdown(found, canonical, origin), { cache: 'no-store' });
}
