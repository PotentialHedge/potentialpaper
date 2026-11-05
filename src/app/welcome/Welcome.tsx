'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { InstitutionRequestForm } from '@/components/InstitutionRequestForm';
import { OnboardingCard } from '@/components/OnboardingCard';
import { ui } from '@/components/ui';
import { hasSubaddress, SUBADDRESS_REFUSED } from '@/lib/email-address';
import { rememberPending } from '@/lib/pending-confirmation';
import { authHref, VERIFY_EMAIL } from '@/lib/return-to';

/**
 * An email alone, sent to `POST /onboarding`, which mails a link and a code for a new address or one
 * with an account alike, then on to `/verify-email`. A refused domain gets the request form.
 */
export function Welcome({ next, institutionCount }: { next: string; institutionCount: number }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);

  if (refused) {
    return (
      <OnboardingCard title="Request your institution" onBack={() => setRefused(null)}>
        <InstitutionRequestForm email={refused} />
      </OnboardingCard>
    );
  }

  return (
    <OnboardingCard title="Join PaperTrail" eyebrow="Anyone can read. Verified researchers can edit.">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const address = email.trim();
          if (hasSubaddress(address)) return setError(SUBADDRESS_REFUSED);
          setBusy(true);
          setError(null);
          const res = await fetch('/api/v1/onboarding', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: address, next }),
          }).catch(() => null);
          setBusy(false);
          if (res?.ok) {
            rememberPending({ email: address, next });
            return router.push(authHref(VERIFY_EMAIL, next, { email: address }));
          }
          if (!res) return setError('Could not reach the server. Try again.');
          const code = (await res.json().catch(() => null))?.error?.code;
          if (code === 'email_domain_not_allowed') return setRefused(address);
          setError(
            code === 'rate_limited'
              ? 'We have sent this address too many mails today. Open the link in the newest one, or try again in a few hours.'
              : 'Something went wrong. Try again.',
          );
        }}
      >
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoFocus
          autoComplete="email"
          placeholder="Institutional email"
          aria-label="Institutional email"
          className={ui.input}
        />
        <button className={ui.btn()} disabled={busy || !email.trim()}>
          {busy ? 'Sending…' : 'Email me a code'}
        </button>
        {error && <div className={ui.note(false)}>{error}</div>}
      </form>
      <p className={ui.fine}>
        Open to about {institutionCount.toLocaleString('en')} universities, institutes and research labs. Not on the
        list? <Link href="/institutions/request">Request your institution</Link>. Have an account?{' '}
        <Link href={authHref('/signin', next)}>Sign in</Link>.
      </p>
    </OnboardingCard>
  );
}
