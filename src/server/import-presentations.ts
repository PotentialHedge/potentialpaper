import { getDb, type Database } from '@/db';
import { sortPresentations } from '@/lib/presentations';
import { reviewsKey } from '@/lib/review-files';
import { MAX_PRESENTATIONS, MAX_SITE, type PaperVersion, type Presentation, siteAt } from '@/lib/versions';
import { ApiError } from './api/errors';
import { type Actor, commitPage } from './pages/commit';
import { readVersions, versionChanges } from './pages/content';
import { readCommit, readFiles, readHead } from './pages/repo';
import { venuePageNames } from './pages/venue-projection';
import { findPaper } from './papers';
import { IMPORT_RATE_LIMIT } from './import-reviews';

/**
 * A venue's schedule, onto the submissions a bot imported (`import-reviews.ts`): when and where each is presented, its
 * poster session and its oral (`Presentation`), and the site it is presented at, for a venue held in several places.
 * Both go in the submission's entry in its version, beside the decision, the one place each is kept; nothing else in
 * the entry or the paper changes. An import of the reviews later keeps them, as it keeps any field it doesn't send.
 *
 * The entry is the one naming the submission's reviews folder (`reviews/<source>/<id>`), or one at its forum. A
 * submission whose paper we don't have, or whose paper has no such entry, is skipped. Safe to run again: a submission
 * whose entry already says so commits nothing.
 */

export interface PresentationsInput {
  /** The source's id for the submission: an OpenReview forum id. */
  externalId: string;
  /** Its forum, to find an entry someone added by hand. */
  url?: string | null;
  /** Where it is presented: "Sydney". Left as it is when not given. */
  site?: string | null;
  /** Every time it is presented: all of them, so one the venue dropped is gone. */
  presentations: Presentation[];
}

export interface PresentationsResult {
  submissions: number;
  skipped: number;
  committed: number;
  unchanged: number;
  failed: { externalId: string; error: string }[];
  changed: string[];
}

const sameUrl = (url: string | undefined | null) => url?.replace(/\/+$/, '').toLowerCase() ?? null;

/** The versions with the submission's entry saying what the schedule does; `null` when the paper has no entry for it. */
export function withPresentations(
  versions: readonly PaperVersion[],
  key: string,
  input: Pick<PresentationsInput, 'url' | 'site' | 'presentations'>,
  locations: (page: string | undefined) => readonly string[],
): PaperVersion[] | null {
  const out = versions.map((v) => ({ ...v, submissions: v.submissions?.map((s) => ({ ...s })) }));
  const entries = out.flatMap((v) => v.submissions ?? []);
  const entry =
    entries.find((s) => s.reviews === key) ??
    (input.url ? entries.find((s) => sameUrl(s.url) === sameUrl(input.url)) : undefined);
  if (!entry) return null;
  const list = sortPresentations(input.presentations).slice(0, MAX_PRESENTATIONS);
  if (list.length > 0) entry.presentations = list;
  else delete entry.presentations;
  const given = input.site?.replace(/\s+/g, ' ').trim().slice(0, MAX_SITE);
  const site = given && siteAt(given, locations(entry.page));
  if (site) entry.site = site;
  return out;
}

export async function importPresentations(
  source: string,
  items: readonly PresentationsInput[],
  { actor, database = getDb(), concurrency = 4 }: { actor: Actor; database?: Database; concurrency?: number },
): Promise<PresentationsResult> {
  const result: PresentationsResult = {
    submissions: 0,
    skipped: 0,
    committed: 0,
    unchanged: 0,
    failed: [],
    changed: [],
  };
  const locationCache = new Map<string, string[]>();
  const all = [...new Map(items.map((i) => [i.externalId, i])).values()];

  const one = async (item: PresentationsInput): Promise<'committed' | 'unchanged' | 'skipped'> => {
    // A submission's paper is found by its id at the source; OpenReview's is the only source papers are kept by.
    const found =
      source === 'openreview' ? await findPaper({ scheme: 'openreview', value: item.externalId }, database) : null;
    if (!found) return 'skipped';
    const paperId = found.paper.id;
    const head = await readHead(database, paperId);
    if (!head) return 'skipped';
    const tree = (await readCommit(database, paperId, head)).tree;
    const before = await readVersions(database, paperId, await readFiles(database, paperId, tree));
    const pages = [...new Set(before.flatMap((v) => v.submissions ?? []).flatMap((s) => (s.page ? [s.page] : [])))];
    const missing = pages.filter((p) => !locationCache.has(p));
    if (missing.length > 0) {
      const { locations } = await venuePageNames(database, missing);
      for (const p of missing) locationCache.set(p, locations.get(p) ?? []);
    }
    const after = withPresentations(before, reviewsKey(source, item.externalId), item, (p) =>
      p ? (locationCache.get(p) ?? []) : [],
    );
    if (!after) return 'skipped';
    const changes = versionChanges(before, after);
    if (changes.length === 0) return 'unchanged';
    const committed = await commitPage(
      paperId,
      head,
      actor,
      changes,
      `Update when and where submission ${item.externalId} is presented`,
      {
        database,
        rateLimit: IMPORT_RATE_LIMIT,
        ...(item.url ? { evidence: [item.url] } : {}),
      },
    );
    if (committed.status === 'committed') result.changed.push(paperId);
    return committed.status === 'committed' ? 'committed' : 'unchanged';
  };

  let next = 0;
  const work = async () => {
    while (next < all.length) {
      const item = all[next++];
      for (let attempt = 1; ; attempt += 1) {
        try {
          const status = await one(item);
          if (status === 'skipped') result.skipped += 1;
          else {
            result.submissions += 1;
            result[status] += 1;
          }
          break;
        } catch (err) {
          if (!(err instanceof ApiError)) throw err;
          if (err.code === 'page_busy' && attempt < 4) {
            await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
            continue;
          }
          result.failed.push({ externalId: item.externalId, error: `${err.code}: ${err.message}` });
          break;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, work));
  return result;
}
