'use client';

import { useState } from 'react';
import { ui } from '@/components/ui';
import { failureOf, send } from './api';

/**
 * "Might belong here" (`handoffs/pages.md` Phase 5): papers the machine suggests for a topic, each with confirm (the
 * paper is linked to the topic, as the reader's edit) and dismiss (remembered, so it doesn't come back). Rendered
 * on the server for every reader; deciding needs a verified account, which the server checks.
 */

export interface SuggestionRow {
  identifier: string;
  url: string;
  title: string;
  year: number | null;
  reason: string;
  matched: string;
}

const WHY: Record<string, (matched: string) => string> = {
  keyword: (m) => `its authors gave the keyword “${m}”`,
  title: (m) => `“${m}” is in its title`,
  abstract: (m) => `“${m}” is in its abstract`,
};

export function TopicSuggestions({
  topic,
  initial,
  total,
}: {
  topic: string;
  initial: SuggestionRow[];
  total: number;
}) {
  const [rows, setRows] = useState(initial);
  const [left, setLeft] = useState(total);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function decide(row: SuggestionRow, action: 'confirm' | 'dismiss', label?: 'introduces-topic') {
    setBusy(row.identifier);
    setProblem(null);
    try {
      const res = await send('POST', `/pages/${encodeURIComponent(topic)}/suggestions`, {
        paper: row.identifier,
        action,
        ...(label ? { label } : {}),
      });
      if (!res.ok) return setProblem((await failureOf(res)).message);
      setRows((list) => list.filter((r) => r.identifier !== row.identifier));
      setLeft((n) => n - 1);
    } catch {
      setProblem('Could not reach the server.');
    } finally {
      setBusy(null);
    }
  }

  if (rows.length === 0) {
    return (
      <p className={ui.empty}>
        {left > 0
          ? 'Reload for more.'
          : 'Nothing suggested here now. Suggestions come from names, titles and keywords.'}
      </p>
    );
  }
  return (
    <div className="font-sans text-sm">
      <p className="text-[13px] text-muted">
        {left.toLocaleString('en')} paper{left === 1 ? '' : 's'} might belong here, found by the topic&apos;s names.
        Confirm those that do; dismissed ones don&apos;t come back.
      </p>
      {problem && <p className={ui.note(false)}>{problem}</p>}
      <ul className="mt-2 space-y-2">
        {rows.map((row) => (
          <li key={row.identifier}>
            <a href={new URL(row.url).pathname} className="font-serif text-[15px]">
              {row.title}
            </a>
            {row.year && <span className="text-faint"> {row.year}</span>}
            <span className="block text-xs text-muted">{(WHY[row.reason] ?? (() => ''))(row.matched)}</span>
            <span className="flex flex-wrap gap-x-3 text-xs">
              <button
                type="button"
                className={ui.linkBtn}
                disabled={busy !== null}
                onClick={() => void decide(row, 'confirm')}
              >
                It is about this
              </button>
              <button
                type="button"
                className={ui.linkBtn}
                disabled={busy !== null}
                onClick={() => void decide(row, 'confirm', 'introduces-topic')}
              >
                It introduced this
              </button>
              <button
                type="button"
                className={ui.linkBtn}
                disabled={busy !== null}
                onClick={() => void decide(row, 'dismiss')}
              >
                Not about this
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
