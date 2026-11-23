import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { accounts, pageCurrent, papers, venues } from '@/db/schema';
import { runConsumer } from '@/server/consumers/run';
import { CONSUMERS } from '@/server/consumers';
import { commitPage } from '@/server/pages/commit';
import { findKeyedPage } from '@/server/pages/kinds';
import { readHead } from '@/server/pages/repo';
import { savePaper } from '@/server/papers';
import { setVersions, versionsAt } from '@/server/versions';
import { venueNamesConsumer } from '@/server/venue-names';
import { closePool, resetDatabase, venueWithForms } from './helpers';

/**
 * A venue's name and forms are kept once, on its page (layout 7): the `venues` table is the page's projection, and a
 * paper's version naming the page shows its name, written again when the name changes.
 */

beforeEach(resetDatabase);
afterAll(closePool);

const SOURCE = 'openreview:ICLR.cc/2027/Conference';
const FORMS = { Official_Review: { label: 'Official review', fields: [{ key: 'rating', label: 'Rating' }] } };

async function people() {
  const [person] = await getDb().insert(accounts).values({ handle: 'a-person', verifiedAt: new Date() }).returning();
  return {
    person: { kind: 'account' as const, accountId: person.id, isAdmin: false },
    admin: { kind: 'account' as const, accountId: person.id, isAdmin: true },
  };
}

async function paper() {
  return savePaper({
    title: 'Sparse routing',
    authors: ['A. Author'],
    abstract: null,
    source: 'arxiv',
    metadataLicense: 'CC0-1.0',
    abstractLicense: null,
    identifiers: [{ scheme: 'arxiv', value: '2701.00002' }],
  });
}

