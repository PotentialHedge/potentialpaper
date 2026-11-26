import { ui } from '@/components/ui';
import { keyedPagePath } from '@/lib/kinds';
import { evidenceLabel } from '@/lib/evidence';
import type { SubmissionStatus } from '@/lib/submissions';
import {
  formatVersionDate,
  submissionStanding,
  VERSION_KIND_LABELS,
  type PaperVersion,
  type VersionSubmission,
} from '@/lib/versions';
import { AddMissing } from '@/components/paper/AddMissing';
import { Fold } from '@/components/paper/Fold';

/**
 * The paper's versions (`lib/versions.ts`), oldest first: where it went and what became of it, each with its
 * PDF and evidence. Two are compared on their own page, by a plain form, so the cached page needs no script.
 */

function tone(status: SubmissionStatus | undefined): string {
  if (status === 'accepted') return 'text-up';
  if (status === 'rejected' || status === 'withdrawn' || status === 'desk_rejected') return 'text-down';
  return 'text-muted';
}

/**
 * Where a version went, a line per venue: "ICLR 2026 Rejected · forum · reviews ↓". The venue's name leads to its page
 * here when it has one, and its forum at the venue has a link of its own; a venue with no page here leads to the forum.
 */
function Sent({
  submissions,
  venueLinks,
}: {
  submissions: VersionSubmission[];
  venueLinks?: Readonly<Record<string, string>>;
}) {
  return (
    <>
      {submissions.map((s, i) => {
        const standing = submissionStanding(s);
        const page = s.page ? keyedPagePath('venue', s.page) : s.venue ? venueLinks?.[s.venue] : undefined;
        const href = page ?? s.url;
        return (
          <span key={`${s.venue}-${i}`} className="block">
            {href ? (
              <a href={href} rel={page ? undefined : 'noopener'}>
                {s.venue}
              </a>
            ) : (
              s.venue
            )}
            {standing && <span className={`ml-2 ${tone(s.status)}`}>{standing}</span>}
            {page && s.url && (
              <a href={s.url} rel="noopener" className="ml-2 text-xs" title="Its forum at the venue">
                forum
              </a>
            )}
            {s.reviews && (
              <a href="#submissions" className="ml-2 text-xs">
                reviews ↓
              </a>
            )}
            {s.evidence?.length ? (
              <span className="ml-1">
                <Evidence urls={s.evidence} />
              </span>
            ) : null}
          </span>
        );
      })}
    </>
  );
}

/** The two versions the form starts on: the oldest and the newest with a PDF, or else at all. */
function defaults(versions: PaperVersion[]): [string | undefined, string | undefined] {
  const withPdf = versions.filter((v) => v.pdf);
  const pool = withPdf.length >= 2 ? withPdf : versions;
  return [pool[0]?.id, pool[pool.length - 1]?.id];
}

function Evidence({ urls }: { urls: string[] }) {
  return (
    <span className="font-sans text-xs">
      {urls.map((url, i) => (
        <a key={url} href={url} rel="noopener nofollow" title={evidenceLabel(url)} className="mr-1">
          [{i + 1}]
        </a>
      ))}
    </span>
  );
}

