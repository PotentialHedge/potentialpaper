'use client';

import { Select } from '@/components/Select';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ui } from '@/components/ui';
import { STATUS_LABELS, type SubmissionStatus } from '@/lib/submissions';

/**
 * A venue's submissions, by status, with filters (`handoffs/pages.md` Phase 2): a status, a decision as the venue
 * words it, words in the title. The server renders the first page of everything, so the list is there without
 * JavaScript and the page stays the same HTML for every reader; filters and further pages are fetched from
 * `GET /api/v1/pages/{identifier}/venue-papers`.
 */

type Status = SubmissionStatus | 'unknown';

export interface VenuePapersData {
  total: number;
  papers: {
    title: string;
    identifier: string | null;
    address: string | null;
    status: Status;
    decision: string | null;
    number: number | null;
    url: string | null;
    venue: { identifier: string; address: string; name: string } | null;
  }[];
  nextOffset: number | null;
}

const STATUS_ORDER: Status[] = ['accepted', 'under_review', 'rejected', 'desk_rejected', 'withdrawn', 'unknown'];
const statusLabel = (status: Status) => (status === 'unknown' ? 'Status unknown' : STATUS_LABELS[status]);

interface Filter {
  status: Status | null;
  decision: string | null;
  q: string;
}

const PAGE = 50;

export function VenuePapersList({
  identifier,
  initial,
  counts,
  decisions,
}: {
  identifier: string;
  initial: VenuePapersData;
  /** Submissions by status, rolled up; `total` is all of them. */
  counts: Partial<Record<Status, number>> & { total: number };
  decisions: { decision: string; count: number }[];
}) {
  const [filter, setFilter] = useState<Filter>({ status: null, decision: null, q: '' });
  const [data, setData] = useState<VenuePapersData>(initial);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const first = useRef(true);
  const request = useRef(0);

  async function load(next: Filter, offset: number) {
    const id = ++request.current;
    setBusy(true);
    setProblem(null);
    const query = new URLSearchParams({ offset: String(offset), limit: String(PAGE) });
    if (next.status) query.set('status', next.status);
    if (next.decision) query.set('decision', next.decision);
    if (next.q.trim()) query.set('q', next.q.trim());
    try {
      const res = await fetch(`/api/v1/pages/${encodeURIComponent(identifier)}/venue-papers?${query}`);
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as VenuePapersData;
      if (id !== request.current) return;
      setData((before) => (offset === 0 ? body : { ...body, papers: [...before.papers, ...body.papers] }));
    } catch {
      if (id === request.current) setProblem('Could not load the papers. Try again.');
    } finally {
      if (id === request.current) setBusy(false);
    }
  }

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    void load(filter, 0);
    // `load` reads only its arguments and refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter.status, filter.decision, filter.q]);

  const [text, setText] = useState('');
  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFilter((f) => ({ ...f, q: text }));
  }

  if (counts.total === 0) return <p className={ui.empty}>No submissions here yet.</p>;
  const statuses = STATUS_ORDER.filter((status) => (counts[status] ?? 0) > 0);
  const filtered = filter.status !== null || filter.decision !== null || filter.q.trim() !== '';
  return (
    <div className="font-sans text-sm">
      <p className="flex flex-wrap gap-x-3 gap-y-1" aria-label="Status">
        <button
          type="button"
          className={filter.status === null ? ui.on : ui.linkBtn}
          aria-pressed={filter.status === null}
          onClick={() => setFilter((f) => ({ ...f, status: null }))}
        >
          All {counts.total.toLocaleString('en')}
        </button>
        {statuses.map((status) => (
          <button
            key={status}
            type="button"
            className={filter.status === status ? ui.on : ui.linkBtn}
            aria-pressed={filter.status === status}
            onClick={() => setFilter((f) => ({ ...f, status }))}
          >
            {statusLabel(status)} {(counts[status] ?? 0).toLocaleString('en')}
          </button>
        ))}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        {decisions.length > 1 && (
          <label className="flex items-center gap-1.5">
            <span className="text-muted">Decision</span>
            <Select
              compact
              className=""
              value={filter.decision ?? ''}
              onChange={(event) => setFilter((f) => ({ ...f, decision: event.target.value || null }))}
            >
              <option value="">Any</option>
              {decisions.map((d) => (
                <option key={d.decision} value={d.decision}>
                  {d.decision} ({d.count.toLocaleString('en')})
                </option>
              ))}
            </Select>
          </label>
        )}
        <form onSubmit={search} className="flex min-w-[220px] flex-1" role="search">
          <input
            className={ui.searchInput}
            type="search"
            placeholder="Words in the title"
            aria-label="Words in the title"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <button type="submit" className={ui.searchBtn}>
            Filter
          </button>
        </form>
      </div>
      <p className={ui.fine} aria-live="polite">
        {busy
          ? 'Loading…'
          : filtered
            ? `${data.total.toLocaleString('en')} matching`
            : `${data.total.toLocaleString('en')} submissions`}
      </p>
      {problem && <p className={ui.note(false)}>{problem}</p>}
      {data.papers.length === 0 && !busy ? (
        <p className={ui.empty}>Nothing matches.</p>
      ) : (
        <div className={ui.tableScroll}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th(true)}>#</th>
                <th className={ui.th()}>Paper</th>
                <th className={ui.th()}>Decision</th>
              </tr>
            </thead>
            <tbody>
              {data.papers.map((paper, i) => (
                <tr key={`${paper.identifier ?? paper.title}-${paper.venue?.identifier ?? ''}-${i}`}>
                  <td className={`${ui.td} ${ui.num} align-top text-faint`}>{paper.number ?? ''}</td>
                  <td className={`${ui.td} align-top font-serif text-[15px]`}>
                    {paper.address ? <a href={paper.address}>{paper.title}</a> : paper.title}
                    {paper.venue && (
                      <span className={ui.badge}>
                        <a href={paper.venue.address}>{paper.venue.name}</a>
                      </span>
                    )}
                  </td>
                  <td className={`${ui.td} align-top text-muted`}>
                    {paper.decision ?? statusLabel(paper.status)}
                    {paper.url && (
                      <>
                        {' '}
                        <a href={paper.url} className="text-faint" aria-label={`${paper.title} at its source`}>
                          ↗
                        </a>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.nextOffset !== null && (
        <button
          type="button"
          className={ui.btn({ ghost: true, inline: true })}
          disabled={busy}
          onClick={() => void load(filter, data.nextOffset!)}
        >
          Show more
        </button>
      )}
    </div>
  );
}
