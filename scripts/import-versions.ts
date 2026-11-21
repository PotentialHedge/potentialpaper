import 'dotenv/config';
import { parseArgs } from 'node:util';
import { getPool } from '@/db';
import { parsePaperId, PAPER_SCHEMES, type PaperScheme } from '@/lib/paper-ids';
import { versionStanding, type VersionPdf } from '@/lib/versions';
import { SYSTEM_ACTOR } from '@/server/pages/commit';
import { refreshPaperPages } from '@/server/pages/refresh';
import { findPaper } from '@/server/papers';
import { lookUpVersions } from '@/server/version-sources';
import { mergeFoundVersions, setVersions, versionsAt } from '@/server/versions';

const USAGE = `Find a paper's versions on OpenReview (every forum with its title) and arXiv, and commit them to its
page's versions/, as the system. The editor's "Look them up" does the same for a person, who checks them first.

  npm run papers:import-versions -- openreview:dskf2Ppd9o [--arxiv 2606.18022] [--dry-run]

PDFs are copied where their license allows it and the source lets us fetch them (into R2, or public/files
without R2 keys); the ingest service then extracts their text, which comparing versions diffs.`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { arxiv: { type: 'string' }, 'dry-run': { type: 'boolean' } },
  });
  const [target] = positionals;
  const [schemeText, ...rest] = (target ?? '').split(':');
  const scheme = PAPER_SCHEMES.find((s): s is PaperScheme => s === schemeText);
  const id = scheme && parsePaperId(scheme, rest.join(':'));
  if (!id) {
    console.error(USAGE);
    process.exit(2);
  }
  const found = await findPaper(id);
  if (!found) throw new Error(`no paper ${target} in this database`);
  const paperId = found.paper.id;

  const { head, versions } = await versionsAt(paperId);
  const known = new Map<string, VersionPdf>();
  for (const v of versions) if (v.pdf?.source) known.set(v.pdf.source, v.pdf);
  const lookup = await lookUpVersions({
    title: found.paper.title,
    arxiv: values.arxiv ?? found.identifiers.find((i) => i.scheme === 'arxiv')?.value ?? null,
    accountId: null,
    known,
  });
  for (const problem of lookup.problems) console.warn(`! ${problem}`);
  const merged = mergeFoundVersions(versions, lookup.versions);
  for (const v of merged) {
    console.log(`${v.date ?? '????'}  ${v.label}  ${versionStanding(v) ?? ''}  ${v.pdf ? 'PDF' : 'no PDF'}  ${v.url}`);
  }
  if (values['dry-run']) return void (await getPool().end());

  const result = await setVersions(paperId, SYSTEM_ACTOR, {
    baseOid: head,
    versions: merged.map((v) => ({ ...v, pdf: v.pdf ? { url: v.pdf.url, license: v.pdf.license } : undefined })),
    summary: 'Import the versions from OpenReview and arXiv',
  });
  await refreshPaperPages(found.identifiers);
  console.log(JSON.stringify(result));
  await getPool().end();
}

main().catch((err) => {
  console.error(err.message ?? err, err.details ? JSON.stringify(err.details, null, 2) : '');
  process.exit(1);
});