export function VersionsSection({
  versions,
  paperPath: here,
  paperTitle,
  venueLinks,
}: {
  versions: PaperVersion[];
  /** The venue pages here of the venues the versions name, by name (`server/entity-paths.ts`). */
  venueLinks?: Readonly<Record<string, string>>;
  /** The paper's address, its short one (`/s/42`), which its "Add" prompts and its tools' links go by. */
  paperPath: string;
  paperTitle: string;
}) {
  const [a, b] = defaults(versions);
  const comparable = versions.length >= 2;
  return (
    <Fold
      id="versions"
      title="Versions"
      extra={
        <>
          <span className="ml-3 font-sans text-xs [font-variant-caps:normal] text-faint">
            <a href="#edit" rel="nofollow">
              {versions.length > 0 ? 'edit' : 'add'}
            </a>{' '}
            · <a href={`/history${here}`}>history</a>
          </span>
        </>
      }
    >
      {versions.length === 0 ? (
        <div className={ui.empty}>
          No versions are recorded yet: its preprint, the venues it went to and what they decided, the camera-ready.{' '}
          <AddMissing what="version" paperPath={here} />
        </div>
      ) : (
        <form action={`/versions${here}`} method="get">
          <div className={ui.tableScroll} data-link-area="versions">
            <table className={`${ui.table} font-sans text-sm`}>
              <thead>
                <tr>
                  {comparable && (
                    <th className={ui.th()} title="Compare this version…">
                      <span className="sr-only">From</span>A
                    </th>
                  )}
                  {comparable && (
                    <th className={ui.th()} title="…with this one">
                      <span className="sr-only">To</span>B
                    </th>
                  )}
                  <th className={ui.th()}>Date</th>
                  <th className={ui.th()}>Version</th>
                  <th className={ui.th()}>Submitted to</th>
                  <th className={ui.th()}>PDF</th>
                  <th className={ui.th()}>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => {
                  return (
                    <tr key={v.id} className="align-baseline">
                      {comparable && (
                        <td className={ui.td}>
                          <input
                            type="radio"
                            name="a"
                            value={v.id}
                            defaultChecked={v.id === a}
                            aria-label={`Compare from ${v.label}`}
                          />
                        </td>
                      )}
                      {comparable && (
                        <td className={ui.td}>
                          <input
                            type="radio"
                            name="b"
                            value={v.id}
                            defaultChecked={v.id === b}
                            aria-label={`Compare to ${v.label}`}
                          />
                        </td>
                      )}
                      <td className={`${ui.td} ${ui.mono} whitespace-nowrap`}>{formatVersionDate(v.date) ?? '—'}</td>
                      <td className={ui.td}>
                        {v.url ? (
                          <a href={v.url} rel="noopener">
                            {v.label}
                          </a>
                        ) : (
                          v.label
                        )}
                        <span className={ui.badge}>{VERSION_KIND_LABELS[v.kind].toLowerCase()}</span>
                        {v.title && v.title !== paperTitle && (
                          <span className="block text-xs text-muted italic">as “{v.title}”</span>
                        )}
                        {v.note && <span className="block text-xs text-subtle">{v.note}</span>}
                      </td>
                      <td className={ui.td}>
                        {v.submissions?.length ? (
                          <Sent submissions={v.submissions} venueLinks={venueLinks} />
                        ) : (
                          <span className="text-faint">—</span>
                        )}
                      </td>
                      <td className={ui.td}>
                        {v.pdf ? (
                          <a
                            href={v.pdf.url}
                            rel="noopener"
                            data-umami-event="pdf_opened"
                            data-umami-event-target="version"
                          >
                            PDF
                          </a>
                        ) : (
                          <span className="text-faint">—</span>
                        )}
                      </td>
                      <td className={ui.td}>
                        {v.evidence?.length ? <Evidence urls={v.evidence} /> : <span className="text-faint">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-2 flex flex-wrap items-baseline gap-x-3 font-sans text-sm">
            {comparable && (
              <>
                <button type="submit" className={ui.btn({ inline: true, ghost: true, flush: true })}>
                  Compare A with B
                </button>
                <span className={ui.fine}>Their titles, abstracts and, where both have a PDF, the text.</span>
              </>
            )}
            <span className="text-xs">
              <AddMissing what="version" paperPath={here} />
            </span>
          </div>
        </form>
      )}
    </Fold>
  );
}

/** Beside the page: each version on a line, with what its latest venue decided. */
export function VersionsBox({ versions, paperPath }: { versions: PaperVersion[]; paperPath: string }) {
  if (versions.length === 0) return null;
  return (
    <div className={ui.box} data-link-area="versions">
      <div className={ui.boxHeadingRow}>
        <h2 className={ui.runIn}>Versions</h2>
        <AddMissing what="version" paperPath={paperPath} compact />
      </div>
      <ul className="space-y-1">
        {versions.map((v) => {
          const last = v.submissions?.at(-1);
          return (
            <li key={v.id} className="flex items-baseline justify-between gap-2">
              <a href="#versions" className="min-w-0 truncate text-ink" title={v.label}>
                {v.label}
              </a>
              <span className={`shrink-0 text-xs ${tone(last?.status)}`}>
                {(last && submissionStanding(last)) ?? formatVersionDate(v.date)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
