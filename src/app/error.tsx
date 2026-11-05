'use client';

import { ui } from '@/components/ui';

/** Mostly a source for a new paper being busy or down, which clears up by itself. Never cached. */
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className={ui.page}>
      <h1 className="mt-6 text-[26px] font-normal">Not available right now</h1>
      <p className="my-4">
        We couldn&apos;t load this page. If it&apos;s a paper we haven&apos;t seen before, its source may be busy.
        Please try again in a moment.
      </p>
      <button className={ui.btn({ inline: true })} onClick={reset}>
        Try again
      </button>
    </main>
  );
}
