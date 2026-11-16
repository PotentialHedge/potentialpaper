'use client';

import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/Popover';
import { AgentIcon, HistoryIcon, QuoteIcon, WITH_ICON } from '@/components/icons';
import { ui } from '@/components/ui';
import { EditDialog, type EditOptions } from './EditDialog';

/** Cite, history and for agents: gray, so Edit stays the one red action under the title. */
const SECONDARY = 'cursor-pointer text-muted hover:text-ink hover:underline';

/** The quick actions under a paper's title. A client island for the BibTeX's clipboard and the Edit dialog. */
export function TitleActions({
  bibtex,
  edit,
  historyPath,
  agentPath,
}: {
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
