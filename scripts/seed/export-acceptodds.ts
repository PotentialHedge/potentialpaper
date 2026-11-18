import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { FIXTURE_PATH, type Fixture, type FixturePaper } from './fixture';
import { resubmitted } from './scrape';

const USAGE = `Adds a sample of one acceptodds kind (its accepted papers, e.g. "NeurIPS 2026") to the dev fixture
(${FIXTURE_PATH}) as an OpenReview venue, replacing that venue's papers if it is there. Some are picked because
they were submitted to an earlier venue too: each of those is also added to that venue in the fixture, with its
reviews from the venue's scrape, and db:seed merges the pair into one paper.

  npm run db:seed:export-acceptodds -- <kind> <OpenReview group> <year> --scrape <scrape.sqlite> <group> <name>
                                       [--overlaps 6] [--others 10]

e.g. npm run db:seed:export-acceptodds -- "NeurIPS 2026" NeurIPS.cc/2026/Conference 2026 \\
       --scrape ../papermarket/scraping/iclr2026.sqlite ICLR.cc/2026/Conference "ICLR 2026"`;

const ACCEPTODDS = 'https://acceptodds.com/api/v1';
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
  // The scrape's papers that came back at this venue, a spread of how they fared there.
  const pairs = resubmitted(values.scrape, titles, Number(values.overlaps), new Set(earlier.papers.map((p) => p.id)));

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
