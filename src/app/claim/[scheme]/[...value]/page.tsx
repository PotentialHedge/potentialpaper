import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { ToolHeader, toolPaper, toolPath, type ToolParams } from '@/components/paper/page-tools';
import { ui } from '@/components/ui';
import { paperPath } from '@/lib/paper-ids';
import { authHref } from '@/lib/return-to';
import { viewerFromHeaders } from '@/server/auth';
import { confirmedAuthors, ownAddressesOnPaper, ownClaim } from '@/server/claims';
import { ClaimForm } from './ClaimForm';

export const dynamic = 'force-dynamic';

type Props = { params: ToolParams };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { paper } = await toolPaper('claim', params);
  return { title: `Claim ${paper.title} · PotentialPaper`, robots: { index: false, follow: false } };
}

/**
 * Asking to be confirmed as one of a paper's authors (DESIGN.md §6). A claim from an account with a
 * confirmed address on the paper's first page is confirmed at once; any other waits for an admin. The page
 * names only the viewer's own addresses, never the others printed on the PDF.
 */
export default async function ClaimPage({ params }: Props) {
  const found = await toolPaper('claim', params);
  const viewer = await viewerFromHeaders(await headers());
  if (!viewer) redirect(authHref('/signin', toolPath('claim', found.id)));
  const verified = viewer.account.verifiedAt !== null && !viewer.account.isBot;
  const [mine, confirmed, addresses] = await Promise.all([
    ownClaim(found.paper.id, viewer.account.id),
    confirmedAuthors(found.paper.id),
    ownAddressesOnPaper(found.paper.id, viewer.account.id),
  ]);
  const taken = confirmed.map((c) => c.authorIndex);
  return (
    <main className={ui.page}>
      <ToolHeader paper={found} tool="claim" title="Claim this paper" />
      <div className="mt-5 max-w-[640px] font-sans text-sm">
        <p>
          {confirmed.length > 0
            ? `Claimed by ${confirmed.map((c) => c.authorName).join(', ')}.`
            : 'Nobody has claimed this paper yet.'}{' '}
          Its confirmed authors write its author section and choose its picture and links.
        </p>
        <p className={ui.fine}>
          On a paper you&apos;ve claimed you always appear under the name printed on it, never your handle, so nothing
          public ties the two together. What you did here before the claim keeps your handle.
        </p>
        {!verified ? (
          <p className="mt-4">
            Claiming needs a confirmed institutional address.{' '}
            <a href="/profile#affiliations">Add one on your profile</a>.
          </p>
        ) : mine?.status === 'confirmed' ? (
          <p className="mt-4">
            You are a confirmed author of this paper, as {mine.authorName}.{' '}
            <a href={toolPath('edit', found.id, 'part=author')}>Write the author section</a>.
          </p>
        ) : mine?.status === 'rejected' ? (
          <p className="mt-4">Your claim to be {mine.authorName} was not confirmed.</p>
        ) : (
          <>
            {addresses.onPaper.length > 0 ? (
              <p className={`${ui.box} mt-4`}>
                Your address {addresses.onPaper.join(' and ')} is printed on this paper&apos;s first page, so your claim
                is confirmed as soon as you send it.
              </p>
            ) : (
              <p className="mt-4">
                A claim is confirmed at once when one of your confirmed addresses is printed on the paper&apos;s first
                page.{' '}
                {addresses.own.length > 0
                  ? `None of yours (${addresses.own.join(', ')}) is on this one`
                  : 'You have none'}
                {addresses.hasPdfEmails ? '' : ', and as far as we can read it lists no addresses'}. If it lists one you
                own, <a href="/profile#affiliations">add it to your profile</a>; otherwise your claim is checked by
                hand.
              </p>
            )}
            <ClaimForm
              paper={found.canonical}
              pagePath={paperPath(found.id)}
              authors={found.paper.authors}
              taken={taken}
              pending={mine}
              instant={addresses.onPaper.length > 0}
            />
          </>
        )}
      </div>
    </main>
  );
}
