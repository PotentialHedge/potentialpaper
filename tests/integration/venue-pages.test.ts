import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { accounts, pageClaims, pageCurrent, venues } from '@/db/schema';
import { encodeReviewFile, submissionFilePath } from '@/lib/review-files';
import type { SubmissionStatus } from '@/lib/submissions';
import { ensureBot, grantBot, OPENREVIEW_BOT } from '@/server/bots';
import { runConsumer } from '@/server/consumers/run';
import { membersConsumer } from '@/server/page-members';
import { decidePageClaim, pendingPageClaims } from '@/server/page-claims';
import { rolesOf } from '@/server/pages/check';
import { commitPage, createPage } from '@/server/pages/commit';
import { findKeyedPage } from '@/server/pages/kinds';
import { readHead } from '@/server/pages/repo';
import { savePaper } from '@/server/papers';
import { reviewsConsumer } from '@/server/review-projection';
import {
  syncVenuePages,
  VENUES_BOT,
  venueChildren,
  venueDecisions,
  venuePapers,
  venueSiblings,
  venueStatusCounts,
} from '@/server/venue-pages';
import { api, closePool, resetDatabase, signUp } from './helpers';

/**
 * Venue pages (`handoffs/pages.md` Phase 2): the `venues` bot making series and edition pages from the venues the
 * import knows, an edition's submissions by status with filters, a series' editions, and organiser claims.
 */

beforeEach(resetDatabase);
afterAll(closePool);

const ICLR_2027 = 'openreview:ICLR.cc/2027/Conference';
const ICLR_2026 = 'openreview:ICLR.cc/2026/Conference';

async function knownVenue(id: string, name: string) {
  await getDb().insert(venues).values({ id, name }).onConflictDoNothing();
}

async function grantVenuesBot() {
  await ensureBot(VENUES_BOT);
  await grantBot(VENUES_BOT, 'venue.json', { grantedBy: 'system', kind: 'venue' });
}

async function venueFile(key: string) {
  const page = await findKeyedPage(getDb(), 'venue', key);
  if (!page) return null;
  const [row] = await getDb()
    .select({ kindFile: pageCurrent.kindFile })
    .from(pageCurrent)
    .where(eq(pageCurrent.pageId, page.id));
  return row?.kindFile ?? null;
}

let papers = 0;
async function submitted(
  venue: string,
  status: SubmissionStatus,
  decision: string | null,
  title = `Paper ${papers + 1}`,
) {
  papers += 1;
  const forum = `forum${papers}`;
  const paperId = await savePaper({
    title,
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
          venue: { id, name: id.startsWith('ICLR.cc/2027') ? 'ICLR 2027' : 'ICLR 2026', url: null },
          number: papers,
          status,
          decision,
          url: `https://openreview.net/forum?id=${forum}`,
          license: 'CC-BY-4.0',
        }),
      },
    ],
    'Import',
  );
  return paperId;
}

async function catchUp() {
  for (const consumer of [reviewsConsumer, membersConsumer]) {
    expect(await runConsumer(consumer, { retryNow: true })).toMatchObject({ status: 'caught-up' });
  }
}

let people = 0;
async function verifiedAccount() {
  people += 1;
  const cookie = await signUp(`organiser${people}@ethz.ch`);
  const me = await api('GET', '/me', { cookie });
  const [account] = await getDb().select().from(accounts).where(eq(accounts.id, me.body.id));
  return { cookie, account, actor: { kind: 'account', accountId: account.id, isAdmin: false } as const };
}

describe('the venues bot', () => {
  it("makes a series' and an edition's pages from the venues the import knows, once", async () => {
    await grantVenuesBot();
    await knownVenue(ICLR_2027, 'ICLR 2027');
    await knownVenue(ICLR_2026, 'ICLR 2026');
    await knownVenue('openreview:ICLR.cc/2026/Workshop/GenAI', 'GenAI Workshop');
    await knownVenue('openreview:TMLR', 'TMLR');

    const report = await syncVenuePages();
    expect(report.written.sort()).toEqual(['iclr', 'iclr/2026', 'iclr/2027']);
    expect(report.skipped.sort()).toEqual(['openreview:ICLR.cc/2026/Workshop/GenAI', 'openreview:TMLR']);
    expect(await venueFile('iclr')).toEqual({ name: 'ICLR' });
    expect(await venueFile('iclr/2027')).toEqual({ name: 'ICLR 2027', sources: [ICLR_2027] });

    // A second run writes nothing.
    expect((await syncVenuePages()).written).toEqual([]);
  });

  it("never rewrites what someone else wrote, and only adds a source that's missing", async () => {
    await grantVenuesBot();
    const page = await createPage('venue', 'iclr/2027');
    // An admin's edit, as any admin's account.
    const admin = await verifiedAccount();
    await commitPage(
      page.id,
      await readHead(getDb(), page.id),
      { ...admin.actor, isAdmin: true },
      [{ path: 'venue.json', content: '{ "name": "ICLR 2027 (Rio)", "url": "https://iclr.cc" }\n' }],
      'Admin',
    );
    expect(await syncVenuePages({ venues: [{ id: ICLR_2027, name: 'ICLR 2027' }] })).toMatchObject({
      written: ['iclr', 'iclr/2027'],
    });
    expect(await venueFile('iclr/2027')).toEqual({
      name: 'ICLR 2027 (Rio)',
      url: 'https://iclr.cc',
      sources: [ICLR_2027],
    });
  });

  it('is refused without its grant', async () => {
    await ensureBot(VENUES_BOT);
    await expect(syncVenuePages({ venues: [{ id: ICLR_2027, name: 'ICLR 2027' }] })).rejects.toThrow(/venue\.json/);
  });
});

