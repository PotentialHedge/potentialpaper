import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AwsClient } from 'aws4fetch';
import { sql, type SQL } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import type { PdfStageState } from '@/db/schema';
import { claimByEmail } from '../claims';
import { extractEmails } from './emails';
import { firstPageText, pageCount, renderFirstPage, wholeText } from './poppler';

/**
 * The PDF ingest pipeline: everything we derive from a hosted PDF, for every PDF a page points at
 * (`page_current.pdf`, and each version's in `page_current.versions`), one row per distinct PDF in
 * `pdf_documents`.
 *
 * Each **stage** has a version. A stage's result is recorded with the version that produced it, so a run
 * does only what is missing or out of date: bump a stage's `version` and the next run redoes that stage for
 * every PDF, and nothing else. A failure is recorded too, and retried on later runs with a growing delay,
 * `MAX_ATTEMPTS` times per version, then left alone until the version changes or a run names the PDF.
 * Every stage only overwrites its own columns from the PDF's bytes, so a run can be stopped at any point
 * and run again.
 *
 * New PDFs need nobody to remember anything: `npm run pdfs:ingest -- --watch`, the `ingest` service in
 * `docker-compose.prod.yml`, looks for new or stale PDFs every minute. Polling `page_current` is cheap
 * (one scan of ~40k rows), and needs no queue that every writer of `pdf.json` would have to feed.
 *
 * To add a stage: add its columns to `pdf_documents`, then an entry to `STAGES`, in order after the
 * stages it reads.
 */

const PDF_BASE = process.env.PDF_BASE_URL ?? 'https://pdfs.potentialhedge.com';
const BUCKET = process.env.R2_BUCKET ?? 'papertrail-pdfs';
export const MAX_ATTEMPTS = 4;
/** The wait before the n-th retry: 10 minutes, then 40, then about 3 hours. */
const retryDelayMs = (attempts: number) => 10 * 60_000 * 4 ** (attempts - 1);
/** The cover's longer side, in pixels: about three times what a search result shows. */
const COVER_SIZE = 360;
/** Far more than any paper's text; a scanned book's is cut here. */
const MAX_FULL_TEXT = 4 * 1024 * 1024;

/** The PDFs pages point at: their own, and their versions'. Rows of `(sha256, url)`, as SQL. */
const VERSION_PDFS = sql`(
  select v -> 'pdf' ->> 'sha256' as sha256
    from page_current c, jsonb_array_elements(c.versions) v
   where jsonb_typeof(c.versions) = 'array' and v ? 'pdf'
)`;

const POINTED_AT = sql`(
  select c.pdf ->> 'sha256' as sha256, c.pdf ->> 'url' as url from page_current c where c.pdf is not null
  union all
  select v -> 'pdf' ->> 'sha256', v -> 'pdf' ->> 'url'
    from page_current c, jsonb_array_elements(c.versions) v
   where jsonb_typeof(c.versions) = 'array' and v ? 'pdf'
)`;

/** The row a stage sees: what earlier stages produced. */
export interface PdfDocument {
  sha256: string;
  url: string;
  firstPageRaw: string | null;
  firstPageLayout: string | null;
  emails: string[];
  /** A version points at it, so the stages for versions run on it. */
  versioned: boolean;
}

export interface StageContext {
  doc: PdfDocument;
  /** The PDF on local disk, fetched on first use and checked against its SHA-256. */
  pdf(): Promise<string>;
  database: Database;
}

/** The columns a stage sets (snake_case, as in the table), and what to do once they are written. */
export interface StageResult {
  set: Record<string, unknown>;
  after?: () => Promise<void>;
}

export interface Stage {
  name: string;
  version: number;
  /**
   * Only for PDFs a version points at (`page_current.versions`), not every page's own: the whole text is
   * needed only to compare versions, and every page PDF would be tens of thousands of downloads.
   */
  versionsOnly?: boolean;
  /** Stages whose results this one reads: it waits until they are done at their current version. */
  needs?: string[];
  run(ctx: StageContext): Promise<StageResult>;
}

