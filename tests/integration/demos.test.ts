import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '@/db';
import { accounts, authorClaims, demoPins, demoSnapshots, pageCurrent } from '@/db/schema';
import { demoBlockMarkdown, demoUrl } from '@/lib/demos';
import { ApiError } from '@/server/api/errors';
import { serveDemo } from '@/server/demos/serve';
import { type Actor, commitPage, type FileChange } from '@/server/pages/commit';
import { rebuildAllPages } from '@/server/pages/projections';
import { pageHistory, readCommit, readFiles, readHead, readText } from '@/server/pages/repo';
import { savePaper } from '@/server/papers';
import { api, closePool, commitFiles, resetDatabase, signUp } from './helpers';

const OWNER = 'someone';
const REPO = 'attention-3d';
const MAIN = '1'.repeat(40);
const PAPER = { scheme: 'arxiv', value: '1706.03762' } as const;

/** A repo at `MAIN`: a Vite-style build in `dist/`, whose page loads its script from the site root. */
const FILES: Record<string, string> = {
  'README.md': '# A demo',
  'src/main.ts': 'console.log(1)',
  'dist/index.html': '<!doctype html><script type="module" src="/assets/index.js"></script>',
  'dist/assets/index.js': 'import "/assets/chunk.js";',
  'dist/assets/chunk.js': 'document.title = "ok";',
};

function pkt(line: string): string {
  return (line.length + 4).toString(16).padStart(4, '0') + line;
}

