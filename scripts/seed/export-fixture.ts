import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { parseReply, submissionStatus, type OpenReviewNote, type ParsedNote } from '@/server/venue-sources/openreview';
import { FIXTURE_PATH, type Fixture, type FixturePaper } from './fixture';

const USAGE = `Adds a small sample of one venue's OpenReview scrape to the dev fixture (${FIXTURE_PATH}), replacing that
venue's papers if it is there. The scrape is what papers:import-iclr and papers:import-reviews read.

  npm run db:seed:export -- <scrape.sqlite> <OpenReview group> <name> <year> [--per-bucket 4] [--anonymous]

  --per-bucket  papers per decision ("Accept (Oral)", "Reject", ...) or status (withdrawn, under review)
  --anonymous   the venue is still under review: leave its authors out, as the real import does

e.g. npm run db:seed:export -- ../papermarket/research/data/iclr2026.sqlite ICLR.cc/2026/Conference "ICLR 2026" 2026`;

/** Forums with more replies than this are skipped, to keep the fixture small. */
const MAX_REPLIES = 15;

interface Row {
  id: string;
  number: number | null;
  title: string;
  abstract: string | null;
  authors: string | null;
  keywords: string | null;
  venueid: string | null;
  cdate: number | null;
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'per-bucket': { type: 'string', default: '4' },
      anonymous: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [path, group, name, yearText] = positionals;
  const perBucket = Number(values['per-bucket']);
  if (values.help || !path || !group || !name || !Number.isInteger(Number(yearText)) || !(perBucket > 0)) {
    console.log(USAGE);
    process.exitCode = values.help ? 0 : 1;
    return;
  }

  const sqlite = new DatabaseSync(path, { readOnly: true });
  const hasReplies = (sqlite.prepare(`select count(*) n from replies`).get() as { n: number }).n > 0;
  const rows = sqlite
    .prepare(
      `select s.id, s.number, s.title, s.abstract, s.authors, s.keywords, s.venueid, s.cdate
       from submissions s left join (select forum, count(*) n from replies group by forum) r on r.forum = s.id
       where length(s.abstract) >= 200 and coalesce(r.n, 0) <= ${MAX_REPLIES} ${hasReplies ? 'and r.n > 0' : ''}
       order by s.id`,
    )
    .all() as unknown as Row[];
  const repliesOf = sqlite.prepare(`select raw from replies where forum = ? order by cdate`);

  const buckets = new Map<string, FixturePaper[]>();
  for (const row of rows) {
    const notes = (repliesOf.all(row.id) as { raw: string }[])
      .map(({ raw }) => parseReply(JSON.parse(raw) as OpenReviewNote))
      .filter((note): note is ParsedNote => note !== null)
      .map((note) => ({ ...note, forum: undefined }));
    const decision = notes.find((note) => note.kind === 'decision')?.content.decision;
    const decisionText = typeof decision === 'string' ? decision.trim() : null;
    const status = submissionStatus(row.venueid, decisionText);
    const bucket = decisionText ?? status ?? 'unknown';
    const list = buckets.get(bucket) ?? [];
    if (list.length >= perBucket) continue;
    list.push({
      id: row.id,
      number: row.number,
      title: row.title,
      abstract: row.abstract ?? '',
      authors: values.anonymous ? [] : (JSON.parse(row.authors ?? '[]') as string[]),
      keywords: JSON.parse(row.keywords ?? '[]') as string[],
      ...(row.cdate ? { submittedAt: new Date(row.cdate).toISOString() } : {}),
      status,
      decision: decisionText,
      notes,
    });
    buckets.set(bucket, list);
  }
  sqlite.close();

  let fixture: Fixture = { venues: [] };
  try {
    fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture;
  } catch {
    // No fixture yet.
  }
  const papers = [...buckets.values()].flat();
  const venue = { group, name, year: Number(yearText), anonymous: values.anonymous ?? false, papers };
  fixture.venues = [...fixture.venues.filter((v) => v.group !== group), venue];
  writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 1)}\n`);
  for (const [bucket, list] of buckets) console.log(`${bucket}: ${list.length}`);
  console.log(`wrote ${papers.length} papers of ${name} to ${FIXTURE_PATH}`);
}

main();
