import { gunzipSync } from 'node:zlib';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { pageCurrent, pdfDocuments, scopeState, scopeStats, venues } from '@/db/schema';
import { encodeReviewFile, formsFilePath, noteFilePath, submissionFilePath } from '@/lib/review-files';
import type { SubmissionStatus } from '@/lib/submissions';
import * as papersRoute from '@/app/api/v1/pages/[identifier]/papers/route';
import * as scoresRoute from '@/app/api/v1/pages/[identifier]/scores/route';
import { ensureBot, grantBot, OPENREVIEW_BOT } from '@/server/bots';
import { rebuildConsumer, runConsumer } from '@/server/consumers/run';
import { membersConsumer, syncDueAffiliations } from '@/server/page-members';
import { ORGS_BOT } from '@/server/org-pages';
import { commitPage, createPage } from '@/server/pages/commit';
import { findKeyedPage } from '@/server/pages/kinds';
import { readHead } from '@/server/pages/repo';
import { savePaper } from '@/server/papers';
import { reviewsConsumer } from '@/server/review-projection';
import { saveSiteSettings } from '@/server/settings';
import {
  MAX_MARKS,
  recomputeDueScopes,
  scopeHasScores,
  scopeScoreMarks,
  scopeStatsConsumer,
  venuePagesOf,
} from '@/server/scope-stats';
import { syncVenuePages, VENUES_BOT, venueScoreStats } from '@/server/venue-pages';
import { api, closePool, ORIGIN, resetDatabase } from './helpers';

/**
 * Data for plugins (`handoffs/plugins.md` Phase 4): the score statistics of a scope (A, `scope_stats`, kept up by the
 * reviews and members consumers marking scopes and the worker recomputing them), their routes with ETags, and a
 * scope's papers in bulk as NDJSON (B).
 */

beforeEach(async () => {
  await resetDatabase();
  papers = 0;
});
afterAll(closePool);

const ICLR_2027 = 'openreview:ICLR.cc/2027/Conference';
const ICLR_2026 = 'openreview:ICLR.cc/2026/Conference';
const enc = encodeURIComponent;
let papers = 0;

const FORMS = {
  Official_Review: {
    label: 'Official review',
    fields: [
      { key: 'summary', label: 'Summary', type: 'text' as const },
      { key: 'confidence', label: 'Confidence', type: 'score' as const, min: 1, max: 5 },
      { key: 'rating', label: 'Rating', type: 'score' as const, min: 0, max: 10 },
    ],
    summary: ['rating', 'confidence'],
  },
};

/** A paper submitted to `venue` with reviews giving `ratings` (and confidence 3 each), as the OpenReview bot writes. */
async function submitted(venue: string, status: SubmissionStatus | null, ratings: (number | string)[]) {
  papers += 1;
  const forum = `forum${papers}`;
  const paperId = await savePaper({
    title: `Paper ${papers}`,
    authors: [],
    abstract: null,
    year: 2027,
    venue: null,
    source: 'openreview',
    metadataLicense: 'CC0-1.0',
    abstractLicense: null,
    identifiers: [{ scheme: 'openreview', value: forum }],
  });
  const bot = await ensureBot(OPENREVIEW_BOT);
  await grantBot(OPENREVIEW_BOT, 'reviews/openreview/**', { grantedBy: 'system' });
  const id = venue.slice('openreview:'.length);
  const license = 'CC-BY-4.0';
  await commitPage(
    paperId,
    null,
    bot,
    [
      {
        path: submissionFilePath('openreview', forum),
        content: encodeReviewFile({
          schema: 'submission/1',
          id: forum,
          venue: { id, name: id.includes('2027') ? 'ICLR 2027' : 'ICLR 2026', url: null },
          number: papers,
          status,
          decision: status === 'accepted' ? 'Accept (Poster)' : status === 'rejected' ? 'Reject' : null,
          url: `https://openreview.net/forum?id=${forum}`,
          license,
        }),
      },
      {
        path: formsFilePath('openreview', forum),
        content: encodeReviewFile({ schema: 'forms/1', forms: FORMS, url: 'https://openreview.net/group', license }),
      },
      ...ratings.map((rating, i) => ({
        path: noteFilePath('openreview', forum, `r${i}`),
        content: encodeReviewFile({
          schema: 'review/1',
          id: `r${i}`,
          replyTo: null,
          kind: 'review',
          invitation: 'Official_Review',
          signature: `Reviewer ${i}`,
          content: { rating, confidence: '3: fairly confident', summary: 'Fine.' },
          createdAt: '2026-11-01T00:00:00Z',
          url: `https://openreview.net/forum?id=${forum}&noteId=r${i}`,
          license,
        }),
      })),
      // A comment's numbers aren't a review's.
      {
        path: noteFilePath('openreview', forum, 'c'),
        content: encodeReviewFile({
          schema: 'review/1',
          id: 'c',
          replyTo: null,
          kind: 'comment',
          invitation: 'Official_Comment',
          signature: 'Authors',
          content: { rating: 1 },
          createdAt: '2026-11-02T00:00:00Z',
          url: `https://openreview.net/forum?id=${forum}&noteId=c`,
          license,
        }),
      },
    ],
    'Import',
  );
  return paperId;
}

