import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { EditorHost } from '@/components/editor/EditorHost';
import { first, toolPage, type ToolParams, type ToolSearchParams } from '@/components/pages/page-tools';
import { webEditor } from '@/editors';
import { toolPath } from '@/lib/page-tools';
import { authHref } from '@/lib/return-to';
import { viewerFromHeaders } from '@/server/auth';

export const dynamic = 'force-dynamic';

type Props = { params: ToolParams; searchParams: ToolSearchParams };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { name } = await toolPage('code', params);
  return { title: `Edit ${name} · potentialpaper`, robots: { index: false, follow: false } };
}

/**
 * A page's repo, of any kind, in the web editor (`src/editors`), with a preview of what is being written. The same
 * repo as `git clone` gives; commits go through the workspace API, which holds them to the same rules. Only for
 * someone signed in: anyone else is sent to sign in, and back.
 */
export default async function CodePage({ params, searchParams }: Props) {
  // `?file=` opens that file once the editor has loaded (the Repo tab's links to a file).
  const file = first((await searchParams).file)?.slice(0, 500) || undefined;
  const query = file ? `file=${encodeURIComponent(file)}` : '';
  const { address, ref, path } = await toolPage('code', params, query);
  // Editing needs an account, so someone signed out is asked to sign in first and comes back here.
  if (!(await viewerFromHeaders(await headers()))) redirect(authHref('/signin', toolPath('code', address, query)));
  return (
    <main className="flex h-[calc(100dvh-3.5rem)] flex-col">
      <EditorHost
        page={ref}
        frameSrc={webEditor.frameSrc(ref)}
        editorName={webEditor.name}
        pagePath={path}
        openPath={file}
      />
    </main>
  );
}
