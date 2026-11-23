import { encodeVersionFile } from '@/lib/versions';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { asc, eq, sql } from 'drizzle-orm';
import fc from 'fast-check';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { starterFiles } from '@/server/pages/starter';
import * as gitRoute from '@/app/git/[...path]/route';
import { getDb } from '@/db';
import {
  accounts,
  authorClaims,
  commitIdentities,
  pageCurrent,
  pageEvents,
  pageObjects,
  pageRefs,
  pageRevisions,
  paperIdentifiers,
  papers,
  pdfDocuments,
} from '@/db/schema';
import { ApiError } from '@/server/api/errors';
import { answerGitRequest, clonePath } from '@/server/pages/clone';
import { type Actor, commitPage, type FileChange, moveHead, revertCommit, SYSTEM_ACTOR } from '@/server/pages/commit';
import { looseObject } from '@/server/pages/git-objects';
import { mergeFile } from '@/server/pages/merge';
import { rebuildAllPages } from '@/server/pages/projections';
import { diffCommits, pageHistory, readHead } from '@/server/pages/repo';
import { encodeLfsPointer, LAYOUT_VERSION, MAX_CHANGES, THUMBNAIL_PATH } from '@/server/pages/rules';
import { recordLfsObject } from '@/server/lfs';
import { savePaper } from '@/server/papers';
import { searchPapers } from '@/server/search';
import { closePool, resetDatabase } from './helpers';

/** The paths a paper's first commit has besides its own: the metadata, `paper.json`, `.gitattributes` and the starter files. */
const byBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const STARTER_PATHS = starterFiles().map(([path]) => path);
const firstPaths = (...own: string[]) =>
  [...new Set(['.gitattributes', '.potentialpaper/metadata.json', 'paper.json', ...STARTER_PATHS, ...own])].sort(byBytes);

const NO_LIMIT = { burst: 100_000, perSecond: 1000 };
const ARXIV = { scheme: 'arxiv', value: '1706.03762' } as const;

beforeEach(resetDatabase);
afterAll(closePool);

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

/** For anything talking to the server in this process, which a blocking call would stop from answering. */
function gitOverHttp(args: string[], cwd?: string, env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 60_000, env: { ...process.env, ...env } }, (err, stdout, stderr) =>
      err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout),
    );
  });
}

function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'page-store-'));
  dirs.push(dir);
  return dir;
}
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

let paperCount = 0;
async function newPaper(identifier: { scheme: 'arxiv' | 'doi' | 'openreview'; value: string } | null = null) {
  paperCount += 1;
  return savePaper({
    title: `Paper ${paperCount}: Über 日本語`,
    authors: ['Ada Lovelace', 'Émile Noether'],
    abstract: 'An abstract.',
    source: 'arxiv',
    metadataLicense: 'CC0-1.0',
    abstractLicense: 'CC0-1.0',
    identifiers: [identifier ?? { scheme: 'arxiv', value: `2001.${String(paperCount).padStart(5, '0')}` }],
  });
}

async function newAccount(fields: Partial<typeof accounts.$inferInsert> = {}): Promise<Actor & { kind: 'account' }> {
  paperCount += 1;
  const [row] = await getDb()
    .insert(accounts)
    .values({ handle: `person-${paperCount}`, verifiedAt: new Date(), ...fields })
    .returning({ id: accounts.id });
  return { kind: 'account', accountId: row.id, isAdmin: false };
}

/** The repo as git sees it: every object written out as a loose file, and `main` pointing at the head. */
async function exportRepo(paperId: string): Promise<string> {
  const repo = workDir();
  git(['init', '-q', '--bare', '--initial-branch=main', repo]);
  const objects = await getDb().select().from(pageObjects).where(eq(pageObjects.pageId, paperId));
  for (const { oid, type, body } of objects) {
    const hex = oid.toString('hex');
    const file = join(repo, 'objects', hex.slice(0, 2), hex.slice(2));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, looseObject(type, body));
  }
  const head = await readHead(getDb(), paperId);
  writeFileSync(join(repo, 'refs/heads/main'), `${head}\n`);
  return repo;
}

