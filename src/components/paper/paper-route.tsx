import 'katex/dist/katex.min.css';
import { eq, sql } from 'drizzle-orm';
import type { Metadata } from 'next';
import { cache } from 'react';
import { ui } from '@/components/ui';
import { canonicalPaperId, paperPath, parsePaperId, type PaperScheme } from '@/lib/paper-ids';
import { getDb } from '@/db';
import { pageCurrent, pdfDocuments } from '@/db/schema';
import { confirmedAuthors } from '@/server/claims';
import { findPaper, type FoundPaper } from '@/server/papers';
import { submissionsOf } from '@/server/submissions';
import { bibtex, titleLinks } from '@/lib/paper-links';
import { DemoFrames } from './DemoFrames';
import { EditableLinks } from './edit/EditableLinks';
import { toolPath } from './page-tools';
import { Slot } from './slots';
import { TitleActions } from './TitleActions';

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
    title: `${paper.title} · PotentialPaper`,
    description: paper.abstract?.slice(0, DESCRIPTION_LENGTH),
    alternates: canonical ? { canonical: paperPath(canonical) } : undefined,
  };
}

export async function PaperRoute({ scheme, segments }: { scheme: PaperScheme; segments: string[] }) {
  const { paper, identifiers } = await load(scheme, segments);
  const [[current], submissions, authors] = await Promise.all([
    getDb()
      .select({
        pdf: pageCurrent.pdf,
        thumbnail: pageCurrent.thumbnail,
        links: pageCurrent.links,
        authorHtml: pageCurrent.authorHtml,
        communityHtml: pageCurrent.communityHtml,
        cover: pdfDocuments.coverUrl,
      })
      .from(pageCurrent)
      .leftJoin(pdfDocuments, sql`${pdfDocuments.sha256} = ${pageCurrent.pdf} ->> 'sha256'`)
      .where(eq(pageCurrent.paperId, paper.id)),
    submissionsOf(paper.id),
    confirmedAuthors(paper.id),
  ]);
  // The authors' choice of picture wins over the PDF's first page.
  const picture = current?.thumbnail
    ? {
        url: current.thumbnail.url,
        alt: current.thumbnail.alt ?? null,
        caption: current.thumbnail.caption ?? current.thumbnail.alt ?? 'The paper, as its authors picture it.',
      }
    : current?.cover
      ? { url: current.cover, alt: null, caption: "The paper's first page." }
      : null;
  const panel = {
    paper,
    identifiers,
    pdf: current?.pdf ?? null,
    picture,
    cover: current?.cover ?? null,
    submissions,
    confirmedAuthors: authors,
    canonical: canonicalPaperId(identifiers) ?? identifiers[0],
    authorHtml: current?.authorHtml ?? null,
    communityHtml: current?.communityHtml ?? null,
  };
  const about = [paper.venue, paper.year].filter(Boolean).join(', ');
  const linkSources = {
    identifiers,
    title: paper.title,
    pdf: current?.pdf?.url,
    forums: submissions.map((s) => s.url),
  };
  return (
    <main className={ui.paperPage}>
      <article>
        <h1 className="mt-6 text-center text-[26px] leading-tight font-normal">{paper.title}</h1>
        <p className="mt-3 text-center">
          {paper.authors.length > 0 ? (
            paper.authors.join(', ')
          ) : (
            <span className="text-muted italic">Anonymous authors</span>
          )}
        </p>
        {about && <p className={`${ui.fine} text-center`}>{about}</p>}
        <EditableLinks
          paper={panel.canonical}
          builtIn={titleLinks(linkSources)}
          shown={titleLinks({ ...linkSources, extra: current?.links ?? [] })}
          claimPath={toolPath('claim', panel.canonical)}
        />
        <TitleActions
          bibtex={bibtex({ paper, identifiers })}
          path={paperPath(panel.canonical)}
          editPath="#edit-community"
          historyPath={toolPath('history', panel.canonical)}
        />
        <div className="mt-5 grid grid-cols-[minmax(0,1fr)_230px] items-start gap-8 narrow:grid-cols-1">
          <div>
            <Slot name="paper.main" {...panel} />
          </div>
          <aside className="space-y-3">
            <Slot name="paper.aside" {...panel} />
          </aside>
        </div>
        <Slot name="paper.body" {...panel} />
      </article>
      <DemoFrames />
    </main>
  );
}
