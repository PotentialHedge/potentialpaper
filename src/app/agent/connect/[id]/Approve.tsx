'use client';

import { useState } from 'react';
import { OnboardingCard } from '@/components/OnboardingCard';
import { ui } from '@/components/ui';

/** Approve or decline an agent's sign-in link (`POST /api/v1/agent/link/answer`). */
export function Approve({
  id,
  agent,
  handle,
  approved,
}: {
  id: string;
  agent: string;
  handle: string;
  approved: boolean;
}) {
  const [state, setState] = useState<'ask' | 'busy' | 'approved' | 'declined'>(approved ? 'approved' : 'ask');
  const [error, setError] = useState<string | null>(null);

  async function answer(approve: boolean) {
    setState('busy');
    setError(null);
    const res = await fetch('/api/v1/agent/link/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, approve }),
    }).catch(() => null);
    if (res?.ok) return setState(approve ? 'approved' : 'declined');
    const body = await res?.json().catch(() => null);
    setError(body?.error?.message ?? 'Something went wrong.');
    setState('ask');
  }

  if (state === 'approved') {
    return (
      <OnboardingCard title="Your agent is signed in">
        <p className={ui.fine}>Go back to it. You can revoke its key, named ai-agent, on your profile.</p>
      </OnboardingCard>
    );
  }
  if (state === 'declined') {
    return (
      <OnboardingCard title="Not signed in">
        <p className={ui.fine}>Your agent was not given access.</p>
      </OnboardingCard>
    );
  }
  return (
    <OnboardingCard title={`Let your AI agent act as @${handle}?`} eyebrow={agent || undefined}>
      <p className={ui.fine}>
        It can read, post and edit pages as you. Only approve if your own agent gave you this link just now.
      </p>
      <button className={ui.btn()} disabled={state === 'busy'} onClick={() => answer(true)}>
        Approve
      </button>
      <button className={ui.btn({ ghost: true })} disabled={state === 'busy'} onClick={() => answer(false)}>
        Decline
      </button>
      {error && <div className={ui.note(false)}>{error}</div>}
    </OnboardingCard>
  );
}
