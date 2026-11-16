'use client';

import { useEffect, useRef, useState } from 'react';
import { PencilIcon, WITH_ICON } from '@/components/icons';
import { ui } from '@/components/ui';

/**
 * How to edit a paper's page: in the web editor (`/code/…`), or with git. Every page is a git repository, so both
 * edit the same files, held to the same rules. Opens from the "edit" button under the title, and from any link to
 * `#edit` (and the old `#edit-…` links) on the page.
 *
 * It shows as little as it can: the two ways in, and the few words each needs. Copying the clone command then
 * offers the desktop extension, as an install command for whichever VS Code-family editor the reader uses: the
 * `.vsix` isn't on the Marketplace or Open VSX, so an `vscode:extension/…` link would have nothing to open.
 */

export interface EditOptions {
  codePath: string;
  clone: { https: string; ssh: string | null };
  /** The page has a repository yet: it starts with its first edit, so until then only the web editor works. */
  hasRepo: boolean;
}

const OPENS = /^#edit(?:-[a-z0-9-]+)?$/;

/** The command-line launcher of each VS Code-family editor, for `--install-extension`. */
const EDITORS = [
  { name: 'VS Code', cli: 'code' },
  { name: 'Cursor', cli: 'cursor' },
  { name: 'Windsurf', cli: 'windsurf' },
  { name: 'VSCodium', cli: 'codium' },
] as const;

const VSIX = '/editor/potentialpaper.vsix';
/** Remembers, in this browser, that the reader declined the extension, so copying doesn't ask again. */
const DECLINED = 'pp:edit:no-extension';

export function EditDialog({ codePath, clone, hasRepo }: EditOptions) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [via, setVia] = useState<'https' | 'ssh'>('https');
  const [offer, setOffer] = useState(false);

  useEffect(() => {
    const check = () => {
      if (OPENS.test(window.location.hash) && !dialog.current?.open) dialog.current?.showModal();
    };
    check();
    window.addEventListener('hashchange', check);
    return () => window.removeEventListener('hashchange', check);
  }, []);

  const close = () => {
    dialog.current?.close();
  };
  const onClose = () => {
    setOffer(false);
    // So the same link opens it again.
    if (OPENS.test(window.location.hash))
      history.replaceState(null, '', window.location.pathname + window.location.search);
  };
  const onCopied = () => {
    let declined = false;
    try {
      declined = localStorage.getItem(DECLINED) === '1';
    } catch {
      // No storage: ask.
    }
    if (!declined) setOffer(true);
  };
  const decline = () => {
    setOffer(false);
    try {
      localStorage.setItem(DECLINED, '1');
    } catch {
      // No storage: it asks again next time.
    }
  };

  const address = via === 'ssh' ? clone.ssh : clone.https;
  return (
    <>
      <button type="button" className={`${ui.linkBtn} ${WITH_ICON}`} onClick={() => dialog.current?.showModal()}>
        <PencilIcon />
        edit
      </button>
      <dialog
        ref={dialog}
        onClose={onClose}
        onClick={(e) => {
          if (e.target === dialog.current) close();
        }}
        aria-labelledby="edit-title"
        className="m-auto w-[min(560px,calc(100vw-32px))] border border-frame bg-card p-0 text-left font-sans text-sm text-ink shadow-sm backdrop:bg-black/30"
      >
        <div className="p-5">
          <div className="flex items-baseline">
            <h2 id="edit-title" className={ui.boxHeading}>
              Edit this page
            </h2>
            <span className="flex-1" />
            <button type="button" className={ui.linkBtn} onClick={close} aria-label="Close">
              close
            </button>
          </div>

          <a href={codePath} rel="nofollow" className={ui.btn({ inline: true, flush: true })}>
            Edit in web editor
          </a>

          <h3 className={`${ui.runIn} mt-5 block`}>Or clone it with git</h3>
          {hasRepo ? (
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
                <TerminalLine text={`git clone ${address}`} onCopied={onCopied} />
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
              {offer && <ExtensionOffer onDecline={decline} />}
            </>
          ) : (
            <p className="mt-1 text-muted">
              The page gets its repository with its first edit, so start in the web editor.
            </p>
          )}
        </div>
      </dialog>
    </>
  );
}

/** After the clone command is copied: the desktop extension, as one command for the reader's editor. */
function ExtensionOffer({ onDecline }: { onDecline: () => void }) {
  const [cli, setCli] = useState<string>(EDITORS[0].cli);
  const url = `${window.location.origin}${VSIX}`;
  const command = `curl -fsSLo potentialpaper.vsix ${url} && ${cli} --install-extension potentialpaper.vsix && rm potentialpaper.vsix`;
  return (
    <div role="status" className="mt-4 border border-rule bg-tint p-3">
      <p>
        <b>Copied.</b> Also install our extension? It previews each section as the page shows it and checks the
        page&apos;s files.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {EDITORS.map((e) => (
          <button
            key={e.cli}
            type="button"
            aria-pressed={cli === e.cli}
            onClick={() => setCli(e.cli)}
            className={cli === e.cli ? ui.on : ui.linkBtn}
          >
            {e.name}
          </button>
        ))}
      </div>
      <TerminalLine text={command} />
      <p className="mt-2 text-xs">
        <a href={VSIX} download>
          Download the .vsix
        </a>{' '}
        <span className="text-muted">to install it by hand (Extensions, ⋯, Install from VSIX)</span>
        <span className="mx-1.5 text-faint">·</span>
        <button type="button" className={ui.linkBtn} onClick={onDecline}>
          no thanks
        </button>
      </p>
    </div>
  );
}

/** A shell command: a `$` prompt, so it reads as one for a terminal, and a copy button. */
function TerminalLine({ text, onCopied }: { text: string; onCopied?: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 flex items-stretch border border-rule bg-white">
      <code className={`${ui.mono} min-w-0 flex-1 overflow-x-auto px-2 py-1.5 whitespace-nowrap`}>
        <span aria-hidden className="text-faint select-none">
          ${' '}
        </span>
        {text}
      </code>
      <button
        type="button"
        className={`${ui.linkBtn} border-l border-rule px-2.5 text-xs`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
            onCopied?.();
          } catch {
            // No clipboard: the command is there to select.
          }
        }}
      >
        {copied ? 'copied' : 'copy'}
      </button>
    </div>
  );
}
