'use client';

import { useEffect, useState } from 'react';
import type { PaperId } from '@/lib/paper-ids';

/** Below this many views the count is not shown: a handful reads as neglect, not information. */
const MIN_SHOWN_VIEWS = 10;

/**
 * A paper's unique viewers, as acceptodds shows a listing's: counted from the browser (`POST /api/v1/views`), so a
 * page served from the cache still counts and a crawler that runs no script does not. Sent with the session cookie,
 * so a signed-in reader counts as their account rather than as their network. The page is the same cached HTML for
 * everyone, so the count is the one the beacon returns. Under `MIN_SHOWN_VIEWS` it still counts, but shows nothing.
 */
export function ViewCount({ paper }: { paper: PaperId }) {
  const [views, setViews] = useState<number | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    fetch('/api/v1/views', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paper: { scheme: paper.scheme, value: paper.value } }),
      signal: abort.signal,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { views?: number } | null) => {
        if (typeof body?.views === 'number') setViews(body.views);
      })
      .catch(() => {});
    return () => abort.abort();
  }, [paper.scheme, paper.value]);

  if (views === null || views < MIN_SHOWN_VIEWS) return null;
  return (
    <span className="text-muted">
      <span className="font-mono">{views.toLocaleString('en-US')}</span> {views === 1 ? 'view' : 'views'}
    </span>
  );
}