export const STAGES: Stage[] = [
  {
    name: 'text',
    version: 1,
    async run({ pdf }) {
      const path = await pdf();
      const [pages, raw, layout, info] = await Promise.all([
        pageCount(path),
        firstPageText(path, 'raw'),
        firstPageText(path, 'layout'),
        stat(path),
      ]);
      return { set: { bytes: info.size, pages, first_page_raw: raw, first_page_layout: layout } };
    },
  },
  {
    name: 'emails',
    // 2: groups split on their separators only, not on spaces inside them.
    version: 2,
    needs: ['text'],
    async run({ doc, database }) {
      const emails = extractEmails(doc.firstPageRaw ?? '', doc.firstPageLayout ?? '');
      return {
        set: { emails },
        // Accounts with these addresses may exist already, with or without a claim on the paper.
        after: emails.length > 0 ? async () => void (await claimByEmail({ sha256: doc.sha256 }, database)) : undefined,
      };
    },
  },
  {
    // The whole text, which comparing two versions of a paper diffs (`server/versions.ts`).
    name: 'fulltext',
    version: 1,
    versionsOnly: true,
    async run({ pdf }) {
      const text = await wholeText(await pdf());
      return { set: { full_text: text.slice(0, MAX_FULL_TEXT) } };
    },
  },
  {
    name: 'cover',
    version: 1,
    async run({ doc, pdf }) {
      return { set: { cover_url: await storeCover(doc.sha256, await renderFirstPage(await pdf(), COVER_SIZE)) } };
    },
  },
];

function r2(): { client: AwsClient; base: string } | null {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) return null;
  return {
    client: new AwsClient({
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
      service: 's3',
      region: 'auto',
    }),
    base: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${BUCKET}`,
  };
}

/**
 * Stores a cover beside its PDF in R2 (`cover/<sha256>.jpg`), or in development without the R2 keys under
 * `public/covers` (or `COVERS_DIR`), served by this site. Returns its address.
 */
async function storeCover(sha256: string, jpeg: Buffer): Promise<string> {
  const remote = r2();
  if (!remote) {
    if (process.env.NODE_ENV === 'production' && !process.env.COVERS_DIR) {
      throw new Error('cover storage: set the R2_* keys, or COVERS_DIR');
    }
    const dir = process.env.COVERS_DIR ?? join(process.cwd(), 'public', 'covers');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${sha256}.jpg`), jpeg);
    return `/covers/${sha256}.jpg`;
  }
  const res = await remote.client.fetch(`${remote.base}/cover/${sha256}.jpg`, {
    method: 'PUT',
    body: new Uint8Array(jpeg),
    headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' },
  });
  if (!res.ok) throw new Error(`R2 upload: HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return `${PDF_BASE}/cover/${sha256}.jpg`;
}

const sha256Of = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Downloads `url` to `path`, a few tries for a flaky network, and checks the bytes are the PDF's. */
async function download(url: string, sha256: string, path: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok || !res.body) throw new Error(`GET ${url}: HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(path));
      break;
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
    }
  }
  const got = sha256Of(await readFile(path));
  if (got !== sha256) throw new Error(`GET ${url}: the bytes hash to ${got}, not ${sha256}`);
}

export interface IngestOptions {
  /** Only these stages (by name); all by default. */
  stages?: string[];
  /** Only this PDF, and run its stages even when they are current or have failed too often. */
  sha256?: string;
  /** Run the stages even when they are current. */
  force?: boolean;
  workers?: number;
  /** A folder of PDFs named `<sha256>.pdf` to read before downloading (the scrape, on this disk). */
  pdfDir?: string;
  database?: Database;
  log?: (line: string) => void;
}

export interface IngestReport {
  documents: number;
  /** Per stage: how many succeeded and how many failed. */
  stages: Record<string, { done: number; failed: number }>;
}

/** Adds a row for every PDF a page points at that has none yet. */
async function discover(database: Database): Promise<number> {
  const { rowCount } = await database.execute(sql`
    insert into pdf_documents (sha256, url)
    select distinct on (p.sha256) p.sha256, p.url
    from ${POINTED_AT} p
    where p.sha256 ~ '^[0-9a-f]{64}$' and p.url is not null
    on conflict (sha256) do nothing
  `);
  return rowCount ?? 0;
}

/** Whether `stage` should run for a row: missing or out of date, and not failing too often to retry yet. */
function stageDue(stage: Stage, force: boolean): SQL {
  const state = sql`(d.stages -> ${stage.name})`;
  const eligible = stage.versionsOnly ? sql`d.sha256 in (select v.sha256 from ${VERSION_PDFS} v)` : sql`true`;
  if (force) return eligible;
  return sql`${eligible} and (
    coalesce((${state} ->> 'version')::int, 0) < ${stage.version}
    and not (
      coalesce((${state} ->> 'failedVersion')::int, 0) = ${stage.version}
      and (
        coalesce((${state} ->> 'attempts')::int, 0) >= ${MAX_ATTEMPTS}
        or coalesce((${state} ->> 'retryAt')::timestamptz, '-infinity') > now()
      )
    )
  )`;
}

