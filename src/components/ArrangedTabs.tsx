'use client';

import { track } from '@/lib/track';
import { type ReactNode, useEffect, useState } from 'react';
import { AnalyticsPanel, usePageAnalytics } from '@/components/pages/Analytics';
import { REPO_HASH, RepoTab, repoWhere } from '@/components/pages/RepoTab';
import { usePluginPanels } from '@/components/plugins/PluginPanel';
import { LockIcon, LockOpenIcon } from '@/components/icons';
import { ui } from '@/components/ui';
import { type ClaimPolicy, KINDS, type PageAddress } from '@/lib/kinds';
import { arrangePanels, type PanelKind } from '@/lib/panels';
import { useSetting } from '@/lib/settings/client';

/**
 * A `<kind>.tabs` slot: its panels as the reader's settings arrange them (as `ArrangedPanels`), shown one at a
 * time under a row of tabs, or alone when there is one. Panels are rendered on the server, the same for every
 * reader; only which one shows is decided here.
 *
 * With `lead`, that comes first as a tab of its own, which settings don't move or hide (a paper page's "Paper": the
 * page itself, which a plugin's tab is shown in place of). It stays mounted while another tab shows.
 */
export function ArrangedTabs({
  kind,
  slot,
  panels: builtIn,
  lead,
  pageId,
  claimPath,
  repo,
}: {
  kind: PanelKind;
  /** The slot's full name (`venue.tabs`), for plugins' panels, which join as tabs of their own. */
  slot?: string;
  panels: { id: string; title: string; node: ReactNode }[];
  lead?: { title: string; node: ReactNode };
  pageId?: string;
  /** Where to claim the page (`OwnersInfo.claimPath`): anyone else sees its Analytics tab locked, pointing there. */
  claimPath?: string | null;
  /** A page with files gets a Repo tab, its git repository browsed (`RepoTab`), loaded only once opened. */
  repo?: { address: PageAddress };
}) {
  const analytics = usePageAnalytics(pageId);
  const hidden = useSetting<string[]>(`${kind}.panels.hidden`);
  const order = useSetting<string[]>(`${kind}.panels.order`);
  const panels: {
    id: string;
    title: string;
    hint?: string;
    locked?: boolean;
    lock?: 'open' | 'shut';
    node: ReactNode;
  }[] = [...builtIn, ...usePluginPanels(slot)];
  // The Repo and Analytics tabs (`PAGE_TABS`) come after the rest by default, and hide and move by the same settings.
  const REPO = 'repo';
  if (repo) {
    panels.push({ id: REPO, title: 'Repo', hint: 'The page’s files, as git has them', node: <RepoTab {...repo} /> });
  }
  const ANALYTICS = 'analytics';
  // Only the page's owners see its analytics: on a person's page, that is only them. Anyone else sees the tab locked,
  // and opening it says how to become an owner.
  const owners = kind in KINDS ? KINDS[kind as keyof typeof KINDS].owners : null;
  const locked = !analytics && owners !== null && !!claimPath;
  if (analytics || locked) {
    const who = owners ? owners.title.replace(/^the /, '') : null;
    panels.push({
      id: ANALYTICS,
      title: 'Analytics',
      hint: who ? `${who[0].toUpperCase()}${who.slice(1)} only` : 'Only you can see this',
      // Open to its owners (an open lock), shut to anyone else.
      lock: locked ? 'shut' : 'open',
      locked,
      node: analytics ? (
        <AnalyticsPanel data={analytics} kind={kind} who={owners ? owners.title : null} />
      ) : (
        <LockedAnalytics who={who!} claim={owners!.claim} claimPath={claimPath!} />
      ),
    });
  }
  const ids = arrangePanels(
    panels.map((p) => p.id),
    hidden,
    order,
  );
  const [chosen, setChosen] = useState<string | null>(null);
  const hasRepo = !!repo;
  // A link into the repo (`#repo/…`) opens its tab, on arrival and as the reader goes back and forth.
  useEffect(() => {
    if (!hasRepo) return;
    const onHash = () => {
      const inRepo = repoWhere(window.location.hash) !== null;
      setChosen((was) => (inRepo ? REPO : was === REPO ? null : was));
    };
    onHash();
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [hasRepo]);
  // A link into the repo opens it even where the reader hid its tab.
  if (chosen === REPO && repo && !ids.includes(REPO)) ids.push(REPO);
  const LEAD = '';
  const tabs = lead ? [LEAD, ...ids] : ids;
  const shown = tabs.includes(chosen ?? '\0') ? chosen! : tabs[0];
  if (shown === undefined) return null;
  const byId = new Map(panels.map((p) => [p.id, p]));
  const title = (id: string) => (id === LEAD ? lead!.title : byId.get(id)!.title);
  return (
    <section className={lead ? 'mt-6' : 'mt-8'}>
      {tabs.length > 1 && (
        <div role="tablist" className="mb-3 flex gap-4 border-b border-rule font-sans text-sm">
          {tabs.map((id) => (
            <button
              key={id}
              role="tab"
              type="button"
              aria-selected={id === shown}
              title={id === LEAD ? undefined : byId.get(id)!.hint}
              onClick={() => {
                setChosen(id);
                // The repo's place is in the address (`RepoTab`); leaving its tab leaves it, as a new entry, so the
                // back button comes back to it.
                const inRepo = repoWhere(window.location.hash) !== null;
                if (id === REPO && !inRepo) history.pushState(null, '', REPO_HASH);
                if (id !== REPO && inRepo)
                  history.pushState(null, '', window.location.pathname + window.location.search);
                track('tab_opened', {
                  target:
                    id === ANALYTICS
                      ? locked
                        ? 'analytics_locked'
                        : 'analytics'
                      : id === REPO
                        ? 'repo'
                        : id || 'lead',
                });
              }}
              className={`-mb-px cursor-pointer border-b-2 pb-1 ${id === shown ? `border-ink ${ui.on}` : 'border-transparent text-muted'} ${id !== LEAD && byId.get(id)!.locked ? 'opacity-60' : ''}`}
            >
              {id !== LEAD && byId.get(id)!.lock === 'shut' && (
                <LockIcon className="mr-1 inline size-3 -translate-y-px" />
              )}
              {id !== LEAD && byId.get(id)!.lock === 'open' && (
                <LockOpenIcon className="mr-1 inline size-3 -translate-y-px" />
              )}
              {title(id)}
            </button>
          ))}
        </div>
      )}
      {lead && (
        <div role={tabs.length > 1 ? 'tabpanel' : undefined} hidden={shown !== LEAD}>
          {lead.node}
        </div>
      )}
      {shown !== LEAD && <div role={tabs.length > 1 ? 'tabpanel' : undefined}>{byId.get(shown)!.node}</div>}
    </section>
  );
}

/** What claiming a page is called, by how its owners are confirmed. */
const CLAIM_ACTION: Record<ClaimPolicy, string> = {
  authors: 'Claim this paper',
  organisers: 'Claim this venue',
  domain: 'See how to join',
};

/** A locked Analytics tab, opened: what is behind it, and how to become one who sees it. */
function LockedAnalytics({ who, claim, claimPath }: { who: string; claim: ClaimPolicy; claimPath: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border border-frame bg-card px-4 py-3 font-sans text-[13px]">
      <p className="min-w-0 flex-1 basis-64 text-muted">
        <strong className="text-ink">Only {who} see this.</strong> Views over time, how long people read, where they
        come from and what they open next.
      </p>
      <a
        href={claimPath}
        rel="nofollow"
        className={ui.btn({ ghost: true, inline: true, flush: true })}
        onClick={() => track('claim_prompt_clicked', { target: 'analytics' })}
        data-seen-event="claim_prompt_shown"
        data-seen-target="analytics"
      >
        {CLAIM_ACTION[claim]}
      </a>
    </div>
  );
}
