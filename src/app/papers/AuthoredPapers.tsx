'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { CopyField } from '@/components/CopyField';
import { Modal } from '@/components/Modal';
import { Select } from '@/components/Select';
import { ui } from '@/components/ui';
import { paperPath, type PaperId } from '@/lib/paper-ids';
import type { AuthoredPaper, WaitingClaim } from '@/server/my-papers';

/** `server/my-papers.ts`'s rows, with dates as strings to cross to the client. */
export type AuthoredRow = Omit<AuthoredPaper, 'waiting'> & {
  waiting: (Omit<WaitingClaim, 'createdAt'> & { createdAt: string })[];
};

async function messageOf(res: Response): Promise<string> {
  if (res.status === 401) return 'Your session ended. Sign in again in another tab.';
  if (res.status === 429) return 'Too many requests. Try again in a minute.';
  const body = await res.json().catch(() => null);
  return body?.error?.message ?? `Something went wrong (${res.status}).`;
}

const claimPath = (paper: PaperId) => `/claim${paperPath(paper)}`;

/**
 * The papers the viewer is an author of, or has claimed, as Table `n`. A confirmed author opens a modal from a paper's
 * row to add a co-author, by handle, or to confirm someone waiting on a claim (`POST /api/v1/me/papers/co-authors`).
 */
