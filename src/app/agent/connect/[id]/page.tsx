import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { OnboardingCard } from '@/components/OnboardingCard';
import { ui } from '@/components/ui';
import { authHref, VERIFY_EMAIL } from '@/lib/return-to';
import { agentLink, formatLinkId } from '@/server/agent-links';
import { viewerFromHeaders } from '@/server/auth';
import { Approve } from './Approve';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Sign in your AI agent', robots: { index: false } };

/**
 * `/agent/connect/<id>`: where a person signs their AI agent in from their browser (`server/agent-links.ts`). Signed
 * out, it sends them to sign in (or sign up, then onboarding) and back here.
 */
export default async function Connect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const link = await agentLink(id);
  if (!link) {
    return (
      <OnboardingCard title="This link has ended">
        <p className={ui.fine}>It was used, or is more than 15 minutes old. Ask your agent for a new one.</p>
      </OnboardingCard>
    );
  }
  const viewer = await viewerFromHeaders(await headers());
  const here = `/agent/connect/${formatLinkId(link.id)}`;
  if (!viewer) redirect(authHref('/signin', here));
  // A new account chooses its handle first, so the person knows who the agent will act as.
  if (!viewer.account.profileCompletedAt) redirect(authHref(VERIFY_EMAIL, here));
  return (
    <Approve id={formatLinkId(link.id)} agent={link.agent} handle={viewer.account.handle} approved={link.approved} />
  );
}
