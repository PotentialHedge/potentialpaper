import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { NewCategoryForm } from '@/components/categories/NewCategoryForm';
import { ui } from '@/components/ui';
import { authHref } from '@/lib/return-to';
import { viewerFromHeaders } from '@/server/auth';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'New category · PotentialPaper', robots: { index: false, follow: false } };

type Props = { searchParams: Promise<{ name?: string | string[] }> };

/**
 * Making a category (`handoffs/pages.md` Phase 5): a research idea that works as a Wikipedia category, with an article
 * the community then writes. Anyone verified may; the form lists categories with names like the one typed, so duplicates stay few.
 */
export default async function NewCategoryPage({ searchParams }: Props) {
  const { name } = await searchParams;
  const initialName = (Array.isArray(name) ? name[0] : name)?.slice(0, 120) ?? '';
  const viewer = await viewerFromHeaders(await headers());
  if (!viewer)
    redirect(authHref('/signin', `/new/category${initialName ? `?name=${encodeURIComponent(initialName)}` : ''}`));
  return (
    <main className={ui.page}>
      <h1 className="mt-6 text-[26px] leading-tight font-normal">New category</h1>
      <div className="mt-5 max-w-[640px] font-sans text-sm">
        <p>
          A category is a research idea, such as &ldquo;Linear attention&rdquo; or &ldquo;Mixture of experts&rdquo;. It
          works like a Wikipedia category: pages are added to it from the bar at the foot of each page, a category too,
          which makes it a subcategory. Its page lists them, under an article anyone verified writes.
        </p>
        {viewer.account.verifiedAt !== null || viewer.isAdmin ? (
          <NewCategoryForm initialName={initialName} />
        ) : (
          <p className="mt-4">
            Making a category needs a confirmed institutional address. <a href="/profile#affiliations">Add one</a>.
          </p>
        )}
      </div>
    </main>
  );
}
