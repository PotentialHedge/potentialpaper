'use client';

import { useState } from 'react';
import { Modal } from '@/components/Modal';
import { AgentPromptField } from '@/components/AgentPromptField';
import { addPrompt } from '@/lib/agent-prompt';
import { ui } from '@/components/ui';

/**
 * A small "Missing a version? Add it" under the paper's versions. It opens a choice: a prompt for the reader's AI
 * agent, which finds what is missing with evidence and asks before saving (`/agent/start` says how), or editing
 * the page's files themselves, in the Edit dialog (`EditDialog`).
 */

type Missing = 'version' | 'submission';

const ASK: Record<Missing, { question: string; title: string }> = {
  version: { question: 'Missing a version?', title: 'Add a missing version' },
  submission: { question: 'Missing a submission?', title: 'Add a missing submission' },
};

export function AddMissing({
  what,
  paperPath,
  compact = false,
}: {
  what: Missing;
  paperPath: string;
  /** Just "Add", as a box's heading has it. */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const ask = ASK[what];
  const show = async () => {
    const origin = window.location.origin;
    setPrompt(addPrompt(origin, what, paperPath));
    setOpen(true);
    // A signed-in reader's prompt carries a one-time sign-in code for the agent, as `OnboardAgent`'s does.
    try {
      const res = await fetch('/api/v1/me/agent-code', { method: 'POST' });
      if (res.ok) {
        const { code } = (await res.json()) as { code?: string };
        if (code) setPrompt(addPrompt(origin, what, paperPath, code));
      }
    } catch {
      // Signed out, or offline: the agent asks for an email instead (`/agent/start`).
    }
  };
  return (
    <>
      {compact ? (
        <button type="button" className={ui.boxAction} onClick={() => void show()} title={ask.title}>
          Add
        </button>
      ) : (
        <span className="text-faint">
          {ask.question}{' '}
          <button type="button" className={ui.linkBtn} onClick={() => void show()}>
            Add it
          </button>
        </span>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title={ask.title}>
        <AgentPromptField prompt={prompt} />
        <div className="mt-5 flex flex-wrap items-baseline gap-x-3 border-t border-rule pt-4">
          <button
            type="button"
            className={ui.btn({ inline: true, ghost: true, flush: true })}
            onClick={() => {
              setOpen(false);
              // The Edit dialog opens on its address: the web editor, or git.
              window.location.hash = '#edit';
            }}
          >
            Edit myself
          </button>
          <span className={ui.fine}>
            Each version is a file in the page&apos;s <code>versions/</code>.
          </span>
        </div>
      </Modal>
    </>
  );
}
