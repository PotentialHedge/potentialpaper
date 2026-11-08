'use client';

import { useRef, type ReactNode } from 'react';
import { ui } from '@/components/ui';
import { closeEditor, useScrollIntoView, type Opening } from './editing';

/**
 * What every editor on the page sits in: a frame where the part it edits was, so that the page keeps its
 * layout and the editor reads as that part, opened. `className` is its margins and width.
 */
export function EditorFrame({
  label,
  children,
  className = 'my-3',
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useScrollIntoView(ref);
  return (
    <div
      ref={ref}
      className={`relative scroll-mt-4 border border-frame bg-card p-3 font-sans text-sm shadow-[0_0_0_3px] shadow-highlight ${className}`}
    >
      <p className="absolute -top-2.5 left-2 bg-card px-1 text-[11px] tracking-wide text-subtle uppercase">{label}</p>
      {children}
    </div>
  );
}

/** The editor until it has opened: loading, or why this viewer can't edit it. */
export function NotOpened({
  opening,
  claimPath,
}: {
  opening: Exclude<Opening<unknown>, { status: 'ready' }>;
  claimPath: string;
}) {
  if (opening.status === 'loading') return <p className="text-muted italic">Opening the editor…</p>;
  return (
    <div>
      <p className={ui.note(false)}>
        {opening.message.charAt(0).toUpperCase() + opening.message.slice(1).replace(/\.$/, '')}.{' '}
        {opening.code === 'not_verified' && <a href="/profile#affiliations">Add one on your profile</a>}
        {opening.code === 'forbidden' && (
          <a href={claimPath} rel="nofollow">
            Are you an author? Claim the paper
          </a>
        )}
      </p>
      <button type="button" onClick={closeEditor} className={`${ui.linkBtn} mt-2`}>
        Close
      </button>
    </div>
  );
}
