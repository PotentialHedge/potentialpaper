'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ui } from '@/components/ui';

/**
 * On a person's page, for that person only: a way back to `/profile` to edit it. The page is the same cached HTML
 * for every reader, so who is reading is asked after load, as the navbar does (`NavUser.tsx`).
 */
export function OwnProfileLink({ handle }: { handle: string }) {
  const [own, setOwn] = useState(false);
  useEffect(() => {
    let current = true;
    fetch('/api/v1/viewer', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => current && setOwn(body?.viewer?.handle?.toLowerCase() === handle.toLowerCase()))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [handle]);
  if (!own) return null;
  return (
    <p className="mt-2.5 text-center font-sans text-[13px]">
      <Link href="/profile" className={ui.btn({ ghost: true, inline: true, flush: true })}>
        edit your profile
      </Link>
    </p>
  );
}
