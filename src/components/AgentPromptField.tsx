'use client';

import { useState } from 'react';
import { ui } from './ui';

/**
 * A prompt for the reader's AI agent, to copy: a terminal line on a white card, `›` in front, with a "Copy" button
 * under it that says "Copied" for a moment. Clicking the text copies it too. The text wraps and can be selected by
 * hand where there is no clipboard.
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
      <p className="mb-1.5 text-xs text-muted">{label}</p>
      <div
        className={`border bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-colors ${copied ? 'border-up' : 'border-frame hover:border-rule-strong'}`}
      >
        <button
          type="button"
          onClick={() => void copy()}
          title="Copy"
          className="flex w-full cursor-pointer gap-2 px-3 pt-2.5 pb-2 text-left"
        >
          <span aria-hidden className={`${ui.mono} text-accent select-none`}>
            ›
          </span>
          <code
            aria-label="Prompt for your AI agent"
            className={`${ui.mono} min-w-0 flex-1 leading-relaxed break-words whitespace-pre-wrap text-ink select-all`}
          >
            {prompt}
          </code>
        </button>
        <div className="flex items-center justify-end border-t border-rule-soft bg-highlight/60 px-2 py-1">
          <button
            type="button"
            onClick={() => void copy()}
            className={`inline-flex cursor-pointer items-center gap-1.5 px-2 py-0.5 font-sans text-xs font-semibold ${copied ? 'text-up' : 'text-accent hover:underline'}`}
          >
            {copied ? (
              <>
                <svg
                  aria-hidden
                  viewBox="0 0 16 16"
                  className="size-3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M3 8.5l3 3 7-7" />
                </svg>
                Copied
              </>
            ) : (
              <>
                <svg
                  aria-hidden
                  viewBox="0 0 16 16"
                  className="size-3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <rect x="5.5" y="5.5" width="8" height="8" />
                  <path d="M10.5 5.5v-3h-8v8h3" />
                </svg>
                Copy
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
