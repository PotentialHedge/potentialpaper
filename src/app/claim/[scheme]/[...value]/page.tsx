import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { InfoTip } from '@/components/InfoTip';
import { ToolHeader, toolPage, type ToolPage, type ToolParams } from '@/components/pages/page-tools';
import { ui } from '@/components/ui';
import { getDb } from '@/db';
import { formatIdentifier, KINDS } from '@/lib/kinds';
import { toolPath } from '@/lib/page-tools';
import { authHref } from '@/lib/return-to';
import { viewerFromHeaders } from '@/server/auth';
import { canStepDown, confirmedAuthors, ownAddressesOnPaper, ownClaim } from '@/server/claims';
import { orgDomains, isOrgMember } from '@/server/org-roles';
import { paperAddresses } from '@/server/claim-requests';
import { ownPageClaim } from '@/server/page-claims';
import { siteUrl } from '@/server/site';
import { underReview } from '@/server/under-review';
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
 * domains. A person's page is its account's, and a category has no owners, so neither is claimed.
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
  const [mine, confirmed, addresses, printed, hidden] = await Promise.all([
    ownClaim(paperId, viewer.account.id),
    confirmedAuthors(paperId),
    ownAddressesOnPaper(paperId, viewer.account.id),
    paperAddresses(paperId),
    underReview(paperId),
  ]);
  const title = found.paper?.paper.title ?? found.name;
  return (
    <main className={ui.page}>
      <header className="mt-6">
        <h1 className="text-[26px] leading-tight font-normal">
          Claim{' '}
          <a
            href={found.path}
            className="text-ink underline decoration-rule-strong underline-offset-4 hover:decoration-ink"
          >
            {title}
          </a>
        </h1>
      </header>
      <div className="mt-4 max-w-[640px] font-sans text-sm">
        <p className="text-subtle">
          {hidden
            ? 'This paper is under review, so its authors are hidden here.'
            : confirmed.length > 0
              ? `Claimed by ${confirmed.map((c) => c.authorName).join(', ')}.`
              : 'Nobody has claimed it yet.'}
          <InfoTip>
            Confirmed authors write the paper&apos;s author section and choose its picture and links. On it you appear
            under the name printed on the paper, never your handle.
            {hidden &&
              ' While it is under review, nothing shows who claimed it, and only an author whose address is printed on it can claim it.'}
          </InfoTip>
        </p>
        {!verified ? (
          <NotVerified />
        ) : mine?.status === 'confirmed' ? (
          <div className="mt-4">
            <p>
              You are its author {mine.authorName}
              {mine.method === 'email' && addresses.onPaper.length > 0 && `, by ${addresses.onPaper.join(' and ')}`}
              {mine.method === 'vouch' && ', confirmed by a co-author'}.{' '}
              <a href={toolPath('code', found.address)}>Write the author section</a> or{' '}
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
          <ClaimForm
            paper={id}
            title={title}
            authors={found.paper?.paper.authors ?? []}
            taken={confirmed.map((c) => c.authorIndex)}
            pending={mine?.status === 'pending' ? mine : null}
            declined={mine?.status === 'declined' ? mine.authorName : null}
            onPaper={addresses.onPaper}
            hidden={hidden}
            printed={printed}
            ownAddresses={addresses.own}
            confirmedNames={hidden ? [] : confirmed.map((c) => c.authorName)}
            inviteUrl={`${siteUrl()}/welcome?next=${encodeURIComponent('/papers')}`}
            devMail={process.env.NODE_ENV !== 'production' && !process.env.RESEND_API_KEY}
          />
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
