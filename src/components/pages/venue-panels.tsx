import { ui } from '@/components/ui';
import { formatIdentifier, keyedPagePath, type VenueFile } from '@/lib/kinds';
import { STATUS_LABELS } from '@/lib/submissions';
import { sourceTitle, sourceUrl } from '@/lib/venues';
import {
  presentVenuePapers,
  type StatusCounts,
  venueChildren,
  venueDecisions,
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

/** What the venue file says: its dates, its own site, and where its submissions come from. */
export function VenueAbout({ kindFile }: KindPanelProps) {
  if (!kindFile) return null;
  const venue = kindFile as VenueFile;
  const dates = [venue.dates?.start, venue.dates?.end].filter((d): d is string => Boolean(d)).map(date);
  const sources = venue.sources ?? [];
  if (dates.length === 0 && !venue.url && sources.length === 0) return null;
  return (
    <p className={`${ui.fine} text-center`}>
      {dates.length > 0 && <span>{dates.join(' to ')}</span>}
      {venue.url && (
        <span>
          {dates.length > 0 && ' · '}
          <a href={venue.url}>{new URL(venue.url).host}</a>
        </span>
      )}
      {sources.length > 0 && (
        <span>
          {(dates.length > 0 || venue.url) && ' · '}
          Submissions from{' '}
          {sources.map((source, i) => {
            const url = sourceUrl(source);
            return (
              <span key={source}>
                {i > 0 && ', '}
                {url ? <a href={url}>{sourceTitle(source)}</a> : <span className={ui.mono}>{source}</span>}
              </span>
            );
          })}
        </span>
      )}
    </p>
  );
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

/** The organisers' section, or the way to claim the venue while nobody has. */
export function VenueOrganizers({ pageKey: key, ownersHtml }: KindPanelProps) {
  const claim = `/claim/venue/${key.split('/').map(encodeURIComponent).join('/')}`;
  return (
    <section id="organizers">
      <h2 className={ui.groupHeading}>Organisers</h2>
      {ownersHtml ? (
        <>
          <div className="md" dangerouslySetInnerHTML={{ __html: ownersHtml }} />
          <p className={ui.fine}>
            Written by the venue&apos;s confirmed organisers. <a href={claim}>Are you one?</a>
          </p>
        </>
      ) : (
        <p className={ui.empty}>
          Nothing from the organisers yet. Organise this venue? <a href={claim}>Claim it</a>.
        </p>
      )}
    </section>
  );
}

/**
 * The venue's submissions by status, rolled up from its editions, with filters. Score statistics join here once
 * `scope_stats` exists (`handoffs/plugins.md` Phase 4, `venueScoreStats`).
 */
export async function VenuePapers({ kind, pageKey: key, pageId }: KindPanelProps) {
  const identifier = formatIdentifier({ kind, key });
  const [initial, counts, decisions, scores] = await Promise.all([
    presentVenuePapers(pageId),
    venueStatusCounts(pageId),
    venueDecisions(pageId),
    venueScoreStats(pageId),
  ]);
  return (
    <>
      {scores /* Phase 4's statistics render here, above the list, once there are any. */}
      <VenuePapersList identifier={identifier} initial={initial} counts={counts} decisions={decisions} />
    </>
  );
}