describe("a venue's pages", () => {
  it("list an edition's submissions by status, with filters, and roll them up into the series", async () => {
    await grantVenuesBot();
    await syncVenuePages({
      venues: [
        { id: ICLR_2027, name: 'ICLR 2027' },
        { id: ICLR_2026, name: 'ICLR 2026' },
      ],
    });
    await submitted(ICLR_2027, 'rejected', 'Reject', 'Rejected work');
    await submitted(ICLR_2027, 'accepted', 'Accept (Poster)', 'Linear attention, again');
    await submitted(ICLR_2027, 'accepted', 'Accept (Oral)', 'State spaces');
    await submitted(ICLR_2027, 'withdrawn', null, 'Withdrawn work');
    await submitted(ICLR_2026, 'accepted', 'Accept (Poster)', 'Older work');
    await catchUp();

    const edition = (await findKeyedPage(getDb(), 'venue', 'iclr/2027'))!;
    const series = (await findKeyedPage(getDb(), 'venue', 'iclr'))!;

    expect(await venueStatusCounts(edition.id)).toEqual({ total: 4, accepted: 2, rejected: 1, withdrawn: 1 });
    const all = await venuePapers(edition.id);
    expect(all.total).toBe(4);
    // Accepted first, then by number.
    expect(all.papers.map((p) => [p.title, p.status])).toEqual([
      ['Linear attention, again', 'accepted'],
      ['State spaces', 'accepted'],
      ['Rejected work', 'rejected'],
      ['Withdrawn work', 'withdrawn'],
    ]);
    expect(all.papers[0].venue).toBeNull();
    expect((await venuePapers(edition.id, { status: 'accepted', decision: 'Accept (Oral)' })).papers).toMatchObject([
      { title: 'State spaces' },
    ]);
    expect((await venuePapers(edition.id, { q: 'linear' })).papers.map((p) => p.title)).toEqual([
      'Linear attention, again',
    ]);
    expect((await venuePapers(edition.id, { q: '100%_' })).total).toBe(0);
    expect((await venuePapers(edition.id, { limit: 3 })).nextOffset).toBe(3);
    expect(await venueDecisions(edition.id)).toEqual([
      { decision: 'Accept (Oral)', count: 1 },
      { decision: 'Accept (Poster)', count: 1 },
      { decision: 'Reject', count: 1 },
    ]);

    // The series rolls its editions up, each paper marked with its edition.
    expect(await venueStatusCounts(series.id)).toMatchObject({ total: 5, accepted: 3 });
    const rolled = await venuePapers(series.id, { status: 'accepted' });
    expect(rolled.papers.map((p) => [p.title, p.venue?.key])).toEqual(
      expect.arrayContaining([['Older work', 'iclr/2026']]),
    );
    const editions = await venueChildren(series);
    expect(editions.map((e) => [e.key, e.name, e.counts.total])).toEqual([
      ['iclr/2027', 'ICLR 2027', 4],
      ['iclr/2026', 'ICLR 2026', 1],
    ]);
    expect((await venueSiblings(edition))?.parent).toEqual({ key: 'iclr', name: 'ICLR' });

    // The public route gives the same, by identifier.
    const route = await api('GET', `/pages/${encodeURIComponent('venue:iclr/2027')}/venue-papers?status=accepted`);
    expect(route.status).toBe(200);
    expect(route.body.total).toBe(2);
    expect(route.body.papers[0]).toMatchObject({
      title: 'Linear attention, again',
      identifier: 'openreview:forum2',
      address: '/openreview/forum2',
      decision: 'Accept (Poster)',
    });
    const onSeries = await api('GET', `/pages/${encodeURIComponent('venue:iclr')}/venue-papers?q=older`);
    expect(onSeries.body.papers[0].venue).toEqual({
      identifier: 'venue:iclr/2026',
      address: '/v/iclr/2026',
      name: 'ICLR 2026',
    });
    expect((await api('GET', `/pages/${encodeURIComponent('venue:iclr')}/venue-papers?status=nope`)).status).toBe(400);
  });
});

