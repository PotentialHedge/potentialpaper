'use client';

import { OTPInput, REGEXP_ONLY_DIGITS, type SlotProps } from 'input-otp';

/**
 * A one-time code as a row of boxes, one digit each: shadcn's `InputOTP`, in
 * our tokens. Underneath it is one real, invisible `<input>` (`input-otp`),
 * so pasting the whole code, the phone's "from Messages/Mail" suggestion and
 * password managers all fill it at once, and deleting or moving the cursor
 * works as in any field. Digits only; anything else typed or pasted is
 * refused, and a pasted code with spaces or dashes is cleaned first.
 *
 * Centered and large on its own (sign-up); `compact` is smaller and starts at the left, for a code inside a form
 * (claiming a paper, confirming an address on the profile).
 */
export function CodeInput({
  value,
  onChange,
  onComplete,
  length = 6,
  autoFocus,
  disabled,
  compact = false,
  ref,
  'aria-label': ariaLabel = 'Code',
}: {
  value: string;
  onChange: (value: string) => void;
  /** When the last digit is in, typed or pasted. */
  onComplete?: (value: string) => void;
  length?: number;
  autoFocus?: boolean;
  disabled?: boolean;
  /** Smaller boxes, left-aligned. */
  compact?: boolean;
  /** The real input, to focus it again. */
  ref?: React.Ref<HTMLInputElement>;
  'aria-label'?: string;
}) {
  return (
    <OTPInput
      ref={ref}
      value={value}
      onChange={onChange}
      onComplete={onComplete}
      maxLength={length}
      pattern={REGEXP_ONLY_DIGITS}
      pasteTransformer={(text) => text.replace(/\D/g, '')}
      inputMode="numeric"
      autoComplete="one-time-code"
      autoFocus={autoFocus}
      disabled={disabled}
      aria-label={ariaLabel}
      containerClassName={`flex items-center has-disabled:opacity-50 ${compact ? '' : 'my-2 justify-center'}`}
      render={({ slots }) => (
        <div className="flex">
          {slots.map((slot, i) => (
            <Slot key={i} {...slot} compact={compact} />
          ))}
        </div>
      )}
    />
  );
}

/** One box: its digit, or the blinking caret where the next one goes. */
function Slot({ char, hasFakeCaret, isActive, compact }: SlotProps & { compact: boolean }) {
  return (
    <div
      className={`relative -ml-px flex items-center justify-center border bg-white font-mono text-ink first:ml-0 ${
        compact ? 'h-8 w-7 text-base narrow:h-10 narrow:w-9' : 'h-11 w-10 text-xl narrow:h-12 narrow:w-11'
      } ${isActive ? 'z-10 border-ink outline outline-ink' : 'border-rule-strong'}`}
    >
      {char}
      {hasFakeCaret && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className={`${compact ? 'h-4' : 'h-5'} w-px animate-caret-blink bg-ink`} />
        </div>
      )}
    </div>
  );
}