async function catchUp() {
  for (const consumer of [reviewsConsumer, membersConsumer, scopeStatsConsumer]) {
    expect(await runConsumer(consumer, { retryNow: true })).toMatchObject({ status: 'caught-up' });
  }
  await recomputeDueScopes({ all: true });
}

async function venuePages() {
  await ensureBot(VENUES_BOT);
  await grantBot(VENUES_BOT, 'venue.json', { grantedBy: 'system', kind: 'venue' });
  await getDb()
    .insert(venues)
    .values([
      { id: ICLR_2027, name: 'ICLR 2027' },
      { id: ICLR_2026, name: 'ICLR 2026' },
    ])
    .onConflictDoNothing();
  await syncVenuePages();
  const edition = (await findKeyedPage(getDb(), 'venue', 'iclr/2027'))!;
  const series = (await findKeyedPage(getDb(), 'venue', 'iclr'))!;
  return { edition, series };
}

async function get(path: string, module: { GET: (req: Request, ctx: never) => Promise<Response> }, headers = {}) {
  const [, identifier] = /^\/pages\/([^/?]+)/.exec(path)!;
  return module.GET(new Request(new URL(`/api/v1${path}`, ORIGIN), { headers }), {
    params: Promise.resolve({ identifier }),
  } as never);
}

