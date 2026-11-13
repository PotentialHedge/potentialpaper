import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { normalizeTitle } from '@/lib/versions';

const USAGE = `Dumps every forum of OpenReview's recent venues into a SQLite file, from which
\`papers:import-venue-versions\` finds our papers' other versions (the same title at another venue).

  npm run papers:dump-openreview -- data/openreview-venues.sqlite [--years 2025,2026,2027] [--venue <id>]...
                                    [--refresh] [--per-minute 15]

It reads only \`notes/search\` filtered to a venue's group, which OpenReview serves to scripts (its \`notes\` and
PDFs ask for a browser check, which this never tries to pass). The API allows 20 requests a minute; this keeps
under that. Venues already dumped are skipped unless --refresh, so it can be stopped and run again.`;

const API = 'https://api2.openreview.net';
const USER_AGENT = 'PotentialPaper (+https://papers.potentialhedge.com)';
const PAGE = 1000;
/** Search never returns a result past this offset. */
const SEARCH_CAP = 10_000;
/** For venues past the cap: terms from the venue string (`ICLR 2026 Poster`, `Submitted to …`), unioned. */
const SPLIT_TERMS = ['Poster', 'Oral', 'Spotlight', 'Submitted', 'Withdrawn', 'Desk', 'Accept', 'Reject', 'Submission'];
/** Venues without a year in their id that are worth having anyway. */
const UNDATED = ['TMLR', 'DMLR'];

interface SearchNote {
  id: string;
  forum?: string;
  cdate?: number;
  odate?: number;
  pdate?: number;
  license?: string;
  content?: Record<string, { value?: unknown } | undefined>;
}

class Challenged extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let spacingMs = 4000;
let lastRequest = 0;
let requests = 0;

