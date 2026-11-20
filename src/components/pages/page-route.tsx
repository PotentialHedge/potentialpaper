import 'katex/dist/katex.min.css';
import { eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { cache } from 'react';
import { getDb } from '@/db';
import { pageCurrent } from '@/db/schema';
import { type KeyedKind, keyedPagePath, keyProblem, KINDS, pageName } from '@/lib/kinds';
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
import { PageHeader, PageView } from './PageView';
import { KIND_PANELS, type KindPanelProps, presentPanel } from './slots';
import type { TopicView } from './topic-panels';
import { topicOverview } from '@/server/topic-pages';
import { presentTopicPapers } from '@/server/topic-papers';
import { previewMetadata, shortIdOf, shortUrl } from '@/server/share';

/**
 * What the routes of the kinds other than a paper share (`/v/…`, `/t/…`, `/o/…`, `/u/…`, `lib/kinds.ts`): the page
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
      } | null;
    };

const load = cache(async (kind: KeyedKind, segments: string[]): Promise<Loaded | null> => {
  const raw = segments.map(decodeURIComponent).join('/');
  const key = kind === 'user' ? raw.toLowerCase() : raw;
  if (keyProblem(kind, key)) return null;
  const page = await findKeyedPage(getDb(), kind, key);
  if (!page) {
    // An old handle or a renamed topic's old slug leads to the page's new address (`page_redirects`).
    const moved = await redirectedPage(getDb(), kind, key);
    const there = moved && (await survivorOf(getDb(), moved));
    return there ? { redirect: keyedPagePath(kind, there.key) } : null;
  }
  // A topic merged into another leads there; its history stays at its own address's tools.
  const survivor = await survivorOf(getDb(), page);
  if (survivor.id !== page.id) return { redirect: keyedPagePath(kind, survivor.key) };
  const [current] = await getDb()
    .select({
      name: pageCurrent.name,
      kindFile: pageCurrent.kindFile,
      ownersHtml: pageCurrent.authorHtml,
      communityHtml: pageCurrent.communityHtml,
    })
    .from(pageCurrent)
    .where(eq(pageCurrent.pageId, page.id));
  return { page, key, current: current ?? null };
});

async function topicView(page: PageRow): Promise<TopicView> {
  const [overview, papers] = await Promise.all([topicOverview(page), presentTopicPapers(page.id, { sort: 'date' })]);
  return { overview, papers };
}

export async function keyedPageMetadata(kind: KeyedKind, segments: string[]): Promise<Metadata> {
  const found = await load(kind, segments);
  if (!found || 'redirect' in found) return {};
  const name = found.current?.name ?? pageName(kind, found.key, null);
  const shortId = await shortIdOf(found.page.id);
  return {
    title: `${name} · ${KINDS[kind].title} · PotentialPaper`,
    ...(shortId !== null && previewMetadata(name, undefined, shortId)),
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
  const [from, to, count, list, summaries, scopes, facts, user, org, topic, shortId, owners] = await Promise.all([
    linksFrom(page.id),
    linksTo(page.id),
    scope ? scopeMemberCount(page.id) : Promise.resolve(0),
    // A venue lists its submissions by status itself (`venue-panels.tsx`), a topic its papers sortable (`topic-panels.tsx`).
    scope && kind !== 'venue' && kind !== 'topic' ? scopePapers(page.id) : Promise.resolve([]),
    pageSummaries([page.id]),
    scopesOfPage(page),
    pageFacts(page),
    // A person's page shows only what its account chose (DESIGN.md §5.3), all of it from `userPageView`.
    kind === 'user' ? userPageView(page) : Promise.resolve(null),
    // Its people are only those who show it as their institution (`orgPeople`).
    kind === 'org' ? orgOverview(page) : Promise.resolve(null),
    // Its neighbours, papers and suggestions (`server/topic-pages.ts`).
    kind === 'topic' ? topicView(page) : Promise.resolve(null),
    shortIdOf(page.id),
    ownersOf(page, address),
  ]);
  const summary = summaries.get(page.id)!;
  const props: KindPanelProps = {
    kind,
    address,
    pageKey: key,
    pageId: page.id,
    name: current?.name ?? pageName(kind, key, null),
    kindFile: current?.kindFile ?? null,
    ownersHtml: current?.ownersHtml ?? null,
    communityHtml: current?.communityHtml ?? null,
    linksFrom: from,
    linksTo: to,
    owners,
    papers: scope ? { count, list } : null,
    user,
    org,
    topic,
  };
  return (
    <PageView
      kind={kind}
      plugins={{ kind, page: summary, scopes, facts }}
      panels={buildPanels(kind, KIND_PANELS[kind], props, (id) => presentPanel(props, id))}
      header={<PageHeader eyebrow={KINDS[kind].title} title={props.name} />}
      actions={
        <PageActions
          pageId={page.id}
          historyPath={toolPath('history', address)}
          share={shortId === null ? null : { url: shortUrl(shortId), title: props.name }}
          edit={{
            codePath: toolPath('code', address),
            clone: cloneAddresses(address),
            hasRepo: current !== null,
            // A topic's names, broader topics and article have a form of their own.
            form:
              kind === 'topic' ? { href: `${keyedPagePath('topic', key)}/edit`, label: 'Edit the topic' } : undefined,
          }}
        />
      }
    />
  );
}
