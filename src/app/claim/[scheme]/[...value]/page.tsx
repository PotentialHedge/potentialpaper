import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { ToolHeader, toolPage, type ToolPage, type ToolParams } from '@/components/pages/page-tools';
import { ui } from '@/components/ui';
import { getDb } from '@/db';
import { formatIdentifier, KINDS } from '@/lib/kinds';
import { toolPath } from '@/lib/page-tools';
import { authHref } from '@/lib/return-to';
import { viewerFromHeaders } from '@/server/auth';
import { canStepDown, confirmedAuthors, ownAddressesOnPaper, ownClaim } from '@/server/claims';
import { orgDomains, isOrgMember } from '@/server/org-roles';
import { ownPageClaim } from '@/server/page-claims';
import { ClaimForm, StepDown } from './ClaimForm';
import { OrganiserClaimForm } from './OrganiserClaimForm';

export const dynamic = 'force-dynamic';

type Props = { params: ToolParams };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { name } = await toolPage('claim', params);
  return { title: `Claim ${name} · PotentialPaper`, robots: { index: false, follow: false } };
}

/**
 * Becoming one of a page's owners, who write its `owners/` (`lib/kinds.ts`, `KINDS[kind].owners.claim`): a paper's
 * authors claim it, a venue's organisers ask an admin, an org's members are whoever has a confirmed address at its
 * domains. A person's page is its account's, and a topic has no owners, so neither is claimed.
 */
export default async function ClaimPage({ params }: Props) {
  const found = await toolPage('claim', params);
  const claim = KINDS[found.address.kind].owners?.claim;
  if (claim !== 'authors' && claim !== 'organisers' && claim !== 'domain') notFound();
  const viewer = await viewerFromHeaders(await headers());
  if (!viewer) redirect(authHref('/signin', toolPath('claim', found.address)));
  const verified = viewer.account.verifiedAt !== null && !viewer.account.isBot;
  if (claim === 'organisers') return <OrganiserClaim found={found} viewer={viewer} verified={verified} />;
  if (claim === 'domain') return <MemberClaim found={found} viewer={viewer} verified={verified} />;
  if (found.address.kind !== 'paper') notFound();
  const id = found.address.id;
  const paperId = found.page.id;
  const [mine, confirmed, addresses] = await Promise.all([
    ownClaim(paperId, viewer.account.id),
    confirmedAuthors(paperId),
    ownAddressesOnPaper(paperId, viewer.account.id),
  ]);
  const taken = confirmed.map((c) => c.authorIndex);
  const editPath = toolPath('code', found.address);
  return (
    <main className={ui.page}>
      <ToolHeader page={found} tool="claim" title="Claim this paper" />
      <div className="mt-5 max-w-[640px] font-sans text-sm">
        <p>
          {confirmed.length > 0
            ? `Claimed by ${confirmed.map((c) => c.authorName).join(', ')}.`
            : 'Nobody has claimed this paper yet.'}{' '}
          Its confirmed authors write its authors&apos; sections and choose its picture and links.
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
          <div className="mt-4">
            <p>
              You are a confirmed author of this paper, as {mine.authorName}
              {mine.method === 'email' &&
                (addresses.onPaper.length > 0
                  ? `, because your address ${addresses.onPaper.join(' and ')} is printed on its first page`
                  : ', from an address of yours printed on its first page')}
              {mine.method === 'vouch' && ', added by a co-author'}.{' '}
              <a href={editPath}>Write the authors&apos; sections</a> (in <code>owners/</code>), or{' '}
              <a href="/papers">add your co-authors</a>.
            </p>
            {canStepDown(mine) && (
              <p className={ui.fine}>
                <StepDown paper={id} />
              </p>
            )}
          </div>
        ) : mine?.status === 'rejected' ? (
          <p className="mt-4">Your claim to be {mine.authorName} was not confirmed.</p>
        ) : (
          <>
            {mine?.status === 'declined' && (
              <p className="mt-4">You stepped down as {mine.authorName}. You can claim the paper again below.</p>
            )}
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
              paper={id}
              pagePath={found.path}
              authors={found.paper?.paper.authors ?? []}
              taken={taken}
              pending={mine?.status === 'pending' ? mine : null}
              instant={addresses.onPaper.length > 0}
            />
          </>
        )}
      </div>
    </main>
  );
}

type ClaimProps = {
  found: ToolPage;
  viewer: NonNullable<Awaited<ReturnType<typeof viewerFromHeaders>>>;
  verified: boolean;
};

function NotVerified() {
  return (
    <p className="mt-4">
      Claiming needs a confirmed institutional address. <a href="/profile#affiliations">Add one on your profile</a>.
    </p>
  );
}

/**
 * Asking to be confirmed as one of a venue's organisers (`page-claims.ts`): an admin reads the evidence and decides.
 * A series' organisers also organise its editions.
 */
async function OrganiserClaim({ found, viewer, verified }: ClaimProps) {
  const mine = await ownPageClaim(found.page, viewer.account.id);
  const identifier = formatIdentifier(found.address);
  const series = found.address.kind === 'venue' && !found.address.key.includes('/');
  return (
    <main className={ui.page}>
      <ToolHeader page={found} tool="claim" title="Organise this venue" />
      <div className="mt-5 max-w-[640px] font-sans text-sm">
        <p>
          Its confirmed organisers write its organisers&apos; sections and keep its <code>venue.json</code>.
          {series && ' Organisers of a series also organise each of its editions.'}
        </p>
        {!verified ? (
          <NotVerified />
        ) : mine?.status === 'confirmed' ? (
          <div className="mt-4">
            <p>
              You are a confirmed organiser{mine.inherited && ', as an organiser of its series'}.{' '}
              <a href={toolPath('code', found.address)}>Write the organisers&apos; sections</a> (in <code>owners/</code>
              ).
            </p>
            {!mine.inherited && <OrganiserClaimForm identifier={identifier} pagePath={found.path} state="confirmed" />}
          </div>
        ) : mine?.status === 'rejected' ? (
          <p className="mt-4">Your claim to organise it was not confirmed.</p>
        ) : (
          <OrganiserClaimForm
            identifier={identifier}
            pagePath={found.path}
            state={mine?.status === 'pending' ? 'pending' : 'none'}
            evidence={mine?.evidence ?? ''}
          />
        )}
      </div>
    </main>
  );
}

/** An organisation's members are whoever has a confirmed address at its domains (`org-roles.ts`): nothing to ask. */
async function MemberClaim({ found, viewer, verified }: ClaimProps) {
  const [member, domains] = await Promise.all([
    verified ? isOrgMember(getDb(), found.page, viewer.account.id) : Promise.resolve(false),
    orgDomains(getDb(), found.page),
  ]);
  return (
    <main className={ui.page}>
      <ToolHeader page={found} tool="claim" title="Members" />
      <div className="mt-5 max-w-[640px] font-sans text-sm">
        <p>
          {domains.length > 0
            ? `Everyone with a confirmed address at ${domains.join(', ')} is a member.`
            : 'It has no email domains yet, so it has no members.'}{' '}
          Members write its members&apos; sections and keep its <code>org.json</code>.
        </p>
        {member ? (
          <p className="mt-4">
            You are a member. <a href={toolPath('code', found.address)}>Write the members&apos; sections</a> (in{' '}
            <code>owners/</code>).
          </p>
        ) : !verified ? (
          <NotVerified />
        ) : (
          domains.length > 0 && (
            <p className="mt-4">
              <a href="/profile#affiliations">Add an address at one of them</a> to your profile.
            </p>
          )
        )}
      </div>
    </main>
  );
}
