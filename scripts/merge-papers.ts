import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { getPool } from '@/db';
import { parsePaperId, PAPER_SCHEMES, type PaperScheme } from '@/lib/paper-ids';
import { mergePapers } from '@/server/merge-papers';
import { SYSTEM_ACTOR } from '@/server/pages/commit';
import { findPaper } from '@/server/papers';

const USAGE = `Merges a duplicate paper into the one it duplicates, as the system: its page's versions, PDF and links
are folded into the survivor's in one commit, and its addresses redirect there.

  npm run papers:merge -- <duplicate> <survivor>          e.g. openreview:Tzcj46FpZT openreview:yQYuOXhMDw
  npm run papers:merge -- --pairs <file> [--dry-run]

--pairs reads a pair a line, "<duplicate> <survivor> [evidence URL]...", as potentialpaper-tools'
find-resubmissions writes them. The system may not write sections or a claimed page's card; a duplicate with those
is refused, for an admin to merge on the site. Purge the edge cache after.`;

function paperArg(text: string | undefined) {
  const [schemeText, ...rest] = (text ?? '').split(':');
  const scheme = PAPER_SCHEMES.find((s): s is PaperScheme => s === schemeText);
  return scheme ? parsePaperId(scheme, rest.join(':')) : null;
}

interface Pair {
  duplicateId: string;
  survivorId: string;
  from: string;
  evidence: string[];
  title: string;
}

/** The pair a line names, by identifiers, or why not. */
async function pairOf(duplicateText: string, survivorText: string, evidence: string[]): Promise<Pair> {
  const [a, b] = [paperArg(duplicateText), paperArg(survivorText)];
  if (!a || !b) throw new Error(`not two paper identifiers: ${duplicateText} ${survivorText}`);
  const [duplicate, survivor] = await Promise.all([findPaper(a), findPaper(b)]);
  if (!duplicate || !survivor) throw new Error(`no such paper: ${!duplicate ? duplicateText : survivorText}`);
  return {
    duplicateId: duplicate.paper.id,
    survivorId: survivor.paper.id,
    from: duplicateText,
    evidence,
    title: survivor.paper.title,
  };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { pairs: { type: 'string' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' } },
  });
  if (values.help) return void console.log(USAGE);

  let pairs: Pair[] = [];
  if (values.pairs) {
    for (const line of readFileSync(values.pairs, 'utf8').split('\n')) {
      const [duplicate, survivor, ...evidence] = line.trim().split(/\s+/);
      if (!duplicate) continue;
      try {
        pairs.push(await pairOf(duplicate, survivor ?? '', evidence));
      } catch (err) {
        console.warn(`! ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else if (positionals.length === 2) {
    pairs = [await pairOf(positionals[0], positionals[1], [])];
  } else {
    console.error(USAGE);
    process.exit(2);
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
