import { and, eq, inArray, sql } from 'drizzle-orm';
import { pageCurrent, pages, venues } from '@/db/schema';
import { type VenueFile, venueFileSchema } from '@/lib/kinds';
import { parseVenueFormsFile, VENUE_FORMS_FILE, type VenueFormsFile } from '@/lib/review-files';
import { sourceUrl } from '@/lib/venues';
import { venuePagesOf, withVenueNames, type PaperVersion } from '@/lib/versions';
import { refreshVenueRatings } from '../paper-ratings';
import type { Writer } from './projections';
import { readText, type Reader } from './repo';

/**
 * What is kept once on a venue's page and shown elsewhere (DESIGN.md §4.3, layout 7): its name, and its forms.
 *
 * - **The `venues` table** is a projection of venue pages: a row for each source a page's `venue.json` lists, named as
 *   the page is, with the source's own page as its address and the forms the page's `forms.json` gives that source.
 *   Written with the page's `page_current`, in its commit. A source no page lists keeps the bare row the review
 *   projection makes for its submissions (`review-projection.ts`).
 * - **A version's submission that names a venue page** (`"page": "neurips/2026"`) is shown with the page's name, filled
 *   in as its `venue` when the paper's `page_current.versions` is written. When a venue page's name changes, the
 *   `venue-names` consumer writes its papers' again (`server/venue-names.ts`).
 * - **Its site** (`"site": "Sydney"`) is one of the page's `locations` where it lists any (`pages/check.ts`), kept and
 *   shown in the short form, the location's first part (`siteAt`). A site its locations no longer have shows as
 *   written; the venue's commit isn't refused for it, and the next import puts it right.
 */

/** Each source's forms on a venue page, from its `forms.json`; none when it has none, or one that doesn't parse. */
export async function readVenueForms(
  db: Reader,
  pageId: string,
  files: ReadonlyMap<string, string>,
): Promise<VenueFormsFile['sources']> {
  const blob = files.get(VENUE_FORMS_FILE);
  if (!blob) return {};
  const parsed = parseVenueFormsFile((await readText(db, pageId, blob)) ?? '');
  return 'file' in parsed ? parsed.file.sources : {};
}

/** Brings the `venues` rows of the sources a venue page lists up to what its files say. */
export async function writeVenueRows(
  tx: Writer,
  pageId: string,
  kindFile: Record<string, unknown> | null,
  files: ReadonlyMap<string, string>,
): Promise<void> {
  const parsed = venueFileSchema.safeParse(kindFile);
  if (!parsed.success) return;
  const venue: VenueFile = parsed.data;
  const sources = venue.sources ?? [];
  if (sources.length === 0) return;
  const forms = await readVenueForms(tx, pageId, files);
  const reformed: string[] = [];
  for (const id of sources) {
    const row = { name: venue.name, url: sourceUrl(id), forms: forms[id]?.forms ?? {} };
    const { rows } = await tx.execute<{ same: boolean }>(
      sql`select forms = ${JSON.stringify(row.forms)}::jsonb as same from venues where id = ${id}`,
    );
    if (rows.length > 0 && !rows[0].same) reformed.push(id);
    await tx
      .insert(venues)
      .values({ id, ...row })
      .onConflictDoUpdate({ target: venues.id, set: row });
  }
  // Ratings are shares of a form's range: new forms rate the venue's papers afresh (`paper-ratings.ts`).
  await refreshVenueRatings(tx, reformed);
}

/** The venue pages these keys name, with their names and `locations`; a key with no page is left out. */
export async function venuePageNames(
  db: Reader,
  keys: readonly string[],
): Promise<{ names: Map<string, string>; locations: Map<string, string[]> }> {
  if (keys.length === 0) return { names: new Map(), locations: new Map() };
  const rows = await db
    .select({
      key: pages.key,
      name: sql<string>`coalesce(${pageCurrent.name}, ${pages.key})`,
      kindFile: pageCurrent.kindFile,
    })
    .from(pages)
    .leftJoin(pageCurrent, eq(pageCurrent.pageId, pages.id))
    .where(and(eq(pages.kind, 'venue'), inArray(pages.key, [...keys])));
  const locations = new Map<string, string[]>();
  for (const row of rows) {
    const parsed = venueFileSchema.safeParse(row.kindFile);
    if (parsed.success && parsed.data.locations?.length) locations.set(row.key, parsed.data.locations);
  }
  return { names: new Map(rows.map((row) => [row.key, row.name])), locations };
}

/** The versions with each submission that names a venue page showing that page's name, and its site's short form. */
export async function resolveVenueNames(db: Reader, versions: PaperVersion[]): Promise<PaperVersion[]> {
  const keys = venuePagesOf(versions);
  if (keys.length === 0) return versions;
  const { names, locations } = await venuePageNames(db, keys);
  return withVenueNames(versions, names, locations);
}
