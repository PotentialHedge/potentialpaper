'use client';

import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/Popover';
import { ui } from '@/components/ui';

/** The quick actions under a paper's title. A client island only for the BibTeX's clipboard. */
export function TitleActions({
  bibtex,
  editPath,
  historyPath,
}: {
  bibtex: string;
  editPath: string;
  historyPath: string;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 font-sans text-[13px]">
      <Popover>
        <PopoverTrigger className={ui.linkBtn}>cite</PopoverTrigger>
        <PopoverContent>
          <h3 className={ui.boxHeading}>BibTeX</h3>
          <pre className="mb-2 overflow-x-auto border border-rule bg-white p-2 font-mono text-xs whitespace-pre">
            {bibtex}
          </pre>
          <Copy value={() => bibtex} label="Copy BibTeX" />
        </PopoverContent>
      </Popover>
      <a href={editPath} rel="nofollow" className="text-accent">
        edit
      </a>
      <a href={historyPath} className="text-accent">
        history
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
