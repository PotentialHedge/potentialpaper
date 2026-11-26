import { venueLine } from '@/lib/paper-file';
import { ENTITY_LINK, EntityLink } from '@/components/EntityLink';
import { venuePaths } from '@/server/entity-paths';
import 'katex/dist/katex.min.css';
import { eq, sql } from 'drizzle-orm';
import type { Metadata } from 'next';
import { cache, Fragment } from 'react';
import { buildPanels } from '@/components/pages/common';
import { PageActions } from '@/components/pages/PageActions';
import { PageHeader, PageView } from '@/components/pages/PageView';
import type { PluginPageData } from '@/components/plugins/PluginPage';
import { agentPaperPath, canonicalPaperId, parsePaperId, shortPath, type PaperScheme } from '@/lib/paper-ids';
import { getDb } from '@/db';
import { pageCurrent, pdfDocuments } from '@/db/schema';
import { findPaper, type FoundPaper } from '@/server/papers';
import { submissionsOf } from '@/server/submissions';
import { citationTags, paperFacts, paperJsonLd } from '@/lib/paper-facts';
import { reviewVenues } from '@/server/under-review';
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

/** The page as last committed, read once for the page and its metadata alike. */
const loadCurrent = cache(async (paperId: string) => {
  const [row] = await getDb()
    .select({
      pdf: pageCurrent.pdf,
      thumbnail: pageCurrent.thumbnail,
      links: pageCurrent.links,
      versions: pageCurrent.versions,
      authorHtml: pageCurrent.authorHtml,
      communityHtml: pageCurrent.communityHtml,
      authorPlugins: pageCurrent.authorPlugins,
      facts: pageCurrent.facts,
      cover: pdfDocuments.coverUrl,
    })
    .from(pageCurrent)
    .leftJoin(pdfDocuments, sql`${pdfDocuments.sha256} = ${pageCurrent.pdf} ->> 'sha256'`)
    .where(eq(pageCurrent.pageId, paperId));
  return row;
});

const loadSubmissions = cache((paperId: string) => submissionsOf(paperId));

/** What the infobox, the JSON-LD and the meta tags say (`lib/paper-facts.ts`), from one read of each source. */
async function factsOf({ paper, identifiers }: FoundPaper) {
  const [current, submissions] = await Promise.all([loadCurrent(paper.id), loadSubmissions(paper.id)]);
  return paperFacts({
    paper,
    versions: current?.versions ?? [],
    submissions,
    identifiers,
    pdf: current?.pdf?.url ?? null,
    own: current?.facts ?? null,
  });
}

/** `citation_*` pairs as Next's `other` metadata: a repeated name as a list. */
function metaTags(pairs: [string, string][]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, value] of pairs) (out[name] ??= []).push(value);
  return out;
}

export async function paperMetadata(scheme: PaperScheme, segments: string[]): Promise<Metadata> {
  const found = await load(scheme, segments);
  const { paper, identifiers } = found;
  const canonical = canonicalPaperId(identifiers);
  const [preview, shortId, facts] = await Promise.all([previewOfPage(paper.id), shortIdOf(paper.id), factsOf(found)]);
  // The authors' own one-sentence summary says it best, where they gave one.
  const description = (facts.tldr ?? paper.abstract)?.slice(0, DESCRIPTION_LENGTH);
  return {
    title: `${paper.title} · potentialpaper`,
    description,
    ...(preview && previewMetadata(paper.title, description, preview)),
    // For Google Scholar, from the same facts as the infobox.
    other: metaTags(citationTags(facts)),
    // The paper's address is its short one (`proxy.ts`), and so is the page as an agent reads it, with the agents'
    // discussion (`app/agent/s/[n]`).
    alternates: {
      ...(shortId !== null ? { canonical: shortUrl(shortId) } : {}),
      ...(shortId !== null
        ? { types: { 'text/markdown': `/agent${shortPath(shortId)}` } }
        : canonical
          ? { types: { 'text/markdown': agentPaperPath(canonical) } }
          : {}),
    },
  };
}

