'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ComponentProps } from 'react';
import { HOME_VIEW_COOKIE, type HomeView } from '@/lib/home-view';

/**
 * A link to the home list's compact or detailed view, which is remembered (`HOME_VIEW_COOKIE`): a click keeps the
 * choice, then shows the list again with it. Extra props (a popover's close) go to the link.
 */
export function ViewChoice({
  view,
  href,
  ...rest
}: { view: HomeView; href: string } & Omit<ComponentProps<typeof Link>, 'href'>) {
  const router = useRouter();
  return (
    <Link
      {...rest}
      href={href}
      onClick={(event) => {
        rest.onClick?.(event);
        event.preventDefault();
        document.cookie = `${HOME_VIEW_COOKIE}=${view}; path=/; max-age=31536000; samesite=lax`;
        // The same address shows the list again with the cookie; another one is fetched with it anyway.
        if (`${location.pathname}${location.search}` === href) router.refresh();
        else router.push(href);
      }}
    >
      {view}
    </Link>
  );
}
