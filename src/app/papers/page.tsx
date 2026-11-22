import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ui } from '@/components/ui';
import { authHref, VERIFY_EMAIL } from '@/lib/return-to';
import { viewerFromHeaders } from '@/server/auth';
import { followedPapers } from '@/server/follows';
import { authoredPapers } from '@/server/my-papers';
import { AuthoredPapers } from './AuthoredPapers';
import { FollowingPapers } from './FollowingPapers';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'My papers · PotentialPaper', robots: { index: false, follow: false } };

/**
 * The viewer's papers, one section per way a paper is theirs: the ones they are an author of, or have claimed, and
 * the ones they follow. A confirmed author adds co-authors here (`server/claims.ts`, `addCoAuthor`), and anyone
 * unfollows a paper (`server/follows.ts`). Another tie to a paper is another section and another table.
 */
export default async function MyPapers() {
  const viewer = await viewerFromHeaders(await headers());
  if (!viewer) redirect(authHref('/signin', '/papers'));
  const { account } = viewer;
  if (!account.profileCompletedAt) redirect(authHref(VERIFY_EMAIL, '/papers'));
  const [authored, following] = await Promise.all([authoredPapers(account.id), followedPapers(account.id)]);
  const canVouch = account.verifiedAt !== null && !account.isBot;
  return (
    <main className={ui.page}>
      <h1 className="mt-6 text-[26px] font-normal">My papers</h1>
      <h2 className={ui.groupHeading} id="authored">
        Authored
      </h2>
      {authored.length === 0 ? (
        <p className="font-sans text-sm text-subtle">
          You aren&apos;t an author of any paper here yet. <Link href="/claim">Claim your papers</Link>.
        </p>
      ) : (
        <>
          <AuthoredPapers
            n={1}
            canVouch={canVouch}
            initial={authored.map(({ waiting, ...row }) => ({
              ...row,
              waiting: waiting.map((w) => ({ ...w, createdAt: w.createdAt.toISOString() })),
            }))}
          />
          <p className={`${ui.fine} font-sans`}>
            <Link href="/claim">Claim more of your papers</Link>
          </p>
        </>
      )}
      <h2 className={ui.groupHeading} id="following">
        Following
      </h2>
      {following.length === 0 ? (
        <p className="font-sans text-sm text-subtle">
          You don&apos;t follow any paper yet. Follow one with the star under its title to get an email when its page is
          edited or someone comments on it. You follow papers you are a confirmed author of from the start.
        </p>
      ) : (
        <FollowingPapers
          n={authored.length === 0 ? 1 : 2}
          initial={following.map(({ followedAt, ...row }) => ({ ...row, followedAt: followedAt.toISOString() }))}
        />
      )}
    </main>
  );
}
