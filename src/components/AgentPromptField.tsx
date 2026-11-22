'use client';

import { CopyField } from './CopyField';

/** A prompt for the reader's AI agent, to copy (`CopyField`, with `›` in front). */
export function AgentPromptField({ prompt, label = 'Paste into your AI agent:' }: { prompt: string; label?: string }) {
  return (
    <div className="mt-3">
      <CopyField value={prompt} label="Prompt for your AI agent" caption={label} marker="prompt" />
    </div>
  );
}
