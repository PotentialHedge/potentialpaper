import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { forumUrl } from '@/server/venue-sources/openreview';
import { FIXTURE_PATH, type Fixture, type FixtureNote } from './fixture';

const USAGE = `Fills one fixture venue's papers (${FIXTURE_PATH}) with their reviews and comments from acceptodds, for a
venue still under review that the OpenReview scrape has none of. Papers are found by their submission number
(acceptodds' <kind>-<number>, e.g. iclr2027-37553), and checked against their forum id.

  npm run db:seed:acceptodds-reviews -- <OpenReview group>

e.g. npm run db:seed:acceptodds-reviews -- ICLR.cc/2027/Conference`;

const ACCEPTODDS = 'https://acceptodds.com/api/v1';

interface Listing {
  links: { label: string; url: string }[];
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

async function get<T>(path: string): Promise<T | null> {
  const res = await fetch(`${ACCEPTODDS}${path}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { help: { type: 'boolean', short: 'h' } },
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
  writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 1)}\n`);
  console.log(`wrote ${notes} notes for ${venue.name} to ${FIXTURE_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
