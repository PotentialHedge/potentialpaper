import { and, eq, inArray, sql } from 'drizzle-orm';
import { pageCurrent, pages, venues } from '@/db/schema';
import { type VenueFile, venueFileSchema } from '@/lib/kinds';
import { parseVenueFormsFile, VENUE_FORMS_FILE, type VenueFormsFile } from '@/lib/review-files';
import { sourceUrl } from '@/lib/venues';
import { venuePagesOf, withVenueNames, type PaperVersion } from '@/lib/versions';
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
  for (const id of sources) {
    const row = { name: venue.name, url: sourceUrl(id), forms: forms[id]?.forms ?? {} };
    await tx
      .insert(venues)
      .values({ id, ...row })
      .onConflictDoUpdate({ target: venues.id, set: row });
  }
}

/** The names of the venue pages these keys name; a key with no page is left out. */
export async function venuePageNames(db: Reader, keys: readonly string[]): Promise<Map<string, string>> {
  if (keys.length === 0) return new Map();
  const rows = await db
    .select({ key: pages.key, name: sql<string>`coalesce(${pageCurrent.name}, ${pages.key})` })
    .from(pages)
    .leftJoin(pageCurrent, eq(pageCurrent.pageId, pages.id))
    .where(and(eq(pages.kind, 'venue'), inArray(pages.key, [...keys])));
  return new Map(rows.map((row) => [row.key, row.name]));
}

/** The versions with each submission that names a venue page showing that page's name. */
export async function resolveVenueNames(db: Reader, versions: PaperVersion[]): Promise<PaperVersion[]> {
  const keys = venuePagesOf(versions);
  return keys.length === 0 ? versions : withVenueNames(versions, await venuePageNames(db, keys));
}
