'use client';

import { useState } from 'react';
import { ui } from './ui';

const label = 'mt-2.5 block font-sans text-[13px] text-muted';

const REFUSALS: Record<string, string> = {
  domain_not_institutional: 'Use the address your institution gave you. Personal mail addresses cannot be added.',
  institution_already_listed: 'That institution is already on our list, so you can sign up with this address.',
  rate_limited: 'Too many requests. Try again tomorrow.',
};

/**
 * What a refused address gets instead of a dead end (DESIGN.md §5.2): ask for the institution to be
 * added. `email` fills in the address that was refused; without it, one is typed here.
 */
export function InstitutionRequestForm({ email: initialEmail = '', onBack }: { email?: string; onBack?: () => void }) {
  const [email, setEmail] = useState(initialEmail);
  const [institutionName, setInstitutionName] = useState('');
  const [website, setWebsite] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  if (sent) {
    return (
      <div className={ui.note(true)}>
        Thanks. We review each request by hand and will email <b>{email.trim()}</b> with the answer, then delete the
        address from the request.
      </div>
    );
  }

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const res = await fetch('/api/v1/institution-requests', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: email.trim(),
            institutionName: institutionName.trim(),
            website: website.trim() || null,
            note: note.trim() || null,
          }),
        }).catch(() => null);
        setBusy(false);
        if (res?.ok) return setSent(true);
        if (!res) return setError('Could not reach the server. Try again.');
        const body = await res.json().catch(() => null);
        const issue = body?.error?.details?.issues?.[0]?.path;
        setError(
          REFUSALS[body?.error?.code] ??
            (issue === 'website'
              ? 'The website should be a full address, starting with https://.'
              : (body?.error?.message ?? 'Something went wrong.')),
        );
      }}
    >
      <p className="mb-2 font-sans text-sm">
        That address is not at an institution on our list. Ask us to add it, and we will email you once we have decided.
      </p>
      <label className={label}>
        Institutional email
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
          className={`${ui.input} mt-0.5`}
        />
      </label>
      <label className={label}>
        Institution name
        <input
          value={institutionName}
          onChange={(e) => setInstitutionName(e.target.value)}
          required
          minLength={2}
          maxLength={200}
          autoComplete="organization"
          className={`${ui.input} mt-0.5`}
        />
      </label>
      <label className={label}>
        Website (optional, helps us check)
        <input
          type="url"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          maxLength={500}
          placeholder="https://"
          className={`${ui.input} mt-0.5`}
        />
      </label>
      <label className={label}>
        Anything else? (optional)
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={1000}
          rows={2}
          className={`${ui.input} mt-0.5`}
        />
      </label>
      <button className={ui.btn()} disabled={busy || !email.trim() || !institutionName.trim()}>
        {busy ? 'Sending…' : 'Request this institution'}
      </button>
      {onBack && (
        <button type="button" className={ui.btn({ ghost: true })} disabled={busy} onClick={onBack}>
          Use another address
        </button>
      )}
      {error && <div className={ui.note(false)}>{error}</div>}
    </form>
  );
}
