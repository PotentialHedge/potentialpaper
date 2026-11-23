import { getDb, type Database } from '@/db';
import {
  encodeReviewFile,
  MAX_KEYWORDS,
  MAX_TLDR,
  NOTE_SCHEMA,
  noteFilePath,
  reviewsKey,
  submissionDir,
  SUBMISSION_SCHEMA,
  submissionFilePath,
  VENUE_FORMS_FILE,
  withSourceForms,
} from '@/lib/review-files';
import { sourceUrl, type VenuePlace, venuePlace } from '@/lib/venues';
import type { PaperId } from '@/lib/paper-ids';
import type { FieldValue, NoteKind, SubmissionStatus, VenueForms } from '@/lib/submissions';
import { ApiError } from './api/errors';
import { botActor, OPENREVIEW_BOT } from './bots';
import { type Actor, commitPage, type FileChange, SYSTEM_ACTOR } from './pages/commit';
import { gitObject } from './pages/git-objects';
import { readVersions, versionChanges } from './pages/content';
import { readCommit, readFiles, readFolder, readHead, readText } from './pages/repo';
import { findKeyedPage } from './pages/kinds';
import { attachSubmission } from './versions';
import { MAX_SITE, MAX_VERSION_DECISION, MAX_VENUE, type VersionSubmission } from '@/lib/versions';
import { syncVenuePages } from './venue-pages';
import { findPaper } from './papers';
import type { RateLimitConfig } from './ratelimit';

/**
 * Adding a venue's submissions and what it published about them, from any source, as files in each paper's
 * repo (`lib/review-files.ts`, DESIGN.md §4.3), committed through `commitPage` by the bot granted the source
 * (`openreview`), one commit per submission. What the venue is goes on its own page, kept once: the import makes
 * the venue's series and edition pages if they aren't there (`venue-pages.ts`), and writes the venue's forms into the
 * edition's `forms.json` as the system; each submission names the venue by its id, and its version's entry names
 * the edition's page. A venue that has no page (a track, a workshop, `lib/venues.ts`) is refused. A submission is attached to the paper one of its identifiers
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
  /** The area its authors chose from the venue's list: "reinforcement learning". */
  primaryArea?: string | null;
  /** Its one-sentence summary, as its authors gave it. */
  tldr?: string | null;
  /**
   * Where it is presented, for a venue held in several places at once: "Sydney". Kept in its version's entry beside
   * the decision. A source that doesn't know it (OpenReview) leaves it out, and the entry keeps the one it has.
   */
  site?: string | null;
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

/**
 * The keywords as a file keeps them: trimmed, each once, no blank ones, at most `MAX_KEYWORDS`. Authors who typed
 * several into one of OpenReview's fields, "Dexterous manipulation;Offline2Online safe RL", get them split.
 */
export function cleanKeywords(keywords: readonly string[] | undefined): { keywords?: string[] } {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of (keywords ?? []).flatMap((k) => k.split(';'))) {
    const keyword = raw.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!keyword || seen.has(keyword.toLowerCase())) continue;
    seen.add(keyword.toLowerCase());
    out.push(keyword);
    if (out.length === MAX_KEYWORDS) break;
  }
  return out.length > 0 ? { keywords: out } : {};
}

/** One line of the source's text, as a file keeps it: spaces collapsed, cut to `max`; left out when blank. */
function cleanText<K extends string>(key: K, value: string | null | undefined, max: number): { [P in K]?: string } {
  const text = value?.replace(/\s+/g, ' ').trim().slice(0, max);
  return (text ? { [key]: text } : {}) as { [P in K]?: string };
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
      venue: { id: venue.id },
      number: input.number,
      ...cleanKeywords(input.keywords),
      ...cleanText('primaryArea', input.primaryArea, 300),
      ...cleanText('tldr', input.tldr, MAX_TLDR),
      url: input.url,
      license: venue.license,
    }),
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

