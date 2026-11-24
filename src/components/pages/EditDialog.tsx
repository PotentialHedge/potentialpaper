'use client';

import { track } from '@/lib/track';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AgentPromptField } from '@/components/AgentPromptField';
import { CopyField } from '@/components/CopyField';
import { PencilIcon, WITH_ICON } from '@/components/icons';
import { ui } from '@/components/ui';
import { setupPrompt } from '@/lib/agent-prompt';

/**
 * How to edit a page of any kind: in the web editor (`/code/…`), with git, by having the reader's AI agent set git
 * up (a prompt pointing at `/agent/setup`, the one setup checklist), or a kind's own form (a category's). Every page is
 * a git repository, so all of them edit the same files, held to the same rules. Opens from the "edit" button under the title, and from any link to
 * `#edit` (and the old `#edit-…` links) on the page.
 *
 * It shows as little as it can: the three ways in, and the few words each needs. Copying the clone command then
 * offers the desktop extension, as an install command for whichever VS Code-family editor the reader uses: the
 * `.vsix` isn't on the Marketplace or Open VSX, so an `vscode:extension/…` link would have nothing to open.
 */

export interface EditOptions {
  /** The page's address, its short one where it has one: what the agent prompt names the page by. */
  pagePath: string;
  codePath: string;
  clone: { https: string; ssh: string | null };
  /** The page has a repository yet: it starts with its first edit, so until then only the web editor works. */
  hasRepo: boolean;
  /** A form of the kind's own for the common edits, offered first (a category's names and article). */
  form?: { href: string; label: string };
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

export function EditDialog({ pagePath, codePath, clone, hasRepo, form }: EditOptions) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [via, setVia] = useState<'https' | 'ssh'>('https');
  const [offer, setOffer] = useState(false);
  const [prompt, setPrompt] = useState('');

  /**
   * Opens the dialog and writes the agent's prompt: at once without a sign-in code, then, for a signed-in reader,
   * with a one-time one (`POST /me/agent-code`, an hour), as `AddMissing` does. Made once per page view.
   */
  const made = useRef(false);
  const open = useCallback(() => {
    if (!dialog.current?.open) {
      dialog.current?.showModal();
      track('edit_opened');
    }
    if (made.current) return;
    made.current = true;
    const origin = window.location.origin;
    setPrompt(setupPrompt(origin, pagePath));
    void (async () => {
      try {
        const res = await fetch('/api/v1/me/agent-code', { method: 'POST' });
        if (!res.ok) return;
        const { code } = (await res.json()) as { code?: string };
        if (code) setPrompt(setupPrompt(origin, pagePath, code));
      } catch {
        // Signed out, or offline: the agent asks for an email instead (`/agent/setup`).
      }
    })();
  }, [pagePath]);

  useEffect(() => {
    const check = () => {
      if (OPENS.test(window.location.hash)) open();
    };
    check();
    window.addEventListener('hashchange', check);
    return () => window.removeEventListener('hashchange', check);
  }, [open]);

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
    track('edit_clone_copied', { target: via });
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
      <button type="button" className={`${ui.linkBtn} ${WITH_ICON}`} onClick={open}>
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

          <div className="mt-2 flex flex-wrap items-baseline justify-center gap-x-4 gap-y-2">
            {form && (
              <a href={form.href} rel="nofollow" className={ui.btn({ inline: true, flush: true })}>
                {form.label}
              </a>
            )}
            <a
              href={codePath}
              rel="nofollow"
              onClick={() => track('edit_web_opened')}
              className={form ? 'text-accent' : ui.btn({ inline: true, flush: true })}
            >
              Edit in web editor
            </a>
          </div>

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

          <h3 className={`${ui.runIn} mt-5 block`}>Or let your agent set it up</h3>
          <p className="mt-1 text-xs text-muted">
            It checks and sets up everything: signing in, git, the clone, credentials and an SSH key.
          </p>
          {prompt && <AgentPromptField prompt={prompt} label="Paste into your AI agent:" where="edit" />}
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
      <TerminalLine text={command} onCopied={() => track('extension_command_copied', { target: cli })} />
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

/** A shell command to copy (`CopyField`, with `$` in front). */
function TerminalLine({ text, onCopied }: { text: string; onCopied?: () => void }) {
  return (
    <div className="mt-2">
      <CopyField value={text} label="Command" marker="shell" onCopied={onCopied} />
    </div>
  );
}
