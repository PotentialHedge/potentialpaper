'use client';

import { useEffect, useState } from 'react';
import { LockOpenIcon } from '@/components/icons';
import { ui } from '@/components/ui';
import { KINDS, type PageKind } from '@/lib/kinds';

/**
 * A page's analytics, as a tab only its owners see (`server/page-analytics.ts`, `GET /api/v1/analytics`). The page is
 * the same cached HTML for everyone, so whether the tab is there is decided here: the request answers only an owner
 * (or an admin), and anyone else gets no tab. Charts are drawn as the venue's score histogram is (`venue-panels.tsx`).
 */

export interface PageAnalytics {
  days: { day: string; views: number; git: number; agent: number }[];
  totalViews: number;
  time: number[];
  institutions: { name: string; visitors: number }[];
  next: { name: string; address: string; count: number }[];
  previous: { name: string; address: string; count: number }[];
}

/** As `TIME_BUCKETS` in `server/page-analytics.ts`. */
const TIME_LABELS = ['<10 s', '10–30 s', '30 s–1 min', '1–2 min', '2–5 min', '5–10 min', '>10 min'];
/** As `MIN_INSTITUTION_VISITORS`. */
const MIN_INSTITUTION_VISITORS = 5;

/** The page's analytics when the viewer may see them, else `null`. */
export function usePageAnalytics(pageId: string | undefined): PageAnalytics | null {
  const [data, setData] = useState<PageAnalytics | null>(null);
  useEffect(() => {
    if (!pageId) return;
    const abort = new AbortController();
    fetch(`/api/v1/analytics?page=${pageId}`, { credentials: 'same-origin', cache: 'no-store', signal: abort.signal })
      .then((res) => (res.ok ? (res.json() as Promise<PageAnalytics>) : null))
      .then(setData)
      .catch(() => {});
    return () => abort.abort();
  }, [pageId]);
  return data;
}

const n = (value: number) => value.toLocaleString('en');

