import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '@/db';
import { accounts, authorClaims, pageCurrent, pageEvents, pageObjects, pageRevisions, papers } from '@/db/schema';
import { ApiError } from '@/server/api/errors';
import { checkTree, rolesOf } from '@/server/pages/check';
import {
  type Actor,
  commitPage,
  recordCommit,
  revertCommit,
  SYSTEM_ACTOR,
  type FileChange,
} from '@/server/pages/commit';
import {
  buildTrees,
  encodeCommit,
  encodeTree,
  gitObject,
  type GitObject,
  looseObject,
  SYSTEM_AUTHOR_ID,
} from '@/server/pages/git-objects';
import { lockPage } from '@/server/pages/projections';
import { gitIdentity, type IncomingObject, receiveCommits } from '@/server/pages/receive';
import { pageHistory, readCommit, readFiles, readHead, readText } from '@/server/pages/repo';
import { recordLfsObject } from '@/server/lfs';
import { encodeLfsPointer } from '@/server/pages/rules';
import { savePaper } from '@/server/papers';
import { closePool, resetDatabase } from './helpers';

/**
 * The commit path's checks, met by trees made by hand: pushed as a git client would (`receiveCommits`),
 * and given to `checkTree` directly. None of it goes through an API route.
 */

const NO_LIMIT = { burst: 100_000, perSecond: 1000 };

beforeEach(resetDatabase);
afterEach(() => vi.unstubAllGlobals());
afterAll(closePool);

let count = 0;
async function newPaper(): Promise<string> {
  count += 1;
  const id = await savePaper({
    title: `Paper ${count}`,
    authors: ['Ada Lovelace'],
    abstract: null,
    year: 2020,
    venue: null,
    source: 'arxiv',
    metadataLicense: 'CC0-1.0',
    abstractLicense: null,
    identifiers: [{ scheme: 'arxiv', value: `2101.${String(count).padStart(5, '0')}` }],
  });
  // A page's repo starts with the system's metadata snapshot.
  await commitPage(id, null, SYSTEM_ACTOR, [], 'Start the page');
  return id;
}

async function newAccount(fields: Partial<typeof accounts.$inferInsert> = {}) {
  count += 1;
  const [row] = await getDb()
    .insert(accounts)
    .values({ handle: `pusher-${count}`, verifiedAt: new Date(), ...fields })
    .returning({ id: accounts.id });
  return { kind: 'account', accountId: row.id, isAdmin: false } as const;
}

type Content = string | Buffer | null;

interface Made {
  oid: string;
  objects: Map<string, IncomingObject>;
  files: Map<string, string>;
}

/** A commit on `parent`, with `changes` applied to its files, as a git client would make it. */
async function make(
  paperId: string,
  parent: string | Made | null,
  changes: Record<string, Content>,
  options: {
    identity?: string;
    committer?: string;
    message?: string;
    parents?: string[];
    headers?: string[];
    time?: number;
    tree?: { oid: string; objects: GitObject[] };
  } = {},
): Promise<Made> {
  const objects = new Map<string, IncomingObject>();
  const add = (object: GitObject) => objects.set(object.oid, { type: object.type, body: object.body });
  let files: Map<string, string>;
  if (parent === null) files = new Map();
  else if (typeof parent === 'string')
    files = await readFiles(getDb(), paperId, (await readCommit(getDb(), paperId, parent)).tree);
  else {
    files = new Map(parent.files);
    for (const [oid, object] of parent.objects) objects.set(oid, object);
  }
  for (const [path, content] of Object.entries(changes)) {
    if (content === null) {
      files.delete(path);
      continue;
    }
    const blob = gitObject('blob', Buffer.isBuffer(content) ? content : Buffer.from(content));
    add(blob);
    files.set(path, blob.oid);
  }
  let tree: string;
  if (options.tree) {
    tree = options.tree.oid;
    options.tree.objects.forEach(add);
  } else {
    const built = buildTrees(files);
    built.trees.forEach(add);
    tree = built.root;
  }
  const id = options.identity ?? 'nobody';
  const committer = options.committer ?? id;
  const time = options.time ?? Math.floor(Date.now() / 1000);
  const parentOid = typeof parent === 'string' ? parent : parent?.oid;
  const parents = options.parents ?? (parentOid ? [parentOid] : []);
  const body = Buffer.from(
    [
      `tree ${tree}`,
      ...parents.map((p) => `parent ${p}`),
      `author ${id} <${id}@users.invalid> ${time} +0100`,
      `committer ${committer} <${committer}@users.invalid> ${time} +0100`,
      ...(options.headers ?? []),
      '',
      options.message ?? 'Edit by hand',
      '',
    ].join('\n'),
  );
  const commit = gitObject('commit', body);
  add(commit);
  return { oid: commit.oid, objects, files };
}