function current(stage: Stage): SQL {
  return sql`coalesce((d.stages -> ${stage.name} ->> 'version')::int, 0) >= ${stage.version}`;
}

/** The PDFs that a page points at now and that have a stage due, oldest first. */
async function due(database: Database, stages: Stage[], options: IngestOptions): Promise<PdfDocument[]> {
  const named = options.sha256 !== undefined;
  const forced = named || options.force === true;
  // A stage is runnable when it is due and what it reads is current, or will be once this pass runs it.
  const runnable = (stage: Stage): SQL => {
    const needs = (stage.needs ?? []).map((name) => {
      const need = STAGES.find((s) => s.name === name)!;
      const runsNow = stages.includes(need) ? sql` or ${runnable(need)}` : sql``;
      return sql`(${current(need)}${runsNow})`;
    });
    return sql.join([stageDue(stage, forced), ...needs], sql` and `);
  };
  const anyDue = sql.join(
    stages.map((s) => sql`(${runnable(s)})`),
    sql` or `,
  );
  const { rows } = await database.execute<{
    sha256: string;
    url: string;
    first_page_raw: string | null;
    first_page_layout: string | null;
    emails: string[];
    versioned: boolean;
  }>(sql`
    select d.sha256, d.url, d.first_page_raw, d.first_page_layout, d.emails,
           d.sha256 in (select v.sha256 from ${VERSION_PDFS} v) as versioned
    from pdf_documents d
    where (${anyDue})
      and ${named ? sql`d.sha256 = ${options.sha256}` : sql`d.sha256 in (select p.sha256 from ${POINTED_AT} p)`}
    order by d.created_at, d.sha256
  `);
  return rows.map((r) => ({
    sha256: r.sha256,
    url: r.url,
    firstPageRaw: r.first_page_raw,
    firstPageLayout: r.first_page_layout,
    emails: r.emails,
    versioned: r.versioned,
  }));
}

async function readState(database: Database, sha256: string): Promise<Record<string, PdfStageState>> {
  const { rows } = await database.execute<{ stages: Record<string, PdfStageState> }>(
    sql`select stages from pdf_documents where sha256 = ${sha256}`,
  );
  return rows[0]?.stages ?? {};
}

function isCurrent(state: PdfStageState | undefined, stage: Stage): boolean {
  return (state?.version ?? 0) >= stage.version;
}

function canRetry(state: PdfStageState | undefined, stage: Stage): boolean {
  if (state?.failedVersion !== stage.version) return true;
  if ((state.attempts ?? 0) >= MAX_ATTEMPTS) return false;
  return !state.retryAt || Date.parse(state.retryAt) <= Date.now();
}

async function record(database: Database, sha256: string, name: string, state: PdfStageState, set: SQL[] = []) {
  await database.execute(sql`
    update pdf_documents
       set ${sql.join([...set, sql`stages = stages || jsonb_build_object(${name}::text, ${JSON.stringify(state)}::jsonb)`, sql`updated_at = now()`], sql`, `)}
     where sha256 = ${sha256}
  `);
}

const COLUMN = /^[a-z_]+$/;

