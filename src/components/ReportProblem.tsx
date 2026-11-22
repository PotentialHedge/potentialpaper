'use client';

/** Where problem reports go: the same people run acceptodds and answer there (`app/privacy`). */
export const REPORT_ADDRESS = 'hello@acceptodds.com';

/** A mail link with a short template; the page it was clicked on is filled in when clicked. */
export function ReportProblem({ className }: { className?: string }) {
  const href = (page: string) =>
    `mailto:${REPORT_ADDRESS}?${new URLSearchParams({
      subject: 'PotentialPaper: a problem',
      body: `Page: ${page}\n\nWhat happened:\n\n\nWhat you expected:\n\n`,
    })
      .toString()
      .replace(/\+/g, '%20')}`;
  return (
    <a
      href={href('')}
      className={className}
      onClick={(e) => {
        e.currentTarget.href = href(window.location.href);
      }}
    >
      Report a problem
    </a>
  );
}
