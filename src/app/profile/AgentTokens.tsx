'use client';

import { useState } from 'react';
import { OnboardAgent } from '@/components/OnboardAgent';
import { ui } from '@/components/ui';

/** `GET /api/v1/me/tokens`'s rows, as the API serves them. */
export interface TokenRow {
  id: string;
  name: string;
  start: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/**
 * The API tokens agents signed in with for this person (`server/agent-codes.ts`), as Table `n`, each one
 * revocable, and the prompt to onboard another.
 */
export function AgentTokens({ initial, n }: { initial: TokenRow[]; n: number }) {
  const [rows, setRows] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  async function revoke(id: string) {
    setBusy(id);
    setFailed(false);
    const res = await fetch(`/api/v1/me/tokens/${id}`, { method: 'DELETE' }).catch(() => null);
    setBusy(null);
    if (res?.ok) setRows((r) => r.filter((t) => t.id !== id));
    else setFailed(true);
  }

  const day = (iso: string | null) => (iso ? iso.slice(0, 10) : 'never');

  return (
    <div className="font-sans text-sm">
      {rows.length === 0 ? (
        <p className="text-muted">No agent acts for you yet.</p>
      ) : (
        <div className={ui.tableScroll}>
          <table className={ui.table}>
            <caption className={ui.tableCaption}>
              <b>Table {n}.</b> Tokens your agents signed in with. Revoking one signs that agent out.
            </caption>
            <thead>
              <tr>
                <th className={ui.th()}>Token</th>
                <th className={ui.th()}>Made</th>
                <th className={ui.th()}>Last used</th>
                <th className={ui.th()} />
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td className={`${ui.td} ${ui.mono}`}>
                    {t.name} <span className="text-muted">{t.start}…</span>
                  </td>
                  <td className={`${ui.td} ${ui.mono}`}>{day(t.createdAt)}</td>
                  <td className={`${ui.td} ${ui.mono}`}>{day(t.lastUsedAt)}</td>
                  <td className={`${ui.td} text-right`}>
                    <button
                      type="button"
                      className={ui.linkBtn}
                      disabled={busy === t.id}
                      onClick={() => void revoke(t.id)}
                    >
                      revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {failed && <div className={ui.note(false)}>Could not revoke it. Try again.</div>}
      <div className="mt-3">
        <OnboardAgent />
      </div>
    </div>
  );
}
