'use client';

import { type ReactNode, useState } from 'react';
import { ui } from '@/components/ui';
import { setSetting, useSetting } from '@/lib/settings/client';

/**
 * Reviewer mode: a paper still under review at a venue (`server/under-review.ts`) is shown blurred but for its title,
 * so a reviewer can find it without seeing who wrote it or what others think of it, until they choose to. The page is
 * the same cached HTML for everyone, blurred, and is shown in the browser. "I'm not a reviewer" turns `review.blur` off,
 * so the reader is asked once, not on every paper; it can be turned back on in settings.
 */
export function ReviewBlur({ children }: { children: ReactNode }) {
  const blur = useSetting<boolean>('review.blur');
  const [shown, setShown] = useState(false);
  if (shown || blur === false) return children;
  const notReviewer = () => {
    setShown(true);
    setSetting('review.blur', false).catch(() => {
      // Not saved: this page is shown, and the next one asks again.
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
            Its page is blurred so you can read it without knowing its authors or what others say about it. You can turn this back on in settings.
          </p>
          <button type="button" className={ui.btn()} onClick={notReviewer}>
            I&apos;m not a reviewer
          </button>
        </div>
      </div>
    </>
  );
}
