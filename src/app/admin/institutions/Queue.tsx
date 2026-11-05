'use client';

import { useState } from 'react';
import { ui } from '@/components/ui';

interface Entry {
  domain: string;
  requests: { id: string; institutionName: string; website: string | null; note: string | null; createdAt: string }[];
}

/** One card per domain: what people said about it, and the decision. A decision answers them all. */
export function Queue({ initial }: { initial: Entry[] }) {
  const [entries, setEntries] = useState(initial);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  if (entries.length === 0) {
    return (
      <>
        {note && <div className={ui.note(note.ok)}>{note.text}</div>}
        <p className={ui.empty}>No open requests.</p>
      </>
    );
  }
  return (
    <>
      {note && <div className={ui.note(note.ok)}>{note.text}</div>}
      {entries.map((entry) => (
        <Card
          key={entry.domain}
          entry={entry}
          onDecided={(text, failed) => {
            setNote({ ok: !failed, text });
            // With failed mails, the entry has left this queue, but repeating the decision retries them.
            setEntries((all) => all.filter((e) => e.domain !== entry.domain));
          }}
        />
      ))}
    </>
  );
}

function Card({ entry, onDecided }: { entry: Entry; onDecided: (text: string, failed: boolean) => void }) {
  const [name, setName] = useState(entry.requests[0].institutionName);
  const [domain, setDomain] = useState(entry.domain);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(action: 'approve' | 'reject') {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/v1/admin/institutions/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        action === 'approve'
          ? { domain: domain.trim().toLowerCase(), institutionName: name.trim() }
          : { domain: entry.domain, reason: reason.trim() || null },
      ),
    }).catch(() => null);
    setBusy(false);
    const body = await res?.json().catch(() => null);
    if (!res?.ok) return setError(body?.error?.message ?? 'Could not reach the server.');
    const done = action === 'approve' ? `Approved ${domain}` : `Rejected ${entry.domain}`;
    onDecided(
      body.mailFailed
        ? `${done}, but ${body.mailFailed} mail(s) failed. Check the log, and repeat through the API to retry them.`
        : `${done}: told ${body.mailed} ${body.mailed === 1 ? 'person' : 'people'}.`,
      body.mailFailed > 0,
    );
  }

  return (
    <section className={`${ui.box} mb-4`}>
      <h2 className={`${ui.mono} text-base`}>{entry.domain}</h2>
      <p className="mt-1 text-[13px]">
        <a
          className="text-accent"
          href={`https://ror.org/search?query=${encodeURIComponent(entry.requests[0].institutionName)}`}
          rel="noreferrer noopener"
          target="_blank"
        >
          Search ROR
        </a>
        {' · '}
        <a className="text-accent" href={`https://${entry.domain}`} rel="noreferrer noopener" target="_blank">
          Open the domain
        </a>
      </p>
      <ul className="mt-2 mb-3 list-none text-[13px]">
        {entry.requests.map((r) => (
          <li key={r.id} className="mt-1 border-t border-rule-soft pt-1">
            <b>{r.institutionName}</b> <span className="text-muted">({r.createdAt})</span>
            {r.website && (
              <>
                {' · '}
                <a
                  className="break-all text-accent"
                  href={r.website}
                  rel="noreferrer noopener nofollow"
                  target="_blank"
                >
                  {r.website}
                </a>
              </>
            )}
            {r.note && <div className="text-subtle">{r.note}</div>}
          </li>
        ))}
      </ul>
      <label className="block text-[13px] text-muted">
        Institution name as shown
        <input value={name} onChange={(e) => setName(e.target.value)} className={`${ui.input} mt-0.5`} />
      </label>
      <label className="block text-[13px] text-muted">
        Domain to approve (a parent admits every subdomain)
        <input value={domain} onChange={(e) => setDomain(e.target.value)} className={`${ui.input} mt-0.5 ${ui.mono}`} />
      </label>
      <button
        className={ui.btn({ inline: true })}
        disabled={busy || name.trim().length < 2}
        onClick={() => decide('approve')}
      >
        Approve
      </button>
      <label className="mt-3 block text-[13px] text-muted">
        Reason, mailed if rejecting (optional)
        <input value={reason} onChange={(e) => setReason(e.target.value)} className={`${ui.input} mt-0.5`} />
      </label>
      <button className={ui.btn({ ghost: true, inline: true })} disabled={busy} onClick={() => decide('reject')}>
        Reject
      </button>
      {error && <div className={ui.note(false)}>{error}</div>}
    </section>
  );
}
