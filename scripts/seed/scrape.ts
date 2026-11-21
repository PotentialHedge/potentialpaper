import { DatabaseSync } from 'node:sqlite';
import { normalizeTitle } from '@/lib/versions';
import { parseReply, submissionStatus, type OpenReviewNote, type ParsedNote } from '@/server/venue-sources/openreview';
import type { FixturePaper } from './fixture';

/** Forums with more replies than this are skipped, to keep the fixture small. */
const MAX_REPLIES = 15;

/**
 * Up to `want` papers of an OpenReview scrape (`../papermarket/scraping/*.sqlite`) that came back at a later venue:
 * those whose title is one of `titles` (slug → title), each with its notes from the scrape and the slug it has
 * there. A spread of how they fared: at most half of them one status, so rejected, withdrawn and desk-rejected all
 * show up. `skip` are forum ids already in the fixture.
 */
export function resubmitted(
  scrape: string,
  titles: Record<string, string>,
  want: number,
  skip: ReadonlySet<string>,
): { earlier: FixturePaper; slug: string }[] {
  const byTitle = new Map(Object.entries(titles).map(([slug, title]) => [normalizeTitle(title), slug]));
  const sqlite = new DatabaseSync(scrape, { readOnly: true });
  const candidates = sqlite
    .prepare(
      `select s.id, s.number, s.title, s.abstract, s.authors, s.keywords, s.venueid, s.cdate
       from submissions s join (select forum, count(*) n from replies group by forum) r on r.forum = s.id
       where length(s.abstract) >= 200 and r.n <= ${MAX_REPLIES} order by s.id`,
    )
    .all() as unknown as {
    id: string;
    number: number | null;
    title: string;
    abstract: string;
    authors: string | null;
    keywords: string | null;
    venueid: string | null;
    cdate: number | null;
  }[];
  const repliesOf = sqlite.prepare(`select raw from replies where forum = ? order by cdate`);
  const perStatus = new Map<string, number>();
  const pairs: { earlier: FixturePaper; slug: string }[] = [];
  for (const row of candidates) {
    if (pairs.length >= want) break;
    const slug = byTitle.get(normalizeTitle(row.title));
    if (!slug || skip.has(row.id)) continue;
    const notes = (repliesOf.all(row.id) as { raw: string }[])
      .map(({ raw }) => parseReply(JSON.parse(raw) as OpenReviewNote))
      .filter((note): note is ParsedNote => note !== null)
      .map((note) => ({ ...note, forum: undefined }));
    const decision = notes.find((note) => note.kind === 'decision')?.content.decision;
    const decisionText = typeof decision === 'string' ? decision.trim() : null;
    const status = submissionStatus(row.venueid, decisionText);
    if ((perStatus.get(status ?? '') ?? 0) >= Math.ceil(want / 2)) continue;
    perStatus.set(status ?? '', (perStatus.get(status ?? '') ?? 0) + 1);
    pairs.push({
      slug,
      earlier: {
        id: row.id,
        number: row.number,
        title: row.title,
        abstract: row.abstract,
        authors: JSON.parse(row.authors ?? '[]') as string[],
        keywords: JSON.parse(row.keywords ?? '[]') as string[],
        ...(row.cdate ? { submittedAt: new Date(row.cdate).toISOString() } : {}),
        ...(row.cdate ? { submittedAt: new Date(row.cdate).toISOString() } : {}),
        status,
        decision: decisionText,
        notes,
      },
    });
  }
  sqlite.close();
  return pairs;
}
