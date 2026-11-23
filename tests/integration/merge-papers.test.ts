import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { accounts, pageRevisions, papers } from '@/db/schema';
import { foldPages, mergePapers } from '@/server/merge-papers';
import { commitPage, SYSTEM_ACTOR } from '@/server/pages/commit';
import { readHead } from '@/server/pages/repo';
import { findPaper, savePaper } from '@/server/papers';
import { currentVersions, setVersions } from '@/server/versions';
import { api, closePool, resetDatabase, signUp } from './helpers';

const OLD = { scheme: 'openreview', value: 'Tzcj46FpZT' } as const;
const NEW = { scheme: 'openreview', value: 'yQYuOXhMDw' } as const;

async function paper(id: typeof OLD | typeof NEW, _year: number): Promise<string> {
  return savePaper({
    title: 'Concept Component Analysis',
    authors: [],
    abstract: 'We extract concepts from LLMs.',
    identifiers: [id],
    source: 'openreview',
    metadataLicense: 'CC0-1.0',
    abstractLicense: 'CC0-1.0',
  });
}

const version = (forum: string, label: string, date: string, status: 'rejected' | 'under_review') => ({
  label,
  kind: 'submitted' as const,
  date,
  submissions: [{ venue: label, status }],
  url: `https://openreview.net/forum?id=${forum}`,
  evidence: [`https://openreview.net/forum?id=${forum}`],
});

beforeEach(resetDatabase);
afterAll(closePool);

describe('merging papers', () => {
  it('folds the duplicate into the survivor, redirects it and closes it to edits', async () => {
    const oldId = await paper(OLD, 2026);
    const newId = await paper(NEW, 2027);
    const both = [
      version(OLD.value, 'ICLR 2026', '2025-09-19', 'rejected'),
      version(NEW.value, 'ICLR 2027', '2026-09-18', 'under_review'),
    ];
    for (const id of [oldId, newId]) {
      await setVersions(id, SYSTEM_ACTOR, { baseOid: await readHead(getDb(), id), versions: both });
    }
    // Something only the duplicate has: a workshop version someone added.
    const ada = await signUp('ada@ethz.ch');
    const added = await api('POST', '/pages/versions', {
      cookie: ada,
      body: {
        paper: OLD,
        baseOid: await readHead(getDb(), oldId),
        versions: [
          ...(await currentVersions(oldId)),
          {
            label: 'SPIGM @ ICML 2026',
            kind: 'submitted',
            date: '2026-04-29',
            submissions: [{ venue: 'SPIGM @ ICML 2026', status: 'accepted' }],
          },
        ],
      },
    });
    expect(added.status).toBe(200);

    const result = await mergePapers(
      { duplicateId: oldId, survivorId: newId, from: 'openreview:Tzcj46FpZT (ICLR 2026)' },
      SYSTEM_ACTOR,
    );
    expect(result.status).toBe('committed');

    const versions = await currentVersions(newId);
    expect(versions.map((v) => v.label)).toEqual(['ICLR 2026', 'SPIGM @ ICML 2026', 'ICLR 2027']);

    const [row] = await getDb().select().from(papers).where(eq(papers.id, oldId));
    expect(row?.mergedInto).toBe(newId);
    const found = await findPaper(OLD);
    expect(found).toMatchObject({ merged: true, paper: { id: newId } });

    const [last] = await getDb()
      .select({ summary: pageRevisions.summary })
      .from(pageRevisions)
      .where(eq(pageRevisions.pageId, newId))
      .orderBy(desc(pageRevisions.seq))
      .limit(1);
    expect(last?.summary).toMatch(
      /^Merge the page of openreview:Tzcj46FpZT \(ICLR 2026\) \(at [0-9a-f]{7}\) into this one$/,
    );

    await expect(
      commitPage(
        oldId,
        await readHead(getDb(), oldId),
        SYSTEM_ACTOR,
        [{ path: 'community/10-x.md', content: '# X\n' }],
        'x',
      ),
    ).rejects.toMatchObject({ code: 'paper_merged' });
    await expect(
      mergePapers({ duplicateId: oldId, survivorId: newId, from: 'again' }, SYSTEM_ACTOR),
    ).rejects.toMatchObject({ code: 'paper_merged' });
  });

  it("records the merge in the survivor's history even when nothing is folded", async () => {
    const oldId = await paper(OLD, 2026);
    const newId = await paper(NEW, 2027);
    const before = await readHead(getDb(), newId);
    const result = await mergePapers(
      { duplicateId: oldId, survivorId: newId, from: 'openreview:Tzcj46FpZT' },
      SYSTEM_ACTOR,
    );
    expect(result.status).toBe('committed');
    expect(await readHead(getDb(), newId)).not.toBe(before);
  });

  it('leaves the duplicate as it was when the fold cannot be committed', async () => {
    const oldId = await paper(OLD, 2026);
    const newId = await paper(NEW, 2027);
    const changes = foldPages(new Map(), new Map([['community/10-notes.md', 'Notes.\n']]), 'x');
    expect(changes).toEqual([{ path: 'community/10-notes.md', content: 'Notes.\n' }]);
    await commitPage(
      oldId,
      await readHead(getDb(), oldId),
      { kind: 'account', accountId: await adminId(), isAdmin: true },
      changes,
      'notes',
    );
    // The system may not write a community section, so this merge needs an admin.
    await expect(mergePapers({ duplicateId: oldId, survivorId: newId, from: 'x' }, SYSTEM_ACTOR)).rejects.toThrow();
    const [row] = await getDb().select().from(papers).where(eq(papers.id, oldId));
    expect(row?.mergedInto).toBeNull();
  });
});

describe('folding a page', () => {
  it("puts the duplicate's sections after the survivor's, saying where they came from, once", () => {
    const survivor = new Map([
      ['community/10-summary.md', '# Summary\nOurs.\n'],
      ['links/10-code.json', '{"label":"Code","url":"https://github.com/a/b"}\n'],
    ]);
    const duplicate = new Map([
      ['community/10-summary.md', '# Summary\nOurs.\n'],
      ['community/20-errata.md', '# Errata\nTheirs.\n'],
      ['links/10-code.json', '{"label":"Code","url":"https://github.com/c/d"}\n'],
      ['links/20-video.json', '{"label":"Video","url":"https://youtu.be/x"}\n'],
      ['thumbnail.json', '{}\n'],
    ]);
    expect(foldPages(survivor, duplicate, 'openreview:x')).toEqual([
      { path: 'links/10-code.json', content: '{\n  "label": "Code",\n  "url": "https://github.com/a/b"\n}\n' },
      { path: 'links/20-video.json', content: '{\n  "label": "Video",\n  "url": "https://youtu.be/x"\n}\n' },
      { path: 'community/20-errata.md', content: '# Errata\nTheirs.\n\n*From openreview:x, merged into this page.*\n' },
      { path: 'thumbnail.json', content: '{}\n' },
    ]);
  });
});

async function adminId(): Promise<string> {
  await signUp('root@ethz.ch');
  const [account] = await getDb().select({ id: accounts.id }).from(accounts);
  return account!.id;
}
