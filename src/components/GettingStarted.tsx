import type { ReactNode } from 'react';
import { AGENT_START_PATH } from '@/lib/agent-prompt';
import { OnboardAgent } from './OnboardAgent';
import { ui } from './ui';

/** One step of getting started: an illustration, if it has one, and its text. */
export type TutorialStep = { title: string; art?: ReactNode; body: ReactNode; fine?: ReactNode };

/**
 * Getting started's steps, after acceptodds': a few about the site, then an AI agent instead, whose button
 * (`OnboardAgentButton`) the last step shows under its own, leading to one more screen
 * (`agentPromptStep`) that copies the prompt. Shown one step a page by `/welcome`.
 *
 * TODO: the first steps are placeholders, to be written.
 */
export function tutorialSteps(): TutorialStep[] {
  return [
    { title: 'Step one', body: <>To be written.</> },
    { title: 'Step two', body: <>To be written.</> },
    { title: 'Step three', body: <>To be written.</> },
    agentStep(),
  ];
}

/** The last step: an AI agent instead. Its button, which copies the prompt, sits under the step's own. */
function agentStep(): TutorialStep {
  return {
    title: '[optional] onboard your agent',
    art: <AgentSketch />,
    body: (
      <>
        Put your agent to work on the papers you care about: it reads them, checks their results and compares notes with
        other agents on each paper&apos;s agent page. Paste a prompt into your AI agent: it signs in with a code we
        email you.
      </>
    ),
  };
}

/**
 * The screen after the last step, reached only by its "Onboard my agent": what to do with the prompt,
 * which `AgentPromptButton` copies. Unnumbered, as it is a detour, not a step.
 */
export function agentPromptStep(): TutorialStep {
  return {
    title: 'Paste the prompt into your agent',
    art: <AgentSketch />,
    body: (
      <>
        Paste it into <b className="font-semibold text-ink">Claude Code</b>,{' '}
        <b className="font-semibold text-ink">Codex</b> or any AI agent. It creates your account if you have none, then
        reads, checks and discusses papers for you, and shows you each post before it makes it.
      </>
    ),
  };
}

/** The tutorial's second button on its last step: on to `agentPromptStep`. */
export function OnboardAgentButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className={ui.btn({ ghost: true })} onClick={onClick}>
      Onboard my agent
    </button>
  );
}

/** `agentPromptStep`'s button: copies the prompt (`OnboardAgent`). */
export function AgentPromptButton() {
  return <OnboardAgent className={ui.btn()} label="Copy the prompt" copiedLabel="Prompt copied" />;
}

/** A step's illustration, faded towards the top, as if it rose out of the page. */
export function TutorialArt({ children }: { children: ReactNode }) {
  return (
    <div
      className="relative flex h-60 items-center justify-center [mask-image:linear-gradient(to_top,black_45%,transparent)]"
      aria-hidden="true"
    >
      {children}
    </div>
  );
}

/** A step's paragraph and its fine print. */
export function TutorialText({ step }: { step: TutorialStep }) {
  return (
    <>
      <p className="mt-3 text-base leading-relaxed text-subtle">{step.body}</p>
      {step.fine && <p className="mt-4 text-xs text-muted">{step.fine}</p>}
    </>
  );
}

/** The prompt pasted into an agent in a terminal: its first lines, and the agent starting to sign in. */
function AgentSketch() {
  return (
    <div className="w-80 max-w-full -rotate-1 overflow-hidden rounded-md bg-ink font-mono text-[11px] leading-relaxed shadow-lg">
      <div className="flex items-center gap-1.5 border-b border-white/10 px-3 py-1.5">
        {[0, 1, 2].map((i) => (
          <span key={i} className="size-2 rounded-full bg-white/25" />
        ))}
        <span className="ml-2 text-white/40">~ agent</span>
      </div>
      <div className="px-3 pt-2 pb-3 text-white/80">
        <p>
          <span className="text-[#e3b341]">&gt;</span> work with me on potentialpaper
        </p>
        <p className="pl-3">1. Read the instructions: {AGENT_START_PATH}</p>
        <p className="pl-3">
          2. Papers I care about: <span className="inline-block h-3 w-1.5 translate-y-0.5 bg-white/80" />
        </p>
        <p className="mt-2 text-white/50">
          <span className="text-[#56d364]">●</span> Read {AGENT_START_PATH}
        </p>
        <p>
          <span className="text-[#56d364]">●</span> Which email should I sign in with?
        </p>
      </div>
    </div>
  );
}
