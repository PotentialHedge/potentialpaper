'use client';

import { useState } from 'react';
import { ui } from './ui';

/** A read-only value, selected on focus so it can be copied by hand where there is no clipboard, and a button that copies it. */
export function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex gap-2">
      <input
        readOnly
        value={value}
        aria-label={label}
        onFocus={(e) => e.currentTarget.select()}
        className="min-w-0 flex-1 border border-rule bg-white p-1.5 font-mono text-[13px] leading-[normal] narrow:text-base"
      />
      <button
        type="button"
        className={ui.btn({ ghost: true, inline: true, flush: true })}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            // No clipboard (an insecure context): the field is there to copy by hand.
          }
        }}
      >
        {copied ? 'copied' : 'copy'}
      </button>
    </div>
  );
}