/** Fails on any error or warning, of which `--strict` has many. Dangling objects would be a lost commit. */
function fsck(repo: string): void {
  const result = execFileSync('git', ['fsck', '--full', '--strict', '--no-progress', '--no-dangling'], {
    cwd: repo,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
  expect(result.trim()).toBe('');
}

function filesAt(repo: string, ref = 'main'): Map<string, string> {
  const names = git(['ls-tree', '-r', '-z', '--name-only', ref], repo).split('\0').filter(Boolean);
  return new Map(
    names.map((name) => [name, execFileSync('git', ['cat-file', 'blob', `${ref}:${name}`], { cwd: repo }).toString()]),
  );
}

async function projections() {
  const db = getDb();
  return {
    revisions: await db.select().from(pageRevisions).orderBy(asc(pageRevisions.pageId), asc(pageRevisions.seq)),
    current: await db.select().from(pageCurrent).orderBy(asc(pageCurrent.pageId)),
  };
}

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

describe('every repo passes git fsck --strict', () => {
  // Plain strings, spellings of the names git cares about, and a few that are fine.
  const name = fc.oneof(
    { weight: 1, arbitrary: fc.string({ unit: 'binary', minLength: 1, maxLength: 12 }) },
    { weight: 1, arbitrary: fc.constantFrom('.git', '.GIT', 'git~1', '.gitmodules', '..', '.', ' ', 'a.') },
    { weight: 6, arbitrary: fc.string({ unit: 'grapheme', minLength: 1, maxLength: 8 }) },
    {
      weight: 6,
      arbitrary: fc.constantFrom('é', 'e\u0301', '日本語', '\u{1F600}', 'A', 'a', 'a-b', 'a b', 'a.b', 'a0'),
    },
    { weight: 10, arbitrary: fc.stringMatching(/^[a-z0-9]{1,6}(\.md)?$/) },
    // Names the layout takes, so that some commits get through.
    { weight: 40, arbitrary: fc.stringMatching(/^\d{2}-[a-z0-9]{1,6}\.md$/) },
  );
  const path = fc
    .oneof(
      { weight: 3, arbitrary: fc.tuple(name) },
      { weight: 1, arbitrary: fc.array(name, { minLength: 1, maxLength: 4 }) },
    )
    .chain((names) =>
      fc
        .constantFrom('community', 'community', 'community', 'community', 'owners', 'extensions')
        .map((top) => [top, ...names].join('/')),
    );
  const content = fc.oneof(
    fc.constant(''),
    fc.string({ unit: 'binary', maxLength: 200 }),
    fc
      .array(fc.constantFrom('# Title', '', 'Text', 'é', '日本語', '\r'), { maxLength: 8 })
      .map((lines) => lines.join('\n')),
  );
  const change = fc.record({ path, content: fc.option(content, { nil: null, freq: 5 }) });
  const edits = fc.array(fc.array(change, { minLength: 1, maxLength: 4 }), { minLength: 1, maxLength: 5 });

  it('for random paths, non-ASCII and empty files', async () => {
    let accepted = 0;
    let refused = 0;
    await fc.assert(
      fc.asyncProperty(edits, fc.string({ unit: 'binary', maxLength: 40 }), async (commits, summary) => {
        const paperId = await newPaper();
        const admin = { ...(await newAccount()), isAdmin: true };
        const expected = new Map<string, string>();
        for (const changes of commits) {
          const head = await readHead(getDb(), paperId);
          try {
            const result = await commitPage(paperId, head, admin, changes, summary, { rateLimit: NO_LIMIT });
            if (result.status === 'committed') accepted += 1;
            // A page's first commit starts it with the starter files the commit doesn't write itself.
            if (!head && result.status === 'committed') {
              for (const [p, c] of starterFiles()) {
                if (!changes.some((change) => change.path.normalize('NFC') === p)) expected.set(p, c);
              }
            }
            for (const { path: p, content: c } of changes) {
              const normal = p.normalize('NFC');
              if (c === null) expected.delete(normal);
              else expected.set(normal, c);
            }
          } catch (err) {
            if (!(err instanceof ApiError) || err.status !== 422) {
              if (!(err instanceof ApiError && err.status === 403)) throw err;
            }
            refused += 1;
          }
        }
        if (!(await readHead(getDb(), paperId))) return;
        const repo = await exportRepo(paperId);
        fsck(repo);
        const files = filesAt(repo);
        expect(files.delete('.potentialpaper/metadata.json')).toBe(true);
        if (!expected.has('paper.json')) expect(files.delete('paper.json')).toBe(true);
        expect(files.delete('.gitattributes')).toBe(true);
        expect(new Map([...files].sort())).toEqual(new Map([...expected].sort()));
      }),
      { numRuns: 60 },
    );
    // A property that only ever saw refusals would prove nothing.
    expect(accepted).toBeGreaterThan(20);
    expect(refused).toBeGreaterThan(5);
  }, 240_000);

  it('for a first commit, a merge, a revert and the system commit, read by real git', async () => {
    const paperId = await newPaper();
    const person = await newAccount();
    const first = await commitPage(
      paperId,
      null,
      person,
      [{ path: 'community/10-tl-dr.md', content: '# Über\n\nA\n\nB\n\nC\n' }],
      'Start 日本語',
      { rateLimit: NO_LIMIT },
    );
    const c1 = first.oid!;
    await commitPage(
      paperId,
      c1,
      person,
      [{ path: 'community/10-tl-dr.md', content: '# Über\n\nA2\n\nB\n\nC\n' }],
      'A',
      {
        rateLimit: NO_LIMIT,
      },
    );
    const merged = await commitPage(
      paperId,
      c1,
      person,
      [{ path: 'community/10-tl-dr.md', content: '# Über\n\nA\n\nB\n\nC2\n' }],
      'C',
      { rateLimit: NO_LIMIT },
    );
    expect(merged).toMatchObject({ status: 'committed', merged: true });
    await revertCommit(paperId, merged.oid!, person, undefined, { rateLimit: NO_LIMIT });
    await commitPage(
      paperId,
      await readHead(getDb(), paperId),
      SYSTEM_ACTOR,
      [{ path: '.potentialpaper/metadata.json', content: '{"title":"T"}\n' }],
      'Update metadata',
    );

    const repo = await exportRepo(paperId);
    fsck(repo);
    expect(git(['rev-list', '--count', 'main'], repo).trim()).toBe('5');
    expect(git(['rev-list', '--merges', 'main'], repo).trim()).toBe('');
    expect(filesAt(repo).get('community/10-tl-dr.md')).toBe('# Über\n\nA2\n\nB\n\nC\n');
    const log = git(['log', '--format=%an|%ae|%cn|%s|%(trailers:key=Edit-Kind,valueonly)', 'main'], repo)
      .trim()
      .split('\n')
      .filter(Boolean);
    expect(log[0]).toBe('potentialpaper|potentialpaper@users.invalid|potentialpaper|Update metadata|edit');
    expect(log[1]).toMatch(/^u_[a-z2-9]{8}\|u_[a-z2-9]{8}@users\.invalid\|potentialpaper\|Revert "C"\|revert$/);
  });
});

describe('concurrent commits', () => {
  it('fifty to one page give a linear history with none lost', async () => {
    const paperId = await newPaper();
    const seedLines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    const page = (lines: string[]) => lines.join('\n\n') + '\n';
    const seed = await commitPage(
      paperId,
      null,
      await newAccount(),
      [{ path: 'community/10-tl-dr.md', content: page(seedLines) }],
      'Seed',
    );
    const people = await Promise.all(Array.from({ length: 50 }, () => newAccount()));

    // All start from the same commit, each changing its own line and adding its own file.
    const results = await Promise.all(
      people.map((person, i) =>
        commitPage(
          paperId,
          seed.oid,
          person,
          [
            {
              path: 'community/10-tl-dr.md',
              content: page(seedLines.map((line, n) => (n === i ? `edited by ${i}` : line))),
            },
            { path: `community/${10 + i}-note.md`, content: `note ${i}\n` },
          ],
          `Edit ${i}`,
        ),
      ),
    );
    expect(results.every((r) => r.status === 'committed')).toBe(true);
    expect(results.map((r) => (r.status === 'committed' ? r.seq : 0)).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 2),
    );

    const repo = await exportRepo(paperId);
    fsck(repo);
    expect(git(['rev-list', '--count', 'main'], repo).trim()).toBe('51');
    expect(git(['rev-list', '--merges', 'main'], repo).trim()).toBe('');
    // Every commit reaches the next: nothing left dangling off the side of the history.
    const everyOid = git(['rev-list', 'main'], repo).trim().split('\n').sort();
    expect(everyOid).toEqual(
      results
        .map((r) => r.oid!)
        .concat(seed.oid!)
        .sort(),
    );
    const files = filesAt(repo);
    const final = files.get('community/10-tl-dr.md')!;
    for (let i = 0; i < 50; i += 1) {
      expect(final).toContain(`edited by ${i}`);
      expect(files.get(`community/${10 + i}-note.md`)).toBe(`note ${i}\n`);
    }
    expect(final).not.toContain('line ');

    const db = getDb();
    const revisions = await db.select().from(pageRevisions).where(eq(pageRevisions.pageId, paperId));
    expect(revisions).toHaveLength(51);
    expect(await db.select().from(pageEvents).where(eq(pageEvents.pageId, paperId))).toHaveLength(51);
    const [current] = await db.select().from(pageCurrent).where(eq(pageCurrent.pageId, paperId));
    expect(current.communityMarkdown).toContain(`### TL;DR\n\n${final}`);
    expect(current.head.toString('hex')).toBe(await readHead(db, paperId));
  }, 60_000);

  it('fifty to the same line: one wins and the others are told, with nothing lost silently', async () => {
    const paperId = await newPaper();
    const seed = await commitPage(
      paperId,
      null,
      await newAccount(),
      [{ path: 'community/10-tl-dr.md', content: 'line\n' }],
      'Seed',
    );
    const people = await Promise.all(Array.from({ length: 50 }, () => newAccount()));
    const results = await Promise.allSettled(
      people.map((person, i) =>
        commitPage(paperId, seed.oid, person, [{ path: 'community/10-tl-dr.md', content: `line ${i}\n` }], `Edit ${i}`),
      ),
    );
    const won = results.filter((r) => r.status === 'fulfilled');
    const conflicts = results.flatMap((r) => (r.status === 'rejected' ? [r.reason as ApiError] : []));
    expect(won).toHaveLength(1);
    expect(conflicts).toHaveLength(49);
    for (const conflict of conflicts) {
      expect(conflict.code).toBe('edit_conflict');
      expect(conflict.status).toBe(409);
    }
    expect((await pageHistory(paperId)).length).toBe(2);
  }, 60_000);

  it('fifty first commits to a new page make one repo', async () => {
    const paperId = await newPaper();
    const people = await Promise.all(Array.from({ length: 50 }, () => newAccount()));
    const results = await Promise.all(
      people.map((person, i) =>
        commitPage(paperId, null, person, [{ path: `community/${10 + i}-n.md`, content: `${i}\n` }], `Edit ${i}`),
      ),
    );
    expect(results.every((r) => r.status === 'committed')).toBe(true);
    const repo = await exportRepo(paperId);
    fsck(repo);
    expect(git(['rev-list', '--count', 'main'], repo).trim()).toBe('50');
    expect(filesAt(repo).size).toBe(53 + STARTER_PATHS.length);
    expect(git(['rev-list', '--max-parents=0', 'main'], repo).trim().split('\n')).toHaveLength(1);
  }, 60_000);

  it('moves the head only from where it expected', async () => {
    const paperId = await newPaper();
    const { oid } = await commitPage(paperId, null, SYSTEM_ACTOR, [], 'Start');
    const a = oid!;
    const b = 'b'.repeat(40);
    await getDb().transaction(async (tx) => {
      expect(await moveHead(tx, paperId, b, 'c'.repeat(40))).toBe(false);
      expect(await moveHead(tx, paperId, null, 'c'.repeat(40))).toBe(false);
      expect(await moveHead(tx, paperId, a, a)).toBe(true);
    });
    expect(await readHead(getDb(), paperId)).toBe(a);
  });
});

describe('rebuilding the projections', () => {
  it('gives identical rows', async () => {
    const [p1, p2, p3] = [await newPaper(), await newPaper(), await newPaper()];
    const person = await newAccount();
    const admin = { ...(await newAccount()), isAdmin: true };
    const bot = await newAccount({ isBot: true, verifiedAt: null });
    const one = await commitPage(
      p1,
      null,
      person,
      [{ path: 'community/10-tl-dr.md', content: '# Über\n\nA\n\nB\n' }],
      'Start 日本語',
    );
    const two = await commitPage(
      p1,
      one.oid,
      admin,
      [
        { path: 'owners/10-overview.md', content: 'Authors\n' },
        { path: 'versions/v_k3x9q2ab.json', content: '{"kind":"preprint","label":"arXiv v1"}\n' },
      ],
      'Author section',
    );
    await commitPage(p1, two.oid, bot, [{ path: 'community/20-bot.md', content: 'Found by a bot.\n' }], 'Bot edit');
    await revertCommit(p1, one.oid!, person);
    await commitPage(p2, null, SYSTEM_ACTOR, [], 'Metadata');
    const del = await commitPage(
      p3,
      null,
      person,
      [
        { path: 'community/20-x.md', content: 'x\n' },
        { path: 'community/10-tl-dr.md', content: '' },
      ],
      'New',
    );
    await commitPage(p3, del.oid, person, [{ path: 'community/20-x.md', content: null }], 'Delete');

    const before = await projections();
    expect(before.revisions).toHaveLength(7);
    expect(before.current).toHaveLength(3);

    const db = getDb();
    await db.execute(sql`truncate table page_revisions, page_current`);
    expect((await projections()).revisions).toHaveLength(0);
    const events = await db.select().from(pageEvents).orderBy(asc(pageEvents.id));
    expect(await rebuildAllPages()).toEqual({ pages: 3, commits: 7 });

    expect(await projections()).toEqual(before);
    // The outbox is not a projection: consumers have read it.
    expect(await db.select().from(pageEvents).orderBy(asc(pageEvents.id))).toEqual(events);

    // Running it over rows that are there changes nothing, and rows of a page with no repo go.
    await db.delete(pageRefs).where(eq(pageRefs.pageId, p3));
    await db.delete(pageObjects).where(eq(pageObjects.pageId, p3));
    await rebuildAllPages();
    const after = await projections();
    expect(after.current.map((c) => c.pageId).sort()).toEqual([p1, p2].sort());
    expect(after.revisions).toEqual(before.revisions.filter((r) => r.pageId !== p3));
  });

  it('keeps a deleted account deleted', async () => {
    const paperId = await newPaper();
    const person = await newAccount();
    await commitPage(paperId, null, person, [{ path: 'community/10-tl-dr.md', content: 'x\n' }], 'Edit');
    const before = await pageHistory(paperId);
    await getDb().delete(accounts).where(eq(accounts.id, person.accountId));
    const [row] = await getDb().select().from(pageRevisions).where(eq(pageRevisions.pageId, paperId));
    expect(row.accountId).toBeNull();
    await rebuildAllPages();
    const [rebuilt] = await getDb().select().from(pageRevisions).where(eq(pageRevisions.pageId, paperId));
    expect(rebuilt).toEqual(row);
    expect(await pageHistory(paperId)).toEqual(before);
  });
});

describe('commitPage', () => {
  it('starts a repo with its metadata and paper.json, and not for nothing', async () => {
    const paperId = await newPaper(ARXIV);
    const person = await newAccount();
    expect(
      await commitPage(paperId, null, person, [{ path: 'community/20-gone.md', content: null }], 'Nothing'),
    ).toEqual({
      status: 'unchanged',
      oid: null,
    });
    expect(await readHead(getDb(), paperId)).toBeNull();

    const first = await commitPage(paperId, null, person, [{ path: 'community/10-tl-dr.md', content: '' }], 'First');
    expect(first).toMatchObject({
      status: 'committed',
      seq: 1,
      merged: false,
      paths: firstPaths(),
    });
    const repo = await exportRepo(paperId);
    expect(JSON.parse(filesAt(repo).get('.potentialpaper/metadata.json')!)).toEqual({
      layout: LAYOUT_VERSION,
      kind: 'paper',
      key: expect.any(String),
    });
    expect(JSON.parse(filesAt(repo).get('paper.json')!)).toEqual({
      title: expect.stringContaining('Über'),
      authors: ['Ada Lovelace', 'Émile Noether'],
      abstract: 'An abstract.',
      license: { metadata: 'CC0-1.0', abstract: 'CC0-1.0' },
    });
    expect(
      await commitPage(paperId, first.oid, person, [{ path: 'community/10-tl-dr.md', content: '' }], 'Same'),
    ).toEqual({
      status: 'unchanged',
      oid: first.oid,
    });
  });

  it('applies path permissions to everyone, before writing anything', async () => {
    const paperId = await newPaper();
    const person = await newAccount();
    const admin = { ...(await newAccount()), isAdmin: true };
    const unverified = await newAccount({ verifiedAt: null });

    for (const [actor, path] of [
      [person, '.potentialpaper/metadata.json'],
      [person, 'owners/10-overview.md'],
      [unverified, 'community/10-tl-dr.md'],
      [admin, 'extensions/x/data.json'],
      [admin, 'README.md'],
      [SYSTEM_ACTOR, 'community/10-tl-dr.md'],
    ] as [Actor, string][]) {
      const err = await refusal(commitPage(paperId, null, actor, [{ path, content: '{}' }], 'Edit'));
      expect([path, err.code]).toEqual([path, 'forbidden']);
    }
    // One forbidden path refuses the commit, not just that file.
    await refusal(
      commitPage(
        paperId,
        null,
        person,
        [
          { path: 'community/10-tl-dr.md', content: 'x' },
          { path: 'owners/10-overview.md', content: 'x' },
        ],
        'Edit',
      ),
    );
    expect(await getDb().select().from(pageObjects)).toEqual([]);

    await commitPage(paperId, null, admin, [{ path: 'owners/10-overview.md', content: 'x' }], 'Edit');
    await commitPage(
      paperId,
      await readHead(getDb(), paperId),
      admin,
      [{ path: '.potentialpaper/metadata.json', content: '{"title":"T"}' }],
      'Edit',
    );
    const bot = await newAccount({ isBot: true, verifiedAt: null });
    await commitPage(
      paperId,
      await readHead(getDb(), paperId),
      bot,
      [{ path: 'community/10-tl-dr.md', content: 'x' }],
      'Edit',
    );
  });

  it('refuses invalid paths, files and shapes', async () => {
    const paperId = await newPaper();
    const person = await newAccount();
    const admin = { ...person, isAdmin: true };
    const content = 'x';
    const cases: [Actor, FileChange[]][] = [
      [person, [{ path: 'community/.git/config', content }]],
      [
        person,
        [
          { path: 'community/10-a.md', content },
          { path: 'community/10-a.md', content },
        ],
      ],
      [
        person,
        [
          { path: 'community/ré', content },
          { path: 'community/ré', content },
        ],
      ],
      [
        person,
        [
          { path: 'community/10-a.md', content },
          { path: 'community/10-a.md/b', content },
        ],
      ],
      [person, [{ path: 'links/10-code.json', content: 'nope' }]],
      [person, [{ path: 'community/notes.md', content }]],
      [person, [{ path: 'community/10-tl-dr.md', content: 'a\0b' }]],
      [person, Array.from({ length: MAX_CHANGES + 1 }, (_, i) => ({ path: `community/${i}`, content }))],
      [admin, [{ path: '.potentialpaper/metadata.json', content: '[]' }]],
      [admin, [{ path: '.potentialpaper/metadata.json', content: '{"a":"\\u0000"}' }]],
    ];
    for (const [actor, changes] of cases) {
      expect((await refusal(commitPage(paperId, null, actor, changes, 'Edit'))).status).toBe(422);
    }
    const first = await commitPage(paperId, null, person, [{ path: 'community/10-a.md', content }], 'First');
    const err = await refusal(
      commitPage(paperId, first.oid, person, [{ path: 'community/10-a.md/b', content }], 'Edit'),
    );
    expect(err.status).toBe(422);
    expect(
      (
        await refusal(
          commitPage(paperId, first.oid, admin, [{ path: '.potentialpaper/metadata.json', content: null }], 'Edit'),
        )
      ).status,
    ).toBe(422);
    expect(
      (await refusal(commitPage(paperId, 'nope', person, [{ path: 'community/20-b.md', content }], 'Edit'))).status,
    ).toBe(422);
    expect(
      (await refusal(commitPage(paperId, 'c'.repeat(40), person, [{ path: 'community/20-b.md', content }], 'Edit')))
        .status,
    ).toBe(422);
  });

  it('merges, and reports a real conflict with all the versions', async () => {
    const paperId = await newPaper();
    const person = await newAccount();
    const base = 'A\n\nB\n\nC\n';
    const one = await commitPage(paperId, null, person, [{ path: 'community/10-tl-dr.md', content: base }], 'Base');
    await commitPage(
      paperId,
      one.oid,
      person,
      [{ path: 'community/10-tl-dr.md', content: 'A2\n\nB\n\nC\n' }],
      'Theirs',
    );
    const head = await readHead(getDb(), paperId);

    const err = await refusal(
      commitPage(paperId, one.oid, person, [{ path: 'community/10-tl-dr.md', content: 'A3\n\nB\n\nC\n' }], 'Ours'),
    );
    expect(err.status).toBe(409);
    expect(err.code).toBe('edit_conflict');
    expect(err.details).toEqual({
      head,
      conflicts: [{ path: 'community/10-tl-dr.md', base, ours: 'A3\n\nB\n\nC\n', theirs: 'A2\n\nB\n\nC\n' }],
    });
    expect(await readHead(getDb(), paperId)).toBe(head);

    const merged = await commitPage(
      paperId,
      one.oid,
      person,
      [{ path: 'community/10-tl-dr.md', content: 'A\n\nB\n\nC3\n' }],
      'Ours',
    );
    expect(merged).toMatchObject({ status: 'committed', merged: true });
    const [current] = await getDb().select().from(pageCurrent).where(eq(pageCurrent.pageId, paperId));
    // Joined for agents, under a heading from the file's name.
    expect(current.communityMarkdown).toBe('### TL;DR\n\nA2\n\nB\n\nC3\n');

    // A commit that didn't touch the other file doesn't undo what happened to it.
    const two = await commitPage(
      paperId,
      merged.oid,
      person,
      [{ path: 'community/20-other.md', content: 'v1\n' }],
      'Other',
    );
    await commitPage(paperId, two.oid, person, [{ path: 'community/20-other.md', content: 'v2\n' }], 'Other 2');
    await commitPage(paperId, two.oid, person, [{ path: 'community/30-third.md', content: '3\n' }], 'Third');
    expect(filesAt(await exportRepo(paperId)).get('community/20-other.md')).toBe('v2\n');
    // A file submitted unchanged doesn't either.
    await commitPage(
      paperId,
      two.oid,
      person,
      [
        { path: 'community/20-other.md', content: 'v1\n' },
        { path: 'community/40-fourth.md', content: '4\n' },
      ],
      'Fourth',
    );
    expect(filesAt(await exportRepo(paperId)).get('community/20-other.md')).toBe('v2\n');
  });

  it('treats a merge that makes invalid JSON as a conflict', async () => {
    const paperId = await newPaper();
    const admin = { ...(await newAccount()), isAdmin: true };
    const path = '.potentialpaper/metadata.json';
    const base = '{"l":[\n\n\n\n\n\n]}\n';
    const object = '{"l":{\n\n\n\n\n\n}}\n';
    const item = '{"l":[\n\n\n1\n\n\n\n]}\n';
    // One side makes the list an object, the other puts a number in the list. Each is valid and their
    // lines don't touch, so the text merges cleanly, into a number where an object needs a key.
    expect(mergeFile(base, item, object)).toEqual({ ok: true, content: '{"l":{\n\n\n1\n\n\n\n}}\n' });
    const one = await commitPage(paperId, null, admin, [{ path, content: base }], 'Base');
    await commitPage(paperId, one.oid, admin, [{ path, content: object }], 'Object');
    const head = await readHead(getDb(), paperId);
    const err = await refusal(commitPage(paperId, one.oid, admin, [{ path, content: item }], 'Item'));
    expect(err.code).toBe('edit_conflict');
    expect(await readHead(getDb(), paperId)).toBe(head);
  });

  it('never puts an account, handle or email in the repo or the outbox', async () => {
    const paperId = await newPaper();
    const person = await newAccount({ handle: 'secret-handle', realName: 'Real Name' });
    await commitPage(paperId, null, person, [{ path: 'community/10-tl-dr.md', content: 'x\n' }], 'Edit');
    const [identity] = await getDb()
      .select()
      .from(commitIdentities)
      .where(eq(commitIdentities.accountId, person.accountId));
    expect(identity.id).toMatch(/^u_[a-z2-9]{8}$/);

    const objects = await getDb().select().from(pageObjects).where(eq(pageObjects.pageId, paperId));
    const events = await getDb().select().from(pageEvents).where(eq(pageEvents.pageId, paperId));
    const history = await pageHistory(paperId);
    const everything = [
      ...objects.map((o) => o.body.toString('latin1')),
      JSON.stringify(events.map((e) => e.payload)),
      JSON.stringify(history),
    ].join('\n');
    for (const secret of [person.accountId, 'secret-handle', 'Real Name']) expect(everything).not.toContain(secret);
    expect(everything).toContain(identity.id);
    expect(events[0].payload).toMatchObject({
      authorId: identity.id,
      kind: 'edit',
      paths: firstPaths(),
    });
  });

  it('keeps one identity per account across pages, and marks bots', async () => {
    const person = await newAccount();
    const bot = await newAccount({ isBot: true });
    const [a, b] = [await newPaper(), await newPaper()];
    await commitPage(a, null, person, [{ path: 'community/10-tl-dr.md', content: 'a' }], 'Edit');
    await commitPage(b, null, person, [{ path: 'community/10-tl-dr.md', content: 'b' }], 'Edit');
    const [ha] = await pageHistory(a);
    const [hb] = await pageHistory(b);
    expect(ha.authorId).toBe(hb.authorId);

    await commitPage(a, await readHead(getDb(), a), bot, [{ path: 'community/20-bot.md', content: 'x' }], 'Bot');
    const repo = await exportRepo(a);
    expect(git(['log', '-1', '--format=%(trailers:key=Bot,valueonly)', 'main'], repo).trim()).toBe('true');
    expect(git(['log', '-1', '--format=%(trailers:key=Bot,valueonly)', 'main~1'], repo).trim()).toBe('');
  });

  it('refuses a merged paper, an unknown paper, and past the rate limit', async () => {
    const paperId = await newPaper();
    const survivor = await newPaper();
    const person = await newAccount();
    await getDb().update(papers).set({ mergedInto: survivor }).where(eq(papers.id, paperId));
    expect(
      (await refusal(commitPage(paperId, null, person, [{ path: 'community/10-a.md', content: '' }], 'E'))).code,
    ).toBe('paper_merged');
    expect(
      (await refusal(commitPage(crypto.randomUUID(), null, person, [{ path: 'community/10-a.md', content: '' }], 'E')))
        .code,
    ).toBe('not_found');
    const limited = { rateLimit: { burst: 1, perSecond: 0.001 } };
    await commitPage(survivor, null, person, [{ path: 'community/10-a.md', content: '' }], 'E', limited);
    expect(
      (await refusal(commitPage(survivor, null, person, [{ path: 'community/20-b.md', content: '' }], 'E', limited)))
        .code,
    ).toBe('rate_limited');
  });
});

describe('revert', () => {
  it('undoes one commit and keeps the ones after it', async () => {
    const paperId = await newPaper();
    const person = await newAccount();
    const one = await commitPage(
      paperId,
      null,
      person,
      [{ path: 'community/10-tl-dr.md', content: 'A\n\nB\n\nC\n' }],
      'One',
    );
    const two = await commitPage(
      paperId,
      one.oid,
      person,
      [
        { path: 'community/10-tl-dr.md', content: 'A2\n\nB\n\nC\n' },
        { path: 'community/20-new.md', content: 'new\n' },
      ],
      'Vandalism',
    );
    const three = await commitPage(
      paperId,
      two.oid,
      person,
      [{ path: 'community/10-tl-dr.md', content: 'A2\n\nB\n\nC3\n' }],
      'Three',
    );

    const reverted = await revertCommit(paperId, two.oid!, person);
    expect(reverted).toMatchObject({ status: 'committed', merged: true });
    const files = filesAt(await exportRepo(paperId));
    expect(files.get('community/10-tl-dr.md')).toBe('A\n\nB\n\nC3\n');
    expect(files.has('community/20-new.md')).toBe(false);
    const [latest] = await pageHistory(paperId);
    expect(latest).toMatchObject({ kind: 'revert', summary: 'Revert "Vandalism"' });
    const [event] = await getDb().select().from(pageEvents).where(eq(pageEvents.seq, latest.seq));
    expect(event.payload).toMatchObject({ kind: 'revert', reverts: two.oid });

    // Reverting it again finds nothing to do, because the change is already gone.
    expect((await revertCommit(paperId, two.oid!, person)).status).toBe('unchanged');
    expect(three.status).toBe('committed');
  });

  it('reports a conflict when later edits touch the same lines', async () => {
    const paperId = await newPaper();
    const person = await newAccount();
    const one = await commitPage(paperId, null, person, [{ path: 'community/10-tl-dr.md', content: 'A\n' }], 'One');
    const two = await commitPage(paperId, one.oid, person, [{ path: 'community/10-tl-dr.md', content: 'B\n' }], 'Two');
    await commitPage(paperId, two.oid, person, [{ path: 'community/10-tl-dr.md', content: 'C\n' }], 'Three');
    expect((await refusal(revertCommit(paperId, two.oid!, person))).code).toBe('edit_conflict');
  });

  it('keeps the metadata when reverting the first commit, and needs the permissions of the paths', async () => {
    const paperId = await newPaper();
    const person = await newAccount();
    const admin = { ...(await newAccount()), isAdmin: true };
    const one = await commitPage(paperId, null, person, [{ path: 'community/10-tl-dr.md', content: 'A\n' }], 'One');
    const author = await commitPage(
      paperId,
      one.oid,
      admin,
      [{ path: 'owners/10-overview.md', content: 'B\n' }],
      'Author',
    );
    expect((await refusal(revertCommit(paperId, author.oid!, person))).code).toBe('forbidden');
    await revertCommit(paperId, one.oid!, person);
    // The summary someone wrote goes; the starter files stay, as the metadata does.
    expect([...filesAt(await exportRepo(paperId)).keys()].sort(byBytes)).toEqual(
      firstPaths('owners/10-overview.md').filter((path) => path !== 'community/10-tl-dr.md'),
    );
    expect((await refusal(revertCommit(paperId, 'd'.repeat(40), person))).code).toBe('not_found');
  });
});

describe('diffs between commits', () => {
  it('match what git says changed', async () => {
    const paperId = await newPaper();
    const person = await newAccount();
    const one = await commitPage(
      paperId,
      null,
      person,
      [
        { path: 'community/10-tl-dr.md', content: 'one\ntwo\n' },
        { path: 'community/20-old.md', content: 'gone\n' },
      ],
      'One',
    );
    const two = await commitPage(
      paperId,
      one.oid,
      person,
      [
        { path: 'community/10-tl-dr.md', content: 'one\nTWO\n' },
        { path: 'community/20-old.md', content: null },
        { path: 'community/30-e.md', content: '' },
      ],
      'Two',
    );
    const diffs = (await diffCommits(paperId, one.oid!, two.oid!))!;
    const repo = await exportRepo(paperId);
    const said = git(
      ['-c', 'core.quotepath=off', 'diff', '--no-renames', '--name-status', '-z', one.oid!, two.oid!],
      repo,
    )
      .split('\0')
      .filter(Boolean);
    const expected = new Map<string, string>();
    for (let i = 0; i < said.length; i += 2)
      expected.set(said[i + 1], { A: 'added', M: 'modified', D: 'deleted' }[said[i]]!);
    expect(new Map(diffs.map((d) => [d.path, d.status]))).toEqual(expected);
    expect(diffs.find((d) => d.path === 'community/10-tl-dr.md')!.patch).toContain('-two\n+TWO\n');
    expect(await diffCommits(paperId, 'a'.repeat(40), two.oid!)).toBeNull();
    expect(await diffCommits(paperId, one.oid!, 'nope')).toBeNull();
    // From nothing, a commit's whole tree is new.
    const all = (await diffCommits(paperId, null, one.oid!))!;
    expect(all.length).toBe(git(['ls-tree', '-r', '--name-only', one.oid!], repo).trim().split('\n').length);
    expect(all.every((d) => d.status === 'added')).toBe(true);
  });
});

describe('git clone', () => {
  let server: Server;
  let base: string;

  /** Every request the server answered, as `METHOD path`. */
  const seen: string[] = [];

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      seen.push(`${req.method} ${req.url}`);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value);
      const request = new Request(new URL(req.url!, base), {
        method: req.method,
        headers,
        ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
      });
      const response = await (req.method === 'POST' ? gitRoute.POST(request) : gitRoute.GET(request));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) for await (const chunk of response.body) res.write(chunk);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((resolve) => server.close(resolve)));

  async function request(path: string): Promise<Response> {
    return gitRoute.GET(new Request(new URL(path, base)));
  }

  it('works with stock git, on real history', async () => {
    const paperId = await newPaper(ARXIV);
    const person = await newAccount();
    const edits: FileChange[][] = [
      [{ path: 'community/10-tl-dr.md', content: '# Über\n' }],
      [
        { path: 'community/20-note.md', content: 'テスト\n' },
        { path: 'community/30-empty.md', content: '' },
      ],
      [{ path: 'community/10-tl-dr.md', content: '# Über\n\nMore.\n' }],
    ];
    let head: string | null = null;
    for (const [i, changes] of edits.entries()) {
      const result = await commitPage(paperId, head, person, changes, `Edit ${i}`);
      head = result.oid;
    }

    const clone = join(workDir(), 'page');
    await gitOverHttp(['clone', '-q', `${base}${clonePath(ARXIV)}`, clone]);
    fsck(clone);
    expect(git(['rev-parse', 'HEAD'], clone).trim()).toBe(head);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], clone).trim()).toBe('main');
    expect(git(['rev-list', '--count', 'HEAD'], clone).trim()).toBe('3');
    expect(readFileSync(join(clone, 'community/20-note.md'), 'utf8')).toBe('テスト\n');
    expect(readFileSync(join(clone, 'community/30-empty.md'), 'utf8')).toBe('');

    // A later edit reaches an existing clone by `git pull`.
    await commitPage(paperId, head, person, [{ path: 'community/10-tl-dr.md', content: 'New\n' }], 'Later');
    await gitOverHttp(['pull', '-q', '--ff-only'], clone);
    expect(readFileSync(join(clone, 'community/10-tl-dr.md'), 'utf8')).toBe('New\n');
    fsck(clone);
  });

  it('works for a DOI with awkward characters and an old arXiv id', async () => {
    const doi = { scheme: 'doi', value: '10.1000/a(b)<c>;d/e.git' } as const;
    const old = { scheme: 'arxiv', value: 'cs.ai/0101001' } as const;
    for (const id of [doi, old]) {
      const paperId = await newPaper(id);
      await commitPage(paperId, null, SYSTEM_ACTOR, [], 'Start');
      const clone = join(workDir(), 'page');
      await gitOverHttp(['clone', '-q', `${base}${clonePath(id)}`, clone]);
      fsck(clone);
    }
  });

  it('follows a redirect from another identifier, or from a merged paper, to the one address', async () => {
    const paperId = await newPaper(ARXIV);
    await getDb().insert(paperIdentifiers).values({ scheme: 'doi', value: '10.1000/attention', paperId });
    await commitPage(paperId, null, SYSTEM_ACTOR, [], 'Start');

    const clone = join(workDir(), 'page');
    await gitOverHttp(['clone', '-q', `${base}/git/doi/10.1000/attention.git`, clone]);
    fsck(clone);
    await gitOverHttp(['clone', '-q', `${base}/git/arxiv/1706.03762v3.git`, join(workDir(), 'versioned')]);

    const redirected = await request('/git/doi/10.1000/ATTENTION.git/info/refs');
    expect(redirected.status).toBe(308);
    expect(redirected.headers.get('location')).toBe('/git/arxiv/1706.03762.git/info/refs');
    expect(redirected.headers.get('cache-control')).toBe('no-store');

    const loser = await newPaper({ scheme: 'arxiv', value: '2001.99999' });
    await getDb().update(papers).set({ mergedInto: paperId }).where(eq(papers.id, loser));
    expect((await request('/git/arxiv/2001.99999.git/info/refs')).headers.get('location')).toBe(
      '/git/arxiv/1706.03762.git/info/refs',
    );
  });

  it('marks objects cacheable and everything else not', async () => {
    const paperId = await newPaper(ARXIV);
    const { oid } = await commitPage(paperId, null, SYSTEM_ACTOR, [], 'Start');
    const smart = await request('/git/arxiv/1706.03762.git/info/refs?service=git-upload-pack');
    expect(smart.headers.get('content-type')).toBe('application/x-git-upload-pack-advertisement');
    expect(smart.headers.get('cache-control')).toBe('no-store, no-transform');
    const post = await gitRoute.POST(
      new Request(new URL('/git/arxiv/1706.03762.git/git-upload-pack', base), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-git-upload-pack-request', 'Git-Protocol': 'version=2' },
        body: '0014command=ls-refs\n0000',
      }),
    );
    expect(await post.text()).toBe(`0032${oid} HEAD\n003d${oid} refs/heads/main\n0000`);
    expect(post.headers.get('content-type')).toBe('application/x-git-upload-pack-result');
    expect(post.headers.get('cache-control')).toBe('no-store, no-transform');
    const refs = await request('/git/arxiv/1706.03762.git/info/refs');
    expect(await refs.text()).toBe(`${oid}\trefs/heads/main\n`);
    expect(refs.headers.get('cache-control')).toBe('no-store');
    expect(refs.headers.get('content-type')).toMatch(/^text\/plain/);
    const head = await request('/git/arxiv/1706.03762.git/HEAD');
    expect(await head.text()).toBe('ref: refs/heads/main\n');
    expect(head.headers.get('cache-control')).toBe('no-store');
    const object = await request(`/git/arxiv/1706.03762.git/objects/${oid!.slice(0, 2)}/${oid!.slice(2)}`);
    expect(object.status).toBe(200);
    expect(object.headers.get('cache-control')).toContain('s-maxage=31536000');
    expect(object.headers.get('x-robots-tag')).toContain('noindex');
  });

  it('answers made-up addresses from the database alone, leaving nothing behind', async () => {
    const paperId = await newPaper(ARXIV);
    const stub = await newPaper({ scheme: 'arxiv', value: '2001.11111' });
    const { oid } = await commitPage(paperId, null, SYSTEM_ACTOR, [], 'Start');
    const realFetch = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error('a clone address must not reach a paper source');
    };
    const count = async () => {
      const [row] = await getDb()
        .execute<{ n: string }>(
          sql`
        select (select count(*) from papers) + (select count(*) from paper_lookup_misses)
          + (select count(*) from rate_limit_buckets) as n`,
        )
        .then((r) => r.rows);
      return row.n;
    };
    const before = await count();
    try {
      for (const path of [
        '/git/arxiv/9999.99999.git/info/refs',
        '/git/arxiv/9999.99999.git/HEAD',
        '/git/arxiv/9999.99999.git/objects/ab/' + 'c'.repeat(38),
        '/git/arxiv/2001.11111.git/info/refs', // a paper nobody has edited has no repo
        `/git/arxiv/2001.11111.git/objects/${oid!.slice(0, 2)}/${oid!.slice(2)}`, // another page's object
        '/git/doi/10.1000/nothing.git/info/refs',
        '/git/openreview/notapaper.git/HEAD',
        '/git/nope/1706.03762.git/info/refs',
        '/git/arxiv/1706.03762',
        '/git/arxiv/1706.03762.git',
        '/git/arxiv/1706.03762.git/config',
        '/git/arxiv/1706.03762.git/objects/info/packs',
        '/git/arxiv/1706.03762.git/objects/AB/' + 'c'.repeat(38),
        '/git/arxiv/1706.03762.git/objects/ab/' + 'c'.repeat(38),
        '/git/arxiv/1706.03762.git/../../etc/passwd',
        '/git/arxiv/%ff.git/info/refs',
      ]) {
        const res = await request(path);
        expect([path, res.status, res.headers.get('cache-control')]).toEqual([path, 404, 'no-store']);
      }
      // A spelling that isn't the address never gets a cacheable answer under that spelling.
      expect(
        (await answerGitRequest(`/git/arxiv/1706.03762v1.git/objects/${oid!.slice(0, 2)}/${oid!.slice(2)}`)).kind,
      ).toBe('missing');
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(await count()).toBe(before);
    expect(stub).toBeTruthy();
  });

  it('takes no other methods, and pushes only from someone signed in', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      const res = await gitRoute[method](
        new Request(new URL('/git/arxiv/1706.03762.git/git-upload-pack', base), { method }),
      );
      expect(res.status).toBe(405);
    }
    const post = (path: string, type?: string) =>
      gitRoute.POST(
        new Request(new URL(path, base), {
          method: 'POST',
          body: '0000',
          headers: type ? { 'content-type': type } : {},
        }),
      );
    expect((await post('/git/arxiv/1706.03762.git/info/refs')).status).toBe(405);
    expect((await post('/git/arxiv/1706.03762.git/git-upload-pack')).status).toBe(415);
    expect((await post('/git/arxiv/1706.03762.git/git-receive-pack')).status).toBe(415);
    expect((await request('/git/arxiv/1706.03762.git/info/refs?service=git-frobnicate')).status).toBe(403);
    // No page yet: nothing to push to.
    expect((await request('/git/arxiv/1706.03762.git/info/refs?service=git-receive-pack')).status).toBe(404);

    const paperId = await newPaper(ARXIV);
    await commitPage(paperId, null, SYSTEM_ACTOR, [], 'Start');
    const refs = await request('/git/arxiv/1706.03762.git/info/refs?service=git-receive-pack');
    expect(refs.status).toBe(401);
    expect(refs.headers.get('www-authenticate')).toMatch(/^Basic realm="PotentialPaper"/);
    const push = await post('/git/arxiv/1706.03762.git/git-receive-pack', 'application/x-git-receive-pack-request');
    expect(push.status).toBe(401);
    expect(await readHead(getDb(), paperId)).not.toBeNull();
  });

  async function longHistory(commits: number): Promise<{ paperId: string; head: string; person: Actor }> {
    const paperId = await newPaper(ARXIV);
    const person = await newAccount();
    let head: string | null = null;
    for (let i = 0; i < commits; i += 1) {
      const changes: FileChange[] = [{ path: 'community/10-tl-dr.md', content: `# Summary\n\nVersion ${i}.\n` }];
      if (i % 10 === 0)
        changes.push({ path: `community/${String(20 + i / 10).padStart(2, '0')}-note.md`, content: `${i}\n` });
      head = (await commitPage(paperId, head, person, changes, `Edit ${i}`, { rateLimit: NO_LIMIT })).oid;
    }
    return { paperId, head: head!, person };
  }

  for (const version of [2, 1, 0]) {
    it(`clones and fetches over the smart protocol, version ${version}`, async () => {
      const { paperId, head, person } = await longHistory(30);
      const config = ['-c', `protocol.version=${version}`];
      seen.length = 0;
      const clone = join(workDir(), 'page');
      await gitOverHttp([...config, 'clone', '-q', `${base}${clonePath(ARXIV)}`, clone]);
      fsck(clone);
      expect(git(['rev-parse', 'HEAD'], clone).trim()).toBe(head);
      expect(git(['rev-list', '--count', 'HEAD'], clone).trim()).toBe('30');
      expect(seen.every((r) => !r.includes('/objects/'))).toBe(true);
      expect(seen.filter((r) => r.startsWith('POST')).length).toBeGreaterThan(0);

      // A new commit, fetched: the client says what it has, and gets only what's new.
      const next = await commitPage(
        paperId,
        head,
        person,
        [{ path: 'community/10-tl-dr.md', content: 'New\n' }],
        'Later',
      );
      await gitOverHttp([...config, 'fetch', '-q', 'origin'], clone);
      expect(git(['rev-parse', 'origin/main'], clone).trim()).toBe(next.oid);
      await gitOverHttp([...config, 'merge', '-q', '--ff-only', 'origin/main'], clone);
      expect(readFileSync(join(clone, 'community/10-tl-dr.md'), 'utf8')).toBe('New\n');
      fsck(clone);
      await expect(
        gitOverHttp([...config, 'clone', '-q', '--depth=1', `${base}${clonePath(ARXIV)}`, join(workDir(), 'shallow')]),
      ).rejects.toThrow(/shallow|depth/i);
    });
  }

  it('still clones over the dumb protocol', async () => {
    const { head } = await longHistory(3);
    seen.length = 0;
    const clone = join(workDir(), 'page');
    await gitOverHttp(['clone', '-q', `${base}${clonePath(ARXIV)}`, clone], undefined, { GIT_SMART_HTTP: '0' });
    fsck(clone);
    expect(git(['rev-parse', 'HEAD'], clone).trim()).toBe(head);
    expect(seen.some((r) => r.includes('/objects/'))).toBe(true);
    expect(seen.some((r) => r.startsWith('POST'))).toBe(false);
  });
});

