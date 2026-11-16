'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ui } from '@/components/ui';

async function messageOf(res: Response): Promise<string> {
  if (res.status === 401) return 'Your session ended. Sign in again in another tab.';
  const body = await res.json().catch(() => null);
  return body?.error?.message ?? `Something went wrong (${res.status}).`;
}

/** Sends, changes or takes back a claim to organise a venue, or steps down as its organiser. */
export function OrganiserClaimForm({
  identifier,
  pagePath,
  state,
  evidence = '',
}: {
  identifier: string;
  pagePath: string;
  state: 'none' | 'pending' | 'confirmed';
  evidence?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const url = `/api/v1/pages/${encodeURIComponent(identifier)}/claim`;

  async function call(init: RequestInit) {
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch(url, init);
      if (!res.ok) return setProblem(await messageOf(res));
      router.refresh();
    } catch {
      setProblem('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = String(new FormData(event.currentTarget).get('evidence') ?? '').trim();
    if (!text) return setProblem('Say who you are at the venue, and where that can be checked.');
    void call({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ evidence: text }),
    });
  }

  if (state === 'confirmed') {
    return (
      <p className={ui.fine}>
        <button type="button" className={ui.linkBtn} disabled={busy} onClick={() => void call({ method: 'DELETE' })}>
          Step down as organiser
        </button>
        {problem && <span className={ui.note(false)}> {problem}</span>}
      </p>
    );
  }
  return (
    <form onSubmit={send} className="mt-4">
      {state === 'pending' && (
        <p className={`${ui.box} mb-4`}>
          Your claim is waiting to be checked. You can change what it says below, or{' '}
          <button type="button" className={ui.linkBtn} onClick={() => void call({ method: 'DELETE' })} disabled={busy}>
            withdraw it
          </button>
          .
        </p>
      )}
      <label className="block text-muted" htmlFor="evidence">
        Who are you at the venue (programme chair, general chair, …), and where can that be checked? A link to the
        venue&apos;s page that names you is best.
      </label>
      <textarea
        id="evidence"
        name="evidence"
        className={`${ui.input} mt-1 min-h-28`}
        defaultValue={evidence}
        maxLength={2000}
        required
      />
      <button type="submit" className={ui.btn({ inline: true })} disabled={busy}>
        {state === 'pending' ? 'Update the claim' : 'Claim'}
      </button>
      {problem && <p className={ui.note(false)}>{problem}</p>}
      <p className={ui.fine}>
        An admin reads it and decides. Until then the <a href={pagePath}>venue&apos;s page</a> stays as it is.
      </p>
    </form>
  );
}
