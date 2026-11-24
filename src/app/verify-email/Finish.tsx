'use client';

import { track } from '@/lib/track';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ClaimSuggestions } from '@/components/ClaimSuggestions';
import { OnboardingCard } from '@/components/OnboardingCard';
import { ProfileFields, profileRefusal, type ProfileValues } from '@/components/ProfileFields';
import { ui } from '@/components/ui';

/**
 * What a confirmed account still lacks, one question at a time: a handle (its institution is shown; both
 * change on the profile), then the papers it wrote, then a password. Papers and the password can be skipped.
 */
export function Finish({
  email,
  needsProfile,
  needsPassword,
  next,
}: {
  email: string;
  needsProfile: boolean;
  needsPassword: boolean;
  next: string;
}) {
  const router = useRouter();
  const [step, setStep] = useState<'profile' | 'papers' | 'password'>(needsProfile ? 'profile' : 'password');
  const [profile, setProfile] = useState<ProfileValues>({ handle: '', realName: '', showInstitution: true });
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Once, as it opens: what is owed.
  useEffect(() => track('finish_shown', { needsName: needsProfile, needsPassword }), [needsProfile, needsPassword]);

  function finish(how: 'done' | 'skip' = 'done') {
    track('finish_completed', { target: how });
    router.push(next);
    router.refresh();
  }

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch('/api/v1/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        handle: profile.handle.trim(),
        showInstitution: true,
      }),
    }).catch(() => null);
    setBusy(false);
    if (!res?.ok) return setError(await profileRefusal(res));
    track('finish_step', { target: 'name' });
    setStep('papers');
  }

  async function savePassword(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch('/api/v1/me/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    }).catch(() => null);
    setBusy(false);
    const code = (
      await res
        ?.clone()
        .json()
        .catch(() => null)
    )?.error?.code;
    if (res?.ok || code === 'password_already_set') {
      track('finish_step', { target: 'password' });
      return finish();
    }
    setError(code === 'validation_error' ? 'At least 12 characters.' : 'Could not save your password.');
  }

  if (step === 'profile') {
    return (
      <OnboardingCard title="Choose a handle" eyebrow="Confirmed. Welcome to potentialpaper.">
        <form onSubmit={saveProfile}>
          <ProfileFields values={profile} onChange={setProfile} handleOnly />
          <p className={ui.fine}>Your institution shows next to it. You can change both on your profile.</p>
          <button className={ui.btn()} disabled={busy || !profile.handle.trim()}>
            {busy ? 'Saving…' : 'Continue'}
          </button>
          {error && <div className={ui.note(false)}>{error}</div>}
        </form>
      </OnboardingCard>
    );
  }

  if (step === 'papers') {
    return (
      <OnboardingCard title="Have you written any papers?" eyebrow="Claim them to write their author section.">
        <ClaimSuggestions />
        <button type="button" className={ui.btn()} onClick={() => (needsPassword ? setStep('password') : finish())}>
          Continue
        </button>
        <p className={ui.fine}>
          You can find more any time under <Link href="/claim">Claim your papers</Link>.
        </p>
      </OnboardingCard>
    );
  }

  return (
    <OnboardingCard title="Choose a password" eyebrow="Optional: a link by email also signs you in.">
      <form onSubmit={savePassword}>
        <input type="email" value={email} readOnly hidden autoComplete="username" />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={12}
          autoFocus
          autoComplete="new-password"
          placeholder="Password (12+ characters)"
          aria-label="Password"
          className={ui.input}
        />
        <button className={ui.btn()} disabled={busy}>
          {busy ? 'Saving…' : 'Set password'}
        </button>
        <button type="button" className={ui.btn({ ghost: true })} disabled={busy} onClick={() => finish('skip')}>
          Skip for now
        </button>
        {error && <div className={ui.note(false)}>{error}</div>}
      </form>
    </OnboardingCard>
  );
}
