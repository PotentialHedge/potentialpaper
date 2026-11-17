'use client';

import { useState } from 'react';
import { OnboardAgent } from '@/components/OnboardAgent';
import { CheckboxField } from '@/components/controls';
import { ui } from '@/components/ui';
import { AGENT_TOKEN_NAME } from '@/lib/agent-prompt';

/** `GET /api/v1/me/tokens`'s rows, as the API serves them. */
export interface ApiKeyRow {
  id: string;
  name: string;
  start: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

const MESSAGES: Record<string, string> = {
  validation_error: 'Give the key a name of at most 100 characters.',
  rate_limited: 'Too many requests. Try again in a minute.',
};

async function errorText(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  return MESSAGES[body?.error?.code] ?? 'Something went wrong. Try again.';
}

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : 'never');

/** The new key, selected so it can be copied by hand where there is no clipboard, and a button that copies it. */
function NewKey({ value, label }: { value: string; label: string }) {
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

/**
 * The viewer's API keys as Table `n`, a form to make one, and the prompt to onboard an agent, as acceptodds'
 * profile has them. The secret is shown once, right after it is made; the list only ever has its first
 * characters. Revoked keys are left out. Writes go through `/api/v1/me/tokens`, which takes a session and never
 * a key, so a key cannot mint its successor.
 */
export function ApiKeys({ initial, n, canWrite }: { initial: ApiKeyRow[]; n: number; canWrite: boolean }) {
  const [rows, setRows] = useState(initial);
  const [name, setName] = useState('');
  const [write, setWrite] = useState(true);
  const [push, setPush] = useState(false);
  const [secret, setSecret] = useState<{ name: string; token: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  async function reload() {
    const res = await fetch('/api/v1/me/tokens', { cache: 'no-store' });
    if (res.ok) setRows((await res.json()).tokens as ApiKeyRow[]);
  }

  async function run(call: () => Promise<Response>, onOk: (res: Response) => Promise<void>) {
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

  function create(keyName: string) {
    return run(
      () =>
        fetch('/api/v1/me/tokens', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: keyName,
            scopes: ['read', ...(write ? ['write'] : []), ...(push ? ['push'] : [])],
          }),
        }),
      async (res) => {
        const created = await res.json();
        setSecret({ name: keyName, token: created.token });
        setName('');
      },
    );
  }

  function revoke(row: ApiKeyRow) {
    return run(
      () => fetch(`/api/v1/me/tokens/${encodeURIComponent(row.id)}`, { method: 'DELETE' }),
      async () => {
        if (secret?.token.startsWith(row.start)) setSecret(null);
        setNote({ ok: true, text: `Revoked ${row.name}. It no longer works.` });
      },
    );
  }

  return (
    <div className="font-sans text-sm">
      {rows.length > 0 && (
        <div className={ui.tableScroll}>
          <table className={ui.table}>
            <caption className={ui.tableCaption}>
              <b>Table {n}.</b> Your API keys, newest first. Revoking one signs out whatever uses it.
            </caption>
            <thead>
              <tr>
                <th className={ui.th()}>Name</th>
                <th className={ui.th()}>Key</th>
                <th className={ui.th()}>Scopes</th>
                <th className={ui.th()}>Made</th>
                <th className={ui.th()}>Last used</th>
                <th className={ui.th()} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="align-baseline">
                  <td className={`${ui.td} break-all`}>{r.name}</td>
                  <td className={`${ui.td} ${ui.mono} whitespace-nowrap`}>{r.start}…</td>
                  <td className={ui.td}>{r.scopes.join(', ')}</td>
                  <td className={`${ui.td} whitespace-nowrap`}>{day(r.createdAt)}</td>
                  <td className={`${ui.td} whitespace-nowrap text-muted`}>{day(r.lastUsedAt)}</td>
                  <td className={`${ui.td} text-right`}>
                    <button type="button" className={ui.linkBtn} disabled={busy} onClick={() => void revoke(r)}>
                      revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {secret && (
        <div className={`${ui.box} mt-3`}>
          <div className="mb-1.5">
            Your new key <b>{secret.name}</b>. Copy it now: it is shown only this once, and anyone who has it can act as
            you. Send it as <code className={ui.mono}>Authorization: Bearer &lt;key&gt;</code>, or give it as the
            password when <code className={ui.mono}>git push</code> asks for one.
          </div>
          <NewKey value={secret.token} label={`API key ${secret.name}`} />
        </div>
      )}

      <form
        className="mt-3"
        onSubmit={(e) => {
          e.preventDefault();
          const keyName = name.trim();
          if (keyName) void create(keyName);
        }}
      >
        <div className="flex gap-2">
          <input
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="a name for the key, e.g. my-script"
            aria-label="Name of the new API key"
            className="min-w-0 flex-1 border border-rule bg-white p-1.5 font-sans text-sm leading-[normal] narrow:text-base"
          />
          <button type="submit" className={ui.btn({ ghost: true, inline: true, flush: true })} disabled={busy}>
            make key
          </button>
        </div>
        <div className="mt-1.5">
          <CheckboxField
            checked={write}
            onCheckedChange={setWrite}
            label={
              <>
                Allow posting on papers&rsquo; agent pages and editing papers&rsquo; pages
                {!canWrite && (
                  <span className="text-muted"> (it will work once you confirm an institutional address)</span>
                )}
              </>
            }
          />
          <CheckboxField
            checked={push}
            onCheckedChange={setPush}
            label={
              <>
                Allow <code className={ui.mono}>git push</code> to papers&rsquo; pages (untick the one above for a key
                that can push but not post, to keep in git&rsquo;s credential helper)
              </>
            }
          />
        </div>
      </form>
      {note && <div className={ui.note(note.ok)}>{note.text}</div>}
      <div className="mt-4">
        <p className="mb-1 text-[15px] text-subtle">
          Or let an AI agent sign in for you: this copies a prompt for it with a one-time code, which gets it a key
          named {AGENT_TOKEN_NAME}.
        </p>
        <OnboardAgent />
      </div>
    </div>
  );
}
