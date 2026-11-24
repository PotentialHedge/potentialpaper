import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { ClaimSuggestions } from '@/components/ClaimSuggestions';
import { ui } from '@/components/ui';
import { authHref } from '@/lib/return-to';
import { viewerFromHeaders } from '@/server/auth';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Claim your papers · potentialpaper', robots: { index: false } };

/** Finding the papers one wrote, to claim them (`server/claim-requests.ts`'s `claimSuggestions`). */
export default async function ClaimIndex() {
  const viewer = await viewerFromHeaders(await headers());
  if (!viewer) redirect(authHref('/signin', '/claim'));
  return (
    <main className={ui.page}>
      <div className="mx-auto max-w-[720px]">
        <h1 className="mt-6 text-[26px] leading-tight font-normal">Claim your papers</h1>
        <p className="mt-2 mb-4 font-sans text-sm text-subtle">
          Papers with your address on them come first, then papers with a name you have claimed under. If your address
          is on a paper you can claim it right here; otherwise a co-author confirms you.
        </p>
        <ClaimSuggestions autoFocus />
      </div>
    </main>
  );
}
