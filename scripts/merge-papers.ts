import 'dotenv/config';
import { parseArgs } from 'node:util';
import { getPool } from '@/db';
import { parsePaperId, PAPER_SCHEMES, type PaperScheme } from '@/lib/paper-ids';
import { normalizeTitle } from '@/lib/versions';
import { mergePapers } from '@/server/merge-papers';
import { SYSTEM_ACTOR } from '@/server/pages/commit';
import { findPaper } from '@/server/papers';
import { abstractOverlap, sameWork } from '@/server/version-sources';
import { forumUrl } from '@/server/venue-sources/openreview';

const USAGE = `Merges a duplicate paper into the one it duplicates, as the system: its page's versions, PDF and links
are folded into the survivor's in one commit, and its addresses redirect there.

  npm run papers:merge -- <duplicate> <survivor>          e.g. openreview:Tzcj46FpZT openreview:yQYuOXhMDw
  npm run papers:merge -- --iclr-resubmissions [--dry-run]

--iclr-resubmissions merges each ICLR 2026 paper into its ICLR 2027 resubmission: the same title (normalized),
one paper a year, abstracts that agree (\`sameWork\`). The system may not write sections or a claimed page's card;
a duplicate with those is refused, for an admin to merge on the site. Purge the edge cache after.`;

function paperArg(text: string | undefined) {
  const [schemeText, ...rest] = (text ?? '').split(':');
  const scheme = PAPER_SCHEMES.find((s): s is PaperScheme => s === schemeText);
  return scheme ? parsePaperId(scheme, rest.join(':')) : null;
}

interface Row {
  id: string;
  title: string;
  abstract: string | null;
  year: number;
  forum: string;
}

async function iclrPairs(): Promise<{ duplicate: Row; survivor: Row }[]> {
  const { rows } = await getPool().query<Row>(
    `select p.id, p.title, p.abstract, p.year, min(i.value) as forum
     from papers p join paper_identifiers i on i.paper_id = p.id and i.scheme = 'openreview'
     where p.merged_into is null and p.year in (2026, 2027) and p.venue like 'ICLR %'
     group by p.id`,
  );
  const byTitle = new Map<string, Row[]>();
  for (const row of rows) {
    const key = normalizeTitle(row.title);
    if (key) byTitle.set(key, [...(byTitle.get(key) ?? []), row]);
  }
  const pairs: { duplicate: Row; survivor: Row }[] = [];
  for (const group of byTitle.values()) {
    const old = group.filter((row) => row.year === 2026);
    const resubmitted = group.filter((row) => row.year === 2027);
    // Two papers of one year with one title can't be told apart: left for a person.
    if (old.length !== 1 || resubmitted.length !== 1) continue;
    const [duplicate, survivor] = [old[0], resubmitted[0]];
    const overlap =
      duplicate.abstract && survivor.abstract ? abstractOverlap(duplicate.abstract, survivor.abstract) : null;
    if (sameWork(survivor.title, overlap)) pairs.push({ duplicate, survivor });
  }
  return pairs;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { 'iclr-resubmissions': { type: 'boolean' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' } },
  });
  if (values.help) return void console.log(USAGE);

  let pairs: { duplicateId: string; survivorId: string; from: string; evidence: string[]; title: string }[];
  if (values['iclr-resubmissions']) {
    pairs = (await iclrPairs()).map(({ duplicate, survivor }) => ({
      duplicateId: duplicate.id,
      survivorId: survivor.id,
      from: `openreview:${duplicate.forum} (ICLR 2026)`,
      evidence: [forumUrl(duplicate.forum), forumUrl(survivor.forum)],
      title: survivor.title,
    }));
  } else {
    const [a, b] = positionals.map(paperArg);
    if (!a || !b || positionals.length !== 2) {
      console.error(USAGE);
      process.exit(2);
    }
    const [duplicate, survivor] = await Promise.all([findPaper(a), findPaper(b)]);
    if (!duplicate || !survivor) throw new Error('no such paper');
    pairs = [
      {
        duplicateId: duplicate.paper.id,
        survivorId: survivor.paper.id,
        from: positionals[0],
        evidence: [],
        title: survivor.paper.title,
      },
    ];
  }

  console.log(`${pairs.length} to merge`);
  const stats = { merged: 0, failed: 0 };
  for (const pair of pairs) {
    if (values['dry-run']) {
      console.log(`${pair.from} → ${pair.title}`);
      continue;
    }
    try {
      await mergePapers(pair, SYSTEM_ACTOR);
      stats.merged += 1;
    } catch (err) {
      stats.failed += 1;
      console.warn(`! ${pair.from}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(JSON.stringify(stats));
  if (stats.merged > 0) console.log('Now purge the edge cache: scripts/purge-edge-cache.sh');
  await getPool().end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
