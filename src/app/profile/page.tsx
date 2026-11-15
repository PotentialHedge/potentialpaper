import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { SignOut } from '@/components/SignOut';
import { ui } from '@/components/ui';
import { authHref, VERIFY_EMAIL } from '@/lib/return-to';
import { listAffiliations } from '@/server/affiliations';
import { viewerFromHeaders } from '@/server/auth';
import { gitSshUrl } from '@/server/site';
import { listSshKeys } from '@/server/ssh-keys';
import { listTokens } from '@/server/tokens';
import { ApiKeys } from './ApiKeys';
import { Affiliations } from './Affiliations';
import { MentionMail } from './MentionMail';
import { ProfileForm } from './ProfileForm';
import { SshKeys } from './SshKeys';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Profile · PotentialPaper' };

export default async function Profile() {
  const viewer = await viewerFromHeaders(await headers());
  if (!viewer) redirect(authHref('/signin', '/profile'));
  const { account } = viewer;
  if (!account.profileCompletedAt) redirect(authHref(VERIFY_EMAIL, '/profile'));
  const [rows, tokens, keys] = await Promise.all([
    listAffiliations(account.id),
    listTokens(account.id),
    listSshKeys(account.id),
  ]);
  return (
    <main className={ui.page}>
      <h1 className="mt-6 text-[26px] font-normal">@{account.handle}</h1>
      <p className={`${ui.fine} mb-4 font-sans`}>
        Signed in as {viewer.email} · <SignOut className={ui.linkBtn} />
      </p>
      <h2 className={ui.groupHeading}>Public profile</h2>
      <ProfileForm
        initial={{
          handle: account.handle,
          realName: account.realName ?? '',
          showInstitution: account.showInstitution,
        }}
        institutions={account.institutions}
      />
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
      <h2 className={ui.groupHeading} id="email">
        Email
      </h2>
      <MentionMail initial={account.mentionMail} />
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
    </main>
  );
}