/** The source's id for the venue, as a venue page lists it and the `venues` table keys it: `openreview:ICLR.cc/2027/Conference`. */
export function venueSourceId(venue: Pick<VenueInput, 'source' | 'id'>): string {
  return `${venue.source}:${venue.id}`;
}

/** The venue's series and edition pages, or a refusal saying it has none yet. */
export function placeOf(venue: Pick<VenueInput, 'source' | 'id' | 'name'>): VenuePlace {
  const place = venuePlace(venueSourceId(venue), venue.name);
  if (!place) {
    throw new ApiError(
      422,
      'validation_error',
      `${venueSourceId(venue)} has no venue page: only a conference's main edition (<Series>/<year>/Conference) has one yet, so its reviews can't be imported`,
    );
  }
  return place;
}

/** The venue's name as a version made for its submission is labelled. */
function venueLabel(venue: VenueInput): string {
  return venue.name.trim().slice(0, MAX_VENUE) || venue.id.slice(0, MAX_VENUE);
}

/** The submission as its version records it: at the venue's edition page, which has its name. */
export function versionEntry(
  place: Pick<VenuePlace, 'edition'>,
  source: string,
  input: SubmissionInput,
): VersionSubmission & { url: string; reviews: string; page: string } {
  const decision = input.decision?.replace(/\s+/g, ' ').trim().slice(0, MAX_VERSION_DECISION);
  const site = input.site?.replace(/\s+/g, ' ').trim().slice(0, MAX_SITE);
  return {
    page: place.edition.key,
    ...(input.status ? { status: input.status } : {}),
    ...(decision ? { decision } : {}),
    ...(site ? { site } : {}),
    ...(input.number !== null && input.number > 0 ? { number: input.number } : {}),
    url: input.url,
    reviews: reviewsKey(source, input.externalId),
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
  place: VenuePlace,
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
  const entry = versionEntry(place, venue.source, input);
  changes.push(...versionChanges(before, attachSubmission(before, entry, { date, label: venueLabel(venue) })));
  if (changes.length === 0) return { status: 'unchanged', paperId };
  const isNew = !held?.has(submissionFilePath(venue.source, input.externalId));
  const result = await commitPage(paperId, head, actor, changes, describe(venue, input, changes, isNew), {
    database,
    rateLimit: options.rateLimit,
    evidence: [input.url],
  });
  return { status: result.status, paperId };
}

/**
 * Writes the venue's forms into its edition page's `forms.json`, as the system, when they changed: what the source says
 * about showing its notes, kept once for all its submissions. Before the submissions, so the `venues` row has them.
 */
export async function writeVenueForms(venue: VenueInput, place: VenuePlace, database: Database): Promise<boolean> {
  const page = await findKeyedPage(database, 'venue', place.edition.key);
  if (!page) throw new Error(`the venue page ${place.edition.key} wasn't made`);
  return withRetry(async () => {
    const head = await readHead(database, page.id);
    const tree = head ? (await readCommit(database, page.id, head)).tree : null;
    const blob = tree ? (await readFiles(database, page.id, tree)).get(VENUE_FORMS_FILE) : undefined;
    const existing = blob ? await readText(database, page.id, blob) : null;
    const content = withSourceForms(existing, place.source, {
      forms: venue.forms,
      url: venue.url ?? sourceUrl(place.source) ?? '',
      license: venue.license,
    });
    if (content === null) return false;
    const result = await commitPage(
      page.id,
      head,
      SYSTEM_ACTOR,
      [{ path: VENUE_FORMS_FILE, content }],
      `${existing === null ? 'Add' : 'Update'} the forms of ${place.source}`,
      { database, rateLimit: IMPORT_RATE_LIMIT },
    );
    return result.status === 'committed';
  });
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
  const place = placeOf(venue);
  await syncVenuePages({ venues: [{ id: place.source, name: venue.name }], database });
  await writeVenueForms(venue, place, database);
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
        const { status, paperId } = await withRetry(() => importOne(venue, place, item, actor, options, database));
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
