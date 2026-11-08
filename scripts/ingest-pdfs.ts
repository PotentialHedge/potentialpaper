import 'dotenv/config';
import { parseArgs } from 'node:util';
import { getPool } from '@/db';
import { ingest, STAGES, type IngestOptions } from '@/server/pdfs/ingest';

const USAGE = `Runs the PDF ingest pipeline (src/server/pdfs/ingest.ts) over every PDF a page points at: each
stage that is missing or out of date, and failures again once their retry is due. Safe to stop and run again.
Needs poppler (pdfinfo, pdftotext, pdftoppm), and the R2_* keys for covers (or COVERS_DIR; in development
public/covers).

  npm run pdfs:ingest                               # one pass
  npm run pdfs:ingest -- --watch                    # a pass every minute, forever (the ingest service)
  npm run pdfs:ingest -- --stage emails [--force]   # only some stages (repeat --stage), --force reruns current ones
  npm run pdfs:ingest -- --sha <sha256>             # one PDF, every stage again, whatever its state
  npm run pdfs:ingest -- --dir <folder>             # read <sha256>.pdf there before downloading
  npm run pdfs:ingest -- --workers 8

Stages: ${STAGES.map((s) => `${s.name} v${s.version}`).join(', ')}`;

const POLL_MS = 60_000;

async function main() {
  const { values } = parseArgs({
    options: {
      watch: { type: 'boolean' },
      stage: { type: 'string', multiple: true },
      sha: { type: 'string' },
      force: { type: 'boolean' },
      dir: { type: 'string' },
      workers: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const options: IngestOptions = {
    stages: values.stage,
    sha256: values.sha,
    force: values.force,
    pdfDir: values.dir,
    workers: values.workers ? Number(values.workers) : Number(process.env.INGEST_WORKERS ?? 4),
    log: (line) => console.log(line),
  };
  const pass = async () => {
    const started = Date.now();
    const report = await ingest(options);
    if (report.documents > 0 || !values.watch) {
      const stages = Object.entries(report.stages)
        .map(([name, { done, failed }]) => `${name} ${done} done${failed ? `, ${failed} failed` : ''}`)
        .join('; ');
      console.log(`${report.documents} PDFs in ${Math.round((Date.now() - started) / 1000)}s: ${stages}`);
    }
  };
  if (!values.watch) {
    await pass();
    await getPool().end();
    return;
  }
  for (;;) {
    try {
      await pass();
    } catch (err) {
      // The database restarting, say: try again next time.
      console.error('ingest pass failed:', err);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
