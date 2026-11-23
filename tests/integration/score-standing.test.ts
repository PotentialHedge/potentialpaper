import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { eq } from 'drizzle-orm';
import { accounts, pageCurrent, pdfDocuments } from '@/db/schema';
import { panelSlot, validateManifest, type PluginManifest } from '@/lib/plugins/manifest';
import { pageWhenContext, whenHolds } from '@/lib/plugins/when';
import { PAGE_KINDS, type PageKind } from '@/lib/kinds';
import { encodeReviewFile, noteFilePath, submissionFilePath, type NoteFile } from '@/lib/review-files';
import { ensureBot, grantBot, OPENREVIEW_BOT } from '@/server/bots';
import { CONSUMERS } from '@/server/consumers';
import { runConsumer } from '@/server/consumers/run';
import { syncDueAffiliations } from '@/server/page-members';
import { commitPage, createPage } from '@/server/pages/commit';
import { savePaper } from '@/server/papers';
import { servePlugin } from '@/server/plugins/serve';
import { pluginHostLabel } from '@/server/plugins/snapshot';
import { recomputeDueScopes } from '@/server/scope-stats';
import { api, closePool, resetDatabase, signUp, submittedVersion, venueWithForms } from './helpers';

/**
 * Score standing (`handoffs/plugins.md` Phase 6), the first plugin outside this repo, installed from GitHub as any
 * reader would install it: its newest release, copied at its commit, its manifest checked by the host, its built
 * files served from its own origin. Then where its panel shows (`page.hasScores` on papers and venues, never on
 * categories, and on organisations with scored papers), and that the data it reads has the shape it reads, the org view's
 * included (the venue's own page and the org's papers by name).
 *
 * It talks to GitHub, so it runs only with `PLUGIN_NETWORK_TESTS=1`:
 *
 *     PLUGIN_NETWORK_TESTS=1 npx vitest run tests/integration/score-standing.test.ts
 */

const NETWORK = process.env.PLUGIN_NETWORK_TESTS === '1';
const SOURCE = 'github:benedict-armstrong/potentialpaper-score-standing';
const PLUGIN_ID = 'benedict-armstrong/score-standing';
const VENUE = 'ICLR.cc/2027/Conference';

let store: string;
beforeAll(() => {
  store = mkdtempSync(join(tmpdir(), 'plugin-store-'));
  process.env.DEMOS_DIR = store;
});
afterAll(async () => {
  rmSync(store, { recursive: true, force: true });
  await closePool();
});
beforeEach(resetDatabase);

async function catchUp() {
  await syncDueAffiliations();
  for (const consumer of CONSUMERS) {
    expect(await runConsumer(consumer, { retryNow: true })).toMatchObject({ status: 'caught-up' });
  }
  await recomputeDueScopes({ all: true });
}

/** A paper at ICLR 2027 with its reviews' ratings and soundness, and its decision. */
async function submitted(
  arxiv: string,
  forum: string,
  status: 'accepted' | 'rejected',
  ratings: number[],
): Promise<string> {
  const paper = await savePaper({
    title: `Paper ${arxiv}`,
    authors: ['A. Author'],
    abstract: 'An abstract.',
    source: 'arxiv',
    metadataLicense: 'CC0-1.0',
    abstractLicense: null,
    identifiers: [{ scheme: 'arxiv', value: arxiv }],
  });
  const bot = await ensureBot(OPENREVIEW_BOT);
  const license = 'CC-BY-4.0';
  await venueWithForms(`openreview:${VENUE}`, 'ICLR 2027', {
    Official_Review: {
      label: 'Official review',
      summary: ['rating'],
      fields: [
        { key: 'soundness', label: 'Soundness', type: 'score', min: 1, max: 4 },
        { key: 'rating', label: 'Rating', type: 'score', min: 1, max: 10 },
      ],
    },
  });
  await commitPage(
    paper,
    null,
    bot,
    [
      {
        path: submissionFilePath('openreview', forum),
        content: encodeReviewFile({
          schema: 'submission/2',
          id: forum,
          venue: { id: VENUE },
          number: 1,
          url: `https://openreview.net/forum?id=${forum}`,
          license,
        }),
      },
      submittedVersion(forum, 'ICLR 2027', status, status === 'accepted' ? 'Accept (poster)' : 'Reject'),
      ...ratings.map((rating, i) => ({
        path: noteFilePath('openreview', forum, `${forum}r${i}`),
        content: encodeReviewFile({
          schema: 'review/1',
          id: `${forum}r${i}`,
          replyTo: null,
          kind: 'review',
          invitation: 'Official_Review',
          signature: `Reviewer ${i}`,
          content: { rating: `${rating}: a reason`, soundness: 3 },
          createdAt: '2026-11-01T12:00:00.000Z',
          url: `https://openreview.net/forum?id=${forum}&noteId=${forum}r${i}`,
          license,
        } satisfies NoteFile),
      })),
    ],
    'Import',
  );
  return paper;
}

