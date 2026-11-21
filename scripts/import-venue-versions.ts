import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { getPool } from '@/db';
import { normalizeTitle, versionStanding, type VersionPdf } from '@/lib/versions';
import { SYSTEM_ACTOR } from '@/server/pages/commit';
import {
  abstractOverlap,
  openReviewVersion,
  sameWork,
  type FoundVersion,
  type OpenReviewSearchNote,
} from '@/server/version-sources';
import { forumUrl } from '@/server/venue-sources/openreview';
import { mergeFoundVersions, setVersions, versionsAt } from '@/server/versions';

const USAGE = `Finds our papers' other versions in a dump of OpenReview's venues (\`papers:dump-openreview\`): forums
at other venues with the same title and an abstract that says the same, and commits them to each paper's
versions/ as the system, next to the paper's own forum.

  npm run papers:import-venue-versions -- data/openreview-venues.sqlite [--scrape iclr2026.sqlite]...
                                          [--paper <uuid>] [--limit N] [--relabel] [--dry-run]

--scrape adds a venue scrape's submissions (\`submissions.raw\`, as \`papers:import-iclr\` reads), for venues
too big for the dump's search. Run again whenever the dump is refreshed: versions are matched by address,
so a decision that came out updates its version and keeps what people wrote (--relabel
replaces the labels of the versions it finds, after a change to how they are named). Purge the edge cache after.`;

interface Forum {
  id: string;
  note: OpenReviewSearchNote;
  abstract: string;
}

interface OurPaper {
  id: string;
  title: string;
  abstract: string | null;
  forums: string[];
  pdf: VersionPdf | null;
}

function readForums(file: string, wanted: Set<string>, into: Map<string, Map<string, Forum>>, scrape: boolean) {
  const db = new DatabaseSync(file, { readOnly: true });
  const rows = scrape
    ? db.prepare('select id, title, raw as note from submissions where raw is not null').iterate()
    : db.prepare('select id, norm_title, note from forums').iterate();
  let read = 0;
  for (const row of rows as Iterable<{ id: string; title?: string; norm_title?: string; note: string }>) {
    const norm = row.norm_title ?? normalizeTitle(row.title ?? '');
    if (!wanted.has(norm)) continue;
    const note = JSON.parse(row.note) as OpenReviewSearchNote;
    const abstract = note.content?.abstract?.value;
    const forums = into.get(norm) ?? new Map<string, Forum>();
    // The dump is read first and is fresher than a scrape: a scrape only fills in what it lacks.
    if (!forums.has(row.id))
      forums.set(row.id, { id: row.id, note, abstract: typeof abstract === 'string' ? abstract : '' });
    into.set(norm, forums);
    read += 1;
  }
  db.close();
  return read;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      scrape: { type: 'string', multiple: true },
      paper: { type: 'string' },
      limit: { type: 'string' },
      'dry-run': { type: 'boolean' },
      relabel: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  const [dump] = positionals;
  if (!dump || values.help) {
    console.error(USAGE);
    process.exit(dump ? 0 : 2);
  }

  const { rows } = await getPool().query<OurPaper>(
    `select p.id, p.title, p.abstract, pc.pdf,
       coalesce(array_agg(i.value) filter (where i.scheme = 'openreview'), '{}') as forums
     from papers p
     left join page_current pc on pc.page_id = p.id
     left join paper_identifiers i on i.paper_id = p.id
     where p.merged_into is null ${values.paper ? 'and p.id = $1' : ''}
     group by p.id, pc.pdf`,
    values.paper ? [values.paper] : [],
  );
  const wanted = new Set(rows.map((paper) => normalizeTitle(paper.title)).filter(Boolean));
  const byTitle = new Map<string, Map<string, Forum>>();
  console.log(`${rows.length} papers; ${readForums(dump, wanted, byTitle, false)} forums share a title in the dump`);
  for (const scrape of values.scrape ?? []) {
    console.log(`${readForums(scrape, wanted, byTitle, true)} in ${scrape}`);
  }

  const stats = { matched: 0, versions: 0, rejected: 0, committed: 0, unchanged: 0, failed: 0 };
  const limit = values.limit ? Number(values.limit) : Infinity;
  for (const paper of rows) {
    if (stats.matched >= limit) break;
    const forums = [...(byTitle.get(normalizeTitle(paper.title))?.values() ?? [])];
    const own = new Set(paper.forums);
    const others = forums.filter((forum) => {
      if (own.has(forum.id)) return false;
      const overlap = paper.abstract && forum.abstract ? abstractOverlap(paper.abstract, forum.abstract) : null;
      const ok = sameWork(paper.title, overlap);
      if (!ok) {
        stats.rejected += 1;
        if (values['dry-run']) console.log(`  no: ${overlap?.toFixed(2)} “${paper.title}” ≠ ${forumUrl(forum.id)}`);
      }
      return ok;
    });
    if (others.length === 0) continue;
    stats.matched += 1;

    const found: (FoundVersion & { pdf?: VersionPdf })[] = [];
    for (const forum of [...forums.filter((f) => own.has(f.id)), ...others]) {
      const version = openReviewVersion({ ...forum.note, id: forum.id, forum: forum.id });
      if (!version) continue;
      // Only the page's own PDF is here already; OpenReview's PDFs ask scripts for a browser check.
      if (paper.pdf && paper.pdf.source === forumUrl(forum.id)) found.push({ ...version, pdf: paper.pdf });
      else found.push(version);
    }
    stats.versions += found.length;

    const { head, versions } = await versionsAt(paper.id);
    const merged = mergeFoundVersions(
      versions,
      found.map((version) => {
        const kept: Partial<FoundVersion> & { pdf?: VersionPdf } = { ...version };
        delete kept.pdfSource;
        delete kept.license;
        return kept as Omit<FoundVersion, 'pdfSource' | 'license'> & { pdf?: VersionPdf };
      }),
      { relabel: values.relabel },
    );
    if (values['dry-run']) {
      if (stats.matched <= 20) {
        console.log(`\n${paper.title}`);
        for (const v of merged) console.log(`  ${v.date ?? '????'}  ${v.label}  ${versionStanding(v) ?? ''}  ${v.url}`);
      }
      continue;
    }
    try {
      const result = await setVersions(paper.id, SYSTEM_ACTOR, {
        baseOid: head,
        versions: merged.map((v) => ({ ...v, pdf: v.pdf ? { url: v.pdf.url, license: v.pdf.license } : undefined })),
        summary: 'Import the versions from OpenReview: the same title at other venues',
      });
      if (result.status === 'unchanged') stats.unchanged += 1;
      else stats.committed += 1;
    } catch (err) {
      stats.failed += 1;
      console.warn(`! ${paper.id} ${paper.title}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if ((stats.committed + stats.unchanged) % 250 === 0) console.log(JSON.stringify(stats));
  }
  console.log(JSON.stringify(stats));
  if (!values['dry-run'] && stats.committed > 0) console.log('Now purge the edge cache: scripts/purge-edge-cache.sh');
  await getPool().end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
