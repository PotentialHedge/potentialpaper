import { ui } from '@/components/ui';
import { formatIdentifier, keyedPagePath, type VenueFile } from '@/lib/kinds';
import type { StatOutcome } from '@/lib/scope-stats';
import { formatScore, STATUS_LABELS } from '@/lib/submissions';
import { sourceTitle, sourceUrl } from '@/lib/venues';
import {
  presentVenuePapers,
  type StatusCounts,
  venueChildren,
  venueDecisions,
  type VenueScoreField,
  venueScoreStats,
  venueSiblings,
  venueStatusCounts,
} from '@/server/venue-pages';
import type { KindPanelProps } from './slots';
import { VenuePapersList } from './VenuePapersList';

/**
 * A venue's own panels (`handoffs/pages.md` Phase 2), beside the generic ones in `slots.tsx`. A series (`/v/iclr`)
 * shows its editions over time; an edition (`/v/iclr/2027`) its place among them, what it is, and its submissions by
 * status. Each reads what it needs itself, as a server component; like every panel, it is the same HTML for every
 * reader, and the reader's settings hide or move it (`lib/panels.ts`).
 */

const date = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

/**
 * What the venue file says, as the top of its infobox: its dates, where it is held, its own site, and where its
 * submissions come from. The venue's JSON-LD (`venueJsonLd`) says the same, from the same file.
 */
