/** Three linked papers: the accent mark beside the wordmark, and `app/icon.svg`. */
export function LogoMark({ size = 20 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" className="inline align-[-3px] text-accent">
      <path d="M5 19 12 5l7 14" fill="none" stroke="currentColor" strokeWidth="2.25" />
      <circle cx="5" cy="19" r="3.5" fill="currentColor" />
      <circle cx="12" cy="5" r="3.5" fill="currentColor" />
      <circle cx="19" cy="19" r="3.5" fill="currentColor" />
    </svg>
  );
}

/** The site's name as the header sets it: "potential" in ink, "paper" in the accent. */
export function Wordmark() {
  return (
    <>
      potential<i className="text-accent not-italic">paper</i>
    </>
  );
}
