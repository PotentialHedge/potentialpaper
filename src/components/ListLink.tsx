'use client';

import Link, { useLinkStatus } from 'next/link';
import { type ComponentProps, type ReactNode, useEffect } from 'react';

/** On `<html>` while a list link's page is on its way: `globals.css` fades the list under it (`data-list`). */
const PENDING = 'data-list-pending';

/** The link's text, underlined while its page is on its way, with the page marked for the list to fade. */
function Pending({ children }: { children: ReactNode }) {
  const { pending } = useLinkStatus();
  useEffect(() => {
    if (!pending) return;
    document.documentElement.setAttribute(PENDING, '');
    return () => document.documentElement.removeAttribute(PENDING);
  }, [pending]);
  return <span className={pending ? 'underline decoration-dotted underline-offset-3' : undefined}>{children}</span>;
}

/**
 * A link that changes what the home list shows (a sort, a venue, a page). The page is rendered on the server, so a
 * click marks the link and fades the list at once, until the new one arrives.
 */
export function ListLink({ children, ...props }: ComponentProps<typeof Link>) {
  return (
    <Link {...props}>
      <Pending>{children}</Pending>
    </Link>
  );
}
