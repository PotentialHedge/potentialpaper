'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ui } from '@/components/ui';
import type { FollowedPaper } from '@/server/follows';

/** `server/follows.ts`'s rows, with the date as a string to cross to the client. */
export type FollowingRow = Omit<FollowedPaper, 'followedAt'> & { followedAt: string };

/**
 * The papers the viewer follows, as Table `n`, each with a button to unfollow (`DELETE /api/v1/follows`). An
 * unfollowed row stays, struck through, with a button to follow it again, so a slip is one click to undo.
 */
export function FollowingPapers({ initial: rows, n }: { initial: FollowingRow[]; n: number }) {
  const [off, setOff] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function toggle(row: FollowingRow) {
    const following = !off.has(row.paperId);
    setBusy(row.paperId);
    setProblem(null);
    const query = new URLSearchParams({ scheme: row.canonical.scheme, value: row.canonical.value });
    const res = await fetch(
      following ? `/api/v1/follows?${query}` : '/api/v1/follows',
      following
        ? { method: 'DELETE' }
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ paper: row.canonical }),
          },
    ).catch(() => null);
    setBusy(null);
    if (!res?.ok)
      return setProblem(res?.status === 401 ? 'Your session ended. Sign in again.' : 'Could not save that.');
    setOff((prev) => {
      const next = new Set(prev);
      if (following) next.add(row.paperId);
      else next.delete(row.paperId);
      return next;
    });
  }

  return (
    <div className="font-sans text-sm">
      <div className={ui.tableScroll}>
        <table className={ui.table}>
          <caption className={ui.tableCaption}>
            <b>Table {n}.</b> Papers you follow, most recently followed first. You get an email when one&apos;s page is
            edited (at most one an hour per paper) or someone comments on it.
          </caption>
          <thead>
            <tr>
              <th className={ui.th()}>Paper</th>
              <th className={ui.th()}>Since</th>
              <th className={ui.th()} />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const unfollowed = off.has(row.paperId);
              return (
                <tr key={row.paperId} className="align-baseline">
                  <td className={`${ui.td} font-serif ${unfollowed ? 'text-muted line-through' : ''}`}>
                    <Link href={row.path}>{row.title}</Link>
                    {(row.year || row.venue) && (
                      <div className="font-sans text-xs text-faint">
                        {[row.venue, row.year].filter(Boolean).join(' ')}
                      </div>
                    )}
                  </td>
                  <td className={`${ui.td} whitespace-nowrap text-subtle tabular-nums`}>
                    {row.followedAt.slice(0, 10)}
                  </td>
                  <td className={`${ui.td} text-right whitespace-nowrap`}>
                    <button
                      type="button"
                      className={ui.linkBtn}
                      disabled={busy === row.paperId}
                      onClick={() => void toggle(row)}
                    >
                      {unfollowed ? 'follow again' : 'unfollow'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {problem && <div className={ui.note(false)}>{problem}</div>}
      <p className={ui.fine}>
        To stop all of these emails without unfollowing, turn them off on your{' '}
        <Link href="/profile#email">profile</Link>.
      </p>
    </div>
  );
}
