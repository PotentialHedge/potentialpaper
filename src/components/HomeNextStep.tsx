'use client';

import { useEffect, useState } from 'react';
import type { TutorialExample } from './GettingStarted';
import { GettingStartedSheet } from './GettingStartedSheet';
import { OnboardAgent } from './OnboardAgent';
import { ui } from './ui';

type Seen = { profileComplete: boolean; hasAgent: boolean } | null;

/**
 * The home page's one next step for the viewer, learned after load since the page is the same HTML for
 * everyone (DESIGN.md §2): getting started (a sheet, `GettingStartedSheet`) until they have finished it, then onboarding their agent, then
 * nothing once an agent holds a token for them.
 */
export function HomeNextStep({ example, host }: { example?: TutorialExample; host: string }) {
  const [seen, setSeen] = useState<Seen | undefined>(undefined);

  useEffect(() => {
    let current = true;
    fetch('/api/v1/viewer', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => current && setSeen(body?.viewer ?? null))
      .catch(() => current && setSeen(null));
    return () => {
      current = false;
    };
  }, []);

  if (seen === undefined || seen?.hasAgent) return null;
  return (
    <div className="mb-5 flex justify-center font-sans">
      {seen?.profileComplete ? (
        // Not on a phone, where no agent runs.
        <div className="narrow:hidden">
          <OnboardAgent className={`text-base font-semibold ${ui.linkBtn}`} />
        </div>
      ) : (
        <GettingStartedSheet example={example} host={host} signedIn={seen !== null} />
      )}
    </div>
  );
}
