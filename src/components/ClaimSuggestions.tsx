'use client';

import { venueLine } from '@/lib/paper-file';
import { useEffect, useState } from 'react';
import type { PaperId } from '@/lib/paper-ids';
import { ui } from './ui';

/** `GET /api/v1/me/claim-suggestions`'s rows. */
interface Suggestion {
  paper: PaperId;
  path: string;
  title: string;
  year: number | null;
  venue: string | null;
  authors: string[];
  byEmail: boolean;
  likely: number | null;
  taken: number[];
  /** Under anonymous review: every name but the viewer's own is blank. */
  underReview: boolean;
  mine: { authorIndex: number; status: string } | null;
}

/**
 * Papers the viewer may have written, most likely first (`server/claim-requests.ts`), with a search. One with their
 * address on its first page is claimed from the list; any other opens its claim page. On `/claim` and in onboarding.
 */
export function ClaimSuggestions({ autoFocus = false }: { autoFocus?: boolean }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Suggestion[] | null>(null);
  const [claimed, setClaimed] = useState<Record<string, { name: string; ok: boolean; text?: string }>>({});

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        fetch(`/api/v1/me/claim-suggestions?${new URLSearchParams(q.trim() ? { q: q.trim() } : {})}`, {
          signal: controller.signal,
          cache: 'no-store',
        })
          .then((res) => (res.ok ? res.json() : { papers: [] }))
          .then((body: { papers: Suggestion[] }) => setRows(body.papers))
          .catch(() => {});
      },
      q ? 250 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q]);

  async function claim(row: Suggestion, authorIndex: number) {
    const res = await fetch('/api/v1/claims', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paper: row.paper, authorIndex, evidence: '' }),
    }).catch(() => null);
    const body = await res?.json().catch(() => null);
    const name = row.authors[authorIndex];
    if (res?.ok && body?.claim?.status === 'confirmed') setClaimed((c) => ({ ...c, [row.path]: { name, ok: true } }));
    else
      setClaimed((c) => ({
        ...c,
        [row.path]: {
          name,
          ok: false,
          text: body?.error?.message ?? 'Could not claim it. Open it to try another way.',
        },
      }));
  }

  return (
    <div className="font-sans text-sm">
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search by title or author name"
        aria-label="Search papers"
        autoFocus={autoFocus}
        className={ui.input}
      />
      {rows === null ? (
        <p className="text-muted">Looking…</p>
      ) : rows.length === 0 ? (
        <p className="text-muted">
          {q.trim()
            ? 'No papers match.'
            : 'No suggestions yet. Search for a paper you wrote; once you claim one, papers with your name show up here.'}
        </p>
      ) : (
        <ul className="divide-y divide-rule-soft">
          {rows.map((row) => {
            const done = claimed[row.path];
            const likely = row.likely !== null && !row.taken.includes(row.likely) ? row.likely : null;
            return (
              <li key={row.path} className="flex items-baseline gap-3 py-2 narrow:flex-col narrow:gap-1">
                <div className="min-w-0 flex-1">
                  <a href={row.path} className="font-serif text-[15px]">
                    {row.title}
                  </a>
                  <div className="text-xs text-muted">
                    {row.underReview
                      ? 'Under review, so its authors are hidden'
                      : row.authors.map((name, i) => (
                          <span key={i}>
                            {i > 0 && ', '}
                            <span
                              className={i === (row.mine?.authorIndex ?? row.likely) ? 'font-semibold text-ink' : ''}
                            >
                              {name}
                            </span>
                          </span>
                        ))}
                    {(row.venue || row.year) && <span className="text-faint"> · {venueLine(row.venue, row.year)}</span>}
                  </div>
                </div>
                <div className="shrink-0 text-right whitespace-nowrap">
                  {done?.ok || row.mine?.status === 'confirmed' ? (
                    <span className="text-up">You, as {done?.name ?? row.authors[row.mine!.authorIndex]}</span>
                  ) : row.mine?.status === 'pending' ? (
                    <a href={`/claim${row.path}`}>Waiting · open</a>
                  ) : row.byEmail && likely !== null && !done ? (
                    <button type="button" className={ui.linkBtn} onClick={() => void claim(row, likely)}>
                      Claim as {row.authors[likely]}
                    </button>
                  ) : (
                    <a href={`/claim${row.path}`}>{row.byEmail ? 'Claim' : 'Claim or ask'}</a>
                  )}
                  {done && !done.ok && <div className={ui.note(false)}>{done.text}</div>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
