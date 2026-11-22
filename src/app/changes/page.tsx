import type { Metadata } from 'next';
import { ui } from '@/components/ui';
import { isPageKind, KINDS, PAGE_KINDS, type PageKind } from '@/lib/kinds';
import { recentChanges } from '@/server/changes';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Recent changes · PotentialPaper', robots: { index: false, follow: true } };

const PAGE_SIZE = 50;

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

function when(at: Date): string {
  return at.toISOString().slice(0, 16).replace('T', ' ');
}

function delta(bytes: number) {
  const tone = bytes > 0 ? 'text-up' : bytes < 0 ? 'text-down' : 'text-faint';
  return <span className={`${ui.mono} ${tone}`}>{bytes > 0 ? `+${bytes}` : bytes}</span>;
}

/**
 * The patrol feed (DESIGN.md §7, `server/changes.ts`): every commit to every page, newest first, for the people who
 * keep pages honest. Filters by kind of page. Bots are hidden unless asked for.
 */
export default async function ChangesPage({ searchParams }: Props) {
  const query = await searchParams;
  const kindText = one(query.kind);
  const kind: PageKind | undefined = kindText && isPageKind(kindText) ? kindText : undefined;
  const bots = one(query.bots) === 'true';
  const beforeText = Number.parseInt(one(query.before) ?? '', 10);
  const before = Number.isSafeInteger(beforeText) && beforeText > 0 ? beforeText : undefined;
  const changes = await recentChanges({ kind, bots, before, limit: PAGE_SIZE });
  const href = (over: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    const next = { kind, bots: bots ? 'true' : undefined, ...over };
    for (const [key, value] of Object.entries(next)) if (value) params.set(key, value);
    const text = params.toString();
    return `/changes${text ? `?${text}` : ''}`;
  };
  const older = changes.length === PAGE_SIZE ? changes[changes.length - 1].id : null;
  return (
    <main className={ui.page}>
      <h1 className="mt-6 text-[26px] leading-tight font-normal">Recent changes</h1>
      <p className="mt-2 font-sans text-sm text-muted">
        Every edit to every page, newest first. Look over what changed, and revert what shouldn&apos;t have.
      </p>
      <p className="mt-3 flex flex-wrap gap-x-3 gap-y-1 font-sans text-sm" aria-label="Kind of page">
        <a href={href({ kind: undefined, before: undefined })} className={kind ? '' : ui.on}>
          All pages
        </a>
        {PAGE_KINDS.map((k) => (
          <a key={k} href={href({ kind: k, before: undefined })} className={kind === k ? ui.on : ''}>
            {KINDS[k].title}s
          </a>
        ))}
      </p>
      <p className="mt-1 flex flex-wrap gap-x-3 font-sans text-sm">
        <a href={href({ bots: bots ? undefined : 'true', before: undefined })} className={bots ? ui.on : ''}>
          {bots ? '✓ ' : ''}Show bots
        </a>
      </p>
      {changes.length === 0 ? (
        <p className={ui.empty}>No changes here.</p>
      ) : (
        <div className={ui.tableScroll}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th()}>When (UTC)</th>
                <th className={ui.th()}>Page</th>
                <th className={ui.th()}>Who</th>
                <th className={ui.th()}>Summary</th>
                <th className={ui.th(true)}>Bytes</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((change) => (
                <tr key={change.id} className="align-baseline">
                  <td className={`${ui.td} ${ui.mono} whitespace-nowrap`}>{when(change.at)}</td>
                  <td className={ui.td}>
                    <a href={change.page.address}>{change.page.name}</a>
                    <span className={ui.badge}>{KINDS[change.page.kind].title.toLowerCase()}</span>
                  </td>
                  <td className={ui.td}>
                    {change.authorName ? (
                      <>
                        {change.authorName}
                        <span className={ui.badge}>author</span>
                      </>
                    ) : change.handle ? (
                      `@${change.handle}`
                    ) : (
                      <i className="text-muted">PotentialPaper</i>
                    )}
                  </td>
                  <td className={ui.td}>
                    {change.summary}
                    {change.kind !== 'edit' && <span className={ui.badge}>{change.kind}</span>}
                    {change.links && <span className={ui.badge}>links</span>}
                    <span className={`block ${ui.fine} font-mono`}>{change.paths.join(', ')}</span>
                  </td>
                  <td className={`${ui.td} text-right`}>{delta(change.bytesDelta)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(older || before) && (
        <p className="mt-4 flex gap-4 font-sans text-sm">
          {before && <a href={href({ before: undefined })}>Newest</a>}
          {older && <a href={href({ before: String(older) })}>Older</a>}
        </p>
      )}
    </main>
  );
}