function tarball(files: Record<string, string>): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'demo-repo-'));
  try {
    for (const [path, content] of Object.entries(files)) {
      const full = join(dir, `${OWNER}-${REPO}-${MAIN.slice(0, 7)}`, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    // No `._` files from a Mac's tar.
    return gzipSync(
      execFileSync('tar', ['-cf', '-', '-C', dir, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** GitHub, as far as demos see it: the ref listing and codeload. */
function fakeGitHub(files: Record<string, string> = FILES) {
  const archive = tarball(files);
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `https://github.com/${OWNER}/${REPO}.git/info/refs?service=git-upload-pack`) {
      return new Response(
        pkt('# service=git-upload-pack\n') +
          '0000' +
          pkt(`${MAIN} HEAD\0symref=HEAD:refs/heads/main\n`) +
          pkt(`${MAIN} refs/heads/main\n`) +
          '0000',
      );
    }
    if (url === `https://codeload.github.com/${OWNER}/${REPO}/tar.gz/${MAIN}`)
      return new Response(new Uint8Array(archive));
    return new Response('not found', { status: 404 });
  });
}

/** A request to a demo's own host, as `proxy.ts` hands it on. */
function demo(id: string, path = ''): Promise<Response> {
  return serveDemo(new Request(demoUrl(id, path)), id);
}

let store: string;

beforeAll(() => {
  store = mkdtempSync(join(tmpdir(), 'demo-store-'));
  process.env.DEMOS_DIR = store;
});
afterAll(async () => {
  rmSync(store, { recursive: true, force: true });
  await closePool();
});
beforeEach(resetDatabase);
afterEach(() => vi.unstubAllGlobals());

async function paper(): Promise<string> {
  return savePaper({
    title: 'Attention Is All You Need',
    authors: [],
    abstract: null,
    year: 2017,
    venue: null,
    identifiers: [PAPER],
    source: 'arxiv',
    metadataLicense: 'CC0-1.0',
    abstractLicense: null,
  });
}

describe('a demo', () => {
  it('copies the built folder at a pinned commit, without committing, and serves the files', async () => {
    const paperId = await paper();
    const cookie = await signUp('ada@ethz.ch');
    vi.stubGlobal('fetch', fakeGitHub());

    const res = await api('POST', '/demos', { cookie, body: { url: `https://github.com/${OWNER}/${REPO}` } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ commit: MAIN, root: 'dist', files: 3 });
    const id: string = res.body.id;
    expect(await pageHistory(paperId, { limit: 1 })).toEqual([]);

    const index = await demo(id);
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toMatch(/^text\/html/);
    // A page has the height reporter added, so it isn't kept as long as the files are.
    expect(index.headers.get('cache-control')).toBe('public, max-age=300');
    const page = await index.text();
    expect(page).toContain('/assets/index.js');
    expect(page).toMatch(/^<!doctype html><script data-potentialpaper>/);
    expect(Number(index.headers.get('content-length'))).toBe(Buffer.byteLength(page));

    // The build asks from the root, which is the demo's own.
    expect((await demo(id, 'assets/index.js')).status).toBe(200);
    const script = await demo(id, 'assets/chunk.js');
    expect(script.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect(script.headers.get('cache-control')).toContain('immutable');
    expect(await script.text()).toBe('document.title = "ok";');

    expect((await demo(id, 'README.md')).status).toBe(404);
    expect((await demo('f'.repeat(32), 'assets/index.js')).status).toBe(404);
  });

  it('goes into a section as a block, renders as a frame, and survives a rebuild', async () => {
    const paperId = await paper();
    const cookie = await signUp('ada@ethz.ch');
    vi.stubGlobal('fetch', fakeGitHub());
    const body = { url: `https://github.com/${OWNER}/${REPO}/tree/main/dist` };
    const first = await api('POST', '/demos', { cookie, body });
    expect((await api('POST', '/demos', { cookie, body })).body.id).toBe(first.body.id);
    expect(await getDb().select().from(demoSnapshots)).toHaveLength(1);

    const content = `# Reproductions\n\n${demoBlockMarkdown({ ref: { kind: 'snapshot', id: first.body.id }, title: 'Attention, in 3D', description: 'Rotate it.' })}`;
    const edit = await commitFiles(cookie, PAPER, null, { 'community/10-reproductions.md': content });
    expect(edit.status).toBe(200);
    const [before] = await getDb().select().from(pageCurrent).where(eq(pageCurrent.pageId, paperId));
    expect(before.communityHtml).toContain(`<figure class="demo" data-demo="${first.body.id}">`);
    expect(before.communityHtml).toContain(`data-src="${demoUrl(first.body.id)}"`);
    expect(before.communityHtml).toContain(`${OWNER}/${REPO}/dist@${MAIN.slice(0, 7)}`);
    expect(before.communityHtml).toContain('<b>Demo:</b> Attention, in 3D. Rotate it.');

    await rebuildAllPages();
    const [after] = await getDb().select().from(pageCurrent).where(eq(pageCurrent.pageId, paperId));
    expect(after.communityHtml).toBe(before.communityHtml);
  });

  it('refuses a block naming a demo this site does not have', async () => {
    await paper();
    const cookie = await signUp('ada@ethz.ch');
    const content = demoBlockMarkdown({ ref: { kind: 'snapshot', id: 'e'.repeat(32) }, title: 'Made up' });
    const edit = await commitFiles(cookie, PAPER, null, { 'community/10-demos.md': content });
    expect(edit.status).toBe(422);
    expect(edit.body.error.details.missing).toEqual(['e'.repeat(32)]);
  });

  it('explains what is wrong with a repo it cannot use', async () => {
    await paper();
    const cookie = await signUp('ada@ethz.ch');
    vi.stubGlobal('fetch', fakeGitHub({ 'src/index.ts': 'x' }));
    const post = (url: string) => api('POST', '/demos', { cookie, body: { url } });

    const noIndex = await post(`https://github.com/${OWNER}/${REPO}`);
    expect(noIndex.status).toBe(422);
    expect(noIndex.body.error.message).toMatch(/no index\.html/);
    expect((await post('https://github.com/nobody/private-thing')).body.error.message).toMatch(/isn't public/);
    expect((await post('https://gitlab.com/a/b')).body.error.message).toMatch(/GitHub/);
    expect((await post(`https://github.com/${OWNER}/${REPO}/tree/nope`)).body.error.message).toMatch(/branch/);
  });

  it('needs a verified account', async () => {
    await paper();
    const res = await api('POST', '/demos', { body: { url: `https://github.com/${OWNER}/${REPO}` } });
    expect(res.status).toBe(401);
  });
});

const NO_LIMIT = { burst: 100_000, perSecond: 1000 };

let accountCount = 0;
async function account(): Promise<Actor & { kind: 'account' }> {
  accountCount += 1;
  const [row] = await getDb()
    .insert(accounts)
    .values({ handle: `person-${accountCount}`, verifiedAt: new Date() })
    .returning({ id: accounts.id });
  return { kind: 'account', accountId: row.id, isAdmin: false };
}

async function current(paperId: string) {
  const [row] = await getDb().select().from(pageCurrent).where(eq(pageCurrent.pageId, paperId));
  return row;
}

async function fileAtHead(paperId: string, path: string): Promise<string | null> {
  const db = getDb();
  const head = await readHead(db, paperId);
  const files = await readFiles(db, paperId, (await readCommit(db, paperId, head!)).tree);
  return readText(db, paperId, files.get(path));
}

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

function frameId(html: string | null): string {
  const id = /data-demo="([0-9a-f]{32})"/.exec(html ?? '')?.[1];
  expect(id).toBeDefined();
  return id!;
}

describe('a demo block naming a GitHub address', () => {
  const URL_BLOCK = `# Demos\n\n\`\`\`demo https://github.com/${OWNER}/${REPO}/tree/main/dist\nAttention, in 3D\n\`\`\`\n`;

  it('is copied when the commit comes in, keeps the address in the file, and stays pinned', async () => {
    const paperId = await paper();
    const cookie = await signUp('ada@ethz.ch');
    vi.stubGlobal('fetch', fakeGitHub());
    const edit = await commitFiles(cookie, PAPER, null, { 'community/10-demos.md': URL_BLOCK });
    expect(edit.status).toBe(200);
    expect(await fileAtHead(paperId, 'community/10-demos.md')).toBe(URL_BLOCK);
    const [snapshot] = await getDb().select().from(demoSnapshots);
    expect(snapshot).toMatchObject({ commit: MAIN, root: 'dist' });
    const [pin] = await getDb().select().from(demoPins);
    expect(pin).toMatchObject({ pageId: paperId, url: `https://github.com/${OWNER}/${REPO}/tree/main/dist` });
    expect(pin.commit.toString('hex')).toBe(edit.body.head);
    const html = (await current(paperId)).communityHtml;
    expect(frameId(html)).toBe(snapshot.id);
    expect(html).toContain(`${OWNER}/${REPO}/dist@${MAIN.slice(0, 7)}`);

    // GitHub isn't asked again while the address stays on the page, whatever its branch does.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 500 })),
    );
    const again = await commitFiles(cookie, PAPER, edit.body.head, {
      'community/10-demos.md': `${URL_BLOCK}\nNow with words.\n`,
    });
    expect(again.status).toBe(200);
    const before = (await current(paperId)).communityHtml;
    expect(frameId(before)).toBe(snapshot.id);
    await rebuildAllPages();
    expect((await current(paperId)).communityHtml).toBe(before);
  });

  it('refuses the commit when the copy fails, saying why', async () => {
    const paperId = await paper();
    const cookie = await signUp('ada@ethz.ch');
    vi.stubGlobal('fetch', fakeGitHub());
    const content = `\`\`\`demo https://github.com/${OWNER}/${REPO}/tree/nope\nBroken\n\`\`\`\n`;
    const edit = await commitFiles(cookie, PAPER, null, { 'community/10-demos.md': content });
    expect(edit.status).toBe(422);
    expect(edit.body.error.message).toMatch(/^the demo at https:\/\/github\.com\/.*branch/);
    expect(await pageHistory(paperId)).toEqual([]);

    const bad = await commitFiles(cookie, PAPER, null, {
      'community/10-demos.md': '```demo https://gitlab.com/a/b\nX\n```\n',
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toMatch(/not a demo/);
  });
});

describe("a demo in the page's own repo", () => {
  const SECTION = 'community/10-demos.md';
  const SHOWN = '# Demos\n\n```demo demos/spin\nSpin it\n```\n';
  const FOLDER: FileChange[] = [
    {
      path: 'demos/spin/index.html',
      content: '<!doctype html><html><head></head><script src="app.js"></script></html>',
    },
    { path: 'demos/spin/app.js', content: 'document.title = "spun";\n' },
  ];

  it('is served from the demo host like a copied one, and a new version is a new snapshot', async () => {
    const paperId = await paper();
    const person = await account();
    const first = await commitPage(
      paperId,
      null,
      person,
      [...FOLDER, { path: SECTION, content: SHOWN }],
      'Add a demo',
      {
        rateLimit: NO_LIMIT,
      },
    );
    expect(first.status).toBe('committed');
    const html = (await current(paperId)).communityHtml;
    const id = frameId(html);
    expect(html).toContain("demos/spin in this page's repo");
    const [snapshot] = await getDb().select().from(demoSnapshots);
    expect(snapshot).toMatchObject({
      id,
      source: `page:${paperId}`,
      root: 'demos/spin',
      totalBytes: expect.any(Number),
    });

    const page = await demo(id);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<head><script data-potentialpaper>');
    const script = await demo(id, 'app.js');
    expect(script.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect(await script.text()).toBe('document.title = "spun";\n');

    const head = first.status === 'committed' ? first.oid : null;
    await commitPage(
      paperId,
      head,
      person,
      [{ path: 'demos/spin/app.js', content: 'document.title = "faster";\n' }],
      'Faster',
      {
        rateLimit: NO_LIMIT,
      },
    );
    const next = (await current(paperId)).communityHtml;
    expect(frameId(next)).not.toBe(id);
    await rebuildAllPages();
    expect((await current(paperId)).communityHtml).toBe(next);
  });

  it('is text in a folder with an index.html, that a block may only name while it is there', async () => {
    const paperId = await paper();
    const person = await account();
    const commit = (changes: FileChange[]) =>
      commitPage(paperId, null, person, changes, 'Demo', { rateLimit: NO_LIMIT });

    expect((await refusal(commit([{ path: 'demos/spin/logo.png', content: 'x' }]))).message).toMatch(/text/);
    expect((await refusal(commit([{ path: 'demos/Spin/index.html', content: 'x' }]))).message).toMatch(
      /demos\/my-demo/,
    );
    expect((await refusal(commit([{ path: 'demos/spin/app.js', content: 'a\0b' }]))).message).toMatch(/not text/);
    expect((await refusal(commit([{ path: 'demos/spin/app.js', content: 'x' }]))).message).toMatch(/no index\.html/);
    expect((await refusal(commit([{ path: SECTION, content: SHOWN }]))).message).toMatch(
      /demos\/spin, which has no index/,
    );

    const made = await commit([...FOLDER, { path: SECTION, content: SHOWN }]);
    const head = made.status === 'committed' ? made.oid : null;
    const removal = FOLDER.map(({ path }) => ({ path, content: null }));
    const err = await refusal(commitPage(paperId, head, person, removal, 'Remove', { rateLimit: NO_LIMIT }));
    expect(err.message).toMatch(/shows demos\/spin/);
  });

  it("is the authors' alone once the author section shows it", async () => {
    const paperId = await paper();
    const author = await account();
    const someone = await account();
    await getDb().insert(authorClaims).values({
      paperId,
      accountId: author.accountId,
      authorIndex: 1,
      authorName: 'Ashish Vaswani',
      status: 'confirmed',
      identityId: 'a_test',
    });
    const made = await commitPage(
      paperId,
      null,
      author,
      [...FOLDER, { path: 'author/10-demos.md', content: SHOWN }],
      'Our demo',
      { rateLimit: NO_LIMIT },
    );
    const head = made.status === 'committed' ? made.oid : null;
    const change = [{ path: 'demos/spin/app.js', content: 'alert(1)\n' }];
    const err = await refusal(commitPage(paperId, head, someone, change, 'Mine now', { rateLimit: NO_LIMIT }));
    expect(err.status).toBe(403);
    expect(err.message).toMatch(/author section/);

    const own = await commitPage(
      paperId,
      head,
      someone,
      [
        { path: 'demos/other/index.html', content: '<p>Another</p>' },
        { path: 'community/10-more.md', content: '```demo demos/other\nAnother\n```\n' },
      ],
      'A community demo',
      { rateLimit: NO_LIMIT },
    );
    expect(own.status).toBe('committed');
  });
});
