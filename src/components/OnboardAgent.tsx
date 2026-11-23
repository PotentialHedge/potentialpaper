'use client';

import { useEffect, useState } from 'react';
import { agentPrompt } from '@/lib/agent-prompt';
import { AgentPromptField } from './AgentPromptField';
import { ui } from './ui';

/**
 * Puts `text` on the clipboard once `pending` resolves. Safari drops the click's permission to write
 * across an `await`, so the write starts in the click itself and is handed the text as a promise;
 * elsewhere, written after.
 */
async function copyWhenReady(pending: Promise<string>): Promise<boolean> {
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      const blob = pending.then((text) => new Blob([text], { type: 'text/plain' }));
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
      return true;
    }
  } catch {
    // Fall through: some browsers refuse a promised item.
  }
  try {
    await navigator.clipboard.writeText(await pending);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copies `lib/agent-prompt.ts`'s prompt for the viewer's AI agent, as acceptodds' `[onboard your agent]`
 * does. A signed-in viewer's prompt carries a one-time code for an API token (`POST /me/agent-code`, a new
 * one each press, an hour), so the agent signs in without a mail; anyone else's has the agent sign in by a
 * code mailed to them (`/agent/start`). Pages are the same HTML for every reader, so whether the viewer is
 * signed in is learned from that call. Where there is no clipboard, the prompt is shown to copy by hand.
 */
export function OnboardAgent({
  className = ui.linkBtn,
  label = '[onboard your agent]',
  copiedLabel = '[prompt copied]',
}: {
  className?: string;
  label?: string;
  copiedLabel?: string;
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'copied' | 'shown' | 'failed'>('idle');
  const [prompt, setPrompt] = useState('');

  async function build(): Promise<string> {
    const res = await fetch('/api/v1/me/agent-code', { method: 'POST' });
    let code: string | undefined;
    if (res.ok) {
      ({ code } = await res.json());
    } else if (res.status !== 401) {
      throw new Error('agent-code');
    }
    const text = agentPrompt(window.location.origin, code);
    setPrompt(text);
    return text;
  }

  async function press() {
    setState('busy');
    const pending = build();
    // Not awaited first: the copy has to start inside the click.
    const copied = await copyWhenReady(pending);
    try {
      await pending;
    } catch {
      setState('failed');
      return;
    }
    setState(copied ? 'copied' : 'shown');
  }

  return (
    <div>
      <button type="button" className={className} disabled={state === 'busy'} onClick={() => void press()}>
        {state === 'copied' ? copiedLabel : label}
      </button>
      {state === 'copied' && <p className={ui.fine}>Paste it into your AI agent.</p>}
      {state === 'shown' && (
        <div className="text-left">
          <AgentPromptField prompt={prompt} label="Copy this into your AI agent:" />
        </div>
      )}
      {state === 'failed' && <div className={ui.note(false)}>Could not make the prompt. Try again in a moment.</div>}
    </div>
  );
}

/**
 * The agent screen's prompt (`AgentPromptButton`): `AgentPromptField`, made as it opens. A signed-in viewer's carries
 * a one-time code, which replaces the plain prompt once it comes.
 */
export function AgentPromptBox() {
  const [prompt, setPrompt] = useState('');

  useEffect(() => {
    let current = true;
    const origin = window.location.origin;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the origin is only known in the browser
    setPrompt(agentPrompt(origin));
    fetch('/api/v1/me/agent-code', { method: 'POST' })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { code?: string } | null) => {
        if (current && body?.code) setPrompt(agentPrompt(origin, body.code));
      })
      .catch(() => {
        // Signed out, or offline: the agent asks for an email instead (`/agent/start`).
      });
    return () => {
      current = false;
    };
  }, []);

  // No caption: the screen's title says what to do with it.
  return <AgentPromptField prompt={prompt} label="" />;
}
