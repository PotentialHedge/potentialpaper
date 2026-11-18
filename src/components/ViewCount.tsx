'use client';

import { useEffect, useState } from 'react';

/** The page this tab showed last, for `from`: after this long, the next page is not "next". */
const LAST_PAGE_KEY = 'pp:lastPage';
const LAST_PAGE_MS = 30 * 60_000;

/** Below this many views the count is not shown: a handful reads as neglect, not information. */
const MIN_SHOWN_VIEWS = 10;

interface LastPage {
  id: string;
  /** The page before it, kept so a reload (or React re-running the effect) sends the same pair. */
  from: string | null;
  at: number;
}

/**
 * The page read just before this one in this tab, and remember this one. `sessionStorage`, so per tab and gone with
 * it; `document.referrer` would not do, as a client-side navigation leaves it unchanged.
 */
function previousPage(pageId: string): string | null {
  try {
    const raw = sessionStorage.getItem(LAST_PAGE_KEY);
    const last = raw ? (JSON.parse(raw) as LastPage) : null;
    const now = Date.now();
    let from: string | null = null;
    if (last && now - last.at < LAST_PAGE_MS) from = last.id === pageId ? last.from : last.id;
    sessionStorage.setItem(LAST_PAGE_KEY, JSON.stringify({ id: pageId, from, at: now } satisfies LastPage));
    return from;
  } catch {
    return null;
  }
}

/**
 * A page's unique viewers, as acceptodds shows a listing's: counted from the browser (`POST /api/v1/views`), so a
 * page served from the cache still counts and a crawler that runs no script does not. Sent with the session cookie,
 * so a signed-in reader counts as their account rather than as their network. The page is the same cached HTML for
 * everyone, so the count is the one the beacon returns. Also names the page this tab showed before (`from`), which
 * the server keeps only as a total per pair. Under `MIN_SHOWN_VIEWS` it still counts, but shows nothing.
 */
export function ViewCount({ pageId, className = 'text-muted' }: { pageId: string; className?: string }) {
  const [views, setViews] = useState<number | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    const from = previousPage(pageId);
    fetch('/api/v1/views', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(from ? { page: pageId, from } : { page: pageId }),
      signal: abort.signal,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { views?: number } | null) => {
        if (typeof body?.views === 'number') setViews(body.views);
      })
      .catch(() => {});
    return () => abort.abort();
  }, [pageId]);

  if (views === null || views < MIN_SHOWN_VIEWS) return null;
  return (
    <span className={className}>
      <span className="font-mono">{views.toLocaleString('en-US')}</span> {views === 1 ? 'view' : 'views'}
    </span>
  );
}
