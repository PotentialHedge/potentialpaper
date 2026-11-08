import 'katex/dist/katex.min.css';
import { eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
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
import { getDb } from '@/db';
import { pageCurrent } from '@/db/schema';
import { paperPath } from '@/lib/paper-ids';
import { authHref } from '@/lib/return-to';
import { viewerFromHeaders } from '@/server/auth';
import { claimRoles } from '@/server/claims';
import { editorState, type PagePart } from '@/server/pages/edit';
import { CardEditor } from './CardEditor';
import { SectionEditor } from './SectionEditor';

export const dynamic = 'force-dynamic';

type Props = { params: ToolParams; searchParams: ToolSearchParams };
type Part = PagePart | 'card';

function partOf(value: string | undefined): Part {
  return value === 'author' || value === 'card' ? value : 'community';
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { paper } = await toolPaper('edit', params);
  return { title: `Editing ${paper.title} · PotentialPaper`, robots: { index: false, follow: false } };
}

const PART_TITLE: Record<Part, string> = {
  community: 'Editing the community section',
  author: 'Editing the author section',
  card: "Editing the paper's picture and links",
};

export default async function EditPage({ params, searchParams }: Props) {
  const query = await searchParams;
  const part = partOf(first(query.part));
  const section = Math.max(0, Math.min(1000, Number.parseInt(first(query.section) ?? '0', 10) || 0));
  const here = new URLSearchParams({
    ...(part !== 'community' ? { part } : {}),
    ...(section ? { section: String(section) } : {}),
  }).toString();
  const found = await toolPaper('edit', params, here);
  const viewer = await viewerFromHeaders(await headers());
  if (!viewer) redirect(authHref('/signin', toolPath('edit', found.id, here)));
  const verified = viewer.account.isBot || viewer.account.verifiedAt !== null;
  const roles = await claimRoles(found.paper.id, viewer.account.id);
  const claimPath = toolPath('claim', found.id);

  // Who may write each part (`server/pages/rules.ts`, which the commit enforces): the author section is the
  // confirmed authors'; the picture and links are theirs once claimed, and any verified researcher's until.
  const denied = !verified ? (
    <p className="mt-6">
      Editing needs a confirmed institutional address. <a href="/profile#affiliations">Add one on your profile</a>.
    </p>
  ) : part === 'author' && !roles.confirmedAuthor && !viewer.isAdmin ? (
    <p className="mt-6">
      Only this paper&apos;s confirmed authors can write its author section.{' '}
      <a href={claimPath}>Are you one? Claim the paper</a>. The{' '}
      <a href={toolPath('edit', found.id)}>community section</a> is open to everyone.
    </p>
  ) : part === 'card' && roles.claimed && !roles.confirmedAuthor && !viewer.isAdmin ? (
    <p className="mt-6">
      This paper is claimed, so its authors choose its picture and links. <a href={claimPath}>Also an author?</a>
    </p>
  ) : null;

  const state = !denied && part !== 'card' ? await editorState(found.paper.id, part, section) : null;
  let body: ReactNode = denied;
  if (!denied && part === 'card') {
    const [current] = await getDb()
      .select({ thumbnail: pageCurrent.thumbnail, links: pageCurrent.links })
      .from(pageCurrent)
      .where(eq(pageCurrent.paperId, found.paper.id));
    body = (
      <CardEditor
        paper={found.canonical}
        pagePath={paperPath(found.id)}
        thumbnail={current?.thumbnail ?? null}
        links={current?.links ?? []}
        claimed={roles.claimed}
      />
    );
  } else if (!denied) {
    body = !state ? (
      <p className="mt-6">
        The page has no section {section} any more.{' '}
        <a href={toolPath('edit', found.id, part === 'author' ? 'part=author' : '')}>Edit the whole section</a>.
      </p>
    ) : (
      <SectionEditor
        paper={found.canonical}
        part={state.part}
        pagePath={paperPath(found.id)}
        baseOid={state.baseOid}
        section={state.section}
        initial={state.text}
        starter={state.starter}
      />
    );
  }

  const title = state?.title ? `Editing “${state.title}”` : PART_TITLE[part];
  return (
    <main className={ui.page}>
      <ToolHeader paper={found} tool="edit" title={title} />
      {body}
    </main>
  );
}