export function AuthoredPapers({
  initial: rows,
  n,
  canVouch,
}: {
  initial: AuthoredRow[];
  n: number;
  canVouch: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const openRow = rows.find((r) => r.paperId === open);
  return (
    <div className="font-sans text-sm">
      <div className={ui.tableScroll}>
        <table className={ui.table}>
          <caption className={ui.tableCaption}>
            <b>Table {n}.</b> Papers you are an author of, or have claimed, newest first. Their confirmed authors write
            the author section and choose the picture and links.
          </caption>
          <thead>
            <tr>
              <th className={ui.th()}>Paper</th>
              <th className={ui.th()}>You, as</th>
              <th className={ui.th()}>Confirmed authors</th>
              <th className={ui.th()} />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const confirmed = row.mine.status === 'confirmed';
              return (
                <tr key={row.paperId} className="align-baseline">
                  <td className={`${ui.td} font-serif`}>
                    <Link href={row.path}>{row.title}</Link>
                    {(row.year || row.venue) && (
                      <div className="font-sans text-xs text-faint">
                        {[row.venue, row.venue?.includes(String(row.year)) ? null : row.year].filter(Boolean).join(' ')}
                      </div>
                    )}
                  </td>
                  <td className={ui.td}>
                    {row.mine.authorName}
                    {!confirmed && (
                      <Link href={claimPath(row.canonical)} className="hover:no-underline">
                        <span className={ui.badge}>pending</span>
                      </Link>
                    )}
                  </td>
                  <td className={ui.td}>
                    {row.confirmed.length === 0 ? (
                      <span className="text-muted">none yet</span>
                    ) : (
                      row.confirmed.map((c) => c.authorName).join(', ')
                    )}{' '}
                    <span className="text-xs whitespace-nowrap text-faint">
                      ({row.confirmed.length} of {row.authors.length})
                    </span>
                  </td>
                  <td className={`${ui.td} text-right whitespace-nowrap`}>
                    {confirmed && canVouch && (
                      <button
                        type="button"
                        className={ui.linkBtn}
                        aria-haspopup="dialog"
                        onClick={() => setOpen(row.paperId)}
                      >
                        add co-author
                      </button>
                    )}
                    {row.waiting.length > 0 && (
                      <div>
                        <button
                          type="button"
                          className={`${ui.linkBtn} text-xs text-down`}
                          onClick={() => setOpen(row.paperId)}
                        >
                          {row.waiting.length} waiting on you
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Modal open={openRow !== undefined} onClose={() => setOpen(null)} title="Add a co-author">
        {openRow && <CoAuthors key={openRow.paperId} row={openRow} />}
      </Modal>
      {!canVouch && rows.some((r) => r.mine.status === 'confirmed') && (
        <p className={ui.fine}>
          Adding co-authors needs a confirmed institutional address. <a href="/profile#affiliations">Add one</a>.
        </p>
      )}
    </div>
  );
}

/** Confirm a co-author waiting on a claim, or add one by handle, on one paper. */
function CoAuthors({ row }: { row: AuthoredRow }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const taken = new Set(row.confirmed.map((c) => c.authorIndex));
  const open = row.authors.map((name, index) => ({ name, index })).filter((a) => !taken.has(a.index));

  async function vouch(body: { handle: string; authorIndex: number } | { claim: string }): Promise<boolean> {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch('/api/v1/me/papers/co-authors', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paper: row.canonical satisfies PaperId, ...body }),
      });
      if (!res.ok) {
        setNote({ ok: false, text: await messageOf(res) });
        return false;
      }
      const added = (await res.json()) as { authorName: string };
      setNote({ ok: true, text: `${added.authorName} is now a confirmed author.` });
      router.refresh();
      return true;
    } catch {
      setNote({ ok: false, text: 'Could not reach the server. Try again.' });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function deny(claim: string) {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch('/api/v1/me/papers/co-authors/deny', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paper: row.canonical satisfies PaperId, claim }),
      });
      if (!res.ok) return setNote({ ok: false, text: await messageOf(res) });
      setNote({ ok: true, text: 'Their claim was turned down. They are told.' });
      router.refresh();
    } catch {
      setNote({ ok: false, text: 'Could not reach the server. Try again.' });
    } finally {
      setBusy(false);
    }
  }

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    const handle = String(form.get('handle') ?? '').trim();
    const authorIndex = Number(form.get('author'));
    if (!handle || form.get('author') === null || !Number.isInteger(authorIndex)) {
      return setNote({ ok: false, text: 'Choose which author they are, and give their handle.' });
    }
    if (await vouch({ handle, authorIndex })) formEl.reset();
  }

  return (
    <div>
      <p className="mt-1 mb-3 font-serif text-base">{row.title}</p>
      {row.waiting.length > 0 && (
        <>
          <h3 className={`${ui.boxHeading} mt-3`}>Waiting to be confirmed</h3>
          <ul className="mb-3">
            {row.waiting.map((w) => (
              <li key={w.claimId} className="mb-2">
                <b className="font-semibold">{w.authorName}</b>
                {(w.realName || w.addresses.length > 0 || w.institutions.length > 0) && (
                  <span className="text-muted">
                    {' '}
                    · {[w.realName, w.addresses.join(', ') || w.institutions.join(', ')].filter(Boolean).join(', ')}
                  </span>
                )}{' '}
                <span className="text-xs text-faint">claimed {w.createdAt.slice(0, 10)}</span>
                {w.evidence && <p className="mt-0.5 whitespace-pre-wrap text-subtle">{w.evidence}</p>}
                <div className="flex gap-4">
                  <button
                    type="button"
                    className={ui.linkBtn}
                    disabled={busy}
                    onClick={() => void vouch({ claim: w.claimId })}
                  >
                    Confirm them as {w.authorName}
                  </button>
                  <button type="button" className={ui.linkBtn} disabled={busy} onClick={() => void deny(w.claimId)}>
                    Not them
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {/* The modal's title says it, unless someone waiting comes first. */}
      {row.waiting.length > 0 && <h3 className={`${ui.boxHeading} mt-3`}>Add another</h3>}
      {open.length === 0 ? (
        <p className="text-muted">Every author of this paper is confirmed.</p>
      ) : (
        <form onSubmit={add}>
          <div className="flex flex-wrap items-start gap-x-2 narrow:flex-col narrow:items-stretch">
            <span className="min-w-0 flex-1">
              <Select name="author" defaultValue="" aria-label="Which author they are" required data-autofocus>
                <option value="" disabled>
                  Which author they are…
                </option>
                {open.map((a) => (
                  <option key={a.index} value={a.index}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </span>
            <span className="min-w-0 flex-1">
              <input
                name="handle"
                placeholder="Their handle, e.g. @ada"
                aria-label="Their handle"
                autoComplete="off"
                className={ui.input}
                maxLength={64}
                required
              />
            </span>
            <button
              type="submit"
              className={`${ui.btn({ inline: true, flush: true })} border border-transparent`}
              disabled={busy}
            >
              {busy ? 'Adding…' : 'Add'}
            </button>
          </div>
        </form>
      )}
      {note && <p className={ui.note(note.ok)}>{note.text}</p>}
      {open.length > 0 && <Invite row={row} open={open} />}
    </div>
  );
}

/**
 * For a co-author not here yet: a link that signs them up and opens the paper's claim page, to copy or to send from
 * one's own mail. Their claim then asks the confirmed authors, so it shows up here as waiting.
 */
function Invite({ row, open }: { row: AuthoredRow; open: { name: string; index: number }[] }) {
  // Only rendered once the modal opens, in the browser.
  const link = `${window.location.origin}/welcome?next=${encodeURIComponent(claimPath(row.canonical))}`;
  const text = (name: string) =>
    `Hi ${name.split(' ')[0]},\n\n` +
    `I've claimed our paper “${row.title}” on PotentialPaper, where authors write a short section about their paper. ` +
    `Join me as ${name}: sign up with your institutional address and claim your name, and I'll confirm you.\n\n` +
    `${link}\n\nThanks!`;
  const mailto = (name: string) =>
    `mailto:?${new URLSearchParams({ subject: `Join me on “${row.title}”`, body: text(name) })
      .toString()
      .replace(/\+/g, '%20')}`;
  return (
    <>
      <h3 className={`${ui.boxHeading} mt-5`}>Or invite them</h3>
      <CopyField value={link} label="Invite link" />
      <p className="mt-2">
        Email{' '}
        {open.map((a, i) => (
          <span key={a.index}>
            {i > 0 && ', '}
            <a href={mailto(a.name)}>{a.name}</a>
          </span>
        ))}{' '}
        yourself.
      </p>
    </>
  );
}
