import 'katex/dist/katex.min.css';
import { eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { cache } from 'react';
import { getDb } from '@/db';
import { pageCurrent } from '@/db/schema';
import { type KeyedKind, keyedPagePath, keyProblem, KINDS, pageName, pagePath, venueFileSchema } from '@/lib/kinds';
import { siteUrl } from '@/server/site';
import type { PageFacts } from '@/lib/infobox-facts';
import { venueJsonLd } from './venue-panels';
import { linksFrom, linksTo } from '@/server/page-links';
import { scopeMemberCount, scopePapers } from '@/server/page-members';
import { cloneAddresses } from '@/server/pages/clone';
import { findKeyedPage, type PageRow, redirectedPage, survivorOf } from '@/server/pages/kinds';
import { orgOverview } from '@/server/org-pages';
import { userPageView } from '@/server/user-pages';
import { pageFacts, pageSummaries, scopesOfPage } from '@/server/plugins/pages';
import { toolPath } from '@/lib/page-tools';
import { ownersOf } from '@/server/owners';
import { buildPanels } from './common';
import { PageActions } from './PageActions';
import { UserByline } from './user-panels';
import { PageHeader, PageView } from './PageView';
import { KIND_PANELS, type KindPanelProps, presentPanel } from './slots';
import { categoryOverview } from '@/server/category-pages';
import { previewMetadata, previewOfPage, shortIdOf, shortUrl } from '@/server/share';

/**
 * What the routes of the kinds other than a paper share (`/v/…`, `/c/…`, `/o/…`, `/u/…`, `lib/kinds.ts`): the page
 * at a key, assembled from its kind's slots. Rendered once and cached, as a paper's page is, so nothing here may
 * read the request; a page that doesn't exist is a 404 until it is made (`createPage` refreshes its address).
 */

type Loaded =
  | { redirect: string }
  | {
      page: PageRow;
      key: string;
      current: {
        name: string | null;
        kindFile: Record<string, unknown> | null;
        ownersHtml: string | null;
        communityHtml: string | null;
        facts: PageFacts | null;
      } | null;
    };

const load = cache(async (kind: KeyedKind, segments: string[]): Promise<Loaded | null> => {
  const raw = segments.map(decodeURIComponent).join('/');
  const key = kind === 'user' ? raw.toLowerCase() : raw;
  if (keyProblem(kind, key)) return null;
  const page = await findKeyedPage(getDb(), kind, key);
  if (!page) {
    // An old handle or a renamed category's old slug leads to the page's new address (`page_redirects`).
    const moved = await redirectedPage(getDb(), kind, key);
    const there = moved && (await survivorOf(getDb(), moved));
    return there ? { redirect: keyedPagePath(kind, there.key) } : null;
  }
  // A category merged into another leads there; its history stays at its own address's tools.
  const survivor = await survivorOf(getDb(), page);
  if (survivor.id !== page.id) return { redirect: keyedPagePath(kind, survivor.key) };
  const [current] = await getDb()
    .select({
      name: pageCurrent.name,
      kindFile: pageCurrent.kindFile,
      ownersHtml: pageCurrent.authorHtml,
      communityHtml: pageCurrent.communityHtml,
      facts: pageCurrent.facts,
    })
    .from(pageCurrent)
    .where(eq(pageCurrent.pageId, page.id));
  return { page, key, current: current ?? null };
});

export async function keyedPageMetadata(kind: KeyedKind, segments: string[]): Promise<Metadata> {
  const found = await load(kind, segments);
  if (!found || 'redirect' in found) return {};
  const name = found.current?.name ?? pageName(kind, found.key, null);
  const preview = await previewOfPage(found.page.id);
  return {
    title: `${name} · ${KINDS[kind].title} · potentialpaper`,
    ...(preview && previewMetadata(name, undefined, preview)),
    alternates: { canonical: keyedPagePath(kind, found.key) },
  };
}

export async function KeyedPageRoute({ kind, segments }: { kind: KeyedKind; segments: string[] }) {
  const found = await load(kind, segments);
  if (!found) notFound();
  if ('redirect' in found) redirect(found.redirect);
  const { page, key, current } = found;
  const address = { kind, key };
  const scope = KINDS[kind].scope;
  const [from, to, count, list, summaries, scopes, facts, user, org, category, shortId, owners] = await Promise.all([
    linksFrom(page.id),
    linksTo(page.id),
    scope ? scopeMemberCount(page.id) : Promise.resolve(0),
    // A venue lists its submissions by status itself (`venue-panels.tsx`), a category its pages by name (`category-panels.tsx`).
    scope && kind !== 'venue' && kind !== 'category' ? scopePapers(page.id) : Promise.resolve([]),
    pageSummaries([page.id]),
    scopesOfPage(page),
    pageFacts(page),
    // A person's page shows only what its account chose (DESIGN.md §5.3), all of it from `userPageView`.
    kind === 'user' ? userPageView(page) : Promise.resolve(null),
    // Its people are only those who show it as their institution (`orgPeople`).
    kind === 'org' ? orgOverview(page) : Promise.resolve(null),
    // Its subcategories and other pages (`server/category-pages.ts`).
    kind === 'category' ? categoryOverview(page) : Promise.resolve(null),
    shortIdOf(page.id),
    ownersOf(page, address),
  ]);
  const summary = summaries.get(page.id)!;
  const parsedVenue = kind === 'venue' ? venueFileSchema.safeParse(current?.kindFile) : null;
  const venue = parsedVenue?.success ? parsedVenue.data : null;
  const props: KindPanelProps = {
    kind,
    address,
    pageKey: key,
    pageId: page.id,
    name: current?.name ?? pageName(kind, key, null),
    kindFile: current?.kindFile ?? null,
    own: current?.facts ?? null,
    ownersHtml: current?.ownersHtml ?? null,
    communityHtml: current?.communityHtml ?? null,
    linksFrom: from,
    linksTo: to,
    owners,
    papers: scope ? { count, list } : null,
    user,
    org,
    category,
  };
  return (
    <PageView
      pageId={page.id}
      claimPath={owners?.claimPath}
      kind={kind}
      plugins={{ kind, page: summary, scopes, facts }}
      panels={buildPanels(kind, KIND_PANELS[kind], props, (id) => presentPanel(props, id))}
      header={
        <>
          {venue && (
            // For search engines, from the same venue file as its infobox (`venue-panels.tsx`).
            <script
              type="application/ld+json"
              dangerouslySetInnerHTML={{
                __html: JSON.stringify(venueJsonLd(venue, `${siteUrl()}${pagePath(address)}`)).replace(/</g, '\\u003c'),
              }}
            />
          )}
          <PageHeader eyebrow={KINDS[kind].title} title={props.name}>
            {user && <UserByline user={user} />}
          </PageHeader>
        </>
      }
      actions={
        <PageActions
          pageId={page.id}
          historyPath={KINDS[kind].repo ? toolPath('history', address) : undefined}
          share={shortId === null ? null : { url: shortUrl(shortId), title: props.name }}
          edit={
            KINDS[kind].repo
              ? {
                  pagePath: pagePath(address),
                  codePath: toolPath('code', address),
                  clone: cloneAddresses(address),
                  hasRepo: current !== null,
                  // A category's name and article have a form of their own.
                  form:
                    kind === 'category'
                      ? { href: `${keyedPagePath('category', key)}/edit`, label: 'Edit the category' }
                      : undefined,
                }
              : undefined
          }
        />
      }
    />
  );
}
