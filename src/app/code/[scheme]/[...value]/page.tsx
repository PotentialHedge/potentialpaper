import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { EditorHost } from '@/components/editor/EditorHost';
import { toolPaper, toolPath, type ToolParams } from '@/components/paper/page-tools';
import { webEditor } from '@/editors';
import { paperPath } from '@/lib/paper-ids';
import { authHref } from '@/lib/return-to';
import { viewerFromHeaders } from '@/server/auth';

export const dynamic = 'force-dynamic';

type Props = { params: ToolParams };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { paper } = await toolPaper('code', params);
  return { title: `Edit ${paper.title} · PotentialPaper`, robots: { index: false, follow: false } };
}

/**
 * A paper's page repo in the web editor (`src/editors`), with a preview of what is being written. The same
 * repo as `git clone` gives; commits go through the workspace API, which holds them to the same rules. Only for
 * someone signed in: anyone else is sent to sign in, and back.
 */
export default async function CodePage({ params }: Props) {
  const { canonical } = await toolPaper('code', params);
  // Editing needs an account, so someone signed out is asked to sign in first and comes back here.
  if (!(await viewerFromHeaders(await headers()))) redirect(authHref('/signin', toolPath('code', canonical)));
  return (
    <main className="flex h-[calc(100dvh-3.5rem)] flex-col">
      <EditorHost
        paper={canonical}
        frameSrc={webEditor.frameSrc(canonical)}
        editorName={webEditor.name}
        pagePath={paperPath(canonical)}
      />
    </main>
  );
}
