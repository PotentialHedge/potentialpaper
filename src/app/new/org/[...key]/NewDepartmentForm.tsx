'use client';

import { track } from '@/lib/track';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ui } from '@/components/ui';

async function messageOf(res: Response): Promise<string> {
  if (res.status === 401) return 'Your session ended. Sign in again in another tab.';
  const body = await res.json().catch(() => null);
  return body?.error?.message ?? `Something went wrong (${res.status}).`;
}

/** "Machine Learning Group" → `machine-learning-group`. */
function slugOf(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

/** Makes a department or lab under an org page (`POST /api/v1/pages/{identifier}/children`), then opens it. */
export function NewDepartmentForm({
  identifier,
  parentKey,
  domains,
}: {
  identifier: string;
  parentKey: string;
  domains: string[];
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const shownSlug = slugTouched ? slug : slugOf(name);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const own = String(form.get('domains') ?? '')
      .split(/[\s,]+/)
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch(`/api/v1/pages/${encodeURIComponent(identifier)}/children`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), slug: shownSlug, domains: own }),
      });
      if (!res.ok) return setProblem(await messageOf(res));
      track('department_created');
      router.push(`/o/${parentKey}/${shownSlug}`);
    } catch {
      setProblem('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-4 space-y-3">
      <label className="block text-[13px] text-muted">
        Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={200}
          placeholder="Department of Computer Science"
          className={`${ui.input} mt-0.5`}
        />
      </label>
      <label className="block text-[13px] text-muted">
        Address: /o/{parentKey}/
        <input
          value={shownSlug}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(e.target.value.toLowerCase());
          }}
          required
          maxLength={60}
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          className={`${ui.input} mt-0.5`}
        />
      </label>
      <label className="block text-[13px] text-muted">
        Its own email domains (optional, separated by spaces),{' '}
        {domains.length > 0 ? domains.join(', ') : 'its organisation’s'} or under them
        <input name="domains" placeholder={domains[0] ? `inf.${domains[0]}` : ''} className={`${ui.input} mt-0.5`} />
      </label>
      <button className={ui.btn()} disabled={busy || !name.trim() || !shownSlug}>
        Add it
      </button>
      {problem && <p className={ui.note(false)}>{problem}</p>}
    </form>
  );
}
