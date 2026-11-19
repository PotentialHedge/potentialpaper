import { eq } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { pageCurrent, pages, paperIdentifiers, papers } from '@/db/schema';
import { type KeyedKind, KINDS, keyedPagePath, pageName } from '@/lib/kinds';
import { canonicalPaperId, paperPath } from '@/lib/paper-ids';
import { STATUS_LABELS } from '@/lib/submissions';
import { survivorOf } from './pages/kinds';
import { siteUrl } from './site';
import { submissionsOf } from './submissions';

/**
 * What the share surfaces read: the short link `/s/<n>`, the link-preview image `/preview/<n>.png` and the README
 * badge `/badge/<n>.svg`, all keyed by `pages.short_id`. **Reads only**, and only what the page itself shows.
 */

export const SITE_NAME = 'potentialpaper';

export interface ShareSubject {
  pageId: string;
  shortId: number;
  kind: string;
  /** "Paper", "Venue", … as the page heads itself. */
  kindTitle: string;
  /** The paper's title, or the page's name. */
  name: string;
  /** A paper's authors; empty for other kinds and while under anonymous review. */
  authors: string[];
  /** A line under the name: a paper's venue and year, or a keyed page's identifier. */
  about: string | null;
  /** The page's path on the site. */
  path: string;
  /** What the badge says, and its tone. */
  badge: { message: string; tone: 'up' | 'down' | 'ink' };
}

/** A page's short link, absolute. */
export function shortUrl(shortId: number): string {
  return `${siteUrl()}/s/${shortId}`;
}

/** A page's preview image, absolute, for its `openGraph.images`. */
export function previewImageUrl(shortId: number): string {
  return `${siteUrl()}/preview/${shortId}.png`;
}

/** A page's link preview, for its metadata: its own image (`/preview/<n>.png`) on Open Graph and X. */
export function previewMetadata(title: string, description: string | undefined, shortId: number) {
  const images = [{ url: previewImageUrl(shortId), width: 1200, height: 630, alt: title }];
  return {
    openGraph: { title, description, siteName: SITE_NAME, type: 'website' as const, images },
    twitter: { card: 'summary_large_image' as const, title, description, images },
  };
}

/** A page's badge, absolute. */
export function badgeUrl(shortId: number): string {
  return `${siteUrl()}/badge/${shortId}.svg`;
}

/** The Markdown for a README: the badge, linking to the page. */
export function badgeMarkdown(shortId: number): string {
  return `[![${SITE_NAME}](${badgeUrl(shortId)})](${shortUrl(shortId)})`;
}

/** A page's short id, by its id. */
export async function shortIdOf(pageId: string, database: Database = getDb()): Promise<number | null> {
  const [row] = await database.select({ shortId: pages.shortId }).from(pages).where(eq(pages.id, pageId));
  return row?.shortId ?? null;
}

/**
 * The page a short id names, as something to share: `null` for anything but digits, or no such page. A merged
 * paper or topic gives the page it was merged into.
 */
export async function shareSubject(ref: string, database: Database = getDb()): Promise<ShareSubject | null> {
  if (!/^\d{1,9}$/.test(ref)) return null;
  const [row] = await database
    .select({ id: pages.id, kind: pages.kind, key: pages.key, shortId: pages.shortId })
    .from(pages)
    .where(eq(pages.shortId, Number(ref)));
  if (!row) return null;
  if (row.kind === 'paper') return paperSubject(row.id, database);
  const page = await survivorOf(database, row);
  const kind = page.kind as KeyedKind;
  const [current] = await database
    .select({ name: pageCurrent.name, shortId: pages.shortId })
    .from(pages)
    .leftJoin(pageCurrent, eq(pageCurrent.pageId, pages.id))
    .where(eq(pages.id, page.id));
  const name = current?.name ?? pageName(kind, page.key, null);
  return {
    pageId: page.id,
    shortId: current?.shortId ?? row.shortId,
    kind,
    kindTitle: KINDS[kind].title,
    name,
    authors: [],
    about: `${kind}:${page.key}`,
    path: keyedPagePath(kind, page.key),
    badge: { message: name, tone: 'ink' },
  };
}

async function paperSubject(paperId: string, database: Database, hops = 0): Promise<ShareSubject | null> {
  const [paper] = await database.select().from(papers).where(eq(papers.id, paperId));
  if (!paper) return null;
  if (paper.mergedInto && hops < 8) return paperSubject(paper.mergedInto, database, hops + 1);
  const [ids, [page], submissions] = await Promise.all([
    database
      .select({ scheme: paperIdentifiers.scheme, value: paperIdentifiers.value })
      .from(paperIdentifiers)
      .where(eq(paperIdentifiers.paperId, paper.id)),
    database.select({ shortId: pages.shortId }).from(pages).where(eq(pages.id, paper.id)),
    submissionsOf(paper.id, database),
  ]);
  const canonical = canonicalPaperId(ids);
  if (!canonical || !page) return null;
  // The newest decision, else the newest submission still under review: venues sort by name, so "ICLR 2027" after "ICLR 2026".
  const latest = [...submissions].reverse();
  const submission = latest.find((s) => s.status && s.status !== 'under_review') ?? latest[0];
  let badge: ShareSubject['badge'] = {
    message:
      canonical.scheme === 'arxiv'
        ? `arXiv:${canonical.value}`
        : [paper.venue, paper.year].filter(Boolean).join(' ') || 'paper',
    tone: 'ink',
  };
  if (submission) {
    const decision = submission.status === 'accepted' && submission.decision ? submission.decision : null;
    const status = decision ?? (submission.status ? STATUS_LABELS[submission.status] : 'submitted');
    badge = {
      message: `${submission.venue.name}: ${status.toLowerCase()}`,
      tone:
        submission.status === 'accepted'
          ? 'up'
          : submission.status === 'under_review' || !submission.status
            ? 'ink'
            : 'down',
    };
  }
  return {
    pageId: paper.id,
    shortId: page.shortId,
    kind: 'paper',
    kindTitle: 'Paper',
    name: paper.title,
    authors: paper.authors,
    about: [paper.venue, paper.year].filter(Boolean).join(', ') || null,
    path: paperPath(canonical),
    badge,
  };
}
