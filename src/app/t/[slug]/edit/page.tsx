import { eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { TopicEditor } from '@/components/topics/TopicEditor';
import { ui } from '@/components/ui';
import { getDb } from '@/db';
import { pageCurrent } from '@/db/schema';
import { keyedPagePath, keyProblem, type TopicFile } from '@/lib/kinds';
import { authHref } from '@/lib/return-to';
import { viewerFromHeaders } from '@/server/auth';
import { protectionOf, protectionWords } from '@/server/page-protection';
import { findPage } from '@/server/pages/kinds';
import { readCommit, readFiles, readHead } from '@/server/pages/repo';
import { joinSections, readSections } from '@/server/pages/sections';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ slug: string }> };

async function load(params: Props['params']) {
  const slug = decodeURIComponent((await params).slug);
  if (keyProblem('topic', slug)) notFound();
  const page = await findPage(`topic:${slug}`);
  if (!page || page.kind !== 'topic') notFound();
  // An old slug, or a topic merged into another: edit the page it leads to.
  if (page.key !== slug) redirect(`${keyedPagePath('topic', page.key)}/edit`);
  const db = getDb();
  const head = await readHead(db, page.id);
  const files = head ? await readFiles(db, page.id, (await readCommit(db, page.id, head)).tree) : new Map();
  const [current] = await db
    .select({ kindFile: pageCurrent.kindFile, name: pageCurrent.name })
    .from(pageCurrent)
    .where(eq(pageCurrent.pageId, page.id));
  const file = (current?.kindFile ?? null) as TopicFile | null;
  return {
    page,
    head,
    name: current?.name ?? file?.name ?? page.key,
    file,
    article: joinSections(await readSections(db, page.id, files, 'community')),
    protection: await protectionOf(db, page.id),
  };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { name } = await load(params);
  return { title: `Edit ${name} · Topic · PotentialPaper`, robots: { index: false, follow: false } };
}

/**
 * Editing a topic (`handoffs/pages.md` Phase 5): its name and its article, in one commit; renaming it (a new address, with a redirect from the old) and merging it into another. Open to anyone
 * verified, as a Wikipedia article is, within the page's protection; every change shows in `/changes`. The same files
 * can be pushed with git.
 */
export default async function EditTopicPage({ params }: Props) {
  const loaded = await load(params);
  const { page, head, name, file, article, protection } = loaded;
  const path = keyedPagePath('topic', page.key);
  const viewer = await viewerFromHeaders(await headers());
  if (!viewer) redirect(authHref('/signin', `${path}/edit`));
  const verified = viewer.account.verifiedAt !== null || viewer.isAdmin;
  return (
    <main className={ui.page}>
      <p className={`${ui.fine} mt-6 font-sans`}>
        <a href={path}>{name}</a> · <a href={`/changes?kind=topic`}>Recent changes to topics</a>
      </p>
      <h1 className="mt-1 text-[26px] leading-tight font-normal">Edit {name}</h1>
      {protection && (
        <p className={`${ui.note(false)} font-sans`}>
          This topic is protected: {protectionWords(protection.level)}
          {protection.reason ? ` (${protection.reason})` : ''}.
        </p>
      )}
      {verified ? (
        <TopicEditor
          identifier={`topic:${page.key}`}
          slug={page.key}
          base={head}
          initial={{
            name: file?.name ?? name,
            article: article || TEMPLATE,
          }}
        />
      ) : (
        <p className="mt-4 font-sans text-sm">
          Editing a topic needs a confirmed institutional address. <a href="/profile#affiliations">Add one</a>.
        </p>
      )}
    </main>
  );
}

/** Where an empty article starts: the sections the plan names, to be written or deleted. */
const TEMPLATE = `# What it is

# Key ideas

# History

# Open problems
`;
