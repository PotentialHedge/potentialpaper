'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import {
  agentPromptStep,
  AgentPromptButton,
  OnboardAgentButton,
  TutorialArt,
  TutorialText,
  tutorialSteps,
} from '@/components/GettingStarted';
import { OnboardingCard } from '@/components/OnboardingCard';
import { ui } from '@/components/ui';
import { DOMAIN_NOT_LISTED, hasSubaddress, SUBADDRESS_REFUSED } from '@/lib/email-address';
import { rememberPending } from '@/lib/pending-confirmation';
import { authHref, VERIFY_EMAIL } from '@/lib/return-to';

/** Getting started's steps, in order, one a page (`components/GettingStarted.tsx`). */
const TOUR = ['open', 'read', 'link'] as const;
type TourStep = (typeof TOUR)[number];

/** `agent-prompt` is the agent screen past the tour's last step, reached only by "Onboard my agent". */
type Step = 'intro' | TourStep | 'agent-prompt' | 'email';
const STEPS: Step[] = ['intro', ...TOUR, 'agent-prompt', 'email'];

/**
 * Getting started, after acceptodds': an intro, a three-step tour whose last step offers an AI agent instead,
 * then sign-up. One step on screen at a time (`OnboardingCard`), in the URL as `?step=` so the back button
 * works.
 */
export function Welcome({
  next,
  institutionCount,
  host,
}: {
  next: string;
  institutionCount: number;
  /** This site's domain, for the tour's address trick. */
  host: string;
}) {
  const params = useSearchParams();
  const asked = params.get('step') as Step | null;
  const step: Step = asked && STEPS.includes(asked) ? asked : 'intro';

  function go(s: Step) {
    const q = new URLSearchParams(params);
    if (s === 'intro') q.delete('step');
    else q.set('step', s);
    window.history.pushState(null, '', q.size ? `/welcome?${q}` : '/welcome');
  }

  const card = (title: React.ReactNode, body: React.ReactNode, figure?: React.ReactNode) => (
    <OnboardingCard
      title={title}
      onBack={step === 'intro' ? undefined : () => window.history.back()}
      eyebrow={step === 'intro' ? 'Anyone can read. Verified researchers can edit.' : 'Getting started'}
      figure={figure}
    >
      {body}
    </OnboardingCard>
  );

  switch (step) {
    case 'intro':
      return card(
        'Join PotentialPaper',
        <>
          <p className="mb-4 text-muted">
            One public page for every research paper, written by its authors and by verified researchers. For
            researchers with an institutional email.
          </p>
          <button className={ui.btn()} onClick={() => go(TOUR[0])}>
            Get started
          </button>
          <Link href={authHref('/signin', next)} className={ui.btn({ ghost: true })}>
            I already have an account
          </Link>
        </>,
      );

    case 'open':
    case 'read':
    case 'link': {
      const at = TOUR.indexOf(step);
      const tour = tutorialSteps({ host });
      const last = at === TOUR.length - 1;
      return card(
        `${at + 1}. ${tour[at].title}`,
        <>
          <TutorialText step={tour[at]} />
          <div className="mt-6">
            <button className={ui.btn()} onClick={() => go(last ? 'email' : TOUR[at + 1])}>
              {last ? 'Create my account' : 'Next'}
            </button>
            {last && <OnboardAgentButton onClick={() => go('agent-prompt')} />}
          </div>
        </>,
        tour[at].art && <TutorialArt>{tour[at].art}</TutorialArt>,
      );
    }

    case 'agent-prompt': {
      const screen = agentPromptStep();
      return card(
        screen.title,
        <>
          <TutorialText step={screen} />
          <div className="mt-6">
            <AgentPromptButton />
          </div>
        </>,
        <TutorialArt>{screen.art}</TutorialArt>,
      );
    }

    case 'email':
      return card(
        'Sign up with your institutional email',
        <EmailStep next={next} institutionCount={institutionCount} />,
      );
  }
}

/**
 * An email alone, sent to `POST /onboarding`, which mails a link and a code for a new address or one
 * with an account alike, then on to `/verify-email`.
 */
function EmailStep({ next, institutionCount }: { next: string; institutionCount: number }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <>
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
          if (code === 'email_domain_not_allowed') return setError(DOMAIN_NOT_LISTED);
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
        Open to about {institutionCount.toLocaleString('en')} universities, institutes and research labs. Have an
        account? <Link href={authHref('/signin', next)}>Sign in</Link>.
      </p>
    </>
  );
}
