import 'katex/dist/katex.min.css';
import { eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { cache } from 'react';
import { ui } from '@/components/ui';
import { ViewCount } from '@/components/ViewCount';
import { getDb } from '@/db';
import { pageCurrent } from '@/db/schema';
import { type KeyedKind, keyedPagePath, keyProblem, KINDS, pageName } from '@/lib/kinds';
import { linksFrom, linksTo } from '@/server/page-links';
import { scopeMemberCount, scopePapers } from '@/server/page-members';
import { cloneAddresses } from '@/server/pages/clone';
import { findKeyedPage, type PageRow, redirectedPage, survivorOf } from '@/server/pages/kinds';
import { orgOverview } from '@/server/org-pages';
import { userPageView } from '@/server/user-pages';
import { PluginPageProvider } from '@/components/plugins/PluginPage';
import { pageFacts, pageSummaries, scopesOfPage } from '@/server/plugins/pages';
import { KindSlot } from './slots';
import type { TopicView } from './topic-panels';
import { topicOverview } from '@/server/topic-pages';
import { presentTopicPapers } from '@/server/topic-papers';

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
  return {
    title: `${name} · ${KINDS[kind].title} · PotentialPaper`,
    alternates: { canonical: keyedPagePath(kind, found.key) },
  };
}

export async function KeyedPageRoute({ kind, segments }: { kind: KeyedKind; segments: string[] }) {
  const found = await load(kind, segments);
  if (!found) notFound();
  if ('redirect' in found) redirect(found.redirect);
  const { page, key, current } = found;
  const scope = KINDS[kind].scope;
  const [from, to, count, list, summaries, scopes, facts, user, org, topic] = await Promise.all([
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
  ]);
  const summary = summaries.get(page.id)!;
  const props = {
    kind,
    pageKey: key,
    pageId: page.id,
    name: current?.name ?? pageName(kind, key, null),
    kindFile: current?.kindFile ?? null,
    ownersHtml: current?.ownersHtml ?? null,
    communityHtml: current?.communityHtml ?? null,
    linksFrom: from,
    linksTo: to,
    papers: scope ? { count, list } : null,
    user,
    org,
    topic,
  };
  const clone = cloneAddresses({ kind, key });
  return (
    <main className={ui.page}>
      <PluginPageProvider data={{ kind, page: summary, scopes, facts }}>
        <article>
          <p className={`${ui.fine} mt-6 text-center font-sans`}>{KINDS[kind].title}</p>
          <h1 className="mt-1 text-center text-[26px] leading-tight font-normal">{props.name}</h1>
          <p className={`${ui.fine} text-center font-sans`}>
            <span className={ui.mono}>
              {kind}:{key}
            </span>{' '}
            · clone with <span className={ui.mono}>git clone {clone.https}</span>
          </p>
          <p className={`${ui.fine} text-center font-sans`}>
            <ViewCount pageId={page.id} />
          </p>
          <div className="mt-5 grid grid-cols-[minmax(0,1fr)_300px] items-start gap-8 narrow:grid-cols-1">
            <div>
              <KindSlot slot="main" {...props} />
            </div>
            <aside className="space-y-3">
              <KindSlot slot="aside" {...props} />
            </aside>
          </div>
          <KindSlot slot="tabs" {...props} />
        </article>
      </PluginPageProvider>
    </main>
  );
}