function shortDate(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** Bars over labelled positions, as the score histogram draws them. */
function Bars({
  values,
  titles,
  colour,
  label,
  height = 'h-28',
}: {
  values: number[];
  titles: string[];
  colour: string;
  label: string;
  height?: string;
}) {
  const peak = Math.max(1, ...values);
  return (
    <div role="img" aria-label={label} className={`flex ${height} items-end gap-px border-b border-ink`}>
      {values.map((value, i) => (
        <div key={i} title={titles[i]} className="flex h-full min-w-0 flex-1 flex-col-reverse">
          {value > 0 && <div className={colour} style={{ height: `${(value / peak) * 100}%` }} />}
        </div>
      ))}
    </div>
  );
}

/** One daily series over the window, with its first and last day under it. */
function DailyChart({
  data,
  metric,
  what,
  colour,
  height,
}: {
  data: PageAnalytics;
  metric: 'views' | 'git' | 'agent';
  what: string;
  colour: string;
  height?: string;
}) {
  const values = data.days.map((d) => d[metric]);
  const first = data.days[0]?.day;
  const last = data.days[data.days.length - 1]?.day;
  const sum = values.reduce((a, b) => a + b, 0);
  return (
    <figure className="mt-3">
      <Bars
        values={values}
        titles={data.days.map((d) => `${shortDate(d.day)}: ${n(d[metric])}`)}
        colour={colour}
        height={height}
        label={`${what}: ${n(sum)} over the last ${data.days.length} days`}
      />
      <div className="mt-0.5 flex justify-between font-mono text-[11px] text-muted">
        <span>{first && shortDate(first)}</span>
        <span>{last && shortDate(last)}</span>
      </div>
    </figure>
  );
}

function lastDays(data: PageAnalytics, metric: 'views' | 'git' | 'agent', days: number): number {
  return data.days.slice(-days).reduce((sum, d) => sum + d[metric], 0);
}

/** The bucket the middle visitor is in. */
function medianBucket(time: number[]): number | null {
  const total = time.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  let seen = 0;
  for (let i = 0; i < time.length; i += 1) {
    seen += time[i];
    if (seen >= total / 2) return i;
  }
  return null;
}

function Related({ title, pages }: { title: string; pages: PageAnalytics['next'] }) {
  return (
    <div>
      <h3 className={ui.sectionHeading}>{title}</h3>
      {pages.length === 0 ? (
        <p className="text-sm text-muted italic">None yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {pages.map((p) => (
            <li key={p.address} className="flex justify-between gap-3">
              <a href={p.address} className="min-w-0">
                {p.name}
              </a>
              <span className={ui.num}>{n(p.count)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AnalyticsPanel({
  data,
  kind,
  who,
}: {
  data: PageAnalytics;
  kind: PageKind;
  /** Its owners, as the page calls them ("the authors"); `null` on a person's page, which only they own. */
  who: string | null;
}) {
  const timeTotal = data.time.reduce((a, b) => a + b, 0);
  const median = medianBucket(data.time);
  const git = lastDays(data, 'git', data.days.length);
  const agent = lastDays(data, 'agent', data.days.length);
  return (
    <section id="analytics">
      <p className={`${ui.fine} flex items-center gap-1.5 font-sans`}>
        <LockOpenIcon />
        {who ? `Only ${who} of this ${KINDS[kind].title.toLowerCase()} can see this.` : 'Only you can see this.'}
      </p>
      <h2 className={`${ui.groupHeading} mt-4`}>Visitors</h2>
      <p className="font-sans text-sm">
        <span className="font-mono">{n(lastDays(data, 'views', 30))}</span> in the last 30 days ·{' '}
        <span className="font-mono">{n(data.totalViews)}</span> in all
      </p>
      <DailyChart data={data} metric="views" what="Visitors a day" colour="bg-accent/70" />
      <p className={ui.caption}>Visitors a day, each counted once a day</p>

      <h2 className={ui.groupHeading}>Time on the page</h2>
      {timeTotal === 0 ? (
        <p className="text-sm text-muted italic">Nothing measured yet.</p>
      ) : (
        <figure className="mt-3">
          <Bars
            values={data.time}
            titles={data.time.map((v, i) => `${TIME_LABELS[i]}: ${n(v)}`)}
            colour="bg-accent/70"
            label={`Time on the page: ${n(timeTotal)} visitors, median ${median === null ? '–' : TIME_LABELS[median]}`}
          />
          <div className="mt-0.5 flex gap-px font-mono text-[11px] text-muted">
            {TIME_LABELS.map((label) => (
              <span key={label} className="min-w-0 flex-1 truncate text-center">
                {label}
              </span>
            ))}
          </div>
          <figcaption className={ui.caption}>
            How long {n(timeTotal)} visitors kept the page open over the last {data.days.length} days · median{' '}
            {median === null ? '–' : TIME_LABELS[median]}
          </figcaption>
        </figure>
      )}

      <h2 className={ui.groupHeading}>Where readers are from</h2>
      {data.institutions.length === 0 ? (
        <p className="text-sm text-muted italic">
          Not enough yet: an institution is shown once {MIN_INSTITUTION_VISITORS} of its signed-in people read the page
          in a month.
        </p>
      ) : (
        <div className={ui.tableScroll}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th()}>Institution</th>
                <th className={ui.th(true)}>Visitors</th>
              </tr>
            </thead>
            <tbody className="font-sans text-sm">
              {data.institutions.map((row) => (
                <tr key={row.name}>
                  <td className={ui.td}>{row.name}</td>
                  <td className={`${ui.td} ${ui.num}`}>{n(row.visitors)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className={ui.fine}>
        Signed-in readers in the last 12 months, each counted once a month. An institution is shown only for months in
        which at least {MIN_INSTITUTION_VISITORS} of its people read the page.
      </p>

      <h2 className={ui.groupHeading}>What its readers read</h2>
      <div className="mt-3 grid grid-cols-2 gap-8 font-sans text-sm narrow:grid-cols-1">
        <Related title="Just before" pages={data.previous} />
        <Related title="Just after" pages={data.next} />
      </div>

      <h2 className={ui.groupHeading}>{kind === 'paper' ? 'Git and agents' : 'Git'}</h2>
      <div className="grid grid-cols-2 gap-8 narrow:grid-cols-1">
        <div>
          <p className="mt-3 font-sans text-sm">
            <span className="font-mono">{n(git)}</span> clones and pulls
          </p>
          <DailyChart data={data} metric="git" what="Clones and pulls a day" colour="bg-faint/60" height="h-16" />
        </div>
        {kind === 'paper' && (
          <div>
            <p className="mt-3 font-sans text-sm">
              <span className="font-mono">{n(agent)}</span> reads of its page for AI agents
            </p>
            <DailyChart data={data} metric="agent" what="Agent reads a day" colour="bg-faint/60" height="h-16" />
          </div>
        )}
      </div>
      <p className={ui.fine}>
        Over the last {data.days.length} days, each visitor counted once a day. None of these numbers says who anyone
        is.
      </p>
    </section>
  );
}
