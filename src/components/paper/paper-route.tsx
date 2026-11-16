import 'katex/dist/katex.min.css';
import { eq, sql } from 'drizzle-orm';
import type { Metadata } from 'next';
import { cache } from 'react';
import { ui } from '@/components/ui';
import { agentPaperPath, canonicalPaperId, paperPath, parsePaperId, type PaperScheme } from '@/lib/paper-ids';
import { getDb } from '@/db';
import { pageCurrent, pdfDocuments } from '@/db/schema';
import { confirmedAuthors } from '@/server/claims';
import { findPaper, type FoundPaper } from '@/server/papers';
import { submissionsOf } from '@/server/submissions';
import { bibtex, titleLinks } from '@/lib/paper-links';
import { sortVersions } from '@/lib/versions';
import { DemoFrames } from './DemoFrames';
import { toolPath } from './page-tools';
import { Slot } from './slots';
import { TitleActions } from './TitleActions';
import { cloneAddresses } from '@/server/pages/clone';
import { linksFrom as pageLinksFrom, linksTo as pageLinksTo } from '@/server/page-links';
import { PluginPageProvider, type PluginPageData } from '@/components/plugins/PluginPage';
import { formatIdentifier, pagePath } from '@/lib/kinds';
import { scopesOfPage, submissionsHaveScores } from '@/server/plugins/pages';
import { siteUrl } from '@/server/site';

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
    // The page as an agent reads it, with the agents' discussion (`app/agent/[prefix]/[...id]`).
    alternates: canonical
      ? { canonical: paperPath(canonical), types: { 'text/markdown': agentPaperPath(canonical) } }
      : undefined,
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
        versions: pageCurrent.versions,
        authorHtml: pageCurrent.authorHtml,
        communityHtml: pageCurrent.communityHtml,
        cover: pdfDocuments.coverUrl,
      })
      .from(pageCurrent)
      .leftJoin(pdfDocuments, sql`${pdfDocuments.sha256} = ${pageCurrent.pdf} ->> 'sha256'`)
      .where(eq(pageCurrent.pageId, paper.id)),
    submissionsOf(paper.id),
    confirmedAuthors(paper.id),
  ]);
  const [linksFrom, linksTo, scopes] = await Promise.all([
    pageLinksFrom(paper.id),
    pageLinksTo(paper.id),
    scopesOfPage({ id: paper.id, kind: 'paper', key: paper.id }),
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
    versions: sortVersions(current?.versions ?? []),
    confirmedAuthors: authors,
    canonical: canonicalPaperId(identifiers) ?? identifiers[0],
    authorHtml: current?.authorHtml ?? null,
    communityHtml: current?.communityHtml ?? null,
    linksFrom,
    linksTo,
  };
  // What the page's plugins are told about it (`components/plugins/`).
  const address = { kind: 'paper' as const, id: panel.canonical };
  const plugins: PluginPageData = {
    kind: 'paper',
    page: {
      kind: 'paper',
      identifier: formatIdentifier(address),
      address: pagePath(address),
      url: `${siteUrl()}${pagePath(address)}`,
      name: paper.title,
    },
    scopes,
    facts: { hasSubmissions: submissions.length > 0, hasScores: submissionsHaveScores(submissions) },
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
      <PluginPageProvider data={plugins}>
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
          <nav
            className="mt-1.5 flex flex-wrap justify-center gap-x-3 font-sans text-[13px]"
            aria-label="The paper elsewhere"
          >
            {titleLinks({ ...linkSources, extra: current?.links ?? [] }).map((l, i) => (
              <a key={i} href={l.url} className="text-accent" rel="noopener noreferrer" target="_blank">
                [{l.label}]
              </a>
            ))}
          </nav>
          <TitleActions
            paper={panel.canonical}
            bibtex={bibtex({ paper, identifiers })}
            historyPath={toolPath('history', panel.canonical)}
            agentPath={agentPaperPath(panel.canonical)}
            edit={{
              codePath: toolPath('code', panel.canonical),
              clone: cloneAddresses(panel.canonical),
              hasRepo: current !== undefined,
            }}
          />
          <div className="mt-5 grid grid-cols-[minmax(0,1fr)_300px] items-start gap-8 narrow:grid-cols-1">
            <div>
              <Slot name="paper.main" {...panel} />
            </div>
            <aside className="space-y-3">
              <Slot name="paper.aside" {...panel} />
            </aside>
          </div>
          <Slot name="paper.body" {...panel} />
          <Slot name="paper.tabs" {...panel} />
        </article>
      </PluginPageProvider>
      <DemoFrames />
    </main>
  );
}