describe("a venue's page", () => {
  it('is what the venues table says: its name, its source page and its forms', async () => {
    await venueWithForms(SOURCE, 'ICLR 2027', FORMS);
    const [row] = await getDb().select().from(venues).where(eq(venues.id, SOURCE));
    expect(row).toMatchObject({
      name: 'ICLR 2027',
      url: 'https://openreview.net/group?id=ICLR.cc%2F2027%2FConference',
      forms: FORMS,
    });

    // Renamed by an admin: the row follows in the same commit.
    const { admin } = await people();
    const edition = (await findKeyedPage(getDb(), 'venue', 'iclr/2027'))!;
    await commitPage(
      edition.id,
      await readHead(getDb(), edition.id),
      admin,
      [{ path: 'venue.json', content: JSON.stringify({ name: 'ICLR 2027 (Rio)', sources: [SOURCE] }) }],
      'Rename',
    );
    const [renamed] = await getDb().select().from(venues).where(eq(venues.id, SOURCE));
    expect(renamed).toMatchObject({ name: 'ICLR 2027 (Rio)', forms: FORMS });
  });

  it("names a paper's submission, which shows the page's name and follows it", async () => {
    await venueWithForms(SOURCE, 'ICLR 2027', FORMS);
    const { person, admin } = await people();
    const id = await paper();
    const edit = (page: string) => ({
      baseOid: null,
      versions: [
        {
          label: 'Conference version',
          kind: 'camera-ready' as const,
          date: '2027-04-01',
          submissions: [{ page, status: 'accepted' as const }],
        },
      ],
      evidence: ['https://e.org'],
    });

    // A page that isn't a venue's is refused.
    await expect(setVersions(id, person, edit('iclr/2099'))).rejects.toMatchObject({
      status: 422,
      message: expect.stringMatching(/no venue page iclr\/2099/),
    });

    await setVersions(id, person, edit('iclr/2027'));
    // The file names the page; what the page shows has its name.
    const { versions } = await versionsAt(id);
    expect(versions[0].submissions).toEqual([{ page: 'iclr/2027', status: 'accepted' }]);
    const shown = async () => {
      const [row] = await getDb()
        .select({ versions: pageCurrent.versions })
        .from(pageCurrent)
        .where(eq(pageCurrent.pageId, id));
      const [listed] = await getDb().select({ venue: papers.venue }).from(papers).where(eq(papers.id, id));
      return { entry: row.versions![0].submissions![0], venue: listed.venue };
    };
    expect(await shown()).toEqual({
      entry: { page: 'iclr/2027', venue: 'ICLR 2027', status: 'accepted' },
      venue: 'ICLR 2027',
    });

    // Sent back as read (with the name), the file still names only the page.
    const [row] = await getDb()
      .select({ versions: pageCurrent.versions })
      .from(pageCurrent)
      .where(eq(pageCurrent.pageId, id));
    await setVersions(id, person, {
      baseOid: await readHead(getDb(), id),
      versions: [{ ...row.versions![0], note: 'Final.' }],
      evidence: ['https://e.org'],
    });
    expect((await versionsAt(id)).versions[0].submissions).toEqual([{ page: 'iclr/2027', status: 'accepted' }]);

    // The venue is renamed: once the consumer has run, the paper shows the new name.
    const edition = (await findKeyedPage(getDb(), 'venue', 'iclr/2027'))!;
    await commitPage(
      edition.id,
      await readHead(getDb(), edition.id),
      admin,
      [{ path: 'venue.json', content: JSON.stringify({ name: 'ICLR 2027 (Rio)', sources: [SOURCE] }) }],
      'Rename',
    );
    expect((await shown()).venue).toBe('ICLR 2027');
    expect(CONSUMERS).toContain(venueNamesConsumer);
    expect(await runConsumer(venueNamesConsumer, { retryNow: true })).toMatchObject({ status: 'caught-up' });
    expect(await shown()).toEqual({
      entry: { page: 'iclr/2027', venue: 'ICLR 2027 (Rio)', status: 'accepted' },
      venue: 'ICLR 2027 (Rio)',
    });
  });
  it("takes a site that is one of the venue page's locations, and refuses one that isn't", async () => {
    await venueWithForms(SOURCE, 'ICLR 2027', FORMS);
    const { person, admin } = await people();
    const edition = (await findKeyedPage(getDb(), 'venue', 'iclr/2027'))!;
    const locate = async (locations: string[]) =>
      commitPage(
        edition.id,
        await readHead(getDb(), edition.id),
        admin,
        [{ path: 'venue.json', content: JSON.stringify({ name: 'ICLR 2027', sources: [SOURCE], locations }) }],
        'Locations',
      );
    await locate(['Rio de Janeiro, Brazil', 'Singapore']);
    const id = await paper();
    const edit = async (site: string, note?: string) =>
      setVersions(id, person, {
        baseOid: await readHead(getDb(), id),
        versions: [
          {
            label: 'Conference version',
            kind: 'camera-ready' as const,
            ...(note ? { note } : {}),
            submissions: [{ page: 'iclr/2027', status: 'accepted' as const, site }],
          },
        ],
        evidence: ['https://e.org'],
      });
    const shownSite = async () => {
      const [row] = await getDb()
        .select({ versions: pageCurrent.versions })
        .from(pageCurrent)
        .where(eq(pageCurrent.pageId, id));
      return row.versions![0].submissions![0].site;
    };

    await expect(edit('Lisbon')).rejects.toMatchObject({
      status: 422,
      message: expect.stringMatching(
        /the site "Lisbon" is not one of iclr\/2027's locations; give one of "Rio de Janeiro, Brazil", "Rio de Janeiro", "Singapore"/,
      ),
    });
    // The full location, in any case: shown in its short form.
    await edit('rio de janeiro, brazil');
    expect((await versionsAt(id)).versions[0].submissions![0].site).toBe('rio de janeiro, brazil');
    expect(await shownSite()).toBe('Rio de Janeiro');

    // The venue's locations change: its commit isn't refused, the paper shows its site as written, and an edit that
    // leaves the entry as it was isn't refused either.
    await locate(['Singapore']);
    await edit('rio de janeiro, brazil', 'Final.');
    expect(await shownSite()).toBe('rio de janeiro, brazil');
    await expect(edit('Rio de Janeiro')).rejects.toMatchObject({ status: 422 });
  });
});
