'use client';

import { useRef, useState } from 'react';
import { ui } from '@/components/ui';
import { STATUS_LABELS, type SubmissionStatus } from '@/lib/submissions';

/**
 * A topic's papers (`handoffs/pages.md` Phase 5), rolled up from its narrower topics, sorted by date, venue or score.
 * The server renders the first page by date, so the list is there without JavaScript and the page is the same HTML
 * for every reader; another order and further pages come from `GET /api/v1/pages/{identifier}/topic-papers`.
 */

export interface TopicPapersData {
  total: number;
  papers: {
    title: string;
    identifier: string | null;
    address: string | null;
    year: number | null;
    introduces: boolean;
    via: { identifier: string; address: string; name: string } | null;
    venue: { id: string; name: string; identifier: string | null; address: string | null } | null;
    status: SubmissionStatus | null;
    decision: string | null;
    score: { mean: number; min: number | null; max: number | null; label: string } | null;
  }[];
  nextOffset: number | null;
}

const SORTS = [
  { sort: 'date', words: 'Newest' },
  { sort: 'venue', words: 'By venue' },
  { sort: 'score', words: 'By review score' },
] as const;
type Sort = (typeof SORTS)[number]['sort'];

const PAGE = 50;

export function TopicPapersList({ identifier, initial }: { identifier: string; initial: TopicPapersData }) {
  const [sort, setSort] = useState<Sort>('date');
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const request = useRef(0);

  async function load(next: Sort, offset: number) {
    const id = ++request.current;
    setBusy(true);
    setProblem(null);
    try {
      const query = new URLSearchParams({ sort: next, offset: String(offset), limit: String(PAGE) });
      const res = await fetch(`/api/v1/pages/${encodeURIComponent(identifier)}/topic-papers?${query}`);
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as TopicPapersData;
      if (id !== request.current) return;
      setData((before) => (offset === 0 ? body : { ...body, papers: [...before.papers, ...body.papers] }));
    } catch {
      if (id === request.current) setProblem('Could not load the papers. Try again.');
    } finally {
      if (id === request.current) setBusy(false);
    }
  }

  if (initial.total === 0) {
    return (
      <p className={ui.empty}>
        No papers here yet. Add one from its page (&ldquo;Add a topic&rdquo;), or confirm one that might belong here.
      </p>
    );
  }
  return (
    <div className="font-sans text-sm">
      <p className="flex flex-wrap gap-x-3 gap-y-1" aria-label="Order">
        {SORTS.map((s) => (
          <button
            key={s.sort}
            type="button"
            className={sort === s.sort ? ui.on : ui.linkBtn}
            aria-pressed={sort === s.sort}
            onClick={() => {
              setSort(s.sort);
              void load(s.sort, 0);
            }}
          >
            {s.words}
          </button>
        ))}
      </p>
      <p className={ui.fine} aria-live="polite">
        {busy ? 'Loading…' : `${data.total.toLocaleString('en')} paper${data.total === 1 ? '' : 's'}`}
      </p>
      {problem && <p className={ui.note(false)}>{problem}</p>}
      <div className={ui.tableScroll}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th()}>Paper</th>
              <th className={ui.th()}>Venue</th>
              <th className={ui.th(true)}>Score</th>
            </tr>
          </thead>
          <tbody>
            {data.papers.map((paper, i) => (
              <tr key={`${paper.identifier ?? paper.title}-${i}`}>
                <td className={`${ui.td} align-top font-serif text-[15px]`}>
                  {paper.address ? <a href={paper.address}>{paper.title}</a> : paper.title}
                  {paper.year && <span className="text-faint"> {paper.year}</span>}
                  {paper.introduces && <span className={ui.badge}>introduced it</span>}
                  {paper.via && (
                    <span className={ui.badge}>
                      <a href={paper.via.address}>{paper.via.name}</a>
                    </span>
                  )}
                </td>
                <td className={`${ui.td} align-top text-muted`}>
                  {paper.venue ? (
                    paper.venue.address ? (
                      <a href={paper.venue.address}>{paper.venue.name}</a>
                    ) : (
                      paper.venue.name
                    )
                  ) : (
                    ''
                  )}
                  {paper.venue && (paper.decision || paper.status) && (
                    <span className="block text-xs text-faint">
                      {paper.decision ?? (paper.status ? STATUS_LABELS[paper.status] : '')}
                    </span>
                  )}
                </td>
                <td
                  className={`${ui.td} ${ui.num} align-top`}
                  title={paper.score ? `Mean ${paper.score.label.toLowerCase()} over its reviews` : undefined}
                >
                  {paper.score ? (
                    <>
                      {paper.score.mean.toFixed(1)}
                      {paper.score.max !== null && <span className="text-faint"> / {paper.score.max}</span>}
                    </>
                  ) : (
                    ''
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.nextOffset !== null && (
        <button
          type="button"
          className={ui.btn({ ghost: true, inline: true })}
          disabled={busy}
          onClick={() => void load(sort, data.nextOffset!)}
        >
          Show more
        </button>
      )}
    </div>
  );
}
