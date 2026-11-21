'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Modal } from '@/components/Modal';
import { ui } from '@/components/ui';
import type { PaperId } from '@/lib/paper-ids';
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

const claimPath = (path: string) => `/claim${path}`;

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
                        {[row.venue, row.year].filter(Boolean).join(' ')}
                      </div>
                    )}
                  </td>
                  <td className={ui.td}>
                    {row.mine.authorName}
                    {!confirmed && (
                      <Link href={claimPath(row.path)} className="hover:no-underline">
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
                    {row.waiting.length > 0 && <div className="text-xs text-down">{row.waiting.length} waiting</div>}
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
                {(w.realName || w.institutions.length > 0) && (
                  <span className="text-muted">
                    {' '}
                    · {[w.realName, w.institutions.join(', ')].filter(Boolean).join(', ')}
                  </span>
                )}{' '}
                <span className="text-xs text-faint">claimed {w.createdAt.slice(0, 10)}</span>
                {w.evidence && <p className="mt-0.5 whitespace-pre-wrap text-subtle">{w.evidence}</p>}
                <button
                  type="button"
                  className={ui.linkBtn}
                  disabled={busy}
                  onClick={() => void vouch({ claim: w.claimId })}
                >
                  Confirm them as {w.authorName}
                </button>
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
          <p className="mb-2 text-subtle">
            They are confirmed at once, and can write the author section with you. They need an account with a confirmed
            institutional address; they can step down from the paper themselves.
          </p>
          <div className="flex flex-wrap items-start gap-x-2 narrow:flex-col narrow:items-stretch">
            <span className="min-w-0 flex-1">
              <select
                name="author"
                defaultValue=""
                className={ui.input}
                aria-label="Which author they are"
                required
                data-autofocus
              >
                <option value="" disabled>
                  Which author they are…
                </option>
                {open.map((a) => (
                  <option key={a.index} value={a.index}>
                    {a.name}
                  </option>
                ))}
              </select>
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
            <button type="submit" className={ui.btn({ inline: true, flush: true })} disabled={busy}>
              {busy ? 'Adding…' : 'Add'}
            </button>
          </div>
        </form>
      )}
      {note && <p className={ui.note(note.ok)}>{note.text}</p>}
    </div>
  );
}