describe('the PDF', () => {
  const POINTER = {
    sha256: 'a'.repeat(64),
    bytes: 2_000_000,
    url: `https://pdfs.example.org/pdf/${'a'.repeat(64)}.pdf`,
    source: 'https://openreview.net/forum?id=submission1',
    license: 'CC BY 4.0',
  };
  // Every PDF of a paper is a version's.
  const change = (pdf: typeof POINTER): FileChange[] => [
    {
      path: 'versions/v_submitted.json',
      content: encodeVersionFile({ id: 'v_submitted', label: 'ICLR 2027', kind: 'submitted', pdf }),
    },
    { path: 'versions/v_submitted.pdf', content: encodeLfsPointer(pdf) },
  ];
  beforeEach(() => recordLfsObject(getDb(), { ...POINTER, type: 'application/pdf' }));

  async function paper(): Promise<string> {
    return savePaper({
      title: 'A paper',
      authors: [],
      abstract: null,
      identifiers: [ARXIV],
      source: 'arxiv',
      metadataLicense: 'CC0-1.0',
      abstractLicense: null,
    });
  }

  it('is projected for the page, with its first files, and survives a rebuild', async () => {
    const id = await paper();
    await commitPage(id, null, SYSTEM_ACTOR, change(POINTER), 'Add the PDF');
    await rebuildAllPages();
    const [current] = await getDb().select().from(pageCurrent).where(eq(pageCurrent.pageId, id));
    expect(current.pdf).toEqual(POINTER);
    const [revision] = await getDb().select().from(pageRevisions).where(eq(pageRevisions.pageId, id));
    expect(revision.paths.toSorted()).toEqual(
      [
        '.gitattributes',
        '.potentialpaper/metadata.json',
        'paper.json',
        'versions/v_submitted.json',
        'versions/v_submitted.pdf',
        ...STARTER_PATHS,
      ].toSorted(),
    );
  });

  it('gives search results its cover once one is rendered', async () => {
    const id = await paper();
    await commitPage(id, null, SYSTEM_ACTOR, change(POINTER), 'Add the PDF');
    const hit = async () => (await searchPapers({ q: 'paper' })).hits[0];
    expect(await hit()).toMatchObject({ pdf: POINTER.url, cover: null });
    const cover = `https://pdfs.example.org/cover/${POINTER.sha256}.jpg`;
    await getDb().insert(pdfDocuments).values({ sha256: POINTER.sha256, url: POINTER.url, coverUrl: cover });
    expect(await hit()).toMatchObject({ pdf: POINTER.url, cover });
  });

  it('refuses a source a page could not safely link to, bytes not stored here, and a PDF of no version', async () => {
    const id = await paper();
    for (const bad of [
      change({ ...POINTER, source: 'javascript:alert(1)' }),
      change({ ...POINTER, sha256: 'c'.repeat(64) }),
      change({ ...POINTER, bytes: 3 }),
      change(POINTER).slice(1),
    ]) {
      await expect(commitPage(id, null, SYSTEM_ACTOR, bad, 'Bad')).rejects.toMatchObject({ status: 422 });
    }
  });

  it('is a version’s, which anyone verified may add, and nobody else', async () => {
    const id = await paper();
    const [unverified] = await getDb().insert(accounts).values({ handle: 'not-yet' }).returning();
    await expect(
      commitPage(id, null, { kind: 'account', accountId: unverified.id, isAdmin: false }, change(POINTER), 'Mine', {
        rateLimit: NO_LIMIT,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      commitPage(
        id,
        null,
        SYSTEM_ACTOR,
        [{ path: '.potentialpaper/paper.pdf', content: encodeLfsPointer(POINTER) }],
        'Old',
      ),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe('the picture', () => {
  const PDF = {
    sha256: 'a'.repeat(64),
    bytes: 2_000_000,
    url: `https://pdfs.example.org/pdf/${'a'.repeat(64)}.pdf`,
  };
  const THUMBNAIL = {
    sha256: 'b'.repeat(64),
    bytes: 300_000,
    type: 'image/gif' as const,
    url: `/thumbnails/${'b'.repeat(64)}.gif`,
    alt: 'The method, animated',
  };
  const change = ({ alt, ...picture }: Partial<typeof THUMBNAIL>, path = 'thumbnail.gif'): FileChange[] => [
    { path, content: encodeLfsPointer({ sha256: picture.sha256!, bytes: picture.bytes! }) },
    { path: THUMBNAIL_PATH, content: `${JSON.stringify({ alt })}\n` },
  ];
  beforeEach(async () => {
    await recordLfsObject(getDb(), { ...PDF, type: 'application/pdf' });
    await recordLfsObject(getDb(), THUMBNAIL);
  });

  it("is projected, survives a rebuild, and replaces the PDF's cover in search results", async () => {
    const id = await newPaper();
    await commitPage(
      id,
      null,
      SYSTEM_ACTOR,
      [
        {
          path: 'versions/v_submitted.json',
          content: encodeVersionFile({ id: 'v_submitted', label: 'ICLR 2027', kind: 'submitted' }),
        },
        { path: 'versions/v_submitted.pdf', content: encodeLfsPointer(PDF) },
      ],
      'Add the PDF',
    );
    await getDb()
      .insert(pdfDocuments)
      .values({ sha256: PDF.sha256, url: PDF.url, coverUrl: 'https://pdfs.example.org/cover/a.jpg' });
    const admin = { ...(await newAccount()), isAdmin: true };
    await commitPage(id, await readHead(getDb(), id), admin, change(THUMBNAIL), 'Set the thumbnail', {
      rateLimit: NO_LIMIT,
    });
    await rebuildAllPages();
    const [current] = await getDb().select().from(pageCurrent).where(eq(pageCurrent.pageId, id));
    expect(current.thumbnail).toEqual(THUMBNAIL);
    const [paper] = await getDb().select().from(papers).where(eq(papers.id, id));
    const { hits } = await searchPapers({ q: paper.title.split(' ')[0] });
    expect(hits.find((hit) => hit.title === paper.title)).toMatchObject({ cover: THUMBNAIL.url });
  });

  it('refuses what is not a picture stored here, and anyone but its authors and admins once claimed', async () => {
    const id = await newPaper();
    const admin = { ...(await newAccount()), isAdmin: true };
    for (const bad of [
      change(THUMBNAIL, 'thumbnail.png'),
      change({ ...THUMBNAIL, sha256: 'c'.repeat(64) }),
      change({ ...THUMBNAIL, sha256: PDF.sha256, bytes: PDF.bytes }),
      change({ ...THUMBNAIL, bytes: 100 * 1024 * 1024 }),
      change(THUMBNAIL).slice(1),
      [...change(THUMBNAIL), ...change(THUMBNAIL, 'thumbnail.webp').slice(0, 1)],
    ]) {
      await expect(commitPage(id, null, admin, bad, 'Bad', { rateLimit: NO_LIMIT })).rejects.toMatchObject({
        status: 422,
      });
    }
    // Unclaimed, the picture is anyone verified's.
    const someone = await newAccount();
    const set = await commitPage(id, null, someone, change(THUMBNAIL), 'Mine', { rateLimit: NO_LIMIT });
    expect(set.status).toBe('committed');
    const author = await newAccount();
    await getDb().insert(authorClaims).values({
      paperId: id,
      accountId: author.accountId,
      authorIndex: 0,
      authorName: 'An Author',
      identityId: 'a_testtest',
      status: 'confirmed',
    });
    const head = await readHead(getDb(), id);
    await expect(
      commitPage(id, head, someone, change({ ...THUMBNAIL, alt: 'Mine' }), 'Mine', { rateLimit: NO_LIMIT }),
    ).rejects.toMatchObject({ status: 403 });
    const byAuthor = await commitPage(id, head, author, change({ ...THUMBNAIL, alt: 'Ours' }), 'Ours', {
      rateLimit: NO_LIMIT,
    });
    expect(byAuthor.status).toBe('committed');
    const [last] = await pageHistory(id, { limit: 1 });
    expect(last.authorId).toBe('a_testtest');
  });
});
