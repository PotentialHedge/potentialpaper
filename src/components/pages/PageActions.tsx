'use client';

import { type ReactNode, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/Popover';
import { AgentIcon, HistoryIcon, QuoteIcon, WITH_ICON } from '@/components/icons';
import { ui } from '@/components/ui';
import type { PaperId } from '@/lib/paper-ids';
import { FollowStar } from '@/components/paper/FollowStar';
import { EditDialog, type EditOptions } from './EditDialog';
import { ViewCount } from '@/components/ViewCount';
import { SharePopover } from '@/components/SharePopover';
import { ConsentPrompt } from '@/components/plugins/PluginPanel';
import { PluginFrame, type ReadyPlugin } from '@/components/plugins/PluginFrame';
import { usePluginPage } from '@/components/plugins/PluginPage';
import { arrangeActions, pluginActions, type PluginAction } from '@/lib/page-actions';
import { usePlugins } from '@/lib/plugins/client';
import { pageWhenContext } from '@/lib/plugins/when';
import { useSetting } from '@/lib/settings/client';

/** Every action but Edit: gray, so Edit stays the one red action under the title. */
const SECONDARY = 'cursor-pointer text-muted hover:text-ink hover:underline';

/**
 * The actions under a page's title, on every kind (`lib/page-actions.ts`): edit, share, history, on a paper also
 * cite, follow and the page for agents, and installed plugins' actions. The reader's `<kind>.actions.order` and
 * `.hidden` arrange them; the first few are in the bar and the rest in its "⋯" menu. A client island for the
 * BibTeX's clipboard, the Edit dialog, the reader's settings and plugins. Plugins and settings are known only once
 * fetched, so the bar starts in its usual order.
 */
export function PageActions({
  pageId,
  edit,
  historyPath,
  share,
  paper,
}: {
  /** The page's id, for the view count. */
  pageId: string;
  /** What the Edit dialog offers; none on a page without files (a person's). */
  edit?: EditOptions;
  historyPath?: string;
  /** The share menu's short link, title and badge (`components/SharePopover`). */
  share: { url: string; title: string; badge?: { image: string; markdown: string } } | null;
  /** A paper's own: its BibTeX, the paper to follow, and its page for AI agents. */
  paper?: { id: PaperId; bibtex: string; agentPath: string };
}) {
  const page = usePluginPage();
  const kind = page?.kind ?? (paper ? 'paper' : null);
  const order = useSetting<string[] | undefined>(`${kind}.actions.order`) ?? [];
  const hidden = useSetting<string[] | undefined>(`${kind}.actions.hidden`) ?? [];
  const { plugins, viewer } = usePlugins(page ? page.page.identifier : null);

  const actions = new Map<string, ReactNode>();
  if (paper) {
    actions.set(
      'cite',
      <Popover>
        <PopoverTrigger className={`${SECONDARY} ${WITH_ICON}`}>
          <QuoteIcon />
          cite
        </PopoverTrigger>
        <PopoverContent>
          <h3 className={ui.boxHeading}>BibTeX</h3>
          <pre className="mb-2 overflow-x-auto border border-rule bg-white p-2 font-mono text-xs whitespace-pre">
            {paper.bibtex}
          </pre>
          <Copy value={() => paper.bibtex} label="Copy BibTeX" />
        </PopoverContent>
      </Popover>,
    );
  }
  if (edit) actions.set('edit', <EditDialog {...edit} />);
  if (paper) actions.set('follow', <FollowStar paper={paper.id} className={SECONDARY} />);
  if (share) actions.set('share', <SharePopover {...share} className={SECONDARY} />);
  if (historyPath) {
    actions.set(
      'history',
      <a href={historyPath} className={`${SECONDARY} ${WITH_ICON}`}>
        <HistoryIcon />
        history
      </a>,
    );
  }
  if (paper) {
    actions.set(
      'agents',
      <a
        href={paper.agentPath}
        className={`${SECONDARY} ${WITH_ICON}`}
        title="This page as Markdown for AI agents, with their discussion"
      >
        <AgentIcon />
        for agents
      </a>,
    );
  }
  if (page) {
    const context = pageWhenContext(page.kind, { ...page.facts, ...viewer });
    for (const action of pluginActions(plugins, { kind: page.kind, context })) {
      const plugin = plugins.find((p) => p.plugin?.id === action.pluginId) as ReadyPlugin | undefined;
      if (plugin) actions.set(action.id, <PluginActionButton action={action} plugin={plugin} viewer={viewer} />);
    }
  }

  const { bar, menu } = arrangeActions([...actions.keys()], hidden, order);
  return (
    <div className="mt-4 flex flex-col items-center gap-2 font-sans text-[13px]">
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
        {bar.map((id) => (
          <span key={id} className="contents">
            {actions.get(id)}
          </span>
        ))}
        {menu.length > 0 && (
          // Picking one leaves the menu open: cite, share and a plugin's action open their own popover from it.
          <Popover>
            <PopoverTrigger className={SECONDARY} aria-label="More actions" title="More actions">
              ⋯
            </PopoverTrigger>
            <PopoverContent menu align="end">
              {menu.map((id) => (
                <span key={id} className="flex">
                  {actions.get(id)}
                </span>
              ))}
            </PopoverContent>
          </Popover>
        )}
      </div>
      {/* On a line of its own below the actions; nothing until the page has enough viewers to show. */}
      <ViewCount pageId={pageId} />
    </div>
  );
}

/** A plugin's action: a popover with its frame, or its consent prompt until the reader approves it. */
function PluginActionButton({
  action,
  plugin,
  viewer,
}: {
  action: PluginAction;
  plugin: ReadyPlugin;
  viewer: { signedIn: boolean; isOwner: boolean };
}) {
  const page = usePluginPage();
  return (
    <Popover>
      <PopoverTrigger className={SECONDARY} title={`${action.title} (${action.plugin})`}>
        {action.title}
      </PopoverTrigger>
      <PopoverContent>
        {plugin.status === 'consent' ? (
          <ConsentPrompt plugin={plugin} signedIn={viewer.signedIn} />
        ) : (
          <>
            {viewer.signedIn && plugin.missing.permissions.length > 0 && (
              <ConsentPrompt plugin={plugin} signedIn personal />
            )}
            <PluginFrame
              plugin={plugin}
              surface={{ type: 'action', id: action.action }}
              page={page}
              viewer={viewer}
              title={`${action.title} (${action.plugin})`}
            />
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

function Copy({ value, label }: { value: () => string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={ui.linkBtn}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value());
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // No clipboard (an insecure origin, or denied): the BibTeX is still there to select.
        }
      }}
    >
      {copied ? 'copied' : label}
    </button>
  );
}
