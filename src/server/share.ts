import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { pageCurrent, pages, paperIdentifiers, papers } from '@/db/schema';
import { type KeyedKind, KINDS, keyedPagePath, pageName } from '@/lib/kinds';
import { canonicalPaperId, paperPath } from '@/lib/paper-ids';
import { STATUS_LABELS } from '@/lib/submissions';
import { survivorOf } from './pages/kinds';
import { siteUrl } from './site';
import { scopeMemberCount } from './page-members';
import { submissionsOf } from './submissions';
import { userPageView } from './user-pages';

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
  /** A line under the name: a paper's venue and year, a person's handle and institution, a scope's paper count. */
  about: string | null;
  /** A few lines of text below: a person's bio, as plain text. */
  summary: string | null;
  /** A paper's latest decision or submission, as its badge says it; `null` when it has none. */
  status: { text: string; tone: 'up' | 'down' | 'ink' } | null;
  /** The page's path on the site. */
  path: string;
  /** What the badge says, and its tone. */
  badge: { message: string; tone: 'up' | 'down' | 'ink' };
}

/** A page's short link, absolute. */
export function shortUrl(shortId: number): string {
  return `${siteUrl()}/s/${shortId}`;
}

/**
 * A page's preview image, absolute, for its `openGraph.images`: versioned by what it shows (`previewVersion`), so the
 * edge and the chat apps can keep each version for good and a changed page gets a new address.
 */
export function previewImageUrl(shortId: number, version: string): string {
  return `${siteUrl()}/preview/${shortId}.png?v=${version}`;
}

/** Bump when the card's design changes, so every page's image is drawn again. */
const PREVIEW_DESIGN = 2;

/** A hash of everything a page's preview shows: same subject, same image. */
export function previewVersion(subject: ShareSubject): string {
  const shown = [
    subject.kind,
    subject.name,
    subject.authors,
    subject.about,
    subject.summary,
    subject.status,
    subject.shortId,
  ];
  return createHash('sha256')
    .update(JSON.stringify([PREVIEW_DESIGN, new URL(siteUrl()).host, shown]))
    .digest('base64url')
    .slice(0, 12);
}

/** The page's preview, as its metadata names it: `null` when it has no short id. */
export async function previewOfPage(
  pageId: string,
  database: Database = getDb(),
): Promise<{ shortId: number; version: string } | null> {
  const shortId = await shortIdOf(pageId, database);
  const subject = shortId === null ? null : await shareSubject(String(shortId), database);
  return subject && { shortId: subject.shortId, version: previewVersion(subject) };
}

/** A page's link preview, for its metadata: its own image (`/preview/<n>.png?v=…`) on Open Graph and X. */
export function previewMetadata(
  title: string,
  description: string | undefined,
  preview: { shortId: number; version: string },
) {
  const images = [{ url: previewImageUrl(preview.shortId, preview.version), width: 1200, height: 630, alt: title }];
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
  const subject: ShareSubject = {
    pageId: page.id,
    shortId: current?.shortId ?? row.shortId,
    kind,
    kindTitle: KINDS[kind].title,
    name,
    authors: [],
    about: null,
    summary: null,
    status: null,
    path: keyedPagePath(kind, page.key),
    badge: { message: name, tone: 'ink' },
  };
  if (kind === 'user') {
    // Only what the person's page shows (DESIGN.md §5.3).
    const user = await userPageView(page, { limit: 0 }, database);
    if (user) {
      const institutions = user.institutions?.join(', ') || null;
      subject.name = user.realName ?? name;
      subject.about = [user.realName ? name : null, institutions].filter(Boolean).join(' · ') || null;
      subject.summary = user.bio ? plainText(user.bio) : null;
    }
  } else if (KINDS[kind].scope) {
    const count = await scopeMemberCount(page.id, { database });
    subject.about = `${count.toLocaleString('en')} ${count === 1 ? 'paper' : 'papers'}`;
  }
  return subject;
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
    // "ICLR 2026", not "ICLR 2026, 2026".
    about:
      [paper.venue, paper.year && !paper.venue?.includes(String(paper.year)) ? paper.year : null]
        .filter(Boolean)
        .join(', ') || null,
    summary: null,
    status: submission ? { text: badge.message, tone: badge.tone } : null,
    path: paperPath(canonical),
    badge,
  };
}

/** Markdown with TeX as plain text, for an image that can't draw either: marks and TeX commands dropped. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\\([a-zA-Z]+)/g, '$1')
    .replace(/[*_`#>$\\{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
