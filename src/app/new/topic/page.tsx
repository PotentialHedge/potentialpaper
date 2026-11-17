import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { NewTopicForm } from '@/components/topics/NewTopicForm';
import { ui } from '@/components/ui';
import { authHref } from '@/lib/return-to';
import { viewerFromHeaders } from '@/server/auth';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'New topic · PotentialPaper', robots: { index: false, follow: false } };

type Props = { searchParams: Promise<{ name?: string | string[] }> };

/**
 * Making a topic (`handoffs/pages.md` Phase 5): a research idea at the size of a Wikipedia article, which the community
 * then writes. Anyone verified may; the form lists topics with names like the one typed, so duplicates stay few.
 */
export default async function NewTopicPage({ searchParams }: Props) {
  const { name } = await searchParams;
  const initialName = (Array.isArray(name) ? name[0] : name)?.slice(0, 120) ?? '';
  const viewer = await viewerFromHeaders(await headers());
  if (!viewer)
    redirect(authHref('/signin', `/new/topic${initialName ? `?name=${encodeURIComponent(initialName)}` : ''}`));
  return (
    <main className={ui.page}>
      <h1 className="mt-6 text-[26px] leading-tight font-normal">New topic</h1>
      <div className="mt-5 max-w-[640px] font-sans text-sm">
        <p>
          A topic is a research idea at the size of a Wikipedia article: &ldquo;Linear attention&rdquo;,
          &ldquo;State-space models&rdquo;, &ldquo;Mixture of experts&rdquo;, not a field such as machine learning. Its
          page is an article anyone verified writes, and the papers on it, which people add from each paper&apos;s page.
        </p>
        {viewer.account.verifiedAt !== null || viewer.isAdmin ? (
          <NewTopicForm initialName={initialName} />
        ) : (
          <p className="mt-4">
            Making a topic needs a confirmed institutional address. <a href="/profile#affiliations">Add one</a>.
          </p>
        )}
      </div>
    </main>
  );
}
