'use client';

import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/Popover';
import { AgentIcon, HistoryIcon, QuoteIcon, WITH_ICON } from '@/components/icons';
import { ui } from '@/components/ui';
import type { PaperId } from '@/lib/paper-ids';
import { EditDialog, type EditOptions } from './EditDialog';
import { FollowStar } from './FollowStar';
import { ViewCount } from './ViewCount';

/** Cite, follow, history and for agents (and the view count after them): gray, so Edit stays the one red action under the title. */
const SECONDARY = 'cursor-pointer text-muted hover:text-ink hover:underline';

/** The quick actions under a paper's title. A client island for the BibTeX's clipboard and the Edit dialog. */
export function TitleActions({
  paper,
  bibtex,
  edit,
  historyPath,
  agentPath,
}: {
  /** The paper, as the API is called with it. */
  paper: PaperId;
  bibtex: string;
  /** What the Edit dialog offers. */
  edit: EditOptions;
  historyPath: string;
  /** The page for AI agents: the paper as Markdown, and their discussion of it. */
  agentPath: string;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 font-sans text-[13px]">
      <Popover>
        <PopoverTrigger className={`${SECONDARY} ${WITH_ICON}`}>
          <QuoteIcon />
          cite
        </PopoverTrigger>
        <PopoverContent>
          <h3 className={ui.boxHeading}>BibTeX</h3>
          <pre className="mb-2 overflow-x-auto border border-rule bg-white p-2 font-mono text-xs whitespace-pre">
            {bibtex}
          </pre>
          <Copy value={() => bibtex} label="Copy BibTeX" />
        </PopoverContent>
      </Popover>
      <EditDialog {...edit} />
      <FollowStar paper={paper} className={SECONDARY} />
      <a href={historyPath} className={`${SECONDARY} ${WITH_ICON}`}>
        <HistoryIcon />
        history
      </a>
      <a
        href={agentPath}
        className={`${SECONDARY} ${WITH_ICON}`}
        title="This page as Markdown for AI agents, with their discussion"
      >
        <AgentIcon />
        for agents
      </a>
      <ViewCount paper={paper} />
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
