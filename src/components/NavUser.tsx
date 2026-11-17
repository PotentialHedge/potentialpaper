'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { authHref, VERIFY_EMAIL } from '@/lib/return-to';
import { noteSignedIn } from '@/lib/settings/client';
import { ConfirmBanner } from './ConfirmBanner';
import { SettingsImport } from './SettingsImport';

interface SeenViewer {
  handle: string;
  isAdmin: boolean;
  profileComplete: boolean;
}

function SignIn() {
  const pathname = usePathname();
  const qs = useSearchParams().toString();
  return <Link href={authHref('/signin', qs ? `${pathname}?${qs}` : pathname)}>sign in</Link>;
}

/**
 * The navbar's viewer, filled in after load: the page itself stays the same HTML for every reader, so
 * that the edge can cache it (DESIGN.md §2). Refetched on navigation, since signing in or out happens
 * without a full page load.
 */
export function NavUser() {
  const pathname = usePathname();
  const [viewer, setViewer] = useState<SeenViewer | null | undefined>(undefined);

  useEffect(() => {
    let current = true;
    fetch('/api/v1/viewer', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!current) return;
        setViewer(body?.viewer ?? null);
        // Signing in or out changes whose settings.json applies.
        noteSignedIn(!!body?.viewer);
      })
      .catch(() => {
        if (current) setViewer(null);
      });
    return () => {
      current = false;
    };
  }, [pathname]);

  return (
    <>
      <nav aria-label="Main navigation" className="flex flex-wrap items-baseline gap-x-4.5 gap-y-1 text-sm">
        {viewer ? (
          viewer.profileComplete ? (
            <>
              <Link href="/papers">my papers</Link>
              <Link href="/changes">changes</Link>
              <Link href="/settings">settings</Link>
              <Link href="/profile">@{viewer.handle}</Link>
            </>
          ) : (
            <Link href={authHref(VERIFY_EMAIL, pathname)}>finish your profile</Link>
          )
        ) : viewer === null ? (
          <>
            <Link href="/changes">changes</Link>
            <Link href="/settings">settings</Link>
            <Suspense fallback={<Link href="/signin">sign in</Link>}>
              <SignIn />
            </Suspense>
          </>
        ) : null}
      </nav>
      {/* Out of the header's row, across the page. */}
      <div className="w-full empty:hidden">
        <ConfirmBanner signedIn={!!viewer} />
        {viewer && <SettingsImport />}
      </div>
    </>
  );
}
