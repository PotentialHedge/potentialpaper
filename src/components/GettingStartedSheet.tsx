'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import {
  agentPromptStep,
  AgentPromptButton,
  OnboardAgentButton,
  TutorialArt,
  TutorialText,
  tutorialSteps,
  type TutorialExample,
} from './GettingStarted';
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from './Sheet';
import { ui } from './ui';

const STEP_TITLE = 'font-serif text-2xl font-normal';

/** How far a swipe must go sideways, in px, to change the step. */
const SWIPE = 50;

/**
 * The tour behind the home page's [getting started], as acceptodds' `TutorialModal`: its steps in a modal on a wide
 * screen, a bottom sheet on a phone, each with one button. A swipe or the arrow keys change the step. Its end leads
 * to sign-up (`/welcome?step=email`), or for a signed-in viewer to their profile.
 */
export function GettingStartedSheet({
  example,
  host,
  signedIn,
}: {
  example?: TutorialExample;
  host: string;
  signedIn: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const content = useRef<HTMLDivElement>(null);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const tour = tutorialSteps({ example, host, signedIn });
  // The tour's last step, then the agent screen past it, reached only by its "Onboard my agent".
  const last = tour.length - 1;
  const steps = [...tour, agentPromptStep()];
  const current = steps[step];

  function go(next: number) {
    setStep(next);
    content.current?.scrollTo({ top: 0 });
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) setStep(0);
      }}
    >
      <SheetTrigger type="button" className="cursor-pointer font-sans text-base font-semibold text-accent">
        [getting started]
      </SheetTrigger>
      <SheetContent
        ref={content}
        onDismiss={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          if (event.key === 'ArrowRight' && step < last) go(step + 1);
          else if (event.key === 'ArrowLeft' && step > 0) go(step - 1);
        }}
        onTouchStart={(event) => {
          const t = event.touches[0];
          swipe.current = { x: t.clientX, y: t.clientY };
        }}
        onTouchEnd={(event) => {
          const from = swipe.current;
          swipe.current = null;
          const t = event.changedTouches[0];
          if (!from || !t) return;
          const dx = t.clientX - from.x;
          if (Math.abs(dx) < SWIPE || Math.abs(dx) < Math.abs(t.clientY - from.y)) return;
          if (dx < 0 && step < last) go(step + 1);
          else if (dx > 0 && step > 0) go(step - 1);
        }}
      >
        {/* The way back is the first thing on the left, as on `/welcome`'s cards (`OnboardingCard`); the dots say
            how far along. The row is kept on the first step, so the illustration does not jump between steps. */}
        <div className="flex min-h-5 items-center">
          {step > 0 && (
            <button
              type="button"
              className="-ml-1 cursor-pointer px-1 font-sans text-sm text-muted hover:text-ink"
              onClick={() => go(Math.min(step - 1, last))}
            >
              ← Back
            </button>
          )}
          <span className="flex-1" />
          <span className="mr-6 flex gap-1.5 narrow:mr-0" aria-hidden="true">
            {tour.map((s, i) => (
              <span
                key={s.title}
                className={`h-1.5 rounded-full transition-all ${i === Math.min(step, last) ? 'w-4 bg-accent' : 'w-1.5 bg-rule-strong'}`}
              />
            ))}
          </span>
        </div>
        {current.art && <TutorialArt>{current.art}</TutorialArt>}
        {/* Every step's text in one grid cell, the others invisible, so the sheet is as tall as the longest and
            never changes size between steps. */}
        <div className="mt-4 grid">
          {steps.map((s, i) => (
            <div key={s.title} className={`[grid-area:1/1] ${i === step ? '' : 'invisible'}`} aria-hidden={i !== step}>
              {i === step ? (
                <SheetTitle className={STEP_TITLE}>
                  {i <= last && `${i + 1}. `}
                  {s.title}
                </SheetTitle>
              ) : (
                <p className={STEP_TITLE}>
                  {i <= last && `${i + 1}. `}
                  {s.title}
                </p>
              )}
              <TutorialText step={s} />
            </div>
          ))}
        </div>
        <div className="mt-6">
          {step > last ? (
            <AgentPromptButton />
          ) : step < last ? (
            <button type="button" className={ui.btn()} onClick={() => go(step + 1)}>
              Next
            </button>
          ) : signedIn ? (
            <SheetClose asChild>
              <Link href="/profile" className={ui.btn()}>
                Finish my profile
              </Link>
            </SheetClose>
          ) : (
            <Link href="/welcome?step=email" className={ui.btn()} onClick={() => setOpen(false)}>
              Create my account
            </Link>
          )}
          {step === last && <OnboardAgentButton onClick={() => go(last + 1)} />}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * The home page's [onboard your agent], for a viewer past the tour: the tour's agent screen (`agentPromptStep`) on
 * its own, in the same modal or bottom sheet, whose button copies the prompt.
 */
export function OnboardAgentSheet() {
  const [open, setOpen] = useState(false);
  const step = agentPromptStep();
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger type="button" className="cursor-pointer font-sans text-base font-semibold text-accent">
        [onboard your agent]
      </SheetTrigger>
      <SheetContent onDismiss={() => setOpen(false)}>
        {step.art && <TutorialArt>{step.art}</TutorialArt>}
        <SheetTitle className={`mt-4 ${STEP_TITLE}`}>{step.title}</SheetTitle>
        <TutorialText step={step} />
        <div className="mt-6">
          <AgentPromptButton />
        </div>
      </SheetContent>
    </Sheet>
  );
}
