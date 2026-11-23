'use client';

import { useState } from 'react';
import { ui } from './ui';

/** What goes in front of the value: `›` for a prompt to an AI agent, `$` for a shell command, or nothing. */
export type CopyMarker = 'prompt' | 'shell';

const MARKS: Record<CopyMarker, { text: string; className: string }> = {
  prompt: { text: '›', className: 'text-accent' },
  shell: { text: '$', className: 'text-faint' },
};

/**
 * A value to copy (a link, a key, a command, a prompt for an AI agent), set in monospace on a white card, with a
 * "Copy" button under it that says "Copied" for a moment. Clicking the value copies it too. It wraps, and can be
 * selected by hand where there is no clipboard (an insecure context).
 */
export function CopyField({
  value,
  label,
  caption,
  marker,
  onCopied,
  bigButton,
}: {
  value: string;
  /** What it is, for screen readers ("Short link", "Prompt for your AI agent"). */
  label: string;
  /** A line above it, shown ("Paste into your AI agent:"). */
  caption?: string;
  marker?: CopyMarker;
  onCopied?: () => void;
  /** A full-width button under the card instead of its Copy bar ("Copy the prompt"), where copying is the one thing to do. */
  bigButton?: { label: string; copiedLabel: string };
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      onCopied?.();
    } catch {
      // No clipboard: the value is there to select.
    }
  };
  const mark = marker && MARKS[marker];
  return (
    <div>
      {caption && <p className="mb-1.5 text-xs text-muted">{caption}</p>}
      <div
        className={`border bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-colors ${copied ? 'border-up' : 'border-frame hover:border-rule-strong'}`}
      >
        <button
          type="button"
          onClick={() => void copy()}
          title="Copy"
          className="flex w-full gap-2 px-3 pt-2.5 pb-2 text-left"
        >
          {mark && (
            <span aria-hidden className={`${ui.mono} select-none ${mark.className}`}>
              {mark.text}
            </span>
          )}
          <code
            aria-label={label}
            className={`${ui.mono} min-w-0 flex-1 leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap text-ink select-all`}
          >
            {value}
          </code>
        </button>
        {!bigButton && (
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
        )}
      </div>
      {bigButton && (
        <button type="button" className={ui.btn()} disabled={!value} onClick={() => void copy()}>
          {copied ? bigButton.copiedLabel : bigButton.label}
        </button>
      )}
    </div>
  );
}
