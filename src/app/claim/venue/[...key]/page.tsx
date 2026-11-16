import { eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { ui } from '@/components/ui';
import { getDb } from '@/db';
import { pageCurrent } from '@/db/schema';
import { formatIdentifier, keyedPagePath, keyProblem, pageName } from '@/lib/kinds';
import { authHref } from '@/lib/return-to';
import { viewerFromHeaders } from '@/server/auth';
import { ownPageClaim } from '@/server/page-claims';
import { findKeyedPage } from '@/server/pages/kinds';
import { OrganiserClaimForm } from './OrganiserClaimForm';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ key: string[] }> };

async function load(params: Props['params']) {
  const key = (await params).key.map(decodeURIComponent).join('/');
  if (keyProblem('venue', key)) notFound();
  const page = await findKeyedPage(getDb(), 'venue', key);
  if (!page) notFound();
  const [current] = await getDb()
    .select({ name: pageCurrent.name })
    .from(pageCurrent)
    .where(eq(pageCurrent.pageId, page.id));
  return { page, key, name: current?.name ?? pageName('venue', key, null) };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { name } = await load(params);
  return { title: `Organise ${name} · PotentialPaper`, robots: { index: false, follow: false } };
}

/**
 * Asking to be confirmed as one of a venue's organisers (`handoffs/pages.md` Phase 2), the author claim flow with the
 * venue as what is claimed. An admin reads the evidence and decides (`npm run claims:decide`). Confirmed organisers
 * write the venue's `organizers/` and its `venue.json`; a series' organisers also organise its editions.
 */
export default async function OrganiserClaimPage({ params }: Props) {
  const { page, key, name } = await load(params);
  const path = keyedPagePath('venue', key);
  const viewer = await viewerFromHeaders(await headers());
  if (!viewer) redirect(authHref('/signin', `/claim/venue/${key}`));
  const verified = viewer.account.verifiedAt !== null && !viewer.account.isBot;
  const mine = await ownPageClaim(page, viewer.account.id);
  const identifier = formatIdentifier({ kind: 'venue', key });
  return (
    <main className={ui.page}>
      <p className={`${ui.fine} mt-6 font-sans`}>
        <a href={path}>{name}</a>
      </p>
      <h1 className="mt-1 text-[26px] leading-tight font-normal">Organise {name}</h1>
      <div className="mt-5 max-w-[640px] font-sans text-sm">
        <p>
          A venue&apos;s confirmed organisers write its organisers&apos; section and keep its <code>venue.json</code>{' '}
          (name, dates, site, where its submissions come from). Anyone with a confirmed address writes its community
          section.
          {!key.includes('/') && ' Organisers of a series also organise each of its editions.'}
        </p>
        {!verified ? (
          <p className="mt-4">
            Claiming needs a confirmed institutional address.{' '}
            <a href="/profile#affiliations">Add one on your profile</a>.
          </p>
        ) : mine?.status === 'confirmed' ? (
          <div className="mt-4">
            <p>
              You are a confirmed organiser of {name}
              {mine.inherited && ', as an organiser of its series'}. Write the organisers&apos; section in{' '}
              <code>organizers/</code>: clone the page with git and push.
            </p>
            {!mine.inherited && <OrganiserClaimForm identifier={identifier} pagePath={path} state="confirmed" />}
          </div>
        ) : mine?.status === 'rejected' ? (
          <p className="mt-4">Your claim to organise {name} was not confirmed.</p>
        ) : (
          <OrganiserClaimForm
            identifier={identifier}
            pagePath={path}
            state={mine?.status === 'pending' ? 'pending' : 'none'}
            evidence={mine?.evidence ?? ''}
          />
        )}
      </div>
    </main>
  );
}
