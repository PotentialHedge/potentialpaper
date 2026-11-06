import Link from 'next/link';

/**
 * One paper in a list: its PDF link, title and authors, venue and year. The whole row is one target: the
 * title's link is stretched over the row (`after:inset-0`), since a row that is itself a link could not hold
 * the PDF link, which sits above the stretched one, in a column of its own at the left so titles align.
 */
export function PaperRow({
  title,
  authors,
  abstract,
  venue,
  year,
  pdf,
  href,
}: {
  title: string;
  authors: string[];
  /** Shown under the authors when given. */
  abstract?: string | null;
  venue: string | null;
  year: number | null;
  pdf: string | null;
  href: string;
}) {
  return (
    <div className="relative grid grid-cols-[34px_1fr_150px_40px] items-center gap-x-3.5 border-b border-dotted border-rule-strong py-2 hover:bg-highlight narrow:grid-cols-[34px_1fr_40px]">
      <span className="font-sans text-xs">
        {pdf && (
          <a href={pdf} className="relative z-10 text-accent" rel="noopener noreferrer" target="_blank">
            [pdf]
          </a>
        )}
      </span>
      <span className="min-w-0 leading-[1.35]">
        {/* At most two lines; the whole title on hover. */}
        <Link href={href} className="line-clamp-2 after:absolute after:inset-0 hover:no-underline" title={title}>
          {title}
        </Link>
        <span className="block font-sans text-xs text-muted">{authorLine(authors)}</span>
        {abstract && <span className="mt-0.5 line-clamp-3 text-[13px] leading-snug text-muted">{abstract}</span>}
      </span>
      <span className="truncate text-right font-sans text-xs text-muted narrow:hidden" title={venue ?? undefined}>
        {venue}
      </span>
      <span className="text-right font-mono text-xs text-muted">{year}</span>
    </div>
  );
}

/** "A, B, C et al.": enough to recognise a paper by. */
function authorLine(names: string[]): string {
  if (names.length === 0) return 'Anonymous authors';
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} et al.` : names.join(', ');
}