export function VenueAbout({ kindFile }: KindPanelProps) {
  if (!kindFile) return null;
  const venue = kindFile as VenueFile;
  const dates = [venue.dates?.start, venue.dates?.end].filter((d): d is string => Boolean(d)).map(date);
  const locations = venue.locations ?? [];
  const sources = venue.sources ?? [];
  if (dates.length === 0 && locations.length === 0 && !venue.url && sources.length === 0) return null;
  return (
    <div className={ui.box}>
      <table className={ui.facts}>
        <tbody>
          {dates.length > 0 && (
            <tr>
              <th scope="row">Dates</th>
              <td>{dates.join(' to ')}</td>
            </tr>
          )}
          {locations.length > 0 && (
            <tr>
              <th scope="row">{locations.length > 1 ? 'Locations' : 'Location'}</th>
              <td>
                {locations.map((l) => (
                  <div key={l}>{l}</div>
                ))}
              </td>
            </tr>
          )}
          {venue.url && (
            <tr>
              <th scope="row">Website</th>
              <td>
                <a href={venue.url} className="text-accent">
                  {new URL(venue.url).host}
                </a>
              </td>
            </tr>
          )}
          {sources.length > 0 && (
            <tr>
              <th scope="row">Submissions</th>
              <td>
                {sources.map((source, i) => {
                  const url = sourceUrl(source);
                  return (
                    <span key={source}>
                      {i > 0 && ', '}
                      {url ? (
                        <a href={url} className="text-accent">
                          {sourceTitle(source)}
                        </a>
                      ) : (
                        <span className={ui.mono}>{source}</span>
                      )}
                    </span>
                  );
                })}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** schema.org's `Event` for an edition, from its venue file, for search engines. */
export function venueJsonLd(venue: VenueFile, url: string): Record<string, unknown> {
  const locations = venue.locations ?? [];
  return {
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: venue.name,
    url,
    ...(venue.dates?.start ? { startDate: venue.dates.start } : {}),
    ...(venue.dates?.end ? { endDate: venue.dates.end } : {}),
    ...(locations.length > 0 ? { location: locations.map((name) => ({ '@type': 'Place', name, address: name })) } : {}),
    ...(venue.url ? { sameAs: venue.url } : {}),
  };
}

/** "3,704 accepted of 11,672", or the total alone before decisions. */
function countLine(counts: StatusCounts): string {
  const total = counts.total.toLocaleString('en');
  if (counts.total === 0) return 'no submissions yet';
  const accepted = counts.accepted ?? 0;
  if (accepted === 0) return `${total} submission${counts.total === 1 ? '' : 's'}`;
  const rate = Math.round((accepted / counts.total) * 100);
  return `${accepted.toLocaleString('en')} accepted of ${total} (${rate}%)`;
}

/**
 * On a series, its editions over time, newest first, each with its dates and its submissions by status. On an edition,
 * the line of its series' editions, so a reader moves between years.
 */
export async function VenueEditions({ pageKey: key, pageId, name }: KindPanelProps) {
  const page = { id: pageId, kind: 'venue' as const, key };
  if (!key.includes('/')) {
    const editions = await venueChildren(page);
    if (editions.length === 0) return <p className={ui.empty}>No editions of {name} here yet.</p>;
    return (
      <section id="editions">
        <h2 className={ui.groupHeading}>Editions</h2>
        <div className={ui.tableScroll}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th()}>Edition</th>
                <th className={ui.th()}>Dates</th>
                <th className={ui.th(true)}>Submissions</th>
                <th className={ui.th(true)}>{STATUS_LABELS.accepted}</th>
              </tr>
            </thead>
            <tbody className="font-sans text-sm">
              {editions.map((edition) => (
                <tr key={edition.key}>
                  <td className={ui.td}>
                    <a href={keyedPagePath('venue', edition.key)}>{edition.name}</a>
                  </td>
                  <td className={`${ui.td} text-muted`}>
                    {[edition.dates?.start, edition.dates?.end]
                      .filter((d): d is string => Boolean(d))
                      .map(date)
                      .join(' to ')}
                  </td>
                  <td className={`${ui.td} ${ui.num}`}>{edition.counts.total.toLocaleString('en')}</td>
                  <td className={`${ui.td} ${ui.num}`}>
                    {edition.counts.accepted
                      ? `${edition.counts.accepted.toLocaleString('en')} (${Math.round((edition.counts.accepted / edition.counts.total) * 100)}%)`
                      : '–'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    );
  }
  const [siblings, counts] = await Promise.all([venueSiblings(page), venueStatusCounts(pageId)]);
  return (
    <div className="mt-3 text-center font-sans text-sm">
      <p className="text-muted">{countLine(counts)}</p>
      {siblings && (
        <p className="mt-1">
          <a href={keyedPagePath('venue', siblings.parent.key)}>{siblings.parent.name}</a>
          {siblings.editions.length > 1 && ': '}
          {siblings.editions.length > 1 &&
            siblings.editions.toReversed().map((edition, i) => (
              <span key={edition.key}>
                {i > 0 && ' · '}
                {edition.key === key ? (
                  <b>{edition.key.slice(siblings.parent.key.length + 1)}</b>
                ) : (
                  <a href={keyedPagePath('venue', edition.key)}>{edition.key.slice(siblings.parent.key.length + 1)}</a>
                )}
              </span>
            ))}
        </p>
      )}
    </div>
  );
}

/** The venue's submissions by status, rolled up from its editions, with filters. */
export async function VenuePapers({ kind, pageKey: key, pageId }: KindPanelProps) {
  const identifier = formatIdentifier({ kind, key });
  const [initial, counts, decisions] = await Promise.all([
    presentVenuePapers(pageId),
    venueStatusCounts(pageId),
    venueDecisions(pageId),
  ]);
  return <VenuePapersList identifier={identifier} initial={initial} counts={counts} decisions={decisions} />;
}

/** Outcomes as the figure stacks them, bottom up, with their colours and words. */
const OUTCOMES: { outcome: StatOutcome; label: string; colour: string }[] = [
  { outcome: 'accepted', label: 'Accepted', colour: 'bg-up' },
  { outcome: 'rejected', label: 'Rejected', colour: 'bg-down/70' },
  { outcome: 'withdrawn', label: 'Withdrawn', colour: 'bg-faint/60' },
  { outcome: 'pending', label: 'No decision yet', colour: 'bg-rule-strong' },
];

const score = (value: number | null) => (value === null ? '–' : formatScore(Math.round(value * 100) / 100));

/** One field's means as a histogram, each bar stacked by outcome. */
function ScoreHistogram({ field }: { field: VenueScoreField }) {
  const { bins, split } = field;
  const totals = bins.counts;
  const peak = Math.max(1, ...totals);
  const shown = OUTCOMES.filter(({ outcome }) => split[outcome].count > 0);
  const range = (i: number) => `${score(bins.lo + i * bins.width)} to ${score(bins.lo + (i + 1) * bins.width)}`;
  const summary =
    `${field.label} at ${field.venue.name}: ${field.count.toLocaleString('en')} submissions, median ${score(field.median)}` +
    (shown.length > 1
      ? `; ${shown.map(({ outcome, label }) => `${label.toLowerCase()} ${split[outcome].count}`).join(', ')}`
      : '');
  return (
    <figure className="mt-3">
      <div role="img" aria-label={summary} className="flex h-28 items-end gap-px border-b border-ink">
        {totals.map((total, i) => (
          <div
            key={i}
            title={`${range(i)}: ${total.toLocaleString('en')}`}
            className="flex h-full min-w-0 flex-1 flex-col-reverse"
          >
            {OUTCOMES.map(({ outcome, colour }) => {
              const n = split[outcome].counts[i] ?? 0;
              return n > 0 ? <div key={outcome} className={colour} style={{ height: `${(n / peak) * 100}%` }} /> : null;
            })}
          </div>
        ))}
      </div>
      <div className="mt-0.5 flex justify-between font-mono text-[11px] text-muted">
        <span>{score(bins.lo)}</span>
        <span>{score(bins.hi)}</span>
      </div>
      <figcaption className={ui.caption}>
        {field.label}: each submission&apos;s mean over its reviews
        {shown.length > 1 && (
          <>
            {' '}
            ·{' '}
            {shown.map(({ outcome, label, colour }, i) => (
              <span key={outcome} className="whitespace-nowrap">
                {i > 0 && ' '}
                <span aria-hidden className={`mr-1 inline-block h-2 w-2 align-middle ${colour}`} />
                {label} ({split[outcome].count.toLocaleString('en')})
              </span>
            ))}
          </>
        )}
      </figcaption>
    </figure>
  );
}

/**
 * The venue's score statistics (`scope_stats`, `handoffs/plugins.md` Phase 4): per venue its papers were submitted to
 * (several on a series), the first score field (usually the overall rating) as a histogram split by outcome, and every
 * score field's quartiles, with the medians of accepted and rejected submissions once decisions are out. Plugins get
 * the same numbers from `scope.scores`.
 */
export async function VenueScores({ pageId }: KindPanelProps) {
  const fields = await venueScoreStats(pageId);
  if (fields.length === 0) return null;
  const byVenue = new Map<string, VenueScoreField[]>();
  for (const field of fields) byVenue.set(field.venue.id, [...(byVenue.get(field.venue.id) ?? []), field]);
  const several = byVenue.size > 1;
  return (
    <section id="scores">
      <h2 className={ui.groupHeading}>Review scores</h2>
      {[...byVenue.values()].map((list) => {
        const [first] = list;
        const decided = list.some((f) => f.split.accepted.count + f.split.rejected.count > 0);
        return (
          <div key={first.venue.id} className={several ? 'mt-5' : undefined}>
            {several && <h3 className={ui.sectionHeading}>{first.venue.name}</h3>}
            {first.hidden ? (
              <p className={ui.empty}>
                {first.count.toLocaleString('en')} submissions have scores. They are shown once the venue&apos;s
                decisions are out.
              </p>
            ) : (
              <>
                <ScoreHistogram field={first} />
                <div className={ui.tableScroll}>
                  <table className={ui.table}>
                    <thead>
                      <tr>
                        <th className={ui.th()}>Score</th>
                        <th className={ui.th(true)}>Submissions</th>
                        <th className={ui.th(true)}>Median</th>
                        <th className={ui.th(true)}>Middle half</th>
                        {decided && <th className={ui.th(true)}>Accepted</th>}
                        {decided && <th className={ui.th(true)}>Rejected</th>}
                      </tr>
                    </thead>
                    <tbody className="font-sans text-sm">
                      {list.map((f) => (
                        <tr key={f.field}>
                          <td className={ui.td}>
                            {f.label}
                            {f.min !== null && f.max !== null && (
                              <span className="text-muted">
                                {' '}
                                ({score(f.min)}–{score(f.max)})
                              </span>
                            )}
                          </td>
                          <td className={`${ui.td} ${ui.num}`}>{f.count.toLocaleString('en')}</td>
                          <td className={`${ui.td} ${ui.num}`}>{score(f.median)}</td>
                          <td className={`${ui.td} ${ui.num}`}>
                            {score(f.q1)} to {score(f.q3)}
                          </td>
                          {decided && <td className={`${ui.td} ${ui.num}`}>{score(f.split.accepted.median)}</td>}
                          {decided && <td className={`${ui.td} ${ui.num}`}>{score(f.split.rejected.median)}</td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        );
      })}
      <p className={ui.fine}>
        Each submission&apos;s mean over its public reviews. Medians by outcome are of the means. Reviews are
        OpenReview&apos;s, CC BY 4.0.
      </p>
    </section>
  );
}
