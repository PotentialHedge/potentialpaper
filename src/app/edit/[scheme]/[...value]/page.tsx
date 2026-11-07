import 'katex/dist/katex.min.css';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  first,
  ToolHeader,
  toolPaper,
  toolPath,
  type ToolParams,
  type ToolSearchParams,
} from '@/components/paper/page-tools';
import { ui } from '@/components/ui';
import { paperPath } from '@/lib/paper-ids';
import { authHref } from '@/lib/return-to';
import { viewerFromHeaders } from '@/server/auth';
import { editorState } from '@/server/pages/edit';
import { SectionEditor } from './SectionEditor';

export const dynamic = 'force-dynamic';

type Props = { params: ToolParams; searchParams: ToolSearchParams };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { paper } = await toolPaper('edit', params);
  return { title: `Editing ${paper.title} · PotentialPaper`, robots: { index: false, follow: false } };
}

export default async function EditPage({ params, searchParams }: Props) {
  const query = await searchParams;
  const section = Math.max(0, Math.min(1000, Number.parseInt(first(query.section) ?? '0', 10) || 0));
  const here = section ? `section=${section}` : '';
  const found = await toolPaper('edit', params, here);
  const viewer = await viewerFromHeaders(await headers());
  if (!viewer) redirect(authHref('/signin', toolPath('edit', found.id, here)));
  const verified = viewer.account.isBot || viewer.account.verifiedAt !== null;
  const state = verified ? await editorState(found.paper.id, section) : null;
  const title = state?.title ? `Editing “${state.title}”` : 'Editing the community section';
  return (
    <main className={ui.page}>
      <ToolHeader paper={found} tool="edit" title={title} />
      {!verified ? (
        <p className="mt-6">
          Editing needs a confirmed institutional address. <a href="/profile#affiliations">Add one on your profile</a>.
        </p>
      ) : !state ? (
        <p className="mt-6">
          The page has no section {section} any more.{' '}
          <a href={toolPath('edit', found.id)}>Edit the whole community section</a>.
        </p>
      ) : (
        <SectionEditor
          paper={found.canonical}
          pagePath={paperPath(found.id)}
          baseOid={state.baseOid}
          section={state.section}
          initial={state.text}
          starter={state.starter}
        />
      )}
    </main>
  );
}
