import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { forumUrl } from '@/server/venue-sources/openreview';
import { FIXTURE_PATH, type Fixture, type FixtureNote, type FixturePaper } from './fixture';

const USAGE = `Fills one fixture venue's papers (${FIXTURE_PATH}) with their reviews and comments from acceptodds, for a
venue still under review that the OpenReview scrape has none of. Papers are found by their submission number
(acceptodds' <kind>-<number>, e.g. iclr2027-37553), and checked against their forum id.

  npm run db:seed:acceptodds-reviews -- <OpenReview group> [--sample 400]

--sample  also adds that many more of the venue's papers (an even spread of acceptodds' list), with only their
          reviewers' scores, so the venue's score distribution has its real shape (the full reviews of all of them
          would make the fixture megabytes). Replaces the sample added before.

e.g. npm run db:seed:acceptodds-reviews -- ICLR.cc/2027/Conference --sample 400`;

const ACCEPTODDS = 'https://acceptodds.com/api/v1';

interface Listing {
  slug: string;
  title: string;
  summary: string;
  keywords: string[];
  venueStatus: string | null;
  links: { label: string; url: string }[];
}

function forumOf(listing: Listing): string | null {
  const url = listing.links.find((l) => l.url.includes('openreview.net/forum'))?.url;
  return url ? new URL(url).searchParams.get('id') : null;
}

/** Runs `fn` over `items`, `n` at a time. */
async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

interface Review {
  externalId: string;
  kind: string;
  replyTo: string | null;
  author: string;
  title: string | null;
  rating: number | null;
  scores: { label: string; value: number }[];
  scoreChanges: { label: string; from: number; at: string }[];
  sections: { label: string; text: string }[];
  postedAt: string;
}

/** "Paper summary" → `paper_summary`, "Questions for authors" → `questions_for_authors`, as OpenReview keys them. */
function key(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

/** Acceptodds' reviews and comments as the OpenReview notes the import takes. */
function toNote(forum: string, r: Review): FixtureNote | null {
  const signature = r.author.replace(/_/g, ' ');
  const changed = r.scoreChanges.map((c) => c.at).sort();
  const base = {
    externalId: r.externalId,
    signature,
    license: 'CC-BY-4.0',
    url: `${forumUrl(forum)}&noteId=${r.externalId}`,
    createdAt: r.postedAt,
    modifiedAt: changed.at(-1) ?? null,
  };
  if (r.kind === 'review') {
    const content: FixtureNote['content'] = {};
    if (r.rating !== null) content.rating = r.rating;
    for (const s of r.scores) content[key(s.label)] = s.value;
    for (const s of r.sections) content[key(s.label)] = s.text;
    return { ...base, replyTo: null, kind: 'review', invitation: 'Official_Review', content };
  }
  if (r.kind === 'comment') {
    const official = /^(Authors|Reviewer|Area Chair|Program Chairs)/.test(signature);
    const content: FixtureNote['content'] = { comment: r.sections.map((s) => s.text).join('\n\n') };
    if (r.title) content.title = r.title;
    return {
      ...base,
      // A comment on the paper itself replies to its forum.
      replyTo: r.replyTo ?? forum,
      kind: 'comment',
      invitation: official ? 'Official_Comment' : 'Public_Comment',
      content,
    };
  }
  return null;
}

async function get<T>(path: string, tries = 8): Promise<T | null> {
  const res = await fetch(`${ACCEPTODDS}${path}`);
  if (res.status === 429 && tries > 0) {
    // Rate limited: wait as long as it says (or a few seconds), then again.
    const wait = Number(res.headers.get('retry-after') ?? res.headers.get('x-ratelimit-reset') ?? 5);
    await new Promise((r) => setTimeout(r, Math.max(1, wait) * 1000));
    return get<T>(path, tries - 1);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { sample: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  const [group] = positionals;
  if (values.help || !group) {
    console.log(USAGE);
    process.exitCode = values.help ? 0 : 1;
    return;
  }
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture;
  const venue = fixture.venues.find((v) => v.group === group);
  if (!venue) throw new Error(`${group} is not in the fixture`);
  const prefix = venue.name.toLowerCase().replace(/[^a-z0-9]/g, '');
  // The sample from a run before goes; the papers picked by hand stay.
  venue.papers = venue.papers.filter((p) => !p.sample);

  let notes = 0;
  for (const paper of venue.papers) {
    if (paper.number === null) continue;
    const slug = `${prefix}-${paper.number}`;
    const listing = await get<Listing>(`/listings/${slug}`);
    if (!listing?.links.some((l) => l.url.includes(`id=${paper.id}`))) {
      console.warn(`  ${slug} is not ${paper.id} on acceptodds; skipped`);
      continue;
    }
    const body = await get<{ reviews: Review[] }>(`/listings/${slug}/reviews`);
    paper.notes = (body?.reviews ?? []).map((r) => toNote(paper.id, r)).filter((n) => n !== null);
    notes += paper.notes.length;
    console.log(`${paper.id}: ${paper.notes.length} notes`);
  }

  const want = Number(values.sample ?? 0);
  if (want > 0) {
    const { slugs } = (await get<{ slugs: string[] }>(`/map/scores?kind=${encodeURIComponent(venue.name)}`))!;
    const have = new Set(venue.papers.map((p) => `${prefix}-${p.number}`));
    const candidates = slugs.filter((slug) => !have.has(slug)).sort();
    const step = Math.max(1, Math.floor(candidates.length / want));
    const picked = candidates.filter((_, i) => i % step === 0).slice(0, want);
    const added = await pool(picked, 2, async (slug) => {
      const [listing, body] = await Promise.all([
        get<Listing>(`/listings/${slug}`),
        get<{ reviews: Review[] }>(`/listings/${slug}/reviews`),
      ]);
      const forum = listing && forumOf(listing);
      if (!listing || !forum || !body) return null;
      const reviews = body.reviews
        .filter((r) => r.kind === 'review')
        .map((r) => toNote(forum, { ...r, sections: [] }))
        .filter((n) => n !== null);
      if (reviews.length === 0) return null;
      const status =
        listing.venueStatus === 'withdrawn' ? 'withdrawn' : listing.venueStatus ? 'desk_rejected' : 'under_review';
      return {
        id: forum,
        number: Number(slug.split('-').pop()),
        title: listing.title,
        abstract: listing.summary,
        authors: [],
        keywords: listing.keywords,
        status,
        decision: null,
        notes: reviews,
        sample: true,
      } satisfies FixturePaper;
    });
    const sample = added.filter((p) => p !== null);
    venue.papers.push(...sample);
    notes += sample.reduce((n, p) => n + p.notes.length, 0);
    console.log(`sampled ${sample.length} more papers, their scores only`);
  }

  writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 1)}\n`);
  console.log(`wrote ${notes} notes for ${venue.name} to ${FIXTURE_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
