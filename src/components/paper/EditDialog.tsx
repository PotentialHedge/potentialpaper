'use client';

import { useEffect, useRef, useState } from 'react';
import { PencilIcon, WITH_ICON } from '@/components/icons';
import { ui } from '@/components/ui';

/**
 * How to edit a paper's page: in the browser, in the web editor (`/code/…`), or with git. Every page is a git
 * repository, so both edit the same files, held to the same rules. Opens from the "edit" button under the
 * title, and from any link to `#edit` (and the old `#edit-…` links) on the page.
 */

export interface EditOptions {
  codePath: string;
  clone: { https: string; ssh: string | null };
  /** The page has a repository yet: it starts with its first edit, so until then only the web editor works. */
  hasRepo: boolean;
}

const OPENS = /^#edit(?:-[a-z0-9-]+)?$/;

export function EditDialog({ codePath, clone, hasRepo }: EditOptions) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [via, setVia] = useState<'https' | 'ssh'>('https');

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
    // So the same link opens it again.
    if (OPENS.test(window.location.hash))
      history.replaceState(null, '', window.location.pathname + window.location.search);
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
          <p className="text-muted">
            Every paper&apos;s page is a git repository. Its sections, links, picture and versions are files, so you can
            edit them in the browser or on your own computer. Either way, each change is checked by the same rules and
            shows in the page&apos;s history.
          </p>

          <h3 className={`${ui.runIn} mt-4 block`}>In the browser</h3>
          <p className="mt-1 text-muted">
            The page&apos;s files in VS Code, with a preview of each section as the page will show it. Commit from
            Source Control when you&apos;re done. If you aren&apos;t signed in, you&apos;ll be asked to first.
          </p>
          <p className="mt-2">
            <a href={codePath} rel="nofollow" className={ui.btn({ inline: true, flush: true })}>
              Open the web editor
            </a>
          </p>

          <h3 className={`${ui.runIn} mt-5 block`}>With git</h3>
          {hasRepo ? (
            <>
              <div role="tablist" aria-label="Clone over" className="mt-1 inline-flex border border-rule text-xs">
                {(['https', 'ssh'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    role="tab"
                    aria-selected={via === v}
                    onClick={() => setVia(v)}
                    className={`cursor-pointer px-2.5 py-1 not-first:border-l not-first:border-rule ${via === v ? 'bg-tint text-ink' : 'text-accent'}`}
                  >
                    {v.toUpperCase()}
                  </button>
                ))}
              </div>
              {address ? (
                <CopyLine text={`git clone ${address}`} />
              ) : (
                <p className="mt-2 text-muted">Cloning over SSH isn&apos;t open yet. Use HTTPS for now.</p>
              )}
              <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
                <li>
                  Install <a href="https://git-lfs.com">Git LFS</a> first, so that the PDFs and the picture come as
                  files.
                </li>
                <li>
                  {via === 'ssh' ? (
                    <>
                      Pushing over SSH needs a key on <a href="/profile#ssh-keys">your profile</a>.
                    </>
                  ) : (
                    <>
                      To push, use an API key from <a href="/profile#agents">your profile</a> as the password.
                    </>
                  )}{' '}
                  If a push breaks a rule, git says what to change.
                </li>
                <li>
                  In VS Code,{' '}
                  <a href="/editor/potentialpaper.vsix" download>
                    our extension
                  </a>{' '}
                  previews each section as the page shows it, opens the PDFs and checks the JSON files (Extensions view,
                  ⋯, Install from VSIX).
                </li>
              </ul>
            </>
          ) : (
            <p className="mt-1 text-muted">
              This page gets its repository with its first edit, so start in the web editor. You can clone it after
              that.
            </p>
          )}
        </div>
      </dialog>
    </>
  );
}

function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 flex items-stretch border border-rule bg-white">
      <code className={`${ui.mono} min-w-0 flex-1 overflow-x-auto px-2 py-1.5 whitespace-nowrap`}>{text}</code>
      <button
        type="button"
        className={`${ui.linkBtn} border-l border-rule px-2.5 text-xs`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
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
