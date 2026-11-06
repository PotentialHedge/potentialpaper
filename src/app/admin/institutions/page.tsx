import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { ui } from '@/components/ui';
import { viewerFromHeaders } from '@/server/auth';
import { pendingByDomain } from '@/server/institution-requests';
import { Queue } from './Queue';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Institution requests · PotentialPaper' };

/** The admin queue for institution requests. Not found for everyone else: nothing here is theirs to know of. */
export default async function InstitutionQueue() {
  const viewer = await viewerFromHeaders(await headers());
  if (!viewer?.isAdmin) notFound();
  const queue = await pendingByDomain();
  return (
    <main className={ui.page}>
      <h1 className="mt-6 text-[26px] font-normal">Institution requests</h1>
      <p className={`${ui.fine} mb-4 font-sans`}>
        Only approve a domain whose mailboxes the organization gives to its own staff or students: never a consumer mail
        service, ISP or hosting domain. Approving also admits its subdomains.
      </p>
      <Queue
        initial={queue.map((entry) => ({
          domain: entry.domain,
          requests: entry.requests.map((r) => ({
            id: r.id,
            institutionName: r.institutionName,
            website: r.website,
            note: r.note,
            createdAt: r.createdAt.toISOString().slice(0, 10),
          })),
        }))}
      />
    </main>
  );
}
