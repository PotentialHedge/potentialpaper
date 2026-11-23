'use client';

import { type ReactNode, useState } from 'react';
import { ui } from '@/components/ui';
import { setSetting, settingsSnapshot, useSetting } from '@/lib/settings/client';
import type { ReviewVenue } from '@/server/under-review';

const NOT_REVIEWER = 'paper.notReviewerAt';

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
      <div
        inert
        className="pointer-events-none select-none [&_article>:not(h1)]:blur-[6px] [&>:not(article)]:blur-[6px]"
      >
        {children}
      </div>
      <div className="fixed inset-x-0 top-1/3 z-40 flex justify-center px-4">
        <div className={`${ui.box} max-w-[420px] text-center shadow-lg`}>
          <p className="font-semibold">This paper is under review</p>
          <p className="mt-1 text-subtle">
            Its page is blurred so you can read it without knowing its authors or what others say about it.
          </p>
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
