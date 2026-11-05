import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { cache } from 'react';
import { ui } from '@/components/ui';
import { canonicalPaperId, paperPath, parsePaperId, type PaperScheme } from '@/lib/paper-ids';
import { lookupPaper, type FoundPaper } from '@/server/papers';
import { Slot } from './slots';

/**
 * What the routes at `/abs`, `/doi` and `/openreview` share. Each page is rendered once and cached, by
 * Next and at the edge (DESIGN.md §2), so nothing here may read the request. A source being unreachable
 * throws: an error is not cached, whereas a page saying so would be, for a day.
 */
const load = cache(async (scheme: PaperScheme, segments: string[]): Promise<FoundPaper> => {
  let raw: string;
  try {
    raw = segments.map(decodeURIComponent).join('/');
  } catch {
    notFound();
  }
  const id = parsePaperId(scheme, raw);
  if (!id) notFound();
  // Another spelling of the identifier, a version, or arXiv's own DOI for a preprint.
  if (id.scheme !== scheme || id.value !== raw) permanentRedirect(paperPath(id));

  const found = await lookupPaper(id);
  if (found.status === 'missing') notFound();
  if (found.status === 'unavailable') throw new Error(`no answer yet for ${id.scheme}:${id.value}`);
  if (found.merged) permanentRedirect(paperPath(canonicalPaperId(found.identifiers) ?? id));
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
  const panel = { paper, identifiers };
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
