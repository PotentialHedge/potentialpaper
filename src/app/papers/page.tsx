import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ui } from '@/components/ui';
import { authHref, VERIFY_EMAIL } from '@/lib/return-to';
import { viewerFromHeaders } from '@/server/auth';
import { authoredPapers } from '@/server/my-papers';
import { AuthoredPapers } from './AuthoredPapers';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'My papers · PotentialPaper', robots: { index: false, follow: false } };

/**
 * The viewer's papers, one section per way a paper is theirs: for now the ones they are an author of, or have
 * claimed. A confirmed author adds co-authors here (`server/claims.ts`, `addCoAuthor`). Another tie to a paper
 * (following one, say) is another section and another table, numbered after these.
 */
export default async function MyPapers() {
  const viewer = await viewerFromHeaders(await headers());
  if (!viewer) redirect(authHref('/signin', '/papers'));
  const { account } = viewer;
  if (!account.profileCompletedAt) redirect(authHref(VERIFY_EMAIL, '/papers'));
  const authored = await authoredPapers(account.id);
  const canVouch = account.verifiedAt !== null && !account.isBot;
  return (
    <main className={ui.page}>
      <h1 className="mt-6 text-[26px] font-normal">My papers</h1>
      <h2 className={ui.groupHeading} id="authored">
        Authored
      </h2>
      {authored.length === 0 ? (
        <p className="font-sans text-sm text-subtle">
          You aren&apos;t an author of any paper here yet. Find one of yours with the search on the{' '}
          <Link href="/">home page</Link>, and claim it from its page. A claim is confirmed at once when one of your
          confirmed addresses is printed on the paper; adding them on your{' '}
          <Link href="/profile#affiliations">profile</Link> claims those papers for you.
        </p>
      ) : (
        <AuthoredPapers
          n={1}
          canVouch={canVouch}
          initial={authored.map(({ waiting, ...row }) => ({
            ...row,
            waiting: waiting.map((w) => ({ ...w, createdAt: w.createdAt.toISOString() })),
          }))}
        />
      )}
    </main>
  );
}
