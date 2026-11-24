'use client';

import { track } from '@/lib/track';
import { useState } from 'react';
import { ui } from '@/components/ui';

/** `GET /api/v1/me/ssh-keys`'s rows, as the API serves them. */
export interface SshKeyRow {
  id: string;
  title: string;
  keyType: string;
  fingerprint: string;
  createdAt: string;
  lastUsedAt: string | null;
}

const MESSAGES: Record<string, string> = {
  ssh_key_taken: 'That key is already in use, on this account or another one.',
  too_many_ssh_keys: 'An account can have at most 50 SSH keys. Remove one first.',
  rate_limited: 'Too many requests. Try again in a minute.',
};

async function errorText(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  const code = body?.error?.code;
  // The parser's own sentence says what is wrong with the key.
  if (code === 'invalid_ssh_key' && typeof body?.error?.message === 'string') return body.error.message;
  if (code === 'validation_error') return 'Paste a public key, and a title of at most 100 characters.';
  return MESSAGES[code] ?? 'Something went wrong. Try again.';
}

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : 'never');

/**
 * The viewer's SSH keys as Table `n`, and a form to add one, for git over SSH (`docs/git.md`). Writes go through
 * `/api/v1/me/ssh-keys`, which takes a session only, as `/me/tokens` does.
 */
export function SshKeys({
  initial,
  n,
  canPush,
  sshUrl,
}: {
  initial: SshKeyRow[];
  n: number;
  canPush: boolean;
  sshUrl: string;
}) {
  const [rows, setRows] = useState(initial);
  const [key, setKey] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  async function reload() {
    const res = await fetch('/api/v1/me/ssh-keys', { cache: 'no-store' });
    if (res.ok) setRows((await res.json()).keys as SshKeyRow[]);
  }

  async function run(call: () => Promise<Response>, onOk: (res: Response) => Promise<void> | void) {
    setBusy(true);
    setNote(null);
    try {
      const res = await call();
      if (!res.ok) {
        setNote({ ok: false, text: await errorText(res) });
        return;
      }
      await onOk(res);
      await reload();
    } catch {
      setNote({ ok: false, text: 'Could not reach the server. Try again.' });
    } finally {
      setBusy(false);
    }
  }

  function add() {
    return run(
      () =>
        fetch('/api/v1/me/ssh-keys', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key, ...(title.trim() ? { title: title.trim() } : {}) }),
        }),
      async (res) => {
        const added = (await res.json()) as SshKeyRow;
        track('ssh_key_added');
        setKey('');
        setTitle('');
        setNote({ ok: true, text: `Added ${added.title} (${added.fingerprint}).` });
      },
    );
  }

  function remove(row: SshKeyRow) {
    return run(
      () => fetch(`/api/v1/me/ssh-keys/${encodeURIComponent(row.id)}`, { method: 'DELETE' }),
      () => setNote({ ok: true, text: `Removed ${row.title}. It no longer signs in.` }),
    );
  }

  return (
    <div className="font-sans text-sm">
      <p className="mb-1 text-[15px] text-subtle">
        To clone and push papers&rsquo; pages over SSH, as{' '}
        <code className={`${ui.mono} break-all`}>git clone {sshUrl}/abs/1706.03762.git</code>, add your public key (the{' '}
        <code className={ui.mono}>.pub</code> file, e.g. <code className={ui.mono}>~/.ssh/id_ed25519.pub</code>).
        Ed25519, ECDSA, or RSA of at least 3072 bits.
        {!canPush && <span className="text-muted"> Pushing works once you confirm an institutional address.</span>}
      </p>
      {rows.length > 0 && (
        <div className={ui.tableScroll}>
          <table className={ui.table}>
            <caption className={ui.tableCaption}>
              <b>Table {n}.</b> Your SSH keys, newest first. Removing one stops it signing in at once.
            </caption>
            <thead>
              <tr>
                <th className={ui.th()}>Title</th>
                <th className={ui.th()}>Fingerprint</th>
                <th className={ui.th()}>Added</th>
                <th className={ui.th()}>Last used</th>
                <th className={ui.th()} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="align-baseline">
                  <td className={`${ui.td} break-all`}>{r.title}</td>
                  <td className={`${ui.td} ${ui.mono} break-all`}>
                    {r.fingerprint} <span className="text-muted">{r.keyType}</span>
                  </td>
                  <td className={`${ui.td} whitespace-nowrap`}>{day(r.createdAt)}</td>
                  <td className={`${ui.td} whitespace-nowrap text-muted`}>{day(r.lastUsedAt)}</td>
                  <td className={`${ui.td} text-right`}>
                    <button type="button" className={ui.linkBtn} disabled={busy} onClick={() => void remove(r)}>
                      remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form
        className="mt-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (key.trim()) void add();
        }}
      >
        <textarea
          required
          rows={3}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA… you@laptop"
          aria-label="Public SSH key"
          spellCheck={false}
          className="mb-2 w-full border border-rule bg-white p-1.5 font-mono text-[13px] leading-[normal] narrow:text-base"
        />
        <div className="flex gap-2">
          <input
            maxLength={100}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="a title, e.g. laptop (default: the key's comment)"
            aria-label="Title of the new SSH key"
            className="min-w-0 flex-1 border border-rule bg-white p-1.5 font-sans text-sm leading-[normal] narrow:text-base"
          />
          <button type="submit" className={ui.btn({ ghost: true, inline: true, flush: true })} disabled={busy}>
            add key
          </button>
        </div>
      </form>
      {note && <div className={ui.note(note.ok)}>{note.text}</div>}
    </div>
  );
}
