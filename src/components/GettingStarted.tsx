import type { ReactNode } from 'react';
import { AGENT_START_PATH } from '@/lib/agent-prompt';
import { AgentPromptBox } from './OnboardAgent';
import { ui } from './ui';

/** One step of getting started: an illustration, if it has one, and its text. */
export type TutorialStep = { title: string; art?: ReactNode; body: ReactNode; fine?: ReactNode };

/** A real paper the illustrations are drawn from, so the tour shows the site's own content. */
export type TutorialExample = { title: string; authors: string[] };

/** The paper the illustrations fall back on when there is no example. */
const FALLBACK: TutorialExample = {
  title: 'Attention Is All You Need',
  authors: ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar', 'Jakob Uszkoreit'],
};

/**
 * Getting started's steps, after acceptodds': three about the site: open a paper, read both sections, link papers.
 * The last one offers an AI agent instead, with a second button (`OnboardAgentButton`) under its own, leading to one
 * more screen (`agentPromptStep`) that copies the prompt. Shown as a sheet by `GettingStartedSheet` and one step a
 * page by `/welcome`. `host` is this site's, for the address trick.
 */
export function tutorialSteps({
  example = FALLBACK,
  host,
  signedIn = false,
}: {
  example?: TutorialExample;
  host: string;
  signedIn?: boolean;
}): TutorialStep[] {
  return [
    {
      title: 'Open any paper',
      art: <AddressSketch host={host} />,
      body: (
        <>
          Every paper has a page here. In any arXiv link, change <span className={ui.mono}>arxiv.org</span> to{' '}
          <span className={`${ui.mono} text-ink`}>{host}</span>.
        </>
      ),
    },
    {
      title: 'Read what researchers say',
      art: <PageSketch example={example} />,
      body: (
        <>
          Its authors keep one section. Verified researchers write the other: summaries, critique and reproductions.
          Every change is a git commit.
        </>
      ),
    },
    {
      title: 'Say how papers connect',
      art: <LinksSketch example={example} />,
      body: signedIn ? (
        <>Link papers that extend, replicate or contradict each other, with your name on each link.</>
      ) : (
        <>
          Link papers that extend, replicate or contradict each other. Sign up with your institutional email to write.
        </>
      ),
    },
  ];
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
        <b className="font-semibold text-ink">Codex</b> or any AI agent. It reads and discusses papers for you, and asks
        before it posts.
      </>
    ),
  };
}

/** The tutorial's second button on its last step: on to `agentPromptStep`. Not on a phone, where no agent runs. */
export function OnboardAgentButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className={`${ui.btn({ ghost: true })} narrow:hidden`} onClick={onClick}>
      Onboard my agent
    </button>
  );
}

/** `agentPromptStep`'s prompt, to copy (`AgentPromptBox`). */
export function AgentPromptButton() {
  return <AgentPromptBox />;
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

/** Shown at the size the illustrations are set in, and never wider than the sheet. */
const SKETCH = 'w-80 max-w-full shadow-lg';

/** "A, B, C et al.", as the home list names authors. */
function authorLine(names: string[]): string {
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} et al.` : names.join(', ');
}

/** A blank line of text, as a sketch draws what it does not spell out. */
function Blank({ w }: { w: string }) {
  return <span className={`block h-2 ${w} bg-rule-soft`} />;
}

/** Two browser address bars: arXiv's address, then the same address on this site, which opens its page. */
function AddressSketch({ host }: { host: string }) {
  const bar = (children: ReactNode, live: boolean) => (
    <div
      className={`flex items-center gap-2 rounded-full border px-3 py-1.5 font-mono text-[12px] ${live ? 'border-frame bg-card text-ink' : 'border-rule bg-rule-soft/60 text-muted'}`}
    >
      <span className={`size-2 shrink-0 rounded-full ${live ? 'bg-up' : 'bg-rule-strong'}`} />
      <span className="truncate">{children}</span>
    </div>
  );
  return (
    <div className={`${SKETCH} -rotate-1 space-y-3 border border-frame bg-card p-4 shadow-lg`}>
      {bar(
        <>
          <span className="line-through decoration-accent decoration-2">arxiv.org</span>/abs/1706.03762
        </>,
        false,
      )}
      <div className="text-center text-lg leading-none text-accent">↓</div>
      {bar(
        <>
          <span className="rounded-sm bg-highlight px-0.5 font-semibold">{host}</span>/abs/1706.03762
        </>,
        true,
      )}
      <div className="space-y-1.5 pt-1">
        <span className="block font-serif text-sm text-ink">Attention Is All You Need</span>
        <Blank w="w-3/4" />
      </div>
    </div>
  );
}

/** A paper's page: its title, then the authors' section and the community's, each with a few lines. */
function PageSketch({ example }: { example: TutorialExample }) {
  return (
    <div className={`${SKETCH} rotate-1 border border-frame bg-card px-4 pt-3 pb-4`}>
      <span className="line-clamp-2 font-serif text-[15px] leading-snug text-ink">{example.title}</span>
      {example.authors.length > 0 && (
        <span className="mt-0.5 block truncate text-xs text-muted">{authorLine(example.authors)}</span>
      )}
      <div className="mt-3 border-l-2 border-ink pl-2.5">
        <div className={`${ui.runIn} text-[13px]`}>
          From the authors <span className={ui.badge}>authors</span>
        </div>
        <div className="mt-1.5">
          <Blank w="w-5/6" />
        </div>
      </div>
      <div className="mt-3 border-l-2 border-accent pl-2.5">
        <div className={`${ui.runIn} text-[13px]`}>Community</div>
        {[
          ['Summary', 'ada', 'Cambridge'],
          ['Reproduction', 'alan', 'MIT'],
        ].map(([what, who, where]) => (
          <div key={what} className="mt-1.5">
            <div className="text-xs text-ink">
              {what} <span className="text-muted">· {who}</span>
              <span className={ui.badge}>{where}</span>
            </div>
            <div className="mt-1">
              <Blank w="w-11/12" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The paper's "What links here": labeled links from two other papers, one of them contested. */
function LinksSketch({ example }: { example: TutorialExample }) {
  const link = (label: string, tone: string, note?: string) => (
    <div className="flex items-start gap-2">
      <span className="text-xs text-muted">←</span>
      <div className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className={`shrink-0 rounded-[3px] px-1.5 text-[11px] font-semibold ${tone}`}>{label}</span>
          <span className="flex-1">
            <Blank w="w-full" />
          </span>
        </span>
        {note && <span className="mt-1 block text-[11px] text-subtle italic">“{note}”</span>}
      </div>
    </div>
  );
  return (
    <div className={`${SKETCH} -rotate-2 border border-frame bg-card px-4 pt-3 pb-5`}>
      <span className="line-clamp-1 font-serif text-sm text-ink">{example.title}</span>
      <div className={`${ui.runIn} mt-2 text-[13px]`}>What links here</div>
      <div className="mt-2 space-y-2.5">
        {link('extended by', 'bg-tint text-ink')}
        {link('replicated by', 'bg-up/10 text-up')}
        {link('contradicted by', 'bg-down/10 text-down', 'The gain vanishes with a tuned baseline.')}
      </div>
    </div>
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