async function setUp() {
  const paperId = await newPaper();
  const actor = await newAccount();
  const { id } = await gitIdentity(paperId, actor);
  const head = (await readHead(getDb(), paperId))!;
  const push = (made: Made, old: string | null = head) =>
    receiveCommits(paperId, actor, { old, new: made.oid }, made.objects, { rateLimit: NO_LIMIT });
  const attempt = async (changes: Record<string, Content>, options: Parameters<typeof make>[3] = {}) =>
    push(await make(paperId, head, changes, { identity: id, ...options }));
  return { paperId, actor, id, head, push, attempt };
}

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof ApiError)) throw new Error(`expected a refusal, got ${String(err)}`);
  return err;
}

describe('a bad tree is refused, whoever made it', () => {
  const LINK = (label: string) => `${JSON.stringify({ label, url: 'https://example.org' })}\n`;
  const SHA = 'c'.repeat(64);
  const cases: [string, Record<string, Content>, number, RegExp][] = [
    ['the system files', { '.potentialpaper/metadata.json': '{}\n' }, 403, /only the system and admins/],
    ['the author section, by someone else', { 'author/10-mine.md': '# Mine\n' }, 403, /confirmed authors/],
    ['a path with no place', { 'page.md': 'hello\n' }, 403, /pages hold \.gitattributes, \.potentialpaper/],
    ['a section not named NN-slug', { 'community/summary.md': 'x\n' }, 422, /one file per section/],
    ['a dot file', { 'community/.hidden': 'x\n' }, 422, /starting with a dot/],
    [
      'HTML off the allowlist',
      { 'community/10-x.html': '<p onclick="steal()">hi</p>\n' },
      422,
      /^commit [0-9a-f]{7}: community\/10-x\.html /,
    ],
    ['a script', { 'community/10-x.html': '<script>steal()</script>\n' }, 422, /community\/10-x\.html/],
    ['a link that is not one', { 'links/10-code.json': '{"label": "Code"}\n' }, 422, /is not a link/],
    [
      'two links with one label',
      { 'links/10-code.json': LINK('Code'), 'links/20-code.json': LINK('code') },
      422,
      /two links are called/,
    ],
    [
      'a version whose PDF was never uploaded',
      {
        'versions/v_test0001.json': `${JSON.stringify({ kind: 'preprint', label: 'v1' })}\n`,
        'versions/v_test0001.pdf': `version https://git-lfs.github.com/spec/v1\noid sha256:${SHA}\nsize 1000\n`,
      },
      422,
      /versions\/v_test0001\.pdf: the file with sha256 c+ isn't stored here; push with Git LFS installed/,
    ],
    [
      'a PDF that is not a Git LFS pointer',
      {
        'versions/v_test0001.json': `${JSON.stringify({ kind: 'preprint', label: 'v1' })}\n`,
        'versions/v_test0001.pdf': '%PDF-1.4\n\u0000\u00ff',
      },
      422,
      /versions\/v_test0001\.pdf has to be a Git LFS pointer: install Git LFS/,
    ],
    [
      'a picture from elsewhere',
      {
        'thumbnail.json': `${JSON.stringify({ sha256: SHA, bytes: 10, type: 'image/png', url: 'https://tracker.example/x.png' })}\n`,
      },
      422,
      /thumbnail\.json is not \{ "alt"/,
    ],
    [
      'a demo the site does not have',
      { 'community/10-demo.md': `\`\`\`demo ${'d'.repeat(32)}\nA demo\n\`\`\`\n` },
      422,
      /names a demo that is not on this site/,
    ],
    [
      'a block naming a folder that is not there',
      { 'community/10-demo.md': '```demo demos/spin\nSpin\n```\n' },
      422,
      /shows demos\/spin, which has no index\.html/,
    ],
    ['a demo folder without index.html', { 'demos/spin/app.js': 'x()\n' }, 422, /demos\/spin has no index\.html/],
    [
      'a binary demo file',
      { 'demos/spin/index.html': '<p>hi</p>', 'demos/spin/app.js': Buffer.from([0xff, 0xfe, 0x00]) },
      422,
      /demos\/spin\/app\.js is not UTF-8 text; a demo's binary files .* come from GitHub/,
    ],
    ['a file with a NUL', { 'community/10-x.md': 'a\0b' }, 422, /community\/10-x\.md is not text/],
    [
      'a name not in Unicode normal form',
      { 'demos/spin/index.html': '<p>hi</p>', ['demos/spin/café.js']: 'x()\n' },
      422,
      /not in Unicode normal form/,
    ],
    [
      'too many files at once',
      Object.fromEntries(
        Array.from({ length: 51 }, (_, i) => [`community/${String(i + 10).padStart(2, '0')}-s.md`, `${i}\n`]),
      ),
      422,
      /at most 50 files/,
    ],
    ['deleting the metadata', { '.potentialpaper/metadata.json': null }, 403, /only the system and admins/],
  ];

  it.each(cases)('%s', async (_name, changes, status, message) => {
    const { attempt, paperId, head } = await setUp();
    const err = await refusal(attempt(changes));
    expect(err.status).toBe(status);
    expect(err.message).toMatch(message);
    expect(err.message).toMatch(/^commit [0-9a-f]{7}: /);
    expect(await readHead(getDb(), paperId)).toBe(head);
  });

  it('a mode git can hold but a page cannot: executable, a symbolic link, a submodule', async () => {
    const { attempt } = await setUp();
    const blob = gitObject('blob', Buffer.from('x\n'));
    for (const [mode, message] of [
      ['100755', /run\.md is executable/],
      ['120000', /run\.md is a symbolic link/],
      ['160000', /run\.md is a submodule/],
    ] as const) {
      const inner = gitObject(
        'tree',
        Buffer.concat([Buffer.from(`${mode} 10-run.md\0`), Buffer.from(blob.oid, 'hex')]),
      );
      const meta = gitObject('blob', Buffer.from('{}\n'));
      const system = gitObject('tree', encodeTree([{ name: 'metadata.json', isTree: false, oid: meta.oid }]));
      const root = gitObject(
        'tree',
        encodeTree([
          { name: '.potentialpaper', isTree: true, oid: system.oid },
          { name: 'community', isTree: true, oid: inner.oid },
        ]),
      );
      const err = await refusal(attempt({}, { tree: { oid: root.oid, objects: [blob, inner, meta, system, root] } }));
      expect(err.message).toMatch(message);
    }
  });

  it('a tree git would not write: an empty folder', async () => {
    const { attempt, paperId, head } = await setUp();
    const files = await readFiles(getDb(), paperId, (await readCommit(getDb(), paperId, head)).tree);
    const { trees } = buildTrees(files);
    const top = trees[trees.length - 1];
    const empty = gitObject('tree', Buffer.alloc(0));
    const root = gitObject(
      'tree',
      Buffer.concat([top.body, Buffer.from('40000 zzz\0'), Buffer.from(empty.oid, 'hex')]),
    );
    const err = await refusal(attempt({}, { tree: { oid: root.oid, objects: [...trees, empty, root] } }));
    expect(err.message).toMatch(/its tree is not as git writes one/);
  });

  it('a merged paper', async () => {
    const { attempt, paperId } = await setUp();
    const other = await newPaper();
    await getDb().update(papers).set({ mergedInto: other }).where(eq(papers.id, paperId));
    const err = await refusal(attempt({ 'community/10-x.md': '# X\n' }));
    expect(err.code).toBe('paper_merged');
  });

  it('checkTree refuses the same trees given as maps, with no commit at all', async () => {
    const paperId = await newPaper();
    const actor = await newAccount();
    const roles = await rolesOf(getDb(), actor, paperId);
    const head = (await readHead(getDb(), paperId))!;
    const before = await readFiles(getDb(), paperId, (await readCommit(getDb(), paperId, head)).tree);
    const texts = new Map<string, string>();
    const tree = (changes: Record<string, string | null>) => {
      const after = new Map(before);
      for (const [path, content] of Object.entries(changes)) {
        if (content === null) after.delete(path);
        else {
          const blob = gitObject('blob', Buffer.from(content));
          texts.set(blob.oid, content);
          after.set(path, blob.oid);
        }
      }
      return after;
    };
    const check = (changes: Record<string, string | null>) =>
      checkTree(getDb(), {
        paperId,
        roles,
        before,
        after: tree(changes),
        text: async (blob) => texts.get(blob) ?? readText(getDb(), paperId, blob),
        newBlobBytes: new Map(),
      });
    await expect(check({ 'community/10-ok.md': '# Fine\n' })).resolves.toEqual([]);
    await expect(check({ 'author/10-x.md': '# X\n' })).rejects.toMatchObject({ status: 403 });
    await expect(check({ 'community/10-x.html': '<img src="x" onerror="y">' })).rejects.toMatchObject({
      status: 422,
      message: expect.stringMatching(/^community\/10-x\.html /),
    });
  });
});

describe('a pushed commit', () => {
  it('signed with the identity the site gives is stored verbatim, and projected as a web edit is', async () => {
    const { paperId, id, head, push } = await setUp();
    expect(id).toMatch(/^u_/);
    const made = await make(
      paperId,
      head,
      { 'community/10-summary.md': '# Summary\n\nPushed.\n' },
      {
        identity: id,
        message: 'Write a summary\n\nA body paragraph, which is kept.\n\nEvidence: https://example.org/proof',
      },
    );
    const result = await push(made);
    expect(result).toMatchObject({ status: 'committed', oid: made.oid });
    expect(await readHead(getDb(), paperId)).toBe(made.oid);
    const [stored] = await getDb()
      .select({ body: pageObjects.body })
      .from(pageObjects)
      .where(eq(pageObjects.oid, Buffer.from(made.oid, 'hex')));
    expect(stored.body.equals(made.objects.get(made.oid)!.body)).toBe(true);

    const [last] = await pageHistory(paperId, { limit: 1 });
    expect(last).toMatchObject({
      oid: made.oid,
      authorId: id,
      kind: 'edit',
      summary: 'Write a summary',
      paths: ['community/10-summary.md'],
      evidence: ['https://example.org/proof'],
    });
    const [revision] = await getDb()
      .select({ accountId: pageRevisions.accountId })
      .from(pageRevisions)
      .where(eq(pageRevisions.oid, Buffer.from(made.oid, 'hex')));
    expect(revision.accountId).not.toBeNull();
    const [current] = await getDb().select().from(pageCurrent).where(eq(pageCurrent.paperId, paperId));
    expect(current.communityHtml).toContain('Pushed.');
    const events = await getDb().select().from(pageEvents).where(eq(pageEvents.paperId, paperId));
    expect(events.at(-1)?.payload).toMatchObject({
      oid: made.oid,
      parent: head,
      evidence: ['https://example.org/proof'],
    });
  });

  it('can be several, stored in order', async () => {
    const { paperId, id, head, push } = await setUp();
    const first = await make(paperId, head, { 'community/10-a.md': '# A\n' }, { identity: id, message: 'One' });
    const second = await make(paperId, first, { 'community/20-b.md': '# B\n' }, { identity: id, message: 'Two' });
    const result = await push(second);
    expect(result.status === 'committed' && result.commits.map((c) => c.oid)).toEqual([first.oid, second.oid]);
    expect((await pageHistory(paperId)).map((r) => r.summary)).toEqual(['Two', 'One', 'Start the page']);
  });

  it('carries the per-claim identity on a paper its account is an author of', async () => {
    const { paperId, actor } = await setUp();
    await getDb().insert(authorClaims).values({
      paperId,
      accountId: actor.accountId,
      authorIndex: 0,
      authorName: 'Ada Lovelace',
      identityId: 'a_claimed1',
      status: 'confirmed',
    });
    const identity = await gitIdentity(paperId, actor);
    expect(identity).toMatchObject({ name: 'a_claimed1', email: 'a_claimed1@users.invalid' });
    expect(identity.commands).toEqual([
      'git config user.name a_claimed1',
      'git config user.email a_claimed1@users.invalid',
    ]);
    const head = (await readHead(getDb(), paperId))!;
    const ok = await make(paperId, head, { 'author/10-tl-dr.md': '# TL;DR\n' }, { identity: 'a_claimed1' });
    expect(
      (await receiveCommits(paperId, actor, { old: head, new: ok.oid }, ok.objects, { rateLimit: NO_LIMIT })).status,
    ).toBe('committed');
    // Their handle's identity is not theirs on this paper.
    const { id: handleId } = await gitIdentity(await newPaper(), actor);
    const wrong = await make(paperId, ok.oid, { 'author/10-tl-dr.md': '# TL;DR!\n' }, { identity: handleId });
    const err = await refusal(
      receiveCommits(paperId, actor, { old: ok.oid, new: wrong.oid }, wrong.objects, { rateLimit: NO_LIMIT }),
    );
    expect(err.code).toBe('wrong_identity');
    expect(err.message).toContain('git config user.name a_claimed1');
  });

  it('with any other identity is refused, saying what to set', async () => {
    const { id, attempt, paperId, head } = await setUp();
    for (const options of [
      { identity: 'Ada Lovelace' },
      { identity: id, committer: 'someone-else' },
      { identity: SYSTEM_AUTHOR_ID },
    ]) {
      const err = await refusal(attempt({ 'community/10-x.md': '# X\n' }, options));
      expect(err.code).toBe('wrong_identity');
      expect(err.message).toContain(`git config user.name ${id}`);
      expect(err.message).toContain(`git config user.email ${id}@users.invalid`);
      expect(err.details).toMatchObject({ identity: { name: id, email: `${id}@users.invalid` } });
    }
    expect(await readHead(getDb(), paperId)).toBe(head);
  });

  it('that is a merge, or not on top of the head, is refused', async () => {
    const { id, paperId, head, push } = await setUp();
    const left = await make(paperId, head, { 'community/10-a.md': '# A\n' }, { identity: id });
    const right = await make(paperId, head, { 'community/20-b.md': '# B\n' }, { identity: id });
    const merge = await make(
      paperId,
      left,
      { 'community/20-b.md': '# B\n' },
      { identity: id, parents: [left.oid, right.oid] },
    );
    for (const [oid, object] of right.objects) merge.objects.set(oid, object);
    const merged = await refusal(push(merge));
    expect(merged.message).toMatch(/is a merge; .* rebase/);

    // Someone else edits on the site meanwhile.
    const other = await commitPage(
      paperId,
      head,
      await newAccount(),
      [{ path: 'community/30-c.md', content: '# C\n' }],
      'C',
      {
        rateLimit: NO_LIMIT,
      },
    );
    const stale = await refusal(push(left));
    expect(stale).toMatchObject({ status: 409, code: 'fetch_first' });
    expect(stale.message).toMatch(/git pull --rebase/);
    // Claiming the new head as the old one doesn't help: the commit isn't on top of it.
    const behind = await refusal(push(left, other.oid));
    expect(behind).toMatchObject({ status: 409, code: 'not_fast_forward' });

    const orphan = await make(paperId, null, { 'community/10-a.md': '# A\n' }, { identity: id });
    expect(await refusal(push(orphan, other.oid))).toMatchObject({ code: 'not_fast_forward' });
  });

  it('is refused for what its message carries that a page does not take', async () => {
    const { id, attempt } = await setUp();
    const change = { 'community/10-x.md': '# X\n' };
    const cases: [Parameters<typeof make>[3], RegExp][] = [
      [{ message: 'Fix\n\nSigned-off-by: Ada Lovelace <ada@example.org>' }, /has a name and address/],
      [{ message: 'Fix\n\nReviewed-by: someone' }, /“Reviewed-by:” trailer/],
      [{ message: 'Fix\n\nEvidence: http://insecure.example' }, /evidence 1 needs an https address/],
      [{ message: 'Fix\n\nEdit-Kind: revert' }, /go together/],
      [{ message: `Fix\n\nEdit-Kind: revert\nReverts: ${'e'.repeat(40)}` }, /not a commit of this page/],
      [{ message: 'Fix\n\nBot: true' }, /not a bot/],
      [{ message: 'x'.repeat(301) }, /first line/],
      [{ headers: ['gpgsig -----BEGIN PGP SIGNATURE-----', ' abc', ' -----END PGP SIGNATURE-----'] }, /it is signed/],
      [{ headers: ['encoding ISO-8859-1'] }, /UTF-8/],
      [{ time: Math.floor(Date.now() / 1000) + 3600 }, /in the future/],
    ];
    for (const [options, message] of cases) {
      const err = await refusal(attempt(change, { identity: id, ...options }));
      expect(err.message).toMatch(message);
    }
  });

  it('from a bot account says so', async () => {
    const paperId = await newPaper();
    const bot = await newAccount({ isBot: true, verifiedAt: null });
    const { id } = await gitIdentity(paperId, bot);
    const head = (await readHead(getDb(), paperId))!;
    const push = (made: Made) =>
      receiveCommits(paperId, bot, { old: head, new: made.oid }, made.objects, { rateLimit: NO_LIMIT });
    const plain = await make(paperId, head, { 'community/10-x.md': '# X\n' }, { identity: id });
    expect((await refusal(push(plain))).message).toMatch(/needs a “Bot: true” trailer/);
    const marked = await make(
      paperId,
      head,
      { 'community/10-x.md': '# X\n' },
      { identity: id, message: 'X\n\nBot: true' },
    );
    expect((await push(marked)).status).toBe('committed');
  });

  it('may revert a commit of the page, which then shows as a revert', async () => {
    const { id, paperId, head, push } = await setUp();
    const add = await make(paperId, head, { 'community/10-x.md': '# X\n' }, { identity: id });
    await push(add);
    const undo = await make(
      paperId,
      add.oid,
      { 'community/10-x.md': null },
      { identity: id, message: `Revert "Edit by hand"\n\nEdit-Kind: revert\nReverts: ${add.oid}` },
    );
    await push(undo, add.oid);
    const [last] = await pageHistory(paperId, { limit: 1 });
    expect(last).toMatchObject({ oid: undo.oid, kind: 'revert', summary: 'Revert "Edit by hand"' });
  });

  it('made by stock git is stored with its id unchanged', async () => {
    const { id, paperId, head, actor } = await setUp();
    const dir = mkdtempSync(join(tmpdir(), 'receive-'));
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: dir }).toString().trim();
      git('init', '-q', '--initial-branch=main');
      const objects = await getDb().select().from(pageObjects).where(eq(pageObjects.paperId, paperId));
      for (const { oid, type, body } of objects) {
        const hex = oid.toString('hex');
        const file = join(dir, '.git/objects', hex.slice(0, 2), hex.slice(2));
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, looseObject(type, body));
      }
      git('update-ref', 'refs/heads/main', head);
      git('checkout', '-q', '-f', 'main');
      git('config', 'user.name', id);
      git('config', 'user.email', `${id}@users.invalid`);
      git('config', 'commit.gpgsign', 'false');
      mkdirSync(join(dir, 'community'), { recursive: true });
      writeFileSync(join(dir, 'community/10-from-git.md'), '# From git\n\nWritten in an editor.\n');
      git('add', '.');
      git('commit', '-q', '-m', 'Write it in an editor', '-m', 'Evidence: https://example.org/e');
      const tip = git('rev-parse', 'HEAD');
      const incoming = new Map<string, IncomingObject>();
      for (const oid of git('rev-list', '--objects', `${head}..${tip}`)
        .split('\n')
        .map((l) => l.split(' ')[0])) {
        const type = git('cat-file', '-t', oid) as IncomingObject['type'];
        incoming.set(oid, { type, body: execFileSync('git', ['cat-file', type, oid], { cwd: dir }) });
      }
      const result = await receiveCommits(paperId, actor, { old: head, new: tip }, incoming, { rateLimit: NO_LIMIT });
      expect(result).toMatchObject({ status: 'committed', oid: tip });
      expect(await readHead(getDb(), paperId)).toBe(tip);
      const [last] = await pageHistory(paperId, { limit: 1 });
      expect(last).toMatchObject({ summary: 'Write it in an editor', evidence: ['https://example.org/e'] });
      expect(readFileSync(join(dir, 'community/10-from-git.md'), 'utf8')).toContain('editor');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the commit path, for web edits too', () => {
  it('checks roles before downloading a demo from GitHub', async () => {
    const paperId = await newPaper();
    const someone = await newAccount();
    const fetch = vi.fn(async () => new Response('should not be asked', { status: 500 }));
    vi.stubGlobal('fetch', fetch);
    const block = '```demo https://github.com/someone/demo\nA demo\n```\n';
    await expect(
      commitPage(paperId, null, someone, [{ path: 'author/10-demo.md', content: block }], 'Demo', {
        rateLimit: NO_LIMIT,
      }),
    ).rejects.toMatchObject({ status: 403 });
    // Nor for content that is refused anyway.
    await expect(
      commitPage(
        paperId,
        null,
        someone,
        [
          { path: 'community/10-demo.md', content: block },
          { path: 'community/20-bad.html', content: '<script>x</script>' },
        ],
        'Demo',
        { rateLimit: NO_LIMIT },
      ),
    ).rejects.toMatchObject({ status: 422 });
    const { id } = await gitIdentity(paperId, someone);
    const head = (await readHead(getDb(), paperId))!;
    const pushed = await make(paperId, head, { 'author/10-demo.md': block }, { identity: id });
    await expect(
      receiveCommits(paperId, someone, { old: head, new: pushed.oid }, pushed.objects, { rateLimit: NO_LIMIT }),
    ).rejects.toMatchObject({ status: 403 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a version PDF that was not uploaded, and takes one that was', async () => {
    const paperId = await newPaper();
    const someone = await newAccount();
    const pdf = { sha256: 'f'.repeat(64), bytes: 1234, url: '/files/paper.pdf' };
    const version = (p: { sha256: string; bytes: number }): FileChange[] => [
      { path: 'versions/v_pdf00001.json', content: `${JSON.stringify({ kind: 'preprint', label: 'v1' })}\n` },
      { path: 'versions/v_pdf00001.pdf', content: encodeLfsPointer(p) },
    ];
    await expect(commitPage(paperId, null, someone, version(pdf), 'V', { rateLimit: NO_LIMIT })).rejects.toMatchObject({
      status: 422,
      message: expect.stringMatching(/isn't stored here/),
    });
    await recordLfsObject(getDb(), { ...pdf, type: 'application/pdf' });
    await expect(
      commitPage(paperId, null, someone, version({ ...pdf, bytes: 99 }), 'V', { rateLimit: NO_LIMIT }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/that file has 1234 bytes, not 99/) });
    // A picture is not a PDF, whatever it is called.
    const gif = { sha256: 'e'.repeat(64), bytes: 10, type: 'image/gif', url: '/thumbnails/e.gif' };
    await recordLfsObject(getDb(), gif);
    await expect(commitPage(paperId, null, someone, version(gif), 'V', { rateLimit: NO_LIMIT })).rejects.toMatchObject({
      message: expect.stringMatching(/is not a PDF/),
    });
    const ok = await commitPage(paperId, null, someone, version(pdf), 'V', { rateLimit: NO_LIMIT });
    expect(ok.status).toBe('committed');
  });

  it('refuses to revert a commit from before the layout of files and folders, saying why', async () => {
    const paperId = await newPaper();
    const head = (await readHead(getDb(), paperId))!;
    // A page as it was before `layout-migration.ts`: one `page.md`, written past today's checks.
    const old = await getDb().transaction(async (tx) => {
      await lockPage(tx, paperId);
      const files = await readFiles(tx, paperId, (await readCommit(tx, paperId, head)).tree);
      const blob = gitObject('blob', Buffer.from('## Summary\n\nOld.\n'));
      files.set('page.md', blob.oid);
      const { root, trees } = buildTrees(files);
      const commit = {
        tree: root,
        parent: head,
        authorId: SYSTEM_AUTHOR_ID,
        at: new Date(Math.floor(Date.now() / 1000) * 1000),
        summary: 'Old layout',
        kind: 'edit' as const,
      };
      const object = gitObject('commit', encodeCommit(commit));
      await recordCommit(tx, paperId, object, commit, [blob, ...trees], []);
      return object.oid;
    });
    const admin: Actor = { ...(await newAccount()), isAdmin: true };
    await commitPage(paperId, old, SYSTEM_ACTOR, [{ path: 'page.md', content: null }], 'Move to files', {
      migration: true,
    });
    for (const target of [old, (await readHead(getDb(), paperId))!]) {
      await expect(revertCommit(paperId, target, admin, undefined, { rateLimit: NO_LIMIT })).rejects.toMatchObject({
        status: 422,
        message: expect.stringMatching(/changed page\.md, which pages no longer have .* edit the page instead/),
      });
    }
  });
});
