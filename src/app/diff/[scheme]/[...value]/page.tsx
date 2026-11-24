import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { first, ToolHeader, toolPage, type ToolParams, type ToolSearchParams } from '@/components/pages/page-tools';
import { toolPath } from '@/lib/page-tools';
import { RevertButton } from '@/components/paper/RevertButton';
import { ui } from '@/components/ui';
import { claimNames } from '@/server/claims';
import { handlesOf } from '@/server/pages/edit';
import type { FileDiff } from '@/server/pages/merge';
import { diffCommits, findCommit } from '@/server/pages/repo';
import { getDb } from '@/db';

export const dynamic = 'force-dynamic';

type Props = { params: ToolParams; searchParams: ToolSearchParams };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { name } = await toolPage('diff', params);
  return { title: `A change to ${name} · potentialpaper`, robots: { index: false, follow: true } };
}

/** A line's look by its first character: added, removed, a hunk's header, or context. */
function lineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-faint';
  if (line.startsWith('+')) return 'bg-[#e6f4ea] text-up';
  if (line.startsWith('-')) return 'bg-[#fbe9e9] text-down';
  if (line.startsWith('@@')) return 'text-muted';
  return '';
}

function Patch({ diff }: { diff: FileDiff }) {
  // The patch's own header names the files; the heading above already does.
  const lines = diff.patch?.split('\n').slice(2) ?? [];
  if (lines.at(-1) === '') lines.pop();
  return (
    <section className="mt-6">
      <h2 className={`${ui.runIn} font-mono`}>
        {diff.path} <span className={ui.badge}>{diff.status}</span>
      </h2>
      {diff.patch === null ? (
        <p className={ui.empty}>Too different to show line by line.</p>
      ) : (
        <pre className="mt-2 overflow-x-auto border border-rule bg-card py-2 font-mono text-[13px] leading-snug">
          {lines.map((line, index) => (
            <div key={index} className={`px-3 whitespace-pre-wrap ${lineClass(line)}`}>
              {line || ' '}
            </div>
          ))}
        </pre>
      )}
    </section>
  );
}

export default async function DiffPage({ params, searchParams }: Props) {
  const oid = first((await searchParams).oid) ?? '';
  const found = await toolPage('diff', params, `oid=${encodeURIComponent(oid)}`);
  const commit = await findCommit(getDb(), found.page.id, oid);
  if (!commit) notFound();
  const [diffs, handles, names] = await Promise.all([
    diffCommits(found.page.id, commit.parent, oid),
    handlesOf([commit.authorId]),
    claimNames([commit.authorId]),
  ]);
  if (!diffs) notFound();
  const handle = handles.get(commit.authorId);
  const authorName = names.get(commit.authorId);
  return (
    <main className={ui.page}>
      <ToolHeader page={found} tool="diff" title={commit.summary} />
      <p className="mt-3 font-sans text-sm">
        {authorName ? (
          <>
            {authorName}
            <span className={ui.badge}>author</span>
          </>
        ) : handle ? (
          `@${handle}`
        ) : (
          <i className="text-muted">potentialpaper</i>
        )}{' '}
        · <span className={ui.mono}>{commit.at.toISOString().slice(0, 16).replace('T', ' ')} UTC</span> ·{' '}
        <span className={ui.mono}>{oid.slice(0, 12)}</span>
        {commit.kind !== 'edit' && <span className={ui.badge}>{commit.kind}</span>}
        {commit.reverts && (
          <>
            {' '}
            · reverts{' '}
            <a href={toolPath('diff', found.address, `oid=${commit.reverts}`)}>{commit.reverts.slice(0, 12)}</a>
          </>
        )}
        {commit.parent && (
          <>
            {' '}
            · <RevertButton page={found.ref} oid={oid} historyPath={toolPath('history', found.address)} />
          </>
        )}
      </p>
      {commit.evidence && commit.evidence.length > 0 && (
        <div className="mt-3 font-sans text-sm">
          <h2 className={ui.runIn}>Evidence</h2>
          <ul className="mt-1 list-disc pl-5">
            {commit.evidence.map((url) => (
              <li key={url}>
                <a href={url} rel="noopener nofollow" className={ui.hyperref}>
                  {url}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
      {diffs.length === 0 ? (
        <p className={ui.empty}>This commit changed no files.</p>
      ) : (
        diffs.map((d) => <Patch key={d.path} diff={d} />)
      )}
    </main>
  );
}
