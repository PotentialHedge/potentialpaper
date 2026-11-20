import { ui } from '@/components/ui';
import { evidenceLabel } from '@/lib/evidence';
import type { PaperId } from '@/lib/paper-ids';
import {
  formatVersionDate,
  VERSION_KIND_LABELS,
  versionStanding,
  type PaperVersion,
  type VersionStatus,
} from '@/lib/versions';
import { toolPath } from '@/lib/page-tools';
import { Fold } from '@/components/paper/Fold';

/**
 * The paper's versions (`lib/versions.ts`), oldest first: where it went and what became of it, each with its
 * PDF and evidence. Two are compared on their own page, by a plain form, so the cached page needs no script.
 */

function tone(status: VersionStatus | undefined): string {
  if (status === 'accepted' || status === 'published') return 'text-up';
  if (status === 'rejected' || status === 'withdrawn') return 'text-down';
  return 'text-muted';
}

function sameUrl(a: string | null | undefined, b: string | null | undefined): boolean {
  const clean = (u: string) => u.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
  return Boolean(a && b && clean(a) === clean(b));
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
  canonical,
  paperTitle,
  submissionUrls,
}: {
  versions: PaperVersion[];
  canonical: PaperId;
  paperTitle: string;
  submissionUrls: (string | null)[];
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
            · <a href={toolPath('history', { kind: 'paper', id: canonical })}>history</a>
          </span>
        </>
      }
    >
      {versions.length === 0 ? (
        <p className={ui.empty}>
          No versions are recorded yet.{' '}
          <a href="#edit" rel="nofollow">
            Add them
          </a>
          : its preprint, the venues it went to and what they decided, the camera-ready, a file each in{' '}
          <code>versions/</code>.
        </p>
      ) : (
        <form action={toolPath('versions', { kind: 'paper', id: canonical })} method="get">
          <div className={ui.tableScroll}>
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
                  <th className={ui.th()}>Outcome</th>
                  <th className={ui.th()}>PDF</th>
                  <th className={ui.th()}>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => {
                  const standing = versionStanding(v);
                  const reviewed = submissionUrls.some((url) => sameUrl(url, v.url));
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
                        {reviewed && (
                          <a href="#submissions" className="ml-2 text-xs">
                            reviews ↓
                          </a>
                        )}
                        {v.title && v.title !== paperTitle && (
                          <span className="block text-xs text-muted italic">as “{v.title}”</span>
                        )}
                        {v.note && <span className="block text-xs text-subtle">{v.note}</span>}
                      </td>
                      <td className={`${ui.td} ${tone(v.status)}`}>{standing ?? '—'}</td>
                      <td className={ui.td}>
                        {v.pdf ? (
                          <a href={v.pdf.url} rel="noopener">
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
          {comparable && (
            <p className="mt-2 flex flex-wrap items-baseline gap-x-3 font-sans text-sm">
              <button type="submit" className={ui.btn({ inline: true, ghost: true, flush: true })}>
                Compare A with B
              </button>
              <span className={ui.fine}>Their titles, abstracts and, where both have a PDF, the text.</span>
            </p>
          )}
        </form>
      )}
    </Fold>
  );
}

/** Beside the page: each version on a line, with what became of it. */
export function VersionsBox({ versions }: { versions: PaperVersion[] }) {
  if (versions.length === 0) return null;
  return (
    <div className={ui.box}>
      <h2 className={ui.boxHeading}>Versions</h2>
      <ul className="space-y-1">
        {versions.map((v) => (
          <li key={v.id} className="flex items-baseline justify-between gap-2">
            <a href="#versions" className="min-w-0 truncate text-ink" title={v.label}>
              {v.label}
            </a>
            <span className={`shrink-0 text-xs ${tone(v.status)}`}>
              {versionStanding(v) ?? formatVersionDate(v.date)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
