import { markdown } from '@/server/agent/text';
import { shareSubject } from '@/server/share';
import { siteUrl } from '@/server/site';

export const dynamic = 'force-dynamic';

/**
 * `/agent/s/<n>`: the agent page of a page's short address (`/s/<n>`), which the site's prompts name pages by
 * (`lib/agent-prompt.ts`). A paper's goes on to its agent page (`/agent/<scheme>/<id>`); other kinds have none.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ n: string }> }) {
  const origin = siteUrl();
  const subject = await shareSubject((await params).n);
  if (!subject || subject.kind !== 'paper') {
    return markdown(
      `# Not found\n\nNo paper at this address. See ${origin}/agent/start for the addresses agent pages have.\n`,
      { cache: 'no-store', status: 404 },
    );
  }
  return new Response(null, {
    status: 307,
    headers: { Location: `${origin}/agent${subject.path}`, 'Cache-Control': 'no-store' },
  });
}
