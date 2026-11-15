import type { Metadata } from 'next';
import { EditorHost } from '@/components/editor/EditorHost';
import { toolPaper, type ToolParams } from '@/components/paper/page-tools';
import { webEditor } from '@/editors';
import { paperPath } from '@/lib/paper-ids';

export const dynamic = 'force-dynamic';

type Props = { params: ToolParams };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { paper } = await toolPaper('code', params);
  return { title: `Edit ${paper.title} · PotentialPaper`, robots: { index: false, follow: false } };
}

/**
 * A paper's page repo in the web editor (`src/editors`), with a preview of what is being written. The same
 * repo as `git clone` gives; commits go through the workspace API, which holds them to the same rules.
 */
export default async function CodePage({ params }: Props) {
  const { canonical } = await toolPaper('code', params);
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
