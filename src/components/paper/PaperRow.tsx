import Link from 'next/link';
import { RowActions, RowNote } from '@/components/plugins/RowPlugins';

/** The link beside a paper in a list: `[pdf]`, or with no PDF its page at its source, such as `[arXiv]`. */
export interface RowLink {
  label: string;
  url: string;
  /** Said on hover, when the label alone is terse: "On OpenReview". */
  title?: string;
}

function SourceLink({ link }: { link: RowLink }) {
  return (
    <a
      href={link.url}
      title={link.title}
      className="relative z-10 text-accent"
      rel="noopener noreferrer"
      target="_blank"
    >
      [{link.label}]
    </a>
  );
}

/**
 * One paper in a list: its PDF link (or, with no PDF, its page at its source), title and authors, venue and year.
 * The whole row is one target: the title's link is stretched over the row (`after:inset-0`), since a row that is
 * itself a link could not hold the PDF link, which sits above the stretched one, in a column of its own at the left
 * so titles align.
 *
 * Under `RowPlugins` (`paper` given), a plugin's note on the paper takes the venue's place, and the year's column
 * widens by `--row-actions` for the ⋯ of the plugins' row commands, when there are any.
 */
export function PaperRow({
  paper,
  title,
  authors,
  venue,
  year,
  link,
  href,
}: {
  /** Its identifier (`arxiv:1706.03762`), which plugins' notes name it by. */
  paper?: string;
  title: string;
  authors: string[];
  venue: string | null;
  year: number | null;
  link: RowLink | null;
  href: string;
}) {
  return (
    <div className="relative grid grid-cols-[44px_1fr_150px_calc(40px_+_var(--row-actions,0px))] items-center gap-x-3.5 border-b border-dotted border-rule-strong py-2 hover:bg-highlight narrow:grid-cols-[44px_1fr_calc(40px_+_var(--row-actions,0px))]">
      <span className="font-sans text-xs">{link && <SourceLink link={link} />}</span>
      <span className="min-w-0 leading-[1.35]">
        {/* At most two lines; the whole title on hover. */}
        <Link href={href} className="line-clamp-2 after:absolute after:inset-0 hover:no-underline" title={title}>
          {title}
        </Link>
        <span className="block font-sans text-xs text-muted">{authorLine(authors)}</span>
      </span>
      <span className="truncate text-right font-sans text-xs text-muted narrow:hidden" title={venue ?? undefined}>
        {paper ? (
          <RowNote paper={paper} venue={venue}>
            {venue}
          </RowNote>
        ) : (
          venue
        )}
      </span>
      <span className="flex items-center justify-end gap-1 font-mono text-xs text-muted">
        {year}
        {paper && <RowActions paper={paper} />}
      </span>
    </div>
  );
}

/** "A, B, C et al.": enough to recognise a paper by. */
function authorLine(names: string[]): string {
  if (names.length === 0) return 'Anonymous authors';
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} et al.` : names.join(', ');
}

/**
 * One paper in the detailed list: a picture of its first page beside the title, authors, abstract, venue
 * and year. As in `PaperRow`, the title's link covers the card, picture included, and opens the paper's
 * page. A paper with no cover gets a blank title page instead, so the column stays even. The frame is A4.
 */
export function PaperCard({
  paper,
  title,
  authors,
  abstract,
  venue,
  year,
  link,
  cover,
  href,
}: {
  /** As `PaperRow`'s: a plugin's note takes the venue's place, and the plugins' ⋯ follows the PDF link. */
  paper?: string;
  title: string;
  authors: string[];
  abstract: string | null;
  venue: string | null;
  year: number | null;
  link: RowLink | null;
  cover: string | null;
  href: string;
}) {
  const page = cover ? (
    // A remote image already sized for this box: Next's optimizer would only fetch it again, and stop a GIF.
    // Fitted whole into the A4 frame, not cropped: an authors' thumbnail need not be a page.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={cover} alt="" loading="lazy" decoding="async" className="size-full object-contain" />
  ) : (
    <span className="flex size-full items-start justify-center px-1.5 pt-3 text-center font-serif text-[7px] leading-tight text-faint">
      <span className="line-clamp-4">{title}</span>
    </span>
  );
  const frame =
    'relative block aspect-[210/297] w-[92px] shrink-0 overflow-hidden border border-rule bg-card shadow-[0_1px_2px_rgb(0_0_0/0.08)] narrow:w-[64px]';
  return (
    <div className="relative flex gap-4 border-b border-dotted border-rule-strong py-3.5 hover:bg-highlight narrow:gap-3">
      {/* Not a link of its own: a click falls through to the title's, which covers the card. */}
      <span className={frame} aria-hidden>
        {page}
      </span>
      <div className="min-w-0 flex-1">
        <Link
          href={href}
          className="line-clamp-2 text-[17px] leading-snug after:absolute after:inset-0 hover:no-underline narrow:text-[15px]"
          title={title}
        >
          {title}
        </Link>
        <div className="mt-0.5 font-sans text-xs text-muted">{authorLine(authors)}</div>
        {abstract && (
          <p className="mt-1.5 line-clamp-3 text-[13px] leading-snug text-subtle narrow:line-clamp-2">{abstract}</p>
        )}
        <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 font-sans text-xs text-muted">
          {paper ? (
            <span>
              <RowNote paper={paper} venue={venue}>
                {venue}
              </RowNote>
              {venue && year && ' · '}
              {year}
            </span>
          ) : (
            [venue, year].filter(Boolean).join(' · ')
          )}
          {link && <SourceLink link={link} />}
          {paper && <RowActions paper={paper} />}
        </div>
      </div>
    </div>
  );
}