/** Runs the due stages of one PDF, in order, and reports which succeeded and which failed. */
async function ingestOne(
  doc: PdfDocument,
  stages: Stage[],
  options: IngestOptions,
  database: Database,
): Promise<Record<string, 'done' | 'failed' | 'skipped'>> {
  const forced = options.force === true || options.sha256 !== undefined;
  const states = await readState(database, doc.sha256);
  const outcome: Record<string, 'done' | 'failed' | 'skipped'> = {};
  let dir: string | null = null;
  let path: string | null = null;
  const pdf = async () => {
    if (path) return path;
    const local = options.pdfDir && join(options.pdfDir, `${doc.sha256}.pdf`);
    if (local && existsSync(local) && sha256Of(await readFile(local)) === doc.sha256) return (path = local);
    // Stored on this disk in development, without R2 (`server/files.ts`).
    const served =
      doc.url.startsWith('/') &&
      join(process.env.EVIDENCE_FILES_DIR ?? join(process.cwd(), 'public', 'files'), doc.url.replace(/^\/files\//, ''));
    if (served && existsSync(served) && sha256Of(await readFile(served)) === doc.sha256) return (path = served);
    dir ??= await mkdtemp(join(tmpdir(), 'pdf-'));
    const target = join(dir, 'in.pdf');
    await download(doc.url, doc.sha256, target);
    return (path = target);
  };
  try {
    for (const stage of stages) {
      const state = states[stage.name];
      if (stage.versionsOnly && !doc.versioned) {
        outcome[stage.name] = 'skipped';
        continue;
      }
      if (!forced && (isCurrent(state, stage) || !canRetry(state, stage))) {
        outcome[stage.name] = 'skipped';
        continue;
      }
      // A stage this one reads must be current; it may have failed just now, or be outside `--stage`.
      const blocked = (stage.needs ?? []).some((name) => {
        const need = STAGES.find((s) => s.name === name);
        return !need || !isCurrent(states[name], need);
      });
      if (blocked) {
        outcome[stage.name] = 'skipped';
        continue;
      }
      try {
        const result = await stage.run({ doc, pdf, database });
        const set = Object.entries(result.set).map(([column, value]) => {
          if (!COLUMN.test(column)) throw new Error(`stage ${stage.name}: bad column ${column}`);
          // Drizzle spreads an array into a list of parameters, so a text[] goes over as JSON.
          const param = Array.isArray(value)
            ? sql`array(select jsonb_array_elements_text(${JSON.stringify(value)}::jsonb))`
            : sql`${value}`;
          return sql`${sql.identifier(column)} = ${param}`;
        });
        const done: PdfStageState = { version: stage.version, at: new Date().toISOString() };
        await record(database, doc.sha256, stage.name, done, set);
        states[stage.name] = done;
        // What later stages read.
        if ('first_page_raw' in result.set) doc.firstPageRaw = result.set.first_page_raw as string;
        if ('first_page_layout' in result.set) doc.firstPageLayout = result.set.first_page_layout as string;
        if ('emails' in result.set) doc.emails = result.set.emails as string[];
        await result.after?.();
        outcome[stage.name] = 'done';
      } catch (err) {
        const attempts = (state?.failedVersion === stage.version ? (state.attempts ?? 0) : 0) + 1;
        const failed: PdfStageState = {
          ...(state?.version !== undefined ? { version: state.version, at: state.at } : {}),
          error: String(err instanceof Error ? err.message : err).slice(0, 1000),
          failedVersion: stage.version,
          attempts,
          retryAt: new Date(Date.now() + retryDelayMs(attempts)).toISOString(),
        };
        await record(database, doc.sha256, stage.name, failed);
        states[stage.name] = failed;
        outcome[stage.name] = 'failed';
        options.log?.(`${doc.sha256} ${stage.name}: ${failed.error}`);
      }
    }
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
  return outcome;
}

/** One pass: finds every PDF with a stage due and runs its due stages, `workers` PDFs at a time. */
export async function ingest(options: IngestOptions = {}): Promise<IngestReport> {
  const database = options.database ?? getDb();
  const stages = options.stages ? STAGES.filter((s) => options.stages!.includes(s.name)) : STAGES;
  const unknown = (options.stages ?? []).filter((name) => !STAGES.some((s) => s.name === name));
  if (unknown.length > 0) throw new Error(`no such stage: ${unknown.join(', ')}`);
  if (options.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(options.sha256))
    throw new Error('--sha: a SHA-256, in hex');

  await discover(database);
  const queue = await due(database, stages, options);
  const report: IngestReport = {
    documents: queue.length,
    stages: Object.fromEntries(stages.map((s) => [s.name, { done: 0, failed: 0 }])),
  };
  if (queue.length > 0) options.log?.(`${queue.length} PDFs with stages to run`);
  let next = 0;
  let finished = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, options.workers ?? 4) }, async () => {
      while (next < queue.length) {
        const doc = queue[next++];
        const outcome = await ingestOne(doc, stages, options, database);
        for (const [name, result] of Object.entries(outcome)) {
          if (result !== 'skipped') report.stages[name][result] += 1;
        }
        finished += 1;
        if (finished % 500 === 0) options.log?.(`${finished}/${queue.length}`);
      }
    }),
  );
  return report;
}
