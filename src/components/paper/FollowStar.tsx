'use client';

import { track } from '@/lib/track';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { StarIcon, WITH_ICON } from '@/components/icons';
import { authHref } from '@/lib/return-to';
import type { PaperId } from '@/lib/paper-ids';

/**
 * The star under a paper's title: follow the paper, to be mailed its edits and comments (`server/follows.ts`). The
 * page is the same cached HTML for everyone, so whether the viewer follows it is asked for here, after load.
 * Nobody signed in: the star leads to sign-in and back.
 */
export function FollowStar({ paper, className }: { paper: PaperId; className: string }) {
  const pathname = usePathname();
  const [state, setState] = useState<{ following: boolean | null; followers: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const query = new URLSearchParams({ scheme: paper.scheme, value: paper.value }).toString();

  useEffect(() => {
    let live = true;
    fetch(`/api/v1/follows?${query}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => live && body && setState(body))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [query]);

  const count = state && state.followers > 0 ? <span className="tabular-nums">{state.followers}</span> : null;
  if (state?.following === null) {
    return (
      <a
        href={authHref('/signin', pathname)}
        className={`${className} ${WITH_ICON}`}
        title="Sign in to follow"
        onClick={() => track('signin_prompt_clicked', { target: 'follow' })}
        data-seen-event="signin_prompt_shown"
        data-seen-target="follow"
      >
        <StarIcon />
        follow {count}
      </a>
    );
  }
  const following = state?.following ?? false;
  return (
    <button
      type="button"
      disabled={busy || state === null}
      aria-pressed={following}
      title={
        failed
          ? 'Could not save that; try again'
          : following
            ? 'You get an email when this page is edited or someone comments. Click to unfollow.'
            : 'Get an email when this page is edited or someone comments'
      }
      className={`${className} ${WITH_ICON}`}
      onClick={async () => {
        setBusy(true);
        setFailed(false);
        const res = await fetch(
          following ? `/api/v1/follows?${query}` : '/api/v1/follows',
          following
            ? { method: 'DELETE' }
            : {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ paper }),
              },
        ).catch(() => null);
        setBusy(false);
        const body = res?.ok ? await res.json().catch(() => null) : null;
        if (body) {
          setState(body);
          track('follow_toggled', { following: !following });
        } else setFailed(true);
      }}
    >
      <StarIcon filled={following} />
      {following ? 'following' : 'follow'} {count}
    </button>
  );
}
