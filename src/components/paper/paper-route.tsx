import 'katex/dist/katex.min.css';
import { eq, sql } from 'drizzle-orm';
import type { Metadata } from 'next';
import { cache, Fragment } from 'react';
import { buildPanels } from '@/components/pages/common';
import { PageActions } from '@/components/pages/PageActions';
import { PageHeader, PageView } from '@/components/pages/PageView';
import type { PluginPageData } from '@/components/plugins/PluginPage';
import { agentPaperPath, canonicalPaperId, paperPath, parsePaperId, type PaperScheme } from '@/lib/paper-ids';
import { getDb } from '@/db';
import { pageCurrent, pdfDocuments } from '@/db/schema';
import { findPaper, type FoundPaper } from '@/server/papers';
import { submissionsOf } from '@/server/submissions';
import { bibtex, titleLinks } from '@/lib/paper-links';
import { sortVersions } from '@/lib/versions';
import { DemoFrames } from './DemoFrames';
import { PAPER_PANELS } from './slots';
import { cloneAddresses } from '@/server/pages/clone';
import { linksFrom as pageLinksFrom, linksTo as pageLinksTo } from '@/server/page-links';
import { pageHasSignals } from '@/server/signals';
import { formatIdentifier, pagePath } from '@/lib/kinds';
import { toolPath } from '@/lib/page-tools';
import { ownersOf } from '@/server/owners';
import { scopesOfPage, submissionsHaveScores } from '@/server/plugins/pages';
import { siteUrl } from '@/server/site';
import { badgeMarkdown, badgeUrl, previewMetadata, previewOfPage, shortIdOf, shortUrl } from '@/server/share';

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
  const preview = await previewOfPage(paper.id);
  const description = paper.abstract?.slice(0, DESCRIPTION_LENGTH);
  return {
    title: `${paper.title} · PotentialPaper`,
    description,
    ...(preview && previewMetadata(paper.title, description, preview)),
    // The page as an agent reads it, with the agents' discussion (`app/agent/[prefix]/[...id]`).
    alternates: canonical
      ? { canonical: paperPath(canonical), types: { 'text/markdown': agentPaperPath(canonical) } }
      : undefined,
  };
}

export async function PaperRoute({ scheme, segments }: { scheme: PaperScheme; segments: string[] }) {
  const { paper, identifiers } = await load(scheme, segments);
  const canonical = canonicalPaperId(identifiers) ?? identifiers[0];
  const address = { kind: 'paper' as const, id: canonical };
  const pageRow = { id: paper.id, kind: 'paper' as const, key: paper.id };
  const [[current], submissions, owners, linksFrom, linksTo, scopes, shortId, hasSignals] = await Promise.all([
    getDb()
      .select({
        pdf: pageCurrent.pdf,
        thumbnail: pageCurrent.thumbnail,
        links: pageCurrent.links,
        versions: pageCurrent.versions,
        authorHtml: pageCurrent.authorHtml,
        communityHtml: pageCurrent.communityHtml,
        authorPlugins: pageCurrent.authorPlugins,
        cover: pdfDocuments.coverUrl,
      })
      .from(pageCurrent)
      .leftJoin(pdfDocuments, sql`${pdfDocuments.sha256} = ${pageCurrent.pdf} ->> 'sha256'`)
      .where(eq(pageCurrent.pageId, paper.id)),
    submissionsOf(paper.id),
    ownersOf(pageRow, address),
    pageLinksFrom(paper.id),
    pageLinksTo(paper.id),
    scopesOfPage(pageRow),
    shortIdOf(paper.id),
    pageHasSignals({ id: paper.id, kind: 'paper' }),
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
  const props = {
    kind: 'paper' as const,
    address,
    pageId: paper.id,
    name: paper.title,
    ownersHtml: current?.authorHtml ?? null,
    communityHtml: current?.communityHtml ?? null,
    linksFrom,
    linksTo,
    owners,
    paper,
    identifiers,
    pdf: current?.pdf ?? null,
    picture,
    cover: current?.cover ?? null,
    submissions,
    versions: sortVersions(current?.versions ?? []),
    canonical,
  };
  // What the page's plugins are told about it (`components/plugins/`).
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
    facts: {
      hasSubmissions: submissions.length > 0,
      hasScores: submissionsHaveScores(submissions),
      hasSignals,
    },
    authorPanels: current?.authorPlugins ?? [],
  };
  const about = [paper.venue, paper.year].filter(Boolean).join(', ');
  const linkSources = {
    identifiers,
    title: paper.title,
    pdf: current?.pdf?.url,
    forums: submissions.map((s) => s.url),
  };
  return (
    <PageView
      pageId={paper.id}
      kind="paper"
      plugins={plugins}
      panels={buildPanels('paper', PAPER_PANELS, props)}
      header={
        <PageHeader title={paper.title}>
          <p className="mt-4 text-center">
            {paper.authors.length > 0 ? (
              // A confirmed author's name links to their page, unless they turned that off.
              paper.authors.map((name, i) => {
                const href = owners?.people.find((p) => p.authorIndex === i)?.href;
                return (
                  <Fragment key={i}>
                    {i > 0 && ', '}
                    {href ? (
                      <a
                        href={href}
                        className="text-ink underline decoration-rule-strong underline-offset-4 hover:decoration-ink"
                      >
                        {name}
                      </a>
                    ) : (
                      name
                    )}
                  </Fragment>
                );
              })
            ) : (
              <span className="text-muted italic">Anonymous authors</span>
            )}
          </p>
          {about && <p className="mt-2.5 text-center text-xs text-faint">{about}</p>}
          <nav
            className="mt-2.5 flex flex-wrap justify-center gap-x-3 font-sans text-[13px]"
            aria-label="The paper elsewhere"
          >
            {titleLinks({ ...linkSources, extra: current?.links ?? [] }).map((l, i) => (
              <a key={i} href={l.url} className="text-accent" rel="noopener noreferrer" target="_blank">
                [{l.label}]
              </a>
            ))}
          </nav>
        </PageHeader>
      }
      actions={
        <PageActions
          pageId={paper.id}
          historyPath={toolPath('history', address)}
          paper={{ id: canonical, bibtex: bibtex({ paper, identifiers }), agentPath: agentPaperPath(canonical) }}
          share={
            shortId === null
              ? null
              : {
                  url: shortUrl(shortId),
                  title: paper.title,
                  badge: { image: badgeUrl(shortId), markdown: badgeMarkdown(shortId) },
                }
          }
          edit={{
            codePath: toolPath('code', address),
            clone: cloneAddresses(canonical),
            hasRepo: current !== undefined,
          }}
        />
      }
      after={<DemoFrames />}
    />
  );
}
