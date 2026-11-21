'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { authHref } from '@/lib/return-to';
import { EyeIcon, WITH_ICON } from './icons';

/** The page this tab showed last, for `from`: after this long, the next page is not "next". */
const LAST_PAGE_KEY = 'pp:lastPage';
const LAST_PAGE_MS = 30 * 60_000;

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
 * Measure how long the page is in view, and report it once as the reader leaves it (`POST /api/v1/views/time`):
 * closing the tab, putting it in the background, or going to another page in the app. Only time it was visible
 * counts. Returns the cleanup that reports on a client-side navigation.
 */
function reportTimeOnPage(pageId: string): () => void {
  let visibleMs = 0;
  let since: number | null = document.visibilityState === 'visible' ? performance.now() : null;
  let sent = false;
  const report = () => {
    if (since !== null) visibleMs += performance.now() - since;
    since = null;
    if (sent || visibleMs < 1000) return;
    sent = true;
    try {
      navigator.sendBeacon(
        '/api/v1/views/time',
        JSON.stringify({ page: pageId, seconds: Math.round(visibleMs / 1000) }),
      );
    } catch {
      // No beacon: the time is simply not counted.
    }
  };
  const onVisibility = () => {
    if (document.visibilityState === 'visible') since ??= performance.now();
    else report();
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', report);
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', report);
    report();
  };
}

/**
 * A page's unique viewers, as acceptodds shows a listing's: counted from the browser (`POST /api/v1/views`), so a
 * page served from the cache still counts and a crawler that runs no script does not. Sent with the session cookie,
 * so a signed-in reader counts as their account rather than as their network. The page is the same cached HTML for
 * everyone, so the count is the one the beacon returns. Also names the page this tab showed before (`from`), which
 * the server keeps only as a total per pair. Under the server's `MIN_SHOWN_VIEWS` it still counts, but shows
 * nothing. The number is for signed-in readers: anyone else sees it blurred, a stand-in the server never filled in,
 * with a link to sign in.
 */
export function ViewCount({ pageId, className = 'text-muted' }: { pageId: string; className?: string }) {
  const pathname = usePathname();
  const [state, setState] = useState<{ views: number | null; shown: boolean } | null>(null);

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
      .then((body: { views?: number | null; shown?: boolean } | null) => {
        if (typeof body?.shown === 'boolean') setState({ views: body.views ?? null, shown: body.shown });
      })
      .catch(() => {});
    return () => abort.abort();
  }, [pageId]);

  useEffect(() => reportTimeOnPage(pageId), [pageId]);

  if (!state?.shown) return null;
  const { views } = state;
  if (views === null) {
    return (
      <a
        href={authHref('/signin', pathname)}
        aria-label="Sign in to see page views"
        className={`group relative no-underline ${WITH_ICON} ${className} hover:text-ink`}
      >
        <EyeIcon />
        <span className="font-mono blur-[3px] select-none" aria-hidden>
          0,000
        </span>{' '}
        views
        <span
          role="tooltip"
          className="pointer-events-none absolute top-full left-1/2 z-10 mt-1 -translate-x-1/2 border border-frame bg-card px-2 py-1 text-xs whitespace-nowrap text-ink opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          Sign in to see page views
        </span>
      </a>
    );
  }
  return (
    <span className={`${WITH_ICON} ${className}`}>
      <EyeIcon />
      <span className="font-mono">{views.toLocaleString('en-US')}</span> {views === 1 ? 'view' : 'views'}
    </span>
  );
}
