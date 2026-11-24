'use client';

import { track } from '@/lib/track';
import { CopyField } from './CopyField';

/** The agent screen's big button (`AgentPromptBox`). */
const BIG_BUTTON = { label: 'Copy the prompt', copiedLabel: 'Prompt copied' };

/** A prompt for the reader's AI agent, to copy (`CopyField`, with `›` in front). */
export function AgentPromptField({
  prompt,
  label = 'Paste into your AI agent:',
  big = false,
  where,
}: {
  prompt: string;
  /** Where it is shown, for analytics ('onboard', 'edit', 'missing', 'tutorial'). */
  where: string;
  label?: string;
  /** "Copy the prompt", a big button under it, instead of the small Copy bar. */
  big?: boolean;
}) {
  return (
    <div className="mt-3">
      <CopyField
        value={prompt}
        label="Prompt for your AI agent"
        caption={label}
        marker="prompt"
        bigButton={big ? BIG_BUTTON : undefined}
        onCopied={() => track('agent_prompt_copied', { target: where })}
      />
    </div>
  );
}
