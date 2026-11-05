import { eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import { cache } from 'react';
import { ui } from '@/components/ui';
import { canonicalPaperId, paperPath, parsePaperId, type PaperScheme } from '@/lib/paper-ids';
import { getDb } from '@/db';
import { pageCurrent } from '@/db/schema';
import { findPaper, type FoundPaper } from '@/server/papers';
import { Slot } from './slots';

/**
 * What the routes at `/abs`, `/doi` and `/openreview` share. Each page is rendered once and cached, by
 * Next and at the edge (DESIGN.md §2), so nothing here may read the request. `proxy.ts` has already
 * answered everything but a real paper at its own address. If that has changed since, this throws, as
 * an error is never cached.
 */
const load = cache(async (scheme: PaperScheme, segments: string[]): Promise<FoundPaper> => {
  const id = parsePaperId(scheme, segments.map(decodeURIComponent).join('/'));
  const found = id && (await findPaper(id));
  if (!found || found.merged) throw new Error(`no paper at ${scheme}:${segments.join('/')}`);
  return found;
});

const DESCRIPTION_LENGTH = 200;

export async function paperMetadata(scheme: PaperScheme, segments: string[]): Promise<Metadata> {
  const { paper, identifiers } = await load(scheme, segments);
  const canonical = canonicalPaperId(identifiers);
  return {
    title: `${paper.title} · PaperTrail`,
    description: paper.abstract?.slice(0, DESCRIPTION_LENGTH),
    alternates: canonical ? { canonical: paperPath(canonical) } : undefined,
  };
}

export async function PaperRoute({ scheme, segments }: { scheme: PaperScheme; segments: string[] }) {
  const { paper, identifiers } = await load(scheme, segments);
  const [current] = await getDb()
    .select({ pdf: pageCurrent.pdf })
    .from(pageCurrent)
    .where(eq(pageCurrent.paperId, paper.id));
  const panel = { paper, identifiers, pdf: current?.pdf ?? null };
  const about = [paper.venue, paper.year].filter(Boolean).join(', ');
  return (
    <main className={ui.page}>
      <article>
        <h1 className="mt-6 text-center text-[26px] leading-tight font-normal">{paper.title}</h1>
        <p className="mt-3 text-center">
          {paper.authors.length > 0 ? (
            paper.authors.join(', ')
          ) : (
            <span className="text-muted italic">Anonymous authors</span>
          )}
        </p>
        {about && <p className={`${ui.fine} mb-5 text-center`}>{about}</p>}
        <div className="mt-5 grid grid-cols-[minmax(0,1fr)_230px] items-start gap-8 narrow:grid-cols-1">
          <div>
            <Slot name="paper.main" {...panel} />
          </div>
          <aside className="space-y-3">
            <Slot name="paper.aside" {...panel} />
          </aside>
        </div>
      </article>
    </main>
  );
}
