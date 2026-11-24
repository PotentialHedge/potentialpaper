import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AbstractText } from '@/components/AbstractText';
import { SignOut } from '@/components/SignOut';
import { ui } from '@/components/ui';
import { keyedPagePath } from '@/lib/kinds';
import { shownHandle } from '@/lib/profile';
import { authHref, VERIFY_EMAIL } from '@/lib/return-to';
import { listAffiliations } from '@/server/affiliations';
import { otherAddresses } from '@/server/claim-addresses';
import { claimedNames } from '@/server/claim-requests';
import { viewerFromHeaders } from '@/server/auth';
import { gitSshUrl } from '@/server/site';
import { listSshKeys } from '@/server/ssh-keys';
import { listTokens } from '@/server/tokens';
import { ApiKeys } from './ApiKeys';
import { Affiliations } from './Affiliations';
import { MailSettings } from './MailSettings';
import { ProfileLinksLine } from '@/components/ProfileLinksLine';
import { EditProfile } from './ProfileForm';
import { SshKeys } from './SshKeys';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Profile · potentialpaper' };

const BUTTON = ui.btn({ ghost: true, inline: true, flush: true });

/**
 * The signed-in person's own account, opening as acceptodds' does: who they are set as a paper's title block (their
 * name, then `@handle` and institutions as its author line, their bio as its abstract), with their public page, the
 * profile editor and their page's settings beside it. Then what only they see: addresses, email, keys.
 */
export default async function Profile() {
  const viewer = await viewerFromHeaders(await headers());
  if (!viewer) redirect(authHref('/signin', '/profile'));
  const { account } = viewer;
  if (!account.profileCompletedAt) redirect(authHref(VERIFY_EMAIL, '/profile'));
  const [rows, others, names, tokens, keys] = await Promise.all([
    listAffiliations(account.id),
    otherAddresses(account.id),
    claimedNames(account.id),
    listTokens(account.id),
    listSshKeys(account.id),
  ]);
  const handle = `@${shownHandle(account.handle, account.isBot)}`;
  return (
    <main className={ui.page}>
      <header className="text-center">
        <h1 className="mt-6 text-[26px] leading-tight font-normal">{account.realName ?? handle}</h1>
        <p className="mt-4">
          {account.realName && handle}
          {account.institutions.map((name, i) => (
            <span key={name}>
              {i === 0 ? (account.realName ? ', ' : '') : '; '}
              <i>{name}</i>
            </span>
          ))}
        </p>
        <ProfileLinksLine links={account} className="mt-2.5" />
        <p className="mt-2.5 font-mono text-xs text-faint">{viewer.email}</p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <a href={keyedPagePath('user', account.handle)} className={BUTTON} title="Your page as everyone sees it">
            view public page
          </a>
          <EditProfile
            className={BUTTON}
            initial={{
              handle: account.handle,
              realName: account.realName ?? '',
              bio: account.bio ?? '',
              homepage: account.homepage ?? '',
              orcid: account.orcid ?? '',
              scholar: account.scholar ?? '',
              showInstitution: account.showInstitution,
            }}
            institutions={account.institutions}
          />
          <Link href="/settings/public-page" className={BUTTON} title="What your public page shows">
            settings
          </Link>
        </div>
      </header>
      <div className="mx-auto mt-8 max-w-[720px]">
        {account.bio ? (
          <AbstractText text={account.bio} />
        ) : (
          <p>
            <b>Abstract.</b>{' '}
            <span className="text-muted italic">
              No bio yet. Add a few lines about you and your research with “edit profile”: your page shows them as its
              abstract.
            </span>
          </p>
        )}
        <p className={`${ui.fine} font-sans`}>
          Your page shows your handle, bio and links; your institution and real name only as you choose; your papers,
          activity and comments unless you turn them off in its settings.
        </p>
      </div>
      <h2 className={ui.groupHeading} id="affiliations">
        Affiliations
      </h2>
      <Affiliations
        n={1}
        initial={rows.map((r) => ({
          id: r.id,
          email: r.email,
          institutionName: r.institutionName,
          primary: r.isPrimary,
          verifiedAt: r.verifiedAt?.toISOString() ?? null,
          codeExpiresAt: r.codeExpiresAt?.toISOString() ?? null,
          createdAt: r.createdAt.toISOString(),
        }))}
      />
      {(others.some((o) => o.verifiedAt) || names.length > 0) && (
        <div className="mt-3 space-y-1 font-sans text-sm">
          {others.some((o) => o.verifiedAt) && (
            <p>
              <span className="text-muted">Other addresses, confirmed to claim papers: </span>
              {others
                .filter((o) => o.verifiedAt)
                .map((o) => o.email)
                .join(', ')}
            </p>
          )}
          {names.length > 0 && (
            <p>
              <span className="text-muted">Names you are an author under: </span>
              {names.join(', ')}
            </p>
          )}
          <p className={ui.fine}>Only you see these.</p>
        </div>
      )}
      <h2 className={ui.groupHeading} id="email">
        Email
      </h2>
      <MailSettings mentionMail={account.mentionMail} followMail={account.followMail} />
      <h2 className={ui.groupHeading} id="agents">
        API keys and agents
      </h2>
      <ApiKeys
        n={2}
        canWrite={account.isBot || account.verifiedAt !== null}
        initial={tokens.map((t) => ({
          id: t.id,
          name: t.name,
          start: t.start,
          scopes: t.scopes,
          createdAt: t.createdAt.toISOString(),
          lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
        }))}
      />
      <h2 className={ui.groupHeading} id="ssh-keys">
        SSH keys
      </h2>
      <SshKeys
        n={3}
        canPush={account.isBot || account.verifiedAt !== null}
        sshUrl={gitSshUrl()}
        initial={keys.map((k) => ({
          id: k.id,
          title: k.title,
          keyType: k.keyType,
          fingerprint: k.fingerprint,
          createdAt: k.createdAt.toISOString(),
          lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
        }))}
      />
      <hr className="mt-10 mb-4 border-rule-soft" />
      <div className="flex justify-end">
        <SignOut className={BUTTON} />
      </div>
    </main>
  );
}