describe('scope statistics (A)', () => {
  it("keeps each venue's score fields per scope: sorted means, bins, the split by outcome, rolled up", async () => {
    const { edition, series } = await venuePages();
    await submitted(ICLR_2027, 'accepted', [8, 6]); // 7
    await submitted(ICLR_2027, 'rejected', [3, '5: marginally below', 1]); // 3
    await submitted(ICLR_2027, null, [6]); // 6
    await submitted(ICLR_2027, 'desk_rejected', []); // no reviews: no mean
    await submitted(ICLR_2026, 'withdrawn', [10]);
    await catchUp();

    const list = await api('GET', `/pages/${enc('venue:iclr/2027')}/scores`);
    expect(list.status).toBe(200);
    expect(list.body.hideUntil).toBe('never');
    expect(list.body.page.identifier).toBe('venue:iclr/2027');
    // The form's summary order: rating, then confidence. The text field is no score.
    expect(list.body.scores.map((s: { field: string }) => s.field)).toEqual(['rating', 'confidence']);
    expect(list.body.scores[0]).toMatchObject({
      venue: { id: ICLR_2027, name: 'ICLR 2027' },
      label: 'Rating',
      count: 3,
      min: 0,
      max: 10,
      byStatus: { accepted: 1, rejected: 1, withdrawn: 0, pending: 1 },
      decisionsOut: true,
      hidden: false,
    });

    const rating = await api('GET', `/pages/${enc('venue:iclr/2027')}/scores/${enc(ICLR_2027)}/rating`);
    expect(rating.status).toBe(200);
    expect(rating.body.values).toEqual([3, 6, 7]);
    expect(rating.body.bins).toMatchObject({ lo: 0, hi: 10, width: 0.5 });
    expect(rating.body.bins.counts).toHaveLength(20);
    expect(rating.body.bins.counts[6]).toBe(1); // 3 is in [3, 3.5)
    expect(rating.body.bins.counts.reduce((a: number, b: number) => a + b, 0)).toBe(3);
    expect(rating.body.split.accepted.values).toEqual([7]);
    expect(rating.body.split.pending.values).toEqual([6]);
    expect(rating.body.split.withdrawn.count).toBe(0);
    const confidence = await api('GET', `/pages/${enc('venue:iclr/2027')}/scores/${enc(ICLR_2027)}/confidence`);
    expect(confidence.body.values).toEqual([3, 3, 3]);

    // The series rolls up both editions, each venue apart.
    const rolled = await api('GET', `/pages/${enc('venue:iclr')}/scores`);
    expect(rolled.body.scores.map((s: { venue: { id: string }; field: string }) => `${s.venue.id} ${s.field}`)).toEqual(
      [`${ICLR_2027} rating`, `${ICLR_2027} confidence`, `${ICLR_2026} rating`, `${ICLR_2026} confidence`],
    );
    expect(await scopeHasScores(series.id)).toBe(true);
    expect(await scopeHasScores(edition.id)).toBe(true);

    // The venue page's panel: quartiles and medians by outcome, without the values.
    const panel = await venueScoreStats(edition.id);
    expect(panel.map((f) => f.field)).toEqual(['rating', 'confidence']);
    expect(panel[0]).toMatchObject({ count: 3, q1: 3, median: 6, q3: 7, hidden: false });
    expect(panel[0].split.accepted).toMatchObject({ count: 1, median: 7 });
    expect(panel[0].split.rejected).toMatchObject({ count: 1, median: 3 });
    expect(panel[0].split.pending.counts.reduce((a, b) => a + b, 0)).toBe(1);
    expect((await venueScoreStats(series.id)).map((f) => f.venue.id)).toEqual([
      ICLR_2027,
      ICLR_2027,
      ICLR_2026,
      ICLR_2026,
    ]);

    const missing = await api('GET', `/pages/${enc('venue:iclr/2027')}/scores/${enc(ICLR_2027)}/soundness`);
    expect(missing.status).toBe(404);
    const paperScope = await api('GET', `/pages/${enc('openreview:forum1')}/scores`);
    expect(paperScope.status).toBe(422);
  });

  it('marks scopes when reviews change, recomputes them when due, and rebuilds', async () => {
    const { edition } = await venuePages();
    const paper = await submitted(ICLR_2027, null, [4]);
    await catchUp();
    const [state] = await getDb().select().from(scopeState).where(eq(scopeState.scopePageId, edition.id));
    expect(state).toMatchObject({ dueAt: null, dirtySince: null });
    expect(state.computedAt).not.toBeNull();

    // A new review: the reviews consumer marks the paper's scopes, due a few seconds on.
    const bot = await ensureBot(OPENREVIEW_BOT);
    await commitPage(
      paper,
      (await readHead(getDb(), paper))!,
      bot,
      [
        {
          path: noteFilePath('openreview', 'forum1', 'r9'),
          content: encodeReviewFile({
            schema: 'review/1',
            id: 'r9',
            replyTo: null,
            kind: 'review',
            invitation: 'Official_Review',
            signature: 'Reviewer 9',
            content: { rating: 8 },
            createdAt: '2026-11-03T00:00:00Z',
            url: 'https://openreview.net/forum?id=forum1&noteId=r9',
            license: 'CC-BY-4.0',
          }),
        },
      ],
      'Import',
    );
    expect(await runConsumer(reviewsConsumer, { retryNow: true })).toMatchObject({ status: 'caught-up' });
    const [marked] = await getDb().select().from(scopeState).where(eq(scopeState.scopePageId, edition.id));
    expect(marked.dueAt).not.toBeNull();
    expect(marked.changedAt.getTime()).toBeGreaterThan(state.changedAt.getTime());
    // Not due yet: nothing is done.
    expect((await recomputeDueScopes()).scopes).toBe(0);
    expect((await recomputeDueScopes({ all: true })).scopes).toBeGreaterThan(0);
    const rows = await getDb().select().from(scopeStats).where(eq(scopeStats.scopePageId, edition.id));
    expect(rows.find((r) => r.field === 'rating')?.values).toEqual([6]);

    // A rebuild empties and marks every scope; recomputing gives the same rows.
    await rebuildConsumer(scopeStatsConsumer);
    expect(await getDb().select().from(scopeStats)).toHaveLength(0);
    await catchUp();
    const again = await getDb().select().from(scopeStats).where(eq(scopeStats.scopePageId, edition.id));
    expect(again.find((r) => r.field === 'rating')?.values).toEqual([6]);
  });

  it('answers with an ETag and a 304, cached a minute', async () => {
    await venuePages();
    await submitted(ICLR_2027, 'accepted', [6]);
    await catchUp();
    const path = `/pages/${enc('venue:iclr/2027')}/scores`;
    const first = await get(path, scoresRoute);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('public, max-age=60');
    const etag = first.headers.get('etag')!;
    expect(etag).toMatch(/^"/);
    const second = await get(path, scoresRoute, { 'if-none-match': etag });
    expect(second.status).toBe(304);
  });

  it('withholds the numbers until decisions under plugins.venueStats.hideUntil = decisions', async () => {
    await venuePages();
    await submitted(ICLR_2027, null, [6]);
    await submitted(ICLR_2026, 'accepted', [5]);
    await catchUp();
    await saveSiteSettings('{ "plugins.venueStats.hideUntil": "decisions" }');

    const list = await api('GET', `/pages/${enc('venue:iclr')}/scores`);
    expect(list.body.hideUntil).toBe('decisions');
    const byVenue = Object.fromEntries(
      list.body.scores
        .filter((s: { field: string }) => s.field === 'rating')
        .map((s: { venue: { id: string }; hidden: boolean }) => [s.venue.id, s.hidden]),
    );
    expect(byVenue).toEqual({ [ICLR_2027]: true, [ICLR_2026]: false });
    const hidden = await api('GET', `/pages/${enc('venue:iclr')}/scores/${enc(ICLR_2027)}/rating`);
    expect(hidden.body).toMatchObject({ hidden: true, values: [], count: 1 });
    expect(hidden.body.bins.counts.every((n: number) => n === 0)).toBe(true);
    const shown = await api('GET', `/pages/${enc('venue:iclr')}/scores/${enc(ICLR_2026)}/rating`);
    expect(shown.body.values).toEqual([5]);
    // Nor are the scope's papers named on it.
    const marked = await api('GET', `/pages/${enc('venue:iclr')}/scores/${enc(ICLR_2027)}/rating?marks=true`);
    expect(marked.body).toMatchObject({ hidden: true, marks: [] });
  });

  it("names each venue's own page, and marks an org's papers by name on the venue's field", async () => {
    await venuePages();
    const ours = await submitted(ICLR_2027, 'accepted', [8, 6]); // 7
    await submitted(ICLR_2027, 'rejected', [3]);
    const alsoOurs = await submitted(ICLR_2027, null, ['5: marginally below', 6]); // 5.5
    await submitted(ICLR_2026, 'withdrawn', [10]);

    // An org whose domain is printed on page 1 of two of the papers.
    const bot = await ensureBot(ORGS_BOT);
    await grantBot(ORGS_BOT, 'org.json', { grantedBy: 'system', kind: 'org' });
    const org = await createPage('org', 'eth');
    await commitPage(
      org.id,
      org.head,
      bot,
      [{ path: 'org.json', content: JSON.stringify({ name: 'ETH Zurich', domains: ['ethz.ch'] }) }],
      'ETH',
    );
    for (const paperId of [ours, alsoOurs]) {
      const sha256 = paperId.replace(/-/g, '').padEnd(64, '0');
      await getDb()
        .update(pageCurrent)
        .set({ pdf: { sha256, bytes: 1, url: `https://example.org/${sha256}.pdf` } as never })
        .where(eq(pageCurrent.pageId, paperId));
      await getDb()
        .insert(pdfDocuments)
        .values({ sha256, url: `https://example.org/${sha256}.pdf`, emails: ['someone@inf.ethz.ch'] });
    }
    await syncDueAffiliations();
    await catchUp();

    // The org's list names the venue's own page, whose numbers are the whole venue's.
    const list = await api('GET', `/pages/${enc('org:eth')}/scores`);
    expect(list.status).toBe(200);
    const rating = list.body.scores.find((s: { field: string }) => s.field === 'rating');
    expect(rating).toMatchObject({
      count: 2,
      venue: {
        id: ICLR_2027,
        name: 'ICLR 2027',
        page: { kind: 'venue', identifier: 'venue:iclr/2027', name: 'ICLR 2027' },
      },
    });
    const whole = await api('GET', `/pages/${enc(rating.venue.page.identifier)}/scores/${enc(ICLR_2027)}/rating`);
    expect(whole.body.values).toEqual([3, 5.5, 7]);
    expect(whole.body.venue.page.identifier).toBe('venue:iclr/2027');
    expect(whole.body.marks).toBeUndefined();

    // The org's own submissions there, by name and mean, ascending, as its statistics take them.
    const marked = await api('GET', `/pages/${enc('org:eth')}/scores/${enc(ICLR_2027)}/rating?marks=true`);
    expect(marked.status).toBe(200);
    expect(marked.body.values).toEqual([5.5, 7]);
    expect(marked.body.marks).toEqual([
      {
        identifier: expect.stringMatching(/^openreview:/),
        address: expect.any(String),
        title: expect.any(String),
        mean: 5.5,
        outcome: 'pending',
      },
      {
        identifier: expect.stringMatching(/^openreview:/),
        address: expect.any(String),
        title: expect.any(String),
        mean: 7,
        outcome: 'accepted',
      },
    ]);
    expect(marked.body.marks.map((m: { mean: number }) => m.mean)).toEqual(marked.body.values);
    // On the edition, every submission is its own.
    const all = await api('GET', `/pages/${enc('venue:iclr/2027')}/scores/${enc(ICLR_2027)}/rating?marks=true`);
    expect(all.body.marks.map((m: { outcome: string }) => m.outcome)).toEqual(['rejected', 'pending', 'accepted']);
    expect((await api('GET', `/pages/${enc('org:eth')}/scores/${enc(ICLR_2027)}/rating?marks=yes`)).status).toBe(400);

    // Over the cap, no names.
    expect(await scopeScoreMarks(org.id, ICLR_2027, 'rating', MAX_MARKS + 1)).toBeNull();
    // A venue with no page of its own has `page: null`.
    await getDb().insert(venues).values({ id: 'openreview:TMLR', name: 'TMLR' }).onConflictDoNothing();
    expect((await venuePagesOf(['openreview:TMLR', ICLR_2026])).get(ICLR_2026)?.identifier).toBe('venue:iclr/2026');
    expect((await venuePagesOf(['openreview:TMLR'])).size).toBe(0);
  });
});

describe("a scope's papers in bulk (B)", () => {
  it('streams NDJSON with submissions, statuses and score vectors, gzipped, ETagged and in chunks', async () => {
    await venuePages();
    await submitted(ICLR_2027, 'accepted', [8, '6: marginally above']);
    await submitted(ICLR_2027, 'rejected', [3]);
    await submitted(ICLR_2026, 'withdrawn', [1]);
    await catchUp();

    const path = `/pages/${enc('venue:iclr')}/papers`;
    const res = await get(path, papersRoute);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-ndjson');
    const rows = Buffer.from(await res.arrayBuffer())
      .toString('utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(rows).toHaveLength(3);
    const first = rows.find((r) => r.title === 'Paper 1');
    expect(first).toMatchObject({ identifier: expect.any(String), year: 2027, address: expect.any(String) });
    expect(first.submissions).toHaveLength(1);
    expect(first.submissions[0]).toMatchObject({
      venue: { id: ICLR_2027, name: 'ICLR 2027' },
      externalId: 'forum1',
      status: 'accepted',
      decision: 'Accept (Poster)',
    });
    expect(first.submissions[0].reviews.map((r: { scores: object }) => r.scores)).toEqual([
      { rating: 8, confidence: 3 },
      { rating: 6, confidence: 3 },
    ]);
    expect(first.submissions[0].reviews[0]).toMatchObject({
      license: 'CC-BY-4.0',
      url: expect.stringMatching(/^https/),
    });

    // Fields: the papers alone.
    const bare = await get(`${path}?fields=`, papersRoute);
    const bareRow = JSON.parse(
      Buffer.from(await bare.arrayBuffer())
        .toString('utf8')
        .split('\n')[0],
    );
    expect(bareRow.submissions).toBeUndefined();
    expect((await api('GET', `${path}?fields=votes`)).status).toBe(400);

    // Gzipped for a client that takes it.
    const zipped = await get(path, papersRoute, { 'accept-encoding': 'gzip, br' });
    expect(zipped.headers.get('content-encoding')).toBe('gzip');
    expect(
      gunzipSync(Buffer.from(await zipped.arrayBuffer()))
        .toString('utf8')
        .trim()
        .split('\n'),
    ).toHaveLength(3);

    // ETag on the scope's last change: the same until something changes.
    const etag = res.headers.get('etag')!;
    expect((await get(path, papersRoute, { 'if-none-match': etag })).status).toBe(304);
    await submitted(ICLR_2027, null, [5]);
    await catchUp();
    expect((await get(path, papersRoute, { 'if-none-match': etag })).status).toBe(200);

    // In chunks, with the cursor for the next.
    const one = await get(`${path}?limit=3`, papersRoute);
    const cursor = one.headers.get('x-next-cursor');
    expect(cursor).toBeTruthy();
    const firstChunk = Buffer.from(await one.arrayBuffer())
      .toString('utf8')
      .trim()
      .split('\n');
    expect(firstChunk).toHaveLength(3);
    const two = await get(`${path}?limit=3&after=${cursor}`, papersRoute);
    expect(two.headers.get('x-next-cursor')).toBeNull();
    expect(
      Buffer.from(await two.arrayBuffer())
        .toString('utf8')
        .trim()
        .split('\n'),
    ).toHaveLength(1);
  });
});