export async function PaperRoute({ scheme, segments }: { scheme: PaperScheme; segments: string[] }) {
  const found = await load(scheme, segments);
  const { paper, identifiers } = found;
  const canonical = canonicalPaperId(identifiers) ?? identifiers[0];
  const address = { kind: 'paper' as const, id: canonical };
  const pageRow = { id: paper.id, kind: 'paper' as const, key: paper.id };
  const [current, submissions, owners, linksFrom, linksTo, scopes, shortId, hasSignals, reviewAt] = await Promise.all([
    loadCurrent(paper.id),
    loadSubmissions(paper.id),
    ownersOf(pageRow, address),
    pageLinksFrom(paper.id),
    pageLinksTo(paper.id),
    scopesOfPage(pageRow),
    shortIdOf(paper.id),
    pageHasSignals({ id: paper.id, kind: 'paper' }),
    reviewVenues(paper.id),
  ]);
  // The venues it names, linked to their pages here: the header's, each submission's, each version's.
  const venueLinks = await venuePaths([
    paper.venue,
    ...submissions.map((s) => s.venue.name),
    ...(current?.versions ?? []).flatMap((v) => (v.submissions ?? []).map((s) => s.venue)),
  ]);
  // Shown and shared at its short address, and the page tools at theirs (`/history/s/42`).
  const shown = shortId === null ? address : { ...address, shortId };
  if (owners) owners.claimPath = toolPath('claim', shown);
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
    address: shown,
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
    facts: await factsOf(found),
    venueLinks,
  };
  const url = `${siteUrl()}${pagePath(shown)}`;
  // What the page's plugins are told about it (`components/plugins/`).
  const plugins: PluginPageData = {
    kind: 'paper',
    page: {
      kind: 'paper',
      identifier: formatIdentifier(address),
      address: pagePath(shown),
      url,
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
  const about = venueLine(paper.venue, paper.year);
  const linkSources = {
    identifiers,
    title: paper.title,
    pdf: current?.pdf?.url,
    forums: submissions.map((s) => s.url),
  };
  return (
    <PageView
      pageId={paper.id}
      claimPath={owners?.claimPath}
      kind="paper"
      repo={{ address: shown }}
      reviewAt={reviewAt}
      plugins={plugins}
      panels={buildPanels('paper', PAPER_PANELS, props)}
      header={
        <>
          {/* For search engines, from the same facts as the infobox (`lib/paper-facts.ts`). */}
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{
              __html: JSON.stringify(paperJsonLd(props.facts, url, siteUrl())).replace(/</g, '\\u003c'),
            }}
          />
          <PageHeader title={paper.title}>
            <p className="mt-4 text-center" data-link-area="authors">
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
            {about && (
              <p className="mt-2.5 text-center text-xs text-faint">
                {paper.venue ? (
                  <EntityLink name={paper.venue} paths={venueLinks} className={ENTITY_LINK}>
                    {about}
                  </EntityLink>
                ) : (
                  about
                )}
              </p>
            )}
            <nav
              className="mt-2.5 flex flex-wrap justify-center gap-x-3 font-sans text-[13px]"
              aria-label="The paper elsewhere"
              data-link-area="title_links"
            >
              {titleLinks({ ...linkSources, extra: current?.links ?? [] }).map((l, i) => (
                <a key={i} href={l.url} className="text-accent" rel="noopener noreferrer" target="_blank">
                  [{l.label}]
                </a>
              ))}
            </nav>
          </PageHeader>
        </>
      }
      actions={
        <PageActions
          pageId={paper.id}
          historyPath={toolPath('history', shown)}
          paper={{ id: canonical, bibtex: bibtex({ paper, identifiers }), agentPath: `/agent${pagePath(shown)}` }}
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
            pagePath: pagePath(shown),
            codePath: toolPath('code', shown),
            clone: cloneAddresses(canonical),
          }}
        />
      }
      after={<DemoFrames />}
    />
  );
}
