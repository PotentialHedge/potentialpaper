'use client';

import { useState } from 'react';
import { ui } from '@/components/ui';
import type { PaperId } from '@/lib/paper-ids';

/** Undoes one commit, as a new commit, then shows the history past every cache. */
export function RevertButton({ paper, oid, historyPath }: { paper: PaperId; oid: string; historyPath: string }) {
  const [state, setState] = useState<'idle' | 'confirm' | 'busy'>('idle');
  const [problem, setProblem] = useState<string | null>(null);

  async function revert() {
    setState('busy');
    setProblem(null);
    try {
      const res = await fetch('/api/v1/pages/revert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paper, oid }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setProblem(
          res.status === 401
            ? 'Sign in to revert.'
            : body?.error?.code === 'edit_conflict'
              ? 'Later edits changed the same lines, so this can’t be undone on its own. Edit the page instead.'
              : (body?.error?.message ?? `Something went wrong (${res.status}).`),
        );
        setState('idle');
        return;
      }
      window.location.replace(`${historyPath}?v=${(body?.head ?? Date.now().toString(16)).slice(0, 12)}`);
    } catch {
      setProblem('Could not reach the server.');
      setState('idle');
    }
  }

  return (
    <span className="font-sans text-sm">
      {state === 'idle' ? (
        <button type="button" className={ui.linkBtn} onClick={() => setState('confirm')}>
          revert
        </button>
      ) : (
        <span>
          Undo this change?{' '}
          <button type="button" className={ui.linkBtn} disabled={state === 'busy'} onClick={revert}>
            {state === 'busy' ? 'reverting…' : 'yes, revert'}
          </button>{' '}
          <button type="button" className={ui.linkBtn} disabled={state === 'busy'} onClick={() => setState('idle')}>
            cancel
          </button>
        </span>
      )}
      {problem && <span className={`block ${ui.note(false)}`}>{problem}</span>}
    </span>
  );
}
