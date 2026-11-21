import { getDb, type Database } from '@/db';
import {
  encodeReviewFile,
  FORMS_SCHEMA,
  formsFilePath,
  MAX_KEYWORDS,
  NOTE_SCHEMA,
  noteFilePath,
  reviewsKey,
  submissionDir,
  SUBMISSION_SCHEMA,
  submissionFilePath,
} from '@/lib/review-files';
import type { PaperId } from '@/lib/paper-ids';
import type { FieldValue, NoteKind, SubmissionStatus, VenueForms } from '@/lib/submissions';
import { ApiError } from './api/errors';
import { botActor, OPENREVIEW_BOT } from './bots';
import { type Actor, commitPage, type FileChange } from './pages/commit';
import { gitObject } from './pages/git-objects';
import { readVersions, versionChanges } from './pages/content';
import { readCommit, readFiles, readFolder, readHead } from './pages/repo';
import { attachSubmission } from './versions';
import { MAX_VERSION_DECISION, MAX_VENUE, type VersionSubmission } from '@/lib/versions';
import { findPaper } from './papers';
import type { RateLimitConfig } from './ratelimit';

/**
 * Adding a venue's submissions and what it published about them, from any source, as files in each paper's
 * repo (`lib/review-files.ts`, DESIGN.md §4.3), committed through `commitPage` by the bot granted the source
 * (`openreview`), one commit per submission. A submission is attached to the paper one of its identifiers
 * names (the paper it was merged into, if it was); one whose paper we don't have is skipped.
 *
 * Safe to run again, and how a run that stopped is resumed: each run writes a submission's folder as the source
 * gives it now, so a note the venue took down is deleted, and a submission whose files already say so commits
 * nothing. The tables the Submissions panel reads are a projection of these files (`review-projection.ts`).
 */

export interface VenueInput {
  /** The source, as the bot's folder names it: `openreview`. */
  source: string;
  /** The source's id for the venue: `ICLR.cc/2027/Conference`. */
  id: string;
  name: string;
  url: string | null;
  forms: VenueForms;
  /** The license of what the source says about a submission and of its forms: `CC-BY-4.0`. */
  license: string;
}

export interface NoteInput {
  externalId: string;
  replyTo: string | null;
  kind: NoteKind;
  invitation: string;
  signature: string;
  content: Record<string, FieldValue>;
  license: string;
  url: string | null;
  createdAt: Date;
  modifiedAt: Date | null;
}

export interface SubmissionInput {
  externalId: string;
  /** The paper it is, by any of its identifiers. */
  paper: PaperId;
  number: number | null;
  status: SubmissionStatus | null;
  decision: string | null;
  /** The keywords its authors gave the source. */
  keywords?: string[];
  /** When it was submitted, as the source says: OpenReview's `cdate`. Its version is dated by it. */
  submittedAt?: Date | null;
  url: string;
  notes: NoteInput[];
}

export interface ImportResult {
  /** Submissions whose paper we have. */
  submissions: number;
  notes: number;
  /** Submissions whose paper we don't have. */
  skipped: number;
  /** Submissions whose folder changed, one commit each. */
  committed: number;
  /** Submissions whose files already said what the source says. */
  unchanged: number;
  /** Submissions whose commit was refused, with why. */
  failed: { externalId: string; error: string }[];
  /** The pages committed to, by id. */
  changed: string[];
}

export interface ImportOptions {
  database?: Database;
  /** Who commits: the source's bot. Defaults to `openreview`. */
  actor?: Actor;
  /** The bot's commit rate limit for this run: a backfill needs one well above `COMMIT_RATE_LIMIT`. */
  rateLimit?: RateLimitConfig;
  /** Submissions committed at once, each to its own page. */
  concurrency?: number;
  /** Called after each submission, with the running totals. */
  progress?: (result: ImportResult, done: number) => void;
}

/** A bot importing on its own schedule: our scripts, run by an admin, not a request. */
export const IMPORT_RATE_LIMIT: RateLimitConfig = { burst: 1_000, perSecond: 1_000 };

/** The keywords as a file keeps them: trimmed, each once, no blank ones, at most `MAX_KEYWORDS`; none left out. */
export function cleanKeywords(keywords: readonly string[] | undefined): { keywords?: string[] } {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of keywords ?? []) {
    const keyword = raw.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!keyword || seen.has(keyword.toLowerCase())) continue;
    seen.add(keyword.toLowerCase());
    out.push(keyword);
    if (out.length === MAX_KEYWORDS) break;
  }
  return out.length > 0 ? { keywords: out } : {};
}

const nonEmpty = (value: string, fallback: string) => (value.trim() ? value : fallback);

