'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ui } from '@/components/ui';
import type { PaperId } from '@/lib/paper-ids';

interface Props {
  paper: PaperId;
  pagePath: string;
  /** As printed on the paper. */
  authors: string[];
  /** Authors someone is already confirmed as. */
  taken: number[];
  pending: { authorIndex: number; evidence: string } | null;
}

async function messageOf(res: Response): Promise<string> {
  if (res.status === 401) return 'Your session ended. Sign in again in another tab.';
  const body = await res.json().catch(() => null);
  return body?.error?.message ?? `Something went wrong (${res.status}).`;
}

export function ClaimForm({ paper, pagePath, authors, taken, pending }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const authorIndex = Number(form.get('author'));
    if (!Number.isInteger(authorIndex) || form.get('author') === null)
      return setProblem('Choose which author you are.');
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch('/api/v1/claims', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paper, authorIndex, evidence: String(form.get('evidence') ?? '') }),
      });
      if (!res.ok) return setProblem(await messageOf(res));
      router.refresh();
    } catch {
      setProblem('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  async function withdraw() {
    setBusy(true);
    setProblem(null);
    try {
      const query = new URLSearchParams({ scheme: paper.scheme, value: paper.value });
      const res = await fetch(`/api/v1/claims?${query}`, { method: 'DELETE' });
      if (!res.ok) return setProblem(await messageOf(res));
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (authors.length === 0) return <p className="mt-4">This paper lists no authors, so it can&apos;t be claimed.</p>;
  return (
    <form onSubmit={send} className="mt-4">
      {pending && (
        <p className={`${ui.box} mb-4`}>
          Your claim to be <b>{authors[pending.authorIndex]}</b> is waiting to be checked. You can change it below, or{' '}
          <button type="button" className={ui.linkBtn} onClick={withdraw} disabled={busy}>
            withdraw it
          </button>
          .
        </p>
      )}
      <fieldset>
        <legend className="text-muted">Which author are you?</legend>
        <div className="mt-1 space-y-0.5">
          {authors.map((name, index) => (
            <label key={index} className={`block ${taken.includes(index) ? 'text-faint' : ''}`}>
              <input
                type="radio"
                name="author"
                value={index}
                defaultChecked={pending?.authorIndex === index}
                disabled={taken.includes(index)}
                className="mr-2"
              />
              {name}
              {taken.includes(index) && ' (confirmed)'}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="mt-3 block">
        <span className="text-muted">How can we tell it&apos;s you?</span>
        <textarea
          name="evidence"
          rows={4}
          maxLength={2000}
          defaultValue={pending?.evidence ?? ''}
          placeholder="The address on the paper, your ORCID, your homepage listing it, a co-author who can vouch…"
          className={ui.input}
        />
      </label>
      <p className={ui.fine}>
        Claims are checked by hand for now. If the paper is still under double-blind review, claiming it reveals that
        you wrote it once your claim is confirmed.
      </p>
      <div className="flex items-baseline gap-4">
        <button type="submit" disabled={busy} className={ui.btn({ inline: true })}>
          {busy ? 'Sending…' : pending ? 'Update the claim' : 'Claim'}
        </button>
        <a href={pagePath}>Back to the paper</a>
      </div>
      {problem && <p className={ui.note(false)}>{problem}</p>}
    </form>
  );
}
