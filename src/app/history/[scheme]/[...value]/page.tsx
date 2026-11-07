import type { Metadata } from 'next';
import {
  first,
  ToolHeader,
  toolPaper,
  toolPath,
  type ToolParams,
  type ToolSearchParams,
} from '@/components/paper/page-tools';
import { RevertButton } from '@/components/paper/RevertButton';
import { ui } from '@/components/ui';
import { historyWithHandles } from '@/server/pages/edit';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

type Props = { params: ToolParams; searchParams: ToolSearchParams };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { paper } = await toolPaper('history', params);
  return { title: `History of ${paper.title} · PotentialPaper`, robots: { index: false, follow: true } };
}

function when(at: Date): string {
  return at.toISOString().slice(0, 16).replace('T', ' ');
}

function delta(bytes: number) {
  const tone = bytes > 0 ? 'text-up' : bytes < 0 ? 'text-down' : 'text-faint';
  return <span className={`${ui.mono} ${tone}`}>{bytes > 0 ? `+${bytes}` : bytes}</span>;
}

export default async function HistoryPage({ params, searchParams }: Props) {
  const query = await searchParams;
  const before = Number.parseInt(first(query.before) ?? '', 10);
  const beforeSeq = Number.isSafeInteger(before) && before > 0 ? before : undefined;
  const found = await toolPaper('history', params, beforeSeq ? `before=${beforeSeq}` : '');
  const rows = await historyWithHandles(found.paper.id, { limit: PAGE_SIZE + 1, beforeSeq });
  const shown = rows.slice(0, PAGE_SIZE);
  const older = rows.length > PAGE_SIZE ? shown[shown.length - 1].seq : null;
  const historyPath = toolPath('history', found.id);
  return (
    <main className={ui.page}>
      <ToolHeader paper={found} tool="history" title="History" />
      {shown.length === 0 ? (
        <p className={ui.empty}>Nobody has changed this page yet.</p>
      ) : (
        <div className={ui.tableScroll}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th()}>#</th>
                <th className={ui.th()}>When (UTC)</th>
                <th className={ui.th()}>Who</th>
                <th className={ui.th()}>Summary</th>
                <th className={ui.th(true)}>Bytes</th>
                <th className={ui.th()} />
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr key={row.seq} className="align-baseline">
                  <td className={`${ui.td} ${ui.mono}`}>{row.seq}</td>
                  <td className={`${ui.td} ${ui.mono} whitespace-nowrap`}>{when(row.at)}</td>
                  <td className={ui.td}>
                    {row.handle ? `@${row.handle}` : <i className="text-muted">PotentialPaper</i>}
                  </td>
                  <td className={ui.td}>
                    <a href={toolPath('diff', found.id, `oid=${row.oid}`)}>{row.summary}</a>
                    {row.kind !== 'edit' && <span className={ui.badge}>{row.kind}</span>}
                    <span className={`block ${ui.fine} font-mono`}>{row.paths.join(', ')}</span>
                  </td>
                  <td className={`${ui.td} text-right`}>{delta(row.bytesDelta)}</td>
                  <td className={`${ui.td} whitespace-nowrap`}>
                    {row.seq > 1 && <RevertButton paper={found.canonical} oid={row.oid} historyPath={historyPath} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(older || beforeSeq) && (
        <p className="mt-4 flex gap-4 font-sans text-sm">
          {beforeSeq && <a href={historyPath}>Newest</a>}
          {older && <a href={toolPath('history', found.id, `before=${older}`)}>Older</a>}
        </p>
      )}
    </main>
  );
}
