'use client';

import { type ReactNode, useEffect, useState } from 'react';
import { ui } from '@/components/ui';
import { setSetting, settingsSnapshot, useSetting } from '@/lib/settings/client';
import type { ReviewVenue } from '@/server/under-review';

const NOT_REVIEWER = 'paper.notReviewerAt';
/** On `<html>`: the venues the reader isn't a reviewer at, space-separated, for the CSS below. */
const ATTRIBUTE = 'data-not-reviewer-at';

/**
 * Run as the HTML is parsed, before the first paint: copies the reader's last known `paper.notReviewerAt` (the
 * settings cache, `lib/settings/client.ts`) onto `<html>`, so a page the reader already chose to see isn't drawn
 * blurred with the box over it until React starts. A source string, so it can be inlined.
 */
const EARLY = `try{var v=JSON.parse(localStorage.getItem('pp.settings.resolved')||'{}')[${JSON.stringify(NOT_REVIEWER)}];if(Array.isArray(v))document.documentElement.setAttribute('${ATTRIBUTE}',v.join(' '))}catch(e){}`;

/** Unblurs this page and hides its box when `<html>` lists every venue it is under review at. */
function earlyStyle(venues: ReviewVenue[]): string {
  const when = `html${venues.map((v) => `[${ATTRIBUTE}~=${JSON.stringify(v.id)}]`).join('')}`;
  return `${when} [data-review-box]{display:none}${when} [data-review-blur]>*,${when} [data-review-blur] article>*{filter:none!important}`;
}

/**
 * Reviewer mode: a paper still under review at a venue (`server/under-review.ts`) is shown blurred but for its title,
 * so a reviewer can find it without seeing who wrote it or what others think of it, until they choose to. The page is
 * the same cached HTML for everyone, blurred, and is shown in the browser. "Show the page" shows this paper only; a
 * ticked "I'm not a reviewer at <venue>" is kept in `paper.notReviewerAt`, and that venue's papers aren't blurred
 * again. A paper under review at several venues is blurred until the reader is listed as not reviewing at all of them.
 */
export function ReviewBlur({ venues, children }: { venues: ReviewVenue[]; children: ReactNode }) {
  const notAt = useSetting<string[]>(NOT_REVIEWER);
  const [shown, setShown] = useState(false);
  const [ticked, setTicked] = useState<string[]>([]);
  // Kept current, for a page this tab opens next.
  useEffect(() => {
    document.documentElement.setAttribute(ATTRIBUTE, notAt.join(' '));
  }, [notAt]);
  if (shown || venues.every((v) => notAt.includes(v.id))) return children;
  const show = () => {
    setShown(true);
    if (ticked.length === 0) return;
    const current = (settingsSnapshot().values[NOT_REVIEWER] as string[] | undefined) ?? [];
    setSetting(NOT_REVIEWER, [...new Set([...current, ...ticked])]).catch(() => {
      // Not saved: this paper is shown, and the venue's next one asks again.
    });
  };
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: EARLY }} />
      <style dangerouslySetInnerHTML={{ __html: earlyStyle(venues) }} />
      <div
        inert
        data-review-blur
        className="pointer-events-none select-none [&_article>:not(h1)]:blur-[6px] [&>:not(article)]:blur-[6px]"
      >
        {children}
      </div>
      <div data-review-box className="fixed inset-x-0 top-1/3 z-40 flex justify-center px-4">
        <div className={`${ui.box} max-w-[420px] text-center shadow-lg`}>
          <p className="font-semibold">This paper is under review</p>
          {venues
            .filter((v) => !notAt.includes(v.id))
            .map((v) => (
              <label
                key={v.id}
                className="mt-3 flex cursor-pointer items-center justify-center gap-2 font-sans text-sm"
              >
                <input
                  type="checkbox"
                  checked={ticked.includes(v.id)}
                  onChange={(e) => setTicked((t) => (e.target.checked ? [...t, v.id] : t.filter((id) => id !== v.id)))}
                />
                I&apos;m not a reviewer at {v.name}
              </label>
            ))}
          <button type="button" className={ui.btn()} onClick={show}>
            Show the page
          </button>
        </div>
      </div>
    </>
  );
}
