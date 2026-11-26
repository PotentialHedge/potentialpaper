'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { NAV_ITEMS, pluginNavItems } from '@/lib/nav';
import { arrangePanels } from '@/lib/panels';
import { usePlugins } from '@/lib/plugins/client';
import { authHref, VERIFY_EMAIL } from '@/lib/return-to';
import { noteSignedIn, useSetting } from '@/lib/settings/client';
import { ConfirmBanner } from './ConfirmBanner';
import { SettingsImport } from './SettingsImport';
import { track } from '@/lib/track';

const signInClicked = () => track('signin_prompt_clicked', { target: 'nav' });

interface SeenViewer {
  handle: string;
  isAdmin: boolean;
  profileComplete: boolean;
}

function SignIn() {
  const pathname = usePathname();
  const qs = useSearchParams().toString();
  return (
    <Link href={authHref('/signin', qs ? `${pathname}?${qs}` : pathname)} onClick={signInClicked}>
      sign in
    </Link>
  );
}

/**
 * The navbar's links (`lib/nav.ts`): the site's and installed plugins', as the reader's `navbar.order` and
 * `navbar.hidden` arrange them. Plugins are known only once fetched, so their links join after load.
 */
function NavLinks({ signedIn }: { signedIn: boolean }) {
  const order = useSetting<string[] | undefined>('navbar.order') ?? [];
  const hidden = useSetting<string[] | undefined>('navbar.hidden') ?? [];
  const { plugins } = usePlugins(null);
  const items = [...NAV_ITEMS.filter((i) => signedIn || !i.signedIn), ...pluginNavItems(plugins)];
  const byId = new Map(items.map((i) => [i.id, i]));
  const shown = arrangePanels(
    items.map((i) => i.id),
    hidden.filter((id) => !byId.get(id)?.locked),
    order,
  );
  return shown.map((id) => (
    <Link key={id} href={byId.get(id)!.href}>
      {byId.get(id)!.title}
    </Link>
  ));
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
              <NavLinks signedIn />
              <Link href="/profile">@{viewer.handle}</Link>
            </>
          ) : (
            <Link href={authHref(VERIFY_EMAIL, pathname)}>finish your profile</Link>
          )
        ) : viewer === null ? (
          <>
            <NavLinks signedIn={false} />
            <Suspense
              fallback={
                <Link href="/signin" onClick={signInClicked}>
                  sign in
                </Link>
              }
            >
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
