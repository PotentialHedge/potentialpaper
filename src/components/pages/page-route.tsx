import 'katex/dist/katex.min.css';
import { eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { ui } from '@/components/ui';
import { getDb } from '@/db';
import { pageCurrent } from '@/db/schema';
import { type KeyedKind, keyedPagePath, keyProblem, KINDS, pageName } from '@/lib/kinds';
import { linksFrom, linksTo } from '@/server/page-links';
import { scopeMemberCount, scopePapers } from '@/server/page-members';
import { cloneAddresses } from '@/server/pages/clone';
import { findKeyedPage } from '@/server/pages/kinds';
import { PluginPageProvider } from '@/components/plugins/PluginPage';
import { pageFacts, pageSummaries, scopesOfPage } from '@/server/plugins/pages';
import { KindSlot } from './slots';

/**
 * What the routes of the kinds other than a paper share (`/v/…`, `/t/…`, `/o/…`, `/u/…`, `lib/kinds.ts`): the page
 * at a key, assembled from its kind's slots. Rendered once and cached, as a paper's page is, so nothing here may
 * read the request; a page that doesn't exist is a 404 until it is made (`createPage` refreshes its address).
 */

const load = cache(async (kind: KeyedKind, segments: string[]) => {
  const raw = segments.map(decodeURIComponent).join('/');
  const key = kind === 'user' ? raw.toLowerCase() : raw;
  if (keyProblem(kind, key)) return null;
  const page = await findKeyedPage(getDb(), kind, key);
  if (!page) return null;
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

export async function keyedPageMetadata(kind: KeyedKind, segments: string[]): Promise<Metadata> {
  const found = await load(kind, segments);
  if (!found) return {};
  const name = found.current?.name ?? pageName(kind, found.key, null);
  return {
    title: `${name} · ${KINDS[kind].title} · PotentialPaper`,
    alternates: { canonical: keyedPagePath(kind, found.key) },
  };
}

export async function KeyedPageRoute({ kind, segments }: { kind: KeyedKind; segments: string[] }) {
  const found = await load(kind, segments);
  if (!found) notFound();
  const { page, key, current } = found;
  const scope = KINDS[kind].scope;
  const [from, to, count, list, summaries, scopes, facts] = await Promise.all([
    linksFrom(page.id),
    linksTo(page.id),
    scope ? scopeMemberCount(page.id) : Promise.resolve(0),
    scope ? scopePapers(page.id) : Promise.resolve([]),
    pageSummaries([page.id]),
    scopesOfPage(page),
    pageFacts(page),
  ]);
  const summary = summaries.get(page.id)!;
  const props = {
    kind,
    key,
    pageId: page.id,
    name: current?.name ?? pageName(kind, key, null),
    kindFile: current?.kindFile ?? null,
    ownersHtml: current?.ownersHtml ?? null,
    communityHtml: current?.communityHtml ?? null,
    linksFrom: from,
    linksTo: to,
    papers: scope ? { count, list } : null,
  };
  const clone = cloneAddresses({ kind, key });
  return (
    <main className={ui.paperPage}>
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
