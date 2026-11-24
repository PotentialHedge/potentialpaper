'use client';

import { type ReactNode, useEffect, useState } from 'react';
import { ui } from '@/components/ui';

/**
 * The invitation to claim a page, or, once the viewer has a claim waiting, that it is waiting. The page is the same
 * cached HTML for everyone, so the viewer's own claim (`GET /claims` on a paper, `GET /pages/{identifier}/claim` on a
 * venue) is asked for here, after load; signed out or with no claim, the invitation stays.
 */
export function OwnClaimStatus({
  claimUrl,
  claimPath,
  children,
}: {
  /** The API route answering with the viewer's own claim; none where nothing is asked for (an org's members). */
  claimUrl: string | null;
  claimPath: string;
  children: ReactNode;
}) {
  const [waiting, setWaiting] = useState<{ as: string | null } | null>(null);

  useEffect(() => {
    if (!claimUrl) return;
    let live = true;
    fetch(claimUrl, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { claim: { status: string; authorName?: string } | null } | null) => {
        if (live && body?.claim?.status === 'pending') setWaiting({ as: body.claim.authorName ?? null });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [claimUrl]);

  if (!waiting) return children;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border border-frame bg-card px-4 py-3 font-sans text-[13px]">
      <p className="min-w-0 flex-1 basis-64 text-muted">
        <strong className="text-ink">Your claim is waiting.</strong>{' '}
        {waiting.as ? `You asked to be confirmed as ${waiting.as}.` : 'You asked to be confirmed as an organiser.'}
      </p>
      <a href={claimPath} rel="nofollow" className={ui.btn({ ghost: true, inline: true, flush: true })}>
        See your claim
      </a>
    </div>
  );
}
