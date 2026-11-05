import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { OnboardingCard } from '@/components/OnboardingCard';
import { LINK_USED } from '@/lib/link-errors';
import { authHref, safeReturnTo } from '@/lib/return-to';
import { viewerFromHeaders } from '@/server/auth';
import { hasPassword } from '@/server/better-auth';
import { CodeForm } from './CodeForm';
import { Finish } from './Finish';

export const dynamic = 'force-dynamic';

/**
 * The one page after an email: where every mail's link lands and where its code is typed. Which of the
 * three it shows follows from the session, never from how the person got here.
 *
 * - **Signed in, nothing owed:** straight on to `next`.
 * - **Signed in, something owed** (a profile, a password): `Finish` asks for what is missing.
 * - **No session, an address in the URL:** the code from the mail, in the tab the person started in
 *   (`CodeForm`); confirming signs in and this page renders again as the case above.
 * - **No session, no address:** a link opened a second time, or a dead one (`?error=`): `/signin` says so.
 */
export default async function VerifyEmail({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string; email?: string; resent?: string; skip?: string }>;
}) {
  const params = await searchParams;
  const next = safeReturnTo(params.next);
  if (params.error) redirect(authHref('/signin', next, { error: params.error }));

  const viewer = await viewerFromHeaders(await headers());
  const userId = viewer?.account.userId;
  if (!viewer || !userId) {
    if (!params.email) redirect(authHref('/signin', next, { error: LINK_USED }));
    return (
      <OnboardingCard title="Check your inbox">
        <CodeForm initialEmail={params.email} next={next} resent={params.resent === '1'} />
      </OnboardingCard>
    );
  }

  const needsProfile = viewer.account.profileCompletedAt === null;
  const needsPassword = !(await hasPassword(userId));
  if (!needsProfile && !needsPassword) redirect(next);
  return <Finish email={viewer.email} needsProfile={needsProfile} needsPassword={needsPassword} next={next} />;
}
