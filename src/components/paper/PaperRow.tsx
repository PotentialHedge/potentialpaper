import Link from 'next/link';
import { RowActions, RowNote } from '@/components/plugins/RowPlugins';

/** The link beside a paper in a list: `[pdf]`, or with no PDF its page at its source, such as `[arXiv]`. */
export interface RowLink {
  label: string;
  url: string;
  /** Said on hover, when the label alone is terse: "On OpenReview". */
  title?: string;
}

/** A paper's mean review score at its venue, and that mean over its reviews' first scores (`paper_ratings`). */
export interface RowScore {
  mean: number;
  first: number | null;
}

/** How far reviewers moved the mean since they first scored, as shown, to one decimal; `0` when not, or not known. */
function scoreMove(score: RowScore): number {
  if (score.first === null) return 0;
  return Math.round(Number(score.mean.toFixed(1)) * 10 - Number(score.first.toFixed(1)) * 10) / 10;
}

/** The venue as a row says it, for its title: "ICLR 2027 (5.5, up from 5.0 before reviewers changed their scores)". */
function venueTitle(venue: string | null, score: RowScore | null): string | undefined {
  if (!venue || !score) return venue ?? undefined;
  const move = scoreMove(score);
  const mean = `mean review score ${score.mean.toFixed(1)}`;
  if (move === 0) return `${venue}, ${mean}`;
  return `${venue}, ${mean}, ${move > 0 ? 'up' : 'down'} from ${score.first!.toFixed(1)} before reviewers changed their scores`;
}

/**
 * The venue and its mean review score: "ICLR 2027 (5.5)", or where reviewers moved it, from where it stood to where it
 * is, the latter coloured: "ICLR 2027 (5.0 → 5.5)".
 */
function Venue({ venue, score }: { venue: string | null; score: RowScore | null }) {
  if (!venue || !score) return venue;
  const move = scoreMove(score);
  if (move === 0) return `${venue} (${score.mean.toFixed(1)})`;
  return (
    <>
      {venue} ({score.first!.toFixed(1)} →{' '}
      <span className={move > 0 ? 'text-up' : 'text-down'}>{score.mean.toFixed(1)}</span>)
    </>
  );
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

/** A row's list ('search' | 'browse' | 'mine' | 'following') and its place in it, counted from 1 across pages. */
export type Listed = { list: string; rank: number };

function listedData(listed: Listed | undefined) {
  return listed ? { 'data-result-list': listed.list, 'data-rank': listed.rank } : {};
}

/**
 * One paper in a list: its PDF link (or, with no PDF, its page at its source), title, authors and year, and venue.
 * The whole row is one target: the title's link is stretched over the row (`after:inset-0`), since a row that is
 * itself a link could not hold the PDF link, which sits above the stretched one, in a column of its own at the left
 * so titles align.
 *
 * Under `RowPlugins` (`paper` given), a plugin's note on the paper takes the venue's place, and the last column
 * is `--row-actions` wide, for the ⋯ of the plugins' row commands, when there are any.
 */
export function PaperRow({
  paper,
  title,
  authors,
  venue,
  score = null,
  year,
  link,
  href,
  listed,
}: {
  /** Its identifier (`arxiv:1706.03762`), which plugins' notes name it by. */
  paper?: string;
  title: string;
  authors: string[];
  venue: string | null;
  /** Its mean review score, after the venue. */
  score?: RowScore | null;
  year: number | null;
  link: RowLink | null;
  href: string;
  /** Its list and place in it, for counting which rows are followed (`result_opened`). */
  listed?: Listed;
}) {
  return (
    <div
      {...listedData(listed)}
      className="relative grid grid-cols-[44px_1fr_150px_var(--row-actions,0px)] items-center gap-x-3.5 border-b border-dotted border-rule-strong py-2 hover:bg-highlight narrow:grid-cols-[44px_1fr_var(--row-actions,0px)]"
    >
      <span className="font-sans text-xs">{link && <SourceLink link={link} />}</span>
      <span className="min-w-0 leading-[1.35]">
        {/* At most two lines; the whole title on hover. */}
        <Link href={href} className="line-clamp-2 after:absolute after:inset-0 hover:no-underline" title={title}>
          {title}
        </Link>
        <span className="block font-sans text-xs text-muted">{authorLine(authors, year)}</span>
      </span>
      <span className="truncate text-right font-sans text-xs text-muted narrow:hidden" title={venueTitle(venue, score)}>
        {paper ? (
          <RowNote paper={paper} venue={venueTitle(venue, score) ?? null}>
            <Venue venue={venue} score={score} />
          </RowNote>
        ) : (
          <Venue venue={venue} score={score} />
        )}
      </span>
      <span className="flex items-center justify-end font-mono text-xs text-muted">
        {paper && <RowActions paper={paper} />}
      </span>
    </div>
  );
}

/** "A, B, C et al., 2017": enough to recognise a paper by. */
function authorLine(names: string[], year: number | null): string {
  const who =
    names.length === 0
      ? 'Anonymous authors'
      : names.length > 3
        ? `${names.slice(0, 3).join(', ')} et al.`
        : names.join(', ');
  return year ? `${who}, ${year}` : who;
}

/**
 * One paper in the detailed list: a picture of its first page beside the title, authors, its TL;DR (or else the
 * start of its abstract), and venue; the year follows the authors. As in `PaperRow`, the title's link covers the card, picture included, and opens the paper's
 * page. A paper with no cover gets a blank title page instead, so the column stays even. The frame is A4.
 */
export function PaperCard({
  paper,
  title,
  authors,
  abstract,
  tldr = null,
  venue,
  score = null,
  year,
  link,
  cover,
  href,
  listed,
}: {
  /** As `PaperRow`'s: a plugin's note takes the venue's place, and the plugins' ⋯ follows the PDF link. */
  paper?: string;
  title: string;
  authors: string[];
  abstract: string | null;
  /** Its one-sentence summary, shown in the abstract's place when it has one. */
  tldr?: string | null;
  venue: string | null;
  score?: RowScore | null;
  year: number | null;
  link: RowLink | null;
  cover: string | null;
  href: string;
  listed?: Listed;
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
    <div
      {...listedData(listed)}
      className="relative flex gap-4 border-b border-dotted border-rule-strong py-3.5 hover:bg-highlight narrow:gap-3"
    >
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
        <div className="mt-0.5 font-sans text-xs text-muted">{authorLine(authors, year)}</div>
        {(tldr || abstract) && (
          <p className="mt-1.5 line-clamp-3 text-[13px] leading-snug text-subtle narrow:line-clamp-2">
            {tldr ? (
              <>
                <b className="font-semibold">TL;DR.</b> {tldr}
              </>
            ) : (
              abstract
            )}
          </p>
        )}
        <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 font-sans text-xs text-muted">
          {paper ? (
            <span title={venueTitle(venue, score)}>
              <RowNote paper={paper} venue={venueTitle(venue, score) ?? null}>
                <Venue venue={venue} score={score} />
              </RowNote>
            </span>
          ) : (
            <span title={venueTitle(venue, score)}>
              <Venue venue={venue} score={score} />
            </span>
          )}
          {link && <SourceLink link={link} />}
          {paper && <RowActions paper={paper} />}
        </div>
      </div>
    </div>
  );
}
