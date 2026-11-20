'use client';

import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/Popover';
import { AgentIcon, HistoryIcon, QuoteIcon, WITH_ICON } from '@/components/icons';
import { ui } from '@/components/ui';
import type { PaperId } from '@/lib/paper-ids';
import { FollowStar } from '@/components/paper/FollowStar';
import { EditDialog, type EditOptions } from './EditDialog';
import { ViewCount } from '@/components/ViewCount';
import { SharePopover } from '@/components/SharePopover';

/** Cite, follow, history and for agents (and the view count after them): gray, so Edit stays the one red action under the title. */
const SECONDARY = 'cursor-pointer text-muted hover:text-ink hover:underline';

/**
 * The quick actions under a page's title, on every kind: edit, share, history, and on a paper also cite, follow and
 * the page for agents. A client island for the BibTeX's clipboard and the Edit dialog.
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
  /** What the Edit dialog offers. */
  edit: EditOptions;
  historyPath: string;
  /** The share menu's short link, title and badge (`components/SharePopover`). */
  share: { url: string; title: string; badge?: { image: string; markdown: string } } | null;
  /** A paper's own: its BibTeX, the paper to follow, and its page for AI agents. */
  paper?: { id: PaperId; bibtex: string; agentPath: string };
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 font-sans text-[13px]">
      {paper && (
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
        </Popover>
      )}
      <EditDialog {...edit} />
      {paper && <FollowStar paper={paper.id} className={SECONDARY} />}
      {share && <SharePopover {...share} className={SECONDARY} />}
      <a href={historyPath} className={`${SECONDARY} ${WITH_ICON}`}>
        <HistoryIcon />
        history
      </a>
      {paper && (
        <a
          href={paper.agentPath}
          className={`${SECONDARY} ${WITH_ICON}`}
          title="This page as Markdown for AI agents, with their discussion"
        >
          <AgentIcon />
          for agents
        </a>
      )}
      <ViewCount pageId={pageId} />
    </div>
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
