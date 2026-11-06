'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { OnboardingCard } from '@/components/OnboardingCard';
import { ProfileFields, profileRefusal, type ProfileValues } from '@/components/ProfileFields';
import { ui } from '@/components/ui';

/**
 * What a confirmed account still lacks, one question at a time: its public profile, then a password.
 * The password can be skipped, since a sign-in link works too; the profile cannot, because nothing is
 * assumed about what someone shows publicly (DESIGN.md §5.3).
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
  const [profileDone, setProfileDone] = useState(!needsProfile);
  const [profile, setProfile] = useState<ProfileValues>({ handle: '', realName: '', showInstitution: null });
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function finish() {
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
        realName: profile.realName.trim() || null,
        showInstitution: profile.showInstitution,
      }),
    }).catch(() => null);
    setBusy(false);
    if (!res?.ok) return setError(await profileRefusal(res));
    if (needsPassword) setProfileDone(true);
    else finish();
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
    if (res?.ok || code === 'password_already_set') return finish();
    setError(code === 'validation_error' ? 'At least 12 characters.' : 'Could not save your password.');
  }

  if (!profileDone) {
    return (
      <OnboardingCard title="How should you appear?" eyebrow="Confirmed. Welcome to PotentialPaper.">
        <form onSubmit={saveProfile}>
          <ProfileFields values={profile} onChange={setProfile} />
          <button className={ui.btn()} disabled={busy || !profile.handle.trim() || profile.showInstitution === null}>
            {busy ? 'Saving…' : 'Continue'}
          </button>
          {error && <div className={ui.note(false)}>{error}</div>}
        </form>
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
        <button type="button" className={ui.btn({ ghost: true })} disabled={busy} onClick={finish}>
          Skip for now
        </button>
        {error && <div className={ui.note(false)}>{error}</div>}
      </form>
    </OnboardingCard>
  );
}