describe('organiser claims', () => {
  it('wait for an admin, then let the organiser write organizers/ and venue.json, on the editions too', async () => {
    const series = await createPage('venue', 'iclr');
    const edition = await createPage('venue', 'iclr/2027');
    const ada = await verifiedAccount();
    const bob = await verifiedAccount();
    const seriesId = encodeURIComponent('venue:iclr');

    // Saying nothing is no claim.
    expect(
      (await api('POST', `/pages/${seriesId}/claim`, { cookie: ada.cookie, body: { evidence: ' ' } })).status,
    ).toBe(422);
    const sent = await api('POST', `/pages/${seriesId}/claim`, {
      cookie: ada.cookie,
      body: { evidence: 'Programme chair, named on https://iclr.cc/about' },
    });
    expect(sent.status).toBe(201);
    expect(sent.body.claim).toEqual({
      status: 'pending',
      evidence: 'Programme chair, named on https://iclr.cc/about',
      inherited: false,
    });
    expect((await api('GET', `/pages/${seriesId}/claim`, { cookie: ada.cookie })).body.claim.status).toBe('pending');

    // Pending grants nothing.
    const write = (pageId: string, head: string | null, actor = ada.actor) =>
      commitPage(
        pageId,
        head,
        actor,
        [{ path: 'organizers/10-welcome.md', content: '# Welcome\nCall for papers is out.\n' }],
        'Welcome',
      );
    await expect(write(series.id, series.head)).rejects.toMatchObject({ status: 403 });

    const [pending] = await pendingPageClaims();
    expect(pending).toMatchObject({ identifier: 'venue:iclr', handle: ada.account.handle });
    await decidePageClaim(pending.id, 'confirmed', null);

    expect(await rolesOf(getDb(), ada.actor, series.id)).toMatchObject({ owner: true, claimed: true });
    // A series' organiser organises its editions.
    expect(await rolesOf(getDb(), ada.actor, edition.id)).toMatchObject({ owner: true, claimed: true });
    expect(await rolesOf(getDb(), bob.actor, edition.id)).toMatchObject({ owner: false, claimed: true });
    expect(
      (await api('GET', `/pages/${encodeURIComponent('venue:iclr/2027')}/claim`, { cookie: ada.cookie })).body,
    ).toEqual({ claim: { status: 'confirmed', evidence: '', inherited: true } });

    expect(await write(edition.id, edition.head)).toMatchObject({ status: 'committed' });
    expect(
      await commitPage(
        edition.id,
        await readHead(getDb(), edition.id),
        ada.actor,
        [{ path: 'venue.json', content: '{ "name": "ICLR 2027", "dates": { "start": "2027-04-24" } }\n' }],
        'Dates',
      ),
    ).toMatchObject({ status: 'committed' });
    // Anyone else verified writes community/, not organizers/.
    await expect(write(edition.id, await readHead(getDb(), edition.id), bob.actor)).rejects.toMatchObject({
      status: 403,
    });

    // Stepping down takes it back.
    expect((await api('DELETE', `/pages/${seriesId}/claim`, { cookie: ada.cookie })).status).toBe(200);
    expect(await rolesOf(getDb(), ada.actor, edition.id)).toMatchObject({ owner: false, claimed: false });
  });

  it('are only for venues, by verified accounts, and a rejection stays', async () => {
    await createPage('topic', 'linear-attention');
    const page = await createPage('venue', 'neurips/2027');
    const ada = await verifiedAccount();
    expect(
      (
        await api('POST', `/pages/${encodeURIComponent('topic:linear-attention')}/claim`, {
          cookie: ada.cookie,
          body: { evidence: 'me' },
        })
      ).status,
    ).toBe(422);
    const id = encodeURIComponent('venue:neurips/2027');
    expect((await api('POST', `/pages/${id}/claim`, { body: { evidence: 'me' } })).status).toBe(401);
    await api('POST', `/pages/${id}/claim`, { cookie: ada.cookie, body: { evidence: 'General chair' } });
    const [claim] = await getDb().select().from(pageClaims).where(eq(pageClaims.pageId, page.id));
    await decidePageClaim(claim.id, 'rejected', null);
    const again = await api('POST', `/pages/${id}/claim`, { cookie: ada.cookie, body: { evidence: 'Really' } });
    expect(again.status).toBe(409);
    expect((await api('DELETE', `/pages/${id}/claim`, { cookie: ada.cookie })).status).toBe(404);
  });
});
