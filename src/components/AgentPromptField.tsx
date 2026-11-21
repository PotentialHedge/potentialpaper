'use client';

import { useState } from 'react';
import { ui } from './ui';

/**
 * A prompt for the reader's AI agent, to copy: set in monospace on white like a terminal line (`EditDialog`'s), with
 * a "copy" button in its corner. The text wraps and can be selected by hand where there is no clipboard.
 */
export function AgentPromptField({ prompt, label = 'Paste into your AI agent:' }: { prompt: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // No clipboard: the prompt is there to select.
    }
  };
  return (
    <div className="mt-3">
      <p className="mb-1 text-xs text-muted">{label}</p>
      <div className="flex items-stretch border border-rule bg-tint">
        <code
          aria-label="Prompt for your AI agent"
          className={`${ui.mono} min-w-0 flex-1 px-2.5 py-2 text-xs leading-relaxed break-words whitespace-pre-wrap select-all`}
        >
          {prompt}
        </code>
        <button
          type="button"
          className={`${ui.linkBtn} shrink-0 self-start px-2.5 py-2 text-xs`}
          onClick={() => void copy()}
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
    </div>
  );
}
