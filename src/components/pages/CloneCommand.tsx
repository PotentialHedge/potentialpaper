'use client';

import { useState } from 'react';
import { CopyField } from '@/components/CopyField';
import { ui } from '@/components/ui';

export type CloneVia = 'https' | 'ssh';

/**
 * `git clone` for a page, over HTTPS or SSH, with what pushing back needs: shown by the Edit dialog and the Repo tab,
 * so both say the same. `onCopied` is told which address was copied.
 */
export function CloneCommand({
  clone,
  onCopied,
}: {
  clone: { https: string; ssh: string | null };
  onCopied?: (via: CloneVia) => void;
}) {
  const [via, setVia] = useState<CloneVia>('https');
  const address = via === 'ssh' ? clone.ssh : clone.https;
  return (
    <>
      <div className="mt-1 flex items-center gap-2 text-xs text-muted">
        <span>Run in a terminal:</span>
        <span className="flex-1" />
        <div role="tablist" aria-label="Clone over" className="inline-flex border border-rule">
          {(['https', 'ssh'] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={via === v}
              onClick={() => setVia(v)}
              className={`cursor-pointer px-2 py-0.5 not-first:border-l not-first:border-rule ${via === v ? 'bg-tint text-ink' : 'text-accent'}`}
            >
              {v.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      {address ? (
        <TerminalLine text={`git clone ${address}`} onCopied={() => onCopied?.(via)} />
      ) : (
        <p className="mt-2 text-muted">Cloning over SSH isn&apos;t open yet. Use HTTPS for now.</p>
      )}
      <p className={ui.fine}>
        Needs <a href="https://git-lfs.com">Git LFS</a>.{' '}
        {via === 'ssh' ? (
          <>
            To push, add an SSH key on <a href="/profile#ssh-keys">your profile</a>.
          </>
        ) : (
          <>
            To push, use an API key from <a href="/profile#agents">your profile</a> as the password.
          </>
        )}
      </p>
    </>
  );
}

/** A shell command to copy (`CopyField`, with `$` in front). */
export function TerminalLine({ text, onCopied }: { text: string; onCopied?: () => void }) {
  return (
    <div className="mt-2">
      <CopyField value={text} label="Command" marker="shell" onCopied={onCopied} />
    </div>
  );
}
