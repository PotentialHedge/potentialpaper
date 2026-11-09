import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { SignOut } from '@/components/SignOut';
import { ui } from '@/components/ui';
import { authHref, VERIFY_EMAIL } from '@/lib/return-to';
import { listAffiliations } from '@/server/affiliations';
import { viewerFromHeaders } from '@/server/auth';
import { listTokens } from '@/server/tokens';
import { AgentTokens } from './AgentTokens';
import { Affiliations } from './Affiliations';
import { ProfileForm } from './ProfileForm';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Profile · PotentialPaper' };

export default async function Profile() {
  const viewer = await viewerFromHeaders(await headers());
  if (!viewer) redirect(authHref('/signin', '/profile'));
  const { account } = viewer;
  if (!account.profileCompletedAt) redirect(authHref(VERIFY_EMAIL, '/profile'));
  const [rows, tokens] = await Promise.all([listAffiliations(account.id), listTokens(account.id)]);
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
      <h2 className={ui.groupHeading} id="agents">
        AI agents
      </h2>
      <AgentTokens
        n={2}
        initial={tokens.map((t) => ({
          id: t.id,
          name: t.name,
          start: t.start,
          createdAt: t.createdAt.toISOString(),
          lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
        }))}
      />
    </main>
  );
}
