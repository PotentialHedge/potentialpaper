'use client';

import { type ReactNode, useEffect, useState } from 'react';
import { LockOpenIcon } from '@/components/icons';
import { ui } from '@/components/ui';
import { BOT_SOURCE_HINT, BOT_SOURCE_LABEL, BOT_SOURCES, type BotSource } from '@/lib/bot-sources';
import { KINDS, type PageKind } from '@/lib/kinds';

/**
 * A page's analytics, as a tab only its owners see (`server/page-analytics.ts`, `GET /api/v1/analytics`). The page is
 * the same cached HTML for everyone, so whether the tab is there is decided here: the request answers only an owner
 * (or an admin), and anyone else gets no tab. Charts are drawn as the venue's score histogram is (`venue-panels.tsx`).
 */

export interface PageAnalytics {
  days: { day: string; views: number; git: number; bots: number; botSources: Record<BotSource, number> }[];
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

/** One line of a bar's tooltip: a stack's part, with its colour. */
interface TipLine {
  label: string;
  value: number;
  colour: string;
}

/**
 * Bars over labelled positions, as the score histogram draws them, each a stack of `segments` (bottom first, in
 * `colours`), with a tooltip on hover: its `titles` line, and each part of the stack when there is more than one.
 */
function Bars({
  segments,
  colours,
  names,
  titles,
  label,
  height = 'h-28',
}: {
  segments: number[][];
  colours: string[];
  /** Each part's name, for the tooltip; none for a bar of one part. */
  names?: string[];
  titles: string[];
  label: string;
  height?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const totals = segments.map((parts) => parts.reduce((a, b) => a + b, 0));
  const peak = Math.max(1, ...totals);
  const count = segments.length;
  let tip: ReactNode = null;
  if (hover !== null) {
    const lines: TipLine[] = names
      ? names.map((name, j) => ({ label: name, value: segments[hover][j], colour: colours[j] })).reverse()
      : [];
    const left = hover < count / 2;
    tip = (
      <div
        role="tooltip"
        className="pointer-events-none absolute bottom-full z-10 mb-1.5 border border-frame bg-card px-2.5 py-1.5 font-sans text-xs whitespace-nowrap shadow-sm"
        style={left ? { left: `${(hover / count) * 100}%` } : { right: `${((count - hover - 1) / count) * 100}%` }}
      >
        <div className="text-ink">{titles[hover]}</div>
        {lines.length > 1 &&
          lines.map((line) => (
            <div key={line.label} className="mt-0.5 flex items-center gap-1.5 text-muted">
              <span className={`inline-block size-2 ${line.colour}`} />
              {line.label}
              <span className="ml-auto pl-3 font-mono text-ink">{n(line.value)}</span>
            </div>
          ))}
      </div>
    );
  }
  return (
    <div className="relative" onMouseLeave={() => setHover(null)}>
      {tip}
      <div role="img" aria-label={label} className={`flex ${height} items-end gap-px border-b border-ink`}>
        {segments.map((parts, i) => (
          <div
            key={i}
            onMouseEnter={() => setHover(i)}
            className={`flex h-full min-w-0 flex-1 flex-col-reverse ${hover === i ? 'bg-ink/5' : ''}`}
          >
            {parts.map(
              (value, j) =>
                value > 0 && <div key={j} className={colours[j]} style={{ height: `${(value / peak) * 100}%` }} />,
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Each kind of bot's colour, bottom of the stack first. */
const BOT_COLOUR: Record<BotSource, string> = {
  assistant: 'bg-accent/80',
  ai: 'bg-accent/40',
  search: 'bg-ink/45',
  other: 'bg-faint/50',
};

/** Bots' reads a day, stacked by kind of bot. */
function BotChart({ days }: { days: PageAnalytics['days'] }) {
  const first = days[0]?.day;
  const last = days[days.length - 1]?.day;
  return (
    <figure className="mt-3">
      <Bars
        segments={days.map((d) => BOT_SOURCES.map((source) => d.botSources[source]))}
        colours={BOT_SOURCES.map((source) => BOT_COLOUR[source])}
        names={BOT_SOURCES.map((source) => BOT_SOURCE_LABEL[source])}
        titles={days.map((d) => `${shortDate(d.day)}: ${n(d.bots)} bot reads`)}
        height="h-20"
        label={`Bot reads a day: ${n(days.reduce((sum, d) => sum + d.bots, 0))} over the last ${days.length} days`}
      />
      <div className="mt-0.5 flex justify-between font-mono text-[11px] text-muted">
        <span>{first && shortDate(first)}</span>
        <span>{last && shortDate(last)}</span>
      </div>
    </figure>
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
  metric: 'views' | 'git' | 'bots';
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
        segments={values.map((v) => [v])}
        colours={[colour]}
        titles={data.days.map((d) => `${shortDate(d.day)}: ${n(d[metric])}`)}
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

function lastDays(data: PageAnalytics, metric: 'views' | 'git' | 'bots', days: number): number {
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
  const bots = lastDays(data, 'bots', data.days.length);
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
            segments={data.time.map((v) => [v])}
            colours={['bg-accent/70']}
            titles={data.time.map((v, i) => `${TIME_LABELS[i]}: ${n(v)}`)}
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

      <h2 className={ui.groupHeading}>Bots and crawlers</h2>
      <p className="font-sans text-sm">
        <span className="font-mono">{n(bots)}</span> reads in the last {data.days.length} days
      </p>
      <BotChart days={data.days} />
      <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1 font-sans text-xs text-muted">
        {BOT_SOURCES.map((source) => (
          <li key={source} title={BOT_SOURCE_HINT[source]} className="flex items-center gap-1.5">
            <span className={`inline-block size-2 ${BOT_COLOUR[source]}`} />
            {BOT_SOURCE_LABEL[source]}
            <span className="font-mono text-ink">{n(data.days.reduce((sum, d) => sum + d.botSources[source], 0))}</span>
          </li>
        ))}
      </ul>
      <p className={ui.fine}>
        Bots that say they are one, reading the page{kind === 'paper' && ' or its page for AI agents'}, counted per
        request as Cloudflare reports them, and updated daily. AI assistants fetch a page for someone who asked them; AI
        crawlers collect pages for training and AI search.
      </p>

      <h2 className={ui.groupHeading}>Git</h2>
      <p className="font-sans text-sm">
        <span className="font-mono">{n(git)}</span> clones and pulls
      </p>
      <DailyChart data={data} metric="git" what="Clones and pulls a day" colour="bg-faint/60" height="h-16" />
      <p className={ui.fine}>
        Over the last {data.days.length} days, each visitor counted once a day. None of these numbers says who anyone
        is.
      </p>
    </section>
  );
}
