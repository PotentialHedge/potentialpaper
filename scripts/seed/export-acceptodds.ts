import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { normalizeTitle } from '@/lib/versions';
import { parseReply, submissionStatus, type OpenReviewNote, type ParsedNote } from '@/server/venue-sources/openreview';
import { FIXTURE_PATH, type Fixture, type FixturePaper } from './fixture';

const USAGE = `Adds a sample of one acceptodds kind (its accepted papers, e.g. "NeurIPS 2026") to the dev fixture
(${FIXTURE_PATH}) as an OpenReview venue, replacing that venue's papers if it is there. Some are picked because
they were submitted to an earlier venue too: each of those is also added to that venue in the fixture, with its
reviews from the venue's scrape, and db:seed merges the pair into one paper.

  npm run db:seed:export-acceptodds -- <kind> <OpenReview group> <year> --scrape <scrape.sqlite> <group> <name>
                                       [--overlaps 6] [--others 10]

e.g. npm run db:seed:export-acceptodds -- "NeurIPS 2026" NeurIPS.cc/2026/Conference 2026 \\
       --scrape ../papermarket/scraping/iclr2026.sqlite ICLR.cc/2026/Conference "ICLR 2026"`;

const ACCEPTODDS = 'https://acceptodds.com/api/v1';
/** Forums with more replies than this are skipped, to keep the fixture small. */
const MAX_REPLIES = 15;

interface Listing {
  slug: string;
  title: string;
  summary: string;
  authors: string[];
  links: { label: string; url: string }[];
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${ACCEPTODDS}${path}`);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
}

/** "Accept (oral)" from the NeurIPS page the listing links: `…/virtual/2026/oral/123`. */
function decisionOf(listing: Listing): string {
  const page = listing.links.find((l) => /neurips\.cc|icml\.cc|iclr\.cc/.test(l.url))?.url ?? '';
  const kind = /\/virtual\/\d{4}\/(oral|spotlight|poster)\//.exec(page)?.[1] ?? 'poster';
  return `Accept (${kind})`;
}

function forumOf(listing: Listing): string | null {
  const url = listing.links.find((l) => l.url.includes('openreview.net/forum'))?.url;
  return url ? new URL(url).searchParams.get('id') : null;
}

function toPaper(listing: Listing, forum: string, keywords: string[]): FixturePaper {
  return {
    id: forum,
    number: Number(/-(\d+)$/.exec(listing.slug)?.[1]) || null,
    title: listing.title,
    abstract: listing.summary,
    authors: listing.authors,
    keywords,
    status: 'accepted',
    decision: decisionOf(listing),
    notes: [],
  };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      scrape: { type: 'string' },
      overlaps: { type: 'string', default: '6' },
      others: { type: 'string', default: '10' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [kind, group, yearText, scrapeGroup, scrapeName] = positionals;
  if (values.help || !kind || !group || !Number.isInteger(Number(yearText)) || !values.scrape || !scrapeName) {
    console.log(USAGE);
    process.exitCode = values.help ? 0 : 1;
    return;
  }
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture;
  const earlier = fixture.venues.find((v) => v.group === scrapeGroup);
  if (!earlier) throw new Error(`${scrapeGroup} is not in the fixture yet: db:seed:export it first`);

  const { titles } = await get<{ titles: Record<string, string> }>(`/map/titles?kind=${encodeURIComponent(kind)}`);
  const byTitle = new Map(Object.entries(titles).map(([slug, title]) => [normalizeTitle(title), slug]));

  // The scrape's papers that came back at this venue, a spread of how they fared there.
  const sqlite = new DatabaseSync(values.scrape, { readOnly: true });
  const candidates = sqlite
    .prepare(
      `select s.id, s.number, s.title, s.abstract, s.authors, s.keywords, s.venueid
       from submissions s join (select forum, count(*) n from replies group by forum) r on r.forum = s.id
       where length(s.abstract) >= 200 and r.n <= ${MAX_REPLIES} order by s.id`,
    )
    .all() as unknown as {
    id: string;
    number: number | null;
    title: string;
    abstract: string;
    authors: string | null;
    keywords: string | null;
    venueid: string | null;
  }[];
  const repliesOf = sqlite.prepare(`select raw from replies where forum = ? order by cdate`);
  const want = Number(values.overlaps);
  const perStatus = new Map<string, number>();
  const pairs: { earlier: FixturePaper; slug: string }[] = [];
  for (const row of candidates) {
    if (pairs.length >= want) break;
    const slug = byTitle.get(normalizeTitle(row.title));
    if (!slug || earlier.papers.some((p) => p.id === row.id)) continue;
    const notes = (repliesOf.all(row.id) as { raw: string }[])
      .map(({ raw }) => parseReply(JSON.parse(raw) as OpenReviewNote))
      .filter((note): note is ParsedNote => note !== null)
      .map((note) => ({ ...note, forum: undefined }));
    const decision = notes.find((note) => note.kind === 'decision')?.content.decision;
    const decisionText = typeof decision === 'string' ? decision.trim() : null;
    const status = submissionStatus(row.venueid, decisionText);
    // At most half of them one status, so rejected, withdrawn and desk-rejected all show up.
    if ((perStatus.get(status ?? '') ?? 0) >= Math.ceil(want / 2)) continue;
    perStatus.set(status ?? '', (perStatus.get(status ?? '') ?? 0) + 1);
    pairs.push({
      slug,
      earlier: {
        id: row.id,
        number: row.number,
        title: row.title,
        abstract: row.abstract,
        authors: JSON.parse(row.authors ?? '[]') as string[],
        keywords: JSON.parse(row.keywords ?? '[]') as string[],
        status,
        decision: decisionText,
        notes,
      },
    });
  }
  sqlite.close();

  const papers: FixturePaper[] = [];
  let overlapping = 0;
  for (const pair of pairs) {
    const listing = await get<Listing>(`/listings/${pair.slug}`);
    const forum = forumOf(listing);
    if (!forum) continue;
    papers.push(toPaper(listing, forum, pair.earlier.keywords));
    earlier.papers.push(pair.earlier);
    overlapping += 1;
    console.log(`${pair.earlier.status} at ${scrapeName}: ${pair.earlier.title}`);
  }
  const paired = new Set(pairs.map((p) => p.slug));
  const others = Object.keys(titles)
    .filter((slug) => !paired.has(slug))
    .sort()
    .slice(0, Number(values.others));
  for (const slug of others) {
    const listing = await get<Listing>(`/listings/${slug}`);
    const forum = forumOf(listing);
    if (forum && listing.summary.length >= 200) papers.push(toPaper(listing, forum, []));
  }

  const venue = { group, name: kind, year: Number(yearText), anonymous: false, papers };
  fixture.venues = [...fixture.venues.filter((v) => v.group !== group), venue];
  writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 1)}\n`);
  console.log(`wrote ${papers.length} papers of ${kind} (${overlapping} also at ${scrapeName}) to ${FIXTURE_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
