import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { accounts } from '@/db/schema';
import { encodeReviewFile, type NoteFile, noteFilePath, submissionFilePath } from '@/lib/review-files';
import { ApiError } from '@/server/api/errors';
import { ensureBot, grantBot, listGrants, OPENREVIEW_BOT, revokeGrant } from '@/server/bots';
import { type Actor, commitPage } from '@/server/pages/commit';
import { readCommit, readFiles, readHead, readText } from '@/server/pages/repo';
import { savePaper } from '@/server/papers';
import { closePool, resetDatabase } from './helpers';

const NO_LIMIT = { burst: 100_000, perSecond: 1000 };

beforeEach(resetDatabase);
afterAll(closePool);

let count = 0;
async function newPaper() {
  count += 1;
  return savePaper({
    title: `Paper ${count}`,
    authors: ['Ada Lovelace'],
    abstract: 'An abstract.',
    source: 'openreview',
    metadataLicense: 'CC0-1.0',
    abstractLicense: 'CC0-1.0',
    identifiers: [{ scheme: 'openreview', value: `forum${count}` }],
  });
}

async function newAccount(fields: Partial<typeof accounts.$inferInsert> = {}): Promise<Actor> {
  count += 1;
  const [row] = await getDb()
    .insert(accounts)
    .values({ handle: `someone-${count}`, verifiedAt: new Date(), ...fields })
    .returning({ id: accounts.id });
  return { kind: 'account', accountId: row.id, isAdmin: false };
}

const submission = encodeReviewFile({
  schema: 'submission/1',
  id: 'Forum1AbC',
  venue: { id: 'ICLR.cc/2027/Conference', name: 'ICLR 2027', url: null },
  number: 7,
  url: 'https://openreview.net/forum?id=Forum1AbC',
  license: 'CC-BY-4.0',
});

const note = (rating: number): string =>
  encodeReviewFile({
    schema: 'review/1',
    id: 'Note9XyZ',
    replyTo: null,
    kind: 'review',
    invitation: 'Official_Review',
    signature: 'Reviewer B3x7',
    content: { rating, summary: 'Fine.' },
    createdAt: '2026-11-01T12:00:00.000Z',
    url: 'https://openreview.net/forum?id=Forum1AbC&noteId=Note9XyZ',
    license: 'CC-BY-4.0',
  } satisfies NoteFile);

const SUBMISSION_PATH = submissionFilePath('openreview', 'Forum1AbC');
const NOTE_PATH = noteFilePath('openreview', 'Forum1AbC', 'Note9XyZ');

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

describe('a bot granted a source', () => {
  it('commits its reviews, and a raised score is a commit of its own', async () => {
    const paper = await newPaper();
    const bot = await ensureBot(OPENREVIEW_BOT);
    await grantBot(OPENREVIEW_BOT, 'reviews/openreview/**', { grantedBy: 'system' });
    expect(await listGrants()).toMatchObject([{ handle: 'openreview', pattern: 'reviews/openreview/**', shown: true }]);

    const first = await commitPage(
      paper,
      null,
      bot,
      [
        { path: SUBMISSION_PATH, content: submission },
        { path: NOTE_PATH, content: note(6) },
      ],
      'Import from OpenReview',
      { rateLimit: NO_LIMIT },
    );
    expect(first.status).toBe('committed');
    const raised = await commitPage(
      paper,
      first.oid,
      bot,
      [
        { path: SUBMISSION_PATH, content: submission },
        { path: NOTE_PATH, content: note(8) },
      ],
      'Import from OpenReview',
      { rateLimit: NO_LIMIT },
    );
    expect(raised).toMatchObject({ status: 'committed', paths: [NOTE_PATH] });
    const again = await commitPage(paper, raised.oid, bot, [{ path: NOTE_PATH, content: note(8) }], 'Import', {
      rateLimit: NO_LIMIT,
    });
    expect(again.status).toBe('unchanged');

    const head = await readCommit(getDb(), paper, (await readHead(getDb(), paper))!);
    const files = await readFiles(getDb(), paper, head.tree);
    expect(JSON.parse((await readText(getDb(), paper, files.get(NOTE_PATH)!))!).content.rating).toBe(8);
  });

  it('refuses everyone else, a source it was not granted, and a note without its submission', async () => {
    const paper = await newPaper();
    const person = await newAccount();
    const otherBot = await newAccount({ isBot: true });
    const bot = await ensureBot(OPENREVIEW_BOT);
    const changes = [{ path: SUBMISSION_PATH, content: submission }];

    for (const actor of [person, otherBot, bot]) {
      const error = await refusal(commitPage(paper, null, actor, changes, 'Import', { rateLimit: NO_LIMIT }));
      expect(error.status).toBe(403);
      expect(error.message).toMatch(/only the bot granted reviews\/openreview\//);
    }

    await grantBot(OPENREVIEW_BOT, 'reviews/openreview/**', { grantedBy: 'system' });
    const elsewhere = await refusal(
      commitPage(paper, null, bot, [{ path: 'reviews/jmlr/x/submission.json', content: submission }], 'Import', {
        rateLimit: NO_LIMIT,
      }),
    );
    expect(elsewhere.status).toBe(403);

    const orphan = await refusal(
      commitPage(paper, null, bot, [{ path: NOTE_PATH, content: note(6) }], 'Import', { rateLimit: NO_LIMIT }),
    );
    expect(orphan.status).toBe(422);
    expect(orphan.message).toMatch(/needs reviews\/openreview\/forum1abc\/submission\.json/);

    const invalid = await refusal(
      commitPage(paper, null, bot, [{ path: SUBMISSION_PATH, content: '{"schema":"submission/9"}' }], 'Import', {
        rateLimit: NO_LIMIT,
      }),
    );
    expect(invalid.status).toBe(422);

    // An admin may, as on every path; taking the grant back stops the bot.
    const admin = { ...(await newAccount()), isAdmin: true } as Actor;
    expect((await commitPage(paper, null, admin, changes, 'Fix', { rateLimit: NO_LIMIT })).status).toBe('committed');
    expect(await revokeGrant(OPENREVIEW_BOT, 'reviews/openreview/**')).toBe(true);
    const head = await readHead(getDb(), paper);
    const revoked = await refusal(
      commitPage(paper, head, bot, [{ path: NOTE_PATH, content: note(6) }], 'Import', { rateLimit: NO_LIMIT }),
    );
    expect(revoked.status).toBe(403);
  });

  it('refuses a grant wider than a source folder, and a handle that is not a bot', async () => {
    await ensureBot(OPENREVIEW_BOT);
    await expect(grantBot(OPENREVIEW_BOT, 'community/**', { grantedBy: 'x' })).rejects.toThrow(/source's folder/);
    const person = await newAccount();
    const [row] = await getDb()
      .select({ handle: accounts.handle })
      .from(accounts)
      .where(eq(accounts.id, (person as { accountId: string }).accountId));
    await expect(grantBot(row.handle, 'reviews/x/**', { grantedBy: 'x' })).rejects.toThrow(/not a bot/);
  });
});
