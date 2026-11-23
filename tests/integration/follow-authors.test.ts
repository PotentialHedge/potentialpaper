import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { accounts, authorClaims, papers } from '@/db/schema';
import { encodePaperFile } from '@/lib/paper-file';
import { SYSTEM_ACTOR } from '@/server/pages/check';
import { commitPage } from '@/server/pages/commit';
import { rebuildPage } from '@/server/pages/projections';
import { readHead } from '@/server/pages/repo';
import { savePaper } from '@/server/papers';
import { closePool, resetDatabase } from './helpers';

/** Claims follow `paper.json`'s authors: by name to a new position, back to pending when the name is gone. */

afterAll(closePool);
beforeEach(resetDatabase);

const AUTHORS = ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar', 'José Uszkoreit'];

let count = 0;

async function paper(): Promise<string> {
  return savePaper({
    title: 'Attention Is All You Need',
    authors: AUTHORS,
    abstract: null,
    identifiers: [{ scheme: 'arxiv', value: '1706.03762' }],
    source: 'arxiv',
    metadataLicense: 'CC0-1.0',
    abstractLicense: null,
  });
}

/** A claim on author `index`, straight in the table, as the claim routes would leave it. */
async function claim(paperId: string, index: number, status: 'pending' | 'confirmed') {
  count += 1;
  const [account] = await getDb()
    .insert(accounts)
    .values({ handle: `author-${count}`, verifiedAt: new Date() })
    .returning();
  const [row] = await getDb()
    .insert(authorClaims)
    .values({
      paperId,
      accountId: account.id,
      authorIndex: index,
      authorName: AUTHORS[index],
      status,
      identityId: `a_test${String(count).padStart(4, '0')}`,
      ...(status === 'confirmed' ? { decidedAt: new Date(), decidedBy: account.id } : {}),
    })
    .returning();
  return row.id;
}

async function setAuthors(paperId: string, authors: string[]) {
  await commitPage(
    paperId,
    await readHead(getDb(), paperId),
    SYSTEM_ACTOR,
    [
      {
        path: 'paper.json',
        content: encodePaperFile({
          title: 'Attention Is All You Need',
          authors,
          license: { metadata: 'CC0-1.0' },
        }),
      },
    ],
    'Authors',
  );
}

async function claims(paperId: string) {
  const rows = await getDb()
    .select()
    .from(authorClaims)
    .where(eq(authorClaims.paperId, paperId))
    .orderBy(asc(authorClaims.identityId));
  return Object.fromEntries(rows.map((r) => [r.id, r]));
}

describe('claims following the authors', () => {
  it('follow a reorder and a respelling, and unconfirm an author who is gone', async () => {
    const paperId = await paper();
    const ashish = await claim(paperId, 0, 'confirmed');
    const noam = await claim(paperId, 1, 'confirmed');
    const niki = await claim(paperId, 2, 'pending');
    const jose = await claim(paperId, 3, 'confirmed');

    // Ashish moves to the end, José loses his accent, Noam is no longer on the paper.
    await setAuthors(paperId, ['Niki Parmar', 'Jose Uszkoreit', 'Ashish Vaswani']);
    const [row] = await getDb().select({ authors: papers.authors }).from(papers).where(eq(papers.id, paperId));
    expect(row.authors).toEqual(['Niki Parmar', 'Jose Uszkoreit', 'Ashish Vaswani']);

    const after = await claims(paperId);
    expect(after[ashish]).toMatchObject({ authorIndex: 2, authorName: 'Ashish Vaswani', status: 'confirmed' });
    expect(after[niki]).toMatchObject({ authorIndex: 0, authorName: 'Niki Parmar', status: 'pending' });
    expect(after[jose]).toMatchObject({ authorIndex: 1, authorName: 'Jose Uszkoreit', status: 'confirmed' });
    expect(after[noam]).toMatchObject({
      authorIndex: 1,
      authorName: 'Noam Shazeer',
      status: 'pending',
      decidedAt: null,
      decidedBy: null,
    });

    // Rebuilding changes nothing.
    await rebuildPage(paperId);
    expect(await claims(paperId)).toEqual(after);
  });

  it('swaps two confirmed authors without tripping the one-claim-per-author index', async () => {
    const paperId = await paper();
    const ashish = await claim(paperId, 0, 'confirmed');
    const noam = await claim(paperId, 1, 'confirmed');

    await setAuthors(paperId, ['Noam Shazeer', 'Ashish Vaswani', 'Niki Parmar', 'José Uszkoreit']);

    const after = await claims(paperId);
    expect(after[ashish]).toMatchObject({ authorIndex: 1, authorName: 'Ashish Vaswani', status: 'confirmed' });
    expect(after[noam]).toMatchObject({ authorIndex: 0, authorName: 'Noam Shazeer', status: 'confirmed' });
  });
});