async function get(path: string, params: Record<string, string>): Promise<unknown> {
  const url = `${API}/${path}?${new URLSearchParams(params)}`;
  for (let attempt = 1; ; attempt += 1) {
    const wait = lastRequest + spacingMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    requests += 1;
    let res: Response;
    try {
      res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(60_000) });
    } catch (err) {
      if (attempt >= 4) throw err;
      await sleep(15_000 * attempt);
      continue;
    }
    const remaining = Number(res.headers.get('ratelimit-remaining') ?? 99);
    const reset = Number(res.headers.get('ratelimit-reset') ?? 60);
    if (res.status === 429) {
      console.warn(`  rate limited; waiting ${reset + 2}s`);
      await sleep((reset + 2) * 1000);
      continue;
    }
    const body = await res.text();
    if (res.status === 403 && body.includes('ChallengeRequired')) throw new Challenged(`${path}: browser check`);
    if (res.status >= 500 && attempt < 4) {
      await sleep(15_000 * attempt);
      continue;
    }
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${body.slice(0, 200)}`);
    if (remaining <= 1) await sleep((reset + 1) * 1000);
    return JSON.parse(body);
  }
}

async function venueIds(years: string[]): Promise<string[]> {
  const ids = new Set<string>();
  for (const group of ['venues', 'active_venues']) {
    const data = (await get('groups', { id: group })) as { groups?: { members?: string[] }[] };
    for (const id of data.groups?.[0]?.members ?? []) ids.add(id);
  }
  const dated = new RegExp(`(^|/)(${years.join('|')})(/|$)`);
  return [...ids].filter((id) => dated.test(id) || UNDATED.includes(id)).sort();
}

/** Every page of one search term in a venue: the notes, and whether the search stopped at its cap. */
async function search(group: string, term: string): Promise<{ notes: SearchNote[]; capped: boolean; count: number }> {
  const notes: SearchNote[] = [];
  let count = 0;
  for (let offset = 0; offset < SEARCH_CAP; offset += PAGE) {
    const data = (await get('notes/search', {
      term,
      group,
      type: 'terms',
      content: 'all',
      source: 'forum',
      limit: String(PAGE),
      offset: String(offset),
    })) as { notes?: SearchNote[]; count?: number };
    const page = data.notes ?? [];
    count = Math.max(count, data.count ?? 0);
    notes.push(...page);
    if (page.length < PAGE) return { notes, capped: false, count };
  }
  return { notes, capped: true, count };
}

const text = (note: SearchNote, key: string): string | undefined => {
  const value = note.content?.[key]?.value;
  return typeof value === 'string' ? value : undefined;
};

/** What the import needs of a forum, and no more: no reviews, no files. */
function slim(note: SearchNote) {
  const content: Record<string, { value: unknown }> = {};
  for (const key of ['title', 'abstract', 'venue', 'venueid', 'pdf', 'authors', 'keywords', 'TLDR']) {
    const value = note.content?.[key]?.value;
    if (value !== undefined && value !== null && value !== '') content[key] = { value };
  }
  return {
    id: note.id,
    forum: note.forum ?? note.id,
    cdate: note.cdate,
    odate: note.odate,
    pdate: note.pdate,
    license: note.license,
    content,
  };
}

function open(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    pragma journal_mode = wal;
    create table if not exists venues (
      id text primary key, fetched_at text not null, forums integer not null, complete integer not null, error text
    );
    create table if not exists forums (
      id text primary key, venue_group text not null, venueid text, title text not null, norm_title text not null,
      note text not null, fetched_at text not null
    );
    create index if not exists forums_norm_title on forums (norm_title);
    create index if not exists forums_venue_group on forums (venue_group);
  `);
  return db;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      years: { type: 'string', default: '2025,2026,2027' },
      venue: { type: 'string', multiple: true },
      refresh: { type: 'boolean' },
      'per-minute': { type: 'string', default: '15' },
      help: { type: 'boolean' },
    },
  });
  const [file] = positionals;
  if (!file || values.help) {
    console.error(USAGE);
    process.exit(file ? 0 : 2);
  }
  spacingMs = Math.ceil(60_000 / Math.min(19, Math.max(1, Number(values['per-minute']))));
  const db = open(file);

  const venues = values.venue?.length ? values.venue : await venueIds(values.years.split(','));
  const done = new Set(
    (db.prepare('select id from venues where error is null').all() as { id: string }[]).map((row) => row.id),
  );
  const todo = values.refresh ? venues : venues.filter((id) => !done.has(id));
  console.log(
    `${venues.length} venues, ${todo.length} to fetch, ~${Math.round((todo.length * spacingMs) / 60_000)} min`,
  );

  const insert = db.prepare(`
    insert into forums (id, venue_group, venueid, title, norm_title, note, fetched_at) values (?, ?, ?, ?, ?, ?, ?)
    on conflict (id) do update set venue_group = excluded.venue_group, venueid = excluded.venueid,
      title = excluded.title, norm_title = excluded.norm_title, note = excluded.note, fetched_at = excluded.fetched_at
  `);
  const mark = db.prepare(`
    insert into venues (id, fetched_at, forums, complete, error) values (?, ?, ?, ?, ?)
    on conflict (id) do update set fetched_at = excluded.fetched_at, forums = excluded.forums,
      complete = excluded.complete, error = excluded.error
  `);

  let total = 0;
  for (const [index, group] of todo.entries()) {
    const now = new Date().toISOString();
    try {
      const first = await search(group, group);
      const byId = new Map(first.notes.map((note) => [note.forum ?? note.id, note]));
      let complete = !first.capped && byId.size >= first.count;
      if (first.capped) {
        for (const term of SPLIT_TERMS) {
          const more = await search(group, term);
          for (const note of more.notes) byId.set(note.forum ?? note.id, note);
        }
        complete = false;
      }
      db.exec('begin');
      let kept = 0;
      for (const note of byId.values()) {
        const title = text(note, 'title')?.trim();
        if (!title) continue;
        const forum = slim(note);
        insert.run(
          forum.forum,
          group,
          text(note, 'venueid') ?? null,
          title,
          normalizeTitle(title),
          JSON.stringify(forum),
          now,
        );
        kept += 1;
      }
      mark.run(group, now, kept, complete ? 1 : 0, null);
      db.exec('commit');
      total += kept;
      console.log(`[${index + 1}/${todo.length}] ${group}: ${kept}${complete ? '' : ' (may be incomplete)'}`);
    } catch (err) {
      if (db.isTransaction) db.exec('rollback');
      if (err instanceof Challenged) {
        console.error(`OpenReview asked for a browser check (${err.message}); stopping. Run again later.`);
        process.exit(1);
      }
      const message = err instanceof Error ? err.message : String(err);
      mark.run(group, now, 0, 0, message);
      console.warn(`[${index + 1}/${todo.length}] ${group}: ! ${message}`);
    }
  }
  console.log(`done: ${total} forums from ${todo.length} venues in ${requests} requests`);
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