/** A submission's folder as the source gives it: each file's path and its content. */
export function submissionFiles(venue: VenueInput, input: SubmissionInput): Map<string, string> {
  const files = new Map<string, string>();
  files.set(
    submissionFilePath(venue.source, input.externalId),
    encodeReviewFile({
      schema: SUBMISSION_SCHEMA,
      id: input.externalId,
      venue: { id: venue.id, name: venue.name, url: venue.url },
      number: input.number,
      ...cleanKeywords(input.keywords),
      url: input.url,
      license: venue.license,
    }),
  );
  files.set(
    formsFilePath(venue.source, input.externalId),
    encodeReviewFile({ schema: FORMS_SCHEMA, forms: venue.forms, url: venue.url ?? input.url, license: venue.license }),
  );
  // A source can list a note twice, as a scan and a lookup both return it: the last one stands.
  for (const note of input.notes) {
    files.set(
      noteFilePath(venue.source, input.externalId, note.externalId),
      encodeReviewFile({
        schema: NOTE_SCHEMA,
        id: note.externalId,
        replyTo: note.replyTo,
        kind: note.kind,
        invitation: nonEmpty(note.invitation, 'Note'),
        signature: nonEmpty(note.signature, 'Anonymous'),
        content: note.content,
        createdAt: note.createdAt.toISOString(),
        ...(note.modifiedAt ? { modifiedAt: note.modifiedAt.toISOString() } : {}),
        url: note.url ?? input.url,
        license: note.license,
      }),
    );
  }
  return files;
}

/** The submission as its version records it. */
export function versionEntry(
  venue: VenueInput,
  input: SubmissionInput,
): VersionSubmission & { url: string; reviews: string } {
  const decision = input.decision?.replace(/\s+/g, ' ').trim().slice(0, MAX_VERSION_DECISION);
  return {
    venue: venue.name.trim().slice(0, MAX_VENUE) || venue.id.slice(0, MAX_VENUE),
    ...(input.status ? { status: input.status } : {}),
    ...(decision ? { decision } : {}),
    ...(input.number !== null && input.number > 0 ? { number: input.number } : {}),
    url: input.url,
    reviews: reviewsKey(venue.source, input.externalId),
    evidence: [input.url],
  };
}

const blobId = (content: string) => gitObject('blob', Buffer.from(content)).oid;

function describe(venue: VenueInput, input: SubmissionInput, changes: FileChange[], isNew: boolean): string {
  const notes = changes.filter((change) => change.path.includes('/notes/'));
  const removed = notes.filter((change) => change.content === null).length;
  const parts = [`${notes.length - removed} note${notes.length - removed === 1 ? '' : 's'}`];
  if (removed > 0) parts.push(`${removed} removed`);
  const what = isNew ? 'Import' : 'Update';
  return `${what} ${venue.name} submission ${input.externalId}: ${parts.join(', ')}`;
}

/** Writes one submission's folder; whether it committed. */
async function importOne(
  venue: VenueInput,
  input: SubmissionInput,
  actor: Actor,
  options: ImportOptions,
  database: Database,
): Promise<{ status: 'committed' | 'unchanged' | 'skipped'; paperId?: string }> {
  const found = await findPaper(input.paper, database);
  if (!found) return { status: 'skipped' };
  const paperId = found.paper.id;
  const wanted = submissionFiles(venue, input);
  const dir = submissionDir(venue.source, input.externalId);
  const head = await readHead(database, paperId);
  const tree = head ? (await readCommit(database, paperId, head)).tree : null;
  const held = tree ? await readFolder(database, paperId, tree, dir) : null;
  const changes: FileChange[] = [];
  for (const [path, content] of wanted) {
    if (held?.get(path) !== blobId(content)) changes.push({ path, content });
  }
  for (const path of held?.keys() ?? []) if (!wanted.has(path)) changes.push({ path, content: null });
  // What the venue decided goes in the version the submission is of, the one place a decision is kept.
  const before = tree ? await readVersions(database, paperId, await readFiles(database, paperId, tree)) : [];
  const date = input.submittedAt ? input.submittedAt.toISOString().slice(0, 10) : undefined;
  changes.push(...versionChanges(before, attachSubmission(before, versionEntry(venue, input), { date })));
  if (changes.length === 0) return { status: 'unchanged', paperId };
  const isNew = !held?.has(submissionFilePath(venue.source, input.externalId));
  const result = await commitPage(paperId, head, actor, changes, describe(venue, input, changes, isNew), {
    database,
    rateLimit: options.rateLimit,
    evidence: [input.url],
  });
  return { status: result.status, paperId };
}

/** Tries again when the page was busy (someone else committing to it), a few times. */
async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (err) {
      if (!(err instanceof ApiError) || err.code !== 'page_busy' || attempt >= 4) throw err;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
}

export async function importReviews(
  venue: VenueInput,
  input: Iterable<SubmissionInput>,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const database = options.database ?? getDb();
  const actor = options.actor ?? (await botActor(OPENREVIEW_BOT, database));
  const all = [...new Map([...input].map((s) => [s.externalId, s])).values()];
  const result: ImportResult = {
    submissions: 0,
    notes: 0,
    skipped: 0,
    committed: 0,
    unchanged: 0,
    failed: [],
    changed: [],
  };
  let next = 0;
  let done = 0;
  const work = async () => {
    while (next < all.length) {
      const item = all[next++];
      try {
        const { status, paperId } = await withRetry(() => importOne(venue, item, actor, options, database));
        if (status === 'committed' && paperId) result.changed.push(paperId);
        if (status === 'skipped') result.skipped += 1;
        else {
          result.submissions += 1;
          result.notes += new Set(item.notes.map((note) => note.externalId.toLowerCase())).size;
          result[status] += 1;
        }
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        result.failed.push({ externalId: item.externalId, error: `${err.code}: ${err.message}` });
      }
      done += 1;
      options.progress?.(result, done);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 1) }, work));
  return result;
}