/** Puts a PDF with these addresses on page 1 on the paper, as the ingest pipeline leaves it. */
async function printAddresses(paperId: string, emails: string[]) {
  const sha256 = paperId.replace(/-/g, '').padEnd(64, '0');
  await getDb()
    .update(pageCurrent)
    .set({ pdf: { sha256, bytes: 1, url: `https://example.org/${sha256}.pdf` } as never })
    .where(eq(pageCurrent.pageId, paperId));
  await getDb()
    .insert(pdfDocuments)
    .values({ sha256, url: `https://example.org/${sha256}.pdf`, emails });
}

describe.skipIf(!NETWORK)('score standing, installed from GitHub', () => {
  it('installs its newest release, serves its built files, and shows on papers and venues with scores', async () => {
    const [admin] = await getDb().insert(accounts).values({ handle: 'admin', verifiedAt: new Date() }).returning();
    const actor = { kind: 'account' as const, accountId: admin.id, isAdmin: true };
    await ensureBot(OPENREVIEW_BOT);
    await grantBot(OPENREVIEW_BOT, 'reviews/openreview/**', { grantedBy: 'system' });
    await createPage('venue', 'iclr');
    const edition = await createPage('venue', 'iclr/2027');
    await commitPage(
      edition.id,
      edition.head,
      actor,
      [{ path: 'venue.json', content: JSON.stringify({ name: 'ICLR 2027', sources: [`openreview:${VENUE}`] }) }],
      'Venue',
    );
    await createPage('category', 'linear-attention');
    const eth = await createPage('org', 'eth');
    await commitPage(
      eth.id,
      eth.head,
      actor,
      [{ path: 'org.json', content: JSON.stringify({ name: 'ETH Zurich', domains: ['ethz.ch'] }) }],
      'Org',
    );
    await createPage('org', 'empty');
    const first = await submitted('2701.00001', 'f1', 'accepted', [8, 6, 8]);
    await submitted('2701.00002', 'f2', 'rejected', [3, 5, 3]);
    const third = await submitted('2701.00003', 'f3', 'rejected', [5, 5, 6, 3]);
    // Two of the three print an ETH address on page 1: they are ETH's papers.
    await printAddresses(first, ['a@inf.ethz.ch']);
    await printAddresses(third, ['b@ethz.ch']);
    await catchUp();

    // Installing with no ref takes the newest release; it asks for its two permissions.
    const cookie = await signUp('ada@ethz.ch');
    const res = await api('POST', '/me/plugins', { cookie, body: { source: SOURCE } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      source: SOURCE,
      status: 'consent',
      plugin: { id: PLUGIN_ID, manifest: { name: 'Score standing', main: 'dist/index.html' } },
      missing: { permissions: expect.arrayContaining(['reviews.read', 'scope.read']), network: [] },
    });
    expect(res.body.ref).toMatch(/^v\d+\.\d+\.\d+$/);
    const manifest = res.body.plugin.manifest as PluginManifest;
    expect(validateManifest(manifest)).toMatchObject({ errors: [], warnings: [] });
    const commit = res.body.plugin.commit as string;
    expect((await api('PUT', '/me/plugins/grants', { cookie, body: { plugin: PLUGIN_ID, commit } })).status).toBe(200);
    expect((await api('GET', '/plugins/installed', { cookie })).body.plugins).toMatchObject([
      { status: 'ready', plugin: { id: PLUGIN_ID } },
    ]);

    // Its settings resolve with their defaults, and a wrong value is refused like the site's own.
    expect((await api('GET', '/me/settings', { cookie })).body.values).toMatchObject({
      [`${PLUGIN_ID}.view`]: 'both',
      [`${PLUGIN_ID}.field`]: '',
      [`${PLUGIN_ID}.splitByDecision`]: 'auto',
    });
    const bad = await api('PUT', '/me/settings', { cookie, text: `{ "${PLUGIN_ID}.view": "pie" }` });
    expect(bad.status).toBe(422);

    // Its built files, from its own origin: the page, its script and style, and none of its sources.
    const label = pluginHostLabel(PLUGIN_ID);
    const base = res.body.plugin.baseUrl as string;
    const get = (path: string) => servePlugin(new Request(`${base}${path}`), label);
    const page = await get('dist/index.html');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toMatch(
      /script-src 'self' [^;]*https:\/\/ppusercontent\.com\/sdk\//,
    );
    const html = await page.text();
    expect(html).toContain('<script src="https://ppusercontent.com/sdk/v1/pp.js"></script>');
    const script = /src="\.\/(assets\/[^"]+\.js)"/.exec(html)?.[1];
    const style = /href="\.\/(assets\/[^"]+\.css)"/.exec(html)?.[1];
    expect((await get(`dist/${script}`)).headers.get('content-type')).toMatch(/^text\/javascript/);
    const css = await get(`dist/${style}`);
    expect(css.status).toBe(200);
    // v0.2.0 and later: the org view's open circles.
    expect(await css.text()).toContain('.mark');
    expect((await get('src/main.ts')).status).toBe(404);

    // Where its panel shows: the browser decides from the page's kind and facts, as here.
    const [panel] = manifest.contributes.panels;
    const shows = async (identifier: string) => {
      const summary = (await api('GET', `/pages/${encodeURIComponent(identifier)}`)).body;
      const kind = summary.kind as PageKind;
      const slot = panelSlot(panel, kind);
      const context = pageWhenContext(kind, { ...summary.facts, signedIn: true, isOwner: false });
      return slot && whenHolds(panel.when, context) ? slot : null;
    };
    expect(PAGE_KINDS.filter((k) => panelSlot(panel, k))).toEqual(['paper', 'venue', 'org']);
    // v0.3.0 and later: under each of the paper's submissions with scores.
    expect(await shows('arxiv:2701.00001')).toBe('submission');
    expect(await shows('venue:iclr/2027')).toBe('main');
    expect(await shows('venue:iclr')).toBe('main');
    expect(await shows('category:linear-attention')).toBeNull();
    // An organisation with scored papers shows it; one without stays quiet.
    expect(await shows('org:eth')).toBe('main');
    expect(await shows('org:empty')).toBeNull();

    // The data it reads: the paper's venue page lists the venue its submission names, rating first, and the field
    // gives sorted means, split by outcome, with decisions out.
    const paperPage = (await api('GET', `/pages/${encodeURIComponent('arxiv:2701.00001')}`)).body;
    const venuePage = paperPage.scopes.find((s: { kind: string }) => s.kind === 'venue');
    const list = (await api('GET', `/pages/${encodeURIComponent(venuePage.identifier)}/scores`)).body;
    const submission = (await api('GET', `/pages/${encodeURIComponent('arxiv:2701.00001')}/submissions`)).body
      .submissions[0];
    expect(list.scores.map((s: { field: string }) => s.field)).toEqual(['rating', 'soundness']);
    expect(list.scores[0].venue.id).toBe(submission.venue.id);
    const field = (
      await api(
        'GET',
        `/pages/${encodeURIComponent(venuePage.identifier)}/scores/${encodeURIComponent(submission.venue.id)}/rating`,
      )
    ).body;
    expect(field).toMatchObject({
      values: [11 / 3, 4.75, 22 / 3].map((v) => expect.closeTo(v, 9)),
      decisionsOut: true,
      split: { accepted: { count: 1 }, rejected: { count: 2 } },
      bins: { lo: 1, hi: 10 },
    });

    // The org view: the org's list names the venue's own page, which gives the whole distribution, and the org's
    // field with marks names its two papers with their means, ascending.
    const orgList = (await api('GET', `/pages/${encodeURIComponent('org:eth')}/scores`)).body;
    const orgRating = orgList.scores.find((s: { field: string }) => s.field === 'rating');
    expect(orgRating).toMatchObject({
      count: 2,
      venue: { id: submission.venue.id, page: { identifier: 'venue:iclr/2027' } },
    });
    const whole = (
      await api(
        'GET',
        `/pages/${encodeURIComponent(orgRating.venue.page.identifier)}/scores/${encodeURIComponent(submission.venue.id)}/rating`,
      )
    ).body;
    expect(whole.values).toEqual(field.values);
    const marked = (
      await api(
        'GET',
        `/pages/${encodeURIComponent('org:eth')}/scores/${encodeURIComponent(submission.venue.id)}/rating?marks=true`,
      )
    ).body;
    expect(marked.marks).toEqual([
      {
        identifier: 'arxiv:2701.00003',
        address: '/abs/2701.00003',
        title: 'Paper 2701.00003',
        mean: 4.75,
        outcome: 'rejected',
      },
      {
        identifier: 'arxiv:2701.00001',
        address: '/abs/2701.00001',
        title: 'Paper 2701.00001',
        mean: expect.closeTo(22 / 3, 9),
        outcome: 'accepted',
      },
    ]);
  });
});
