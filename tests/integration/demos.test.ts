import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '@/db';
import { demoSnapshots, pageCurrent } from '@/db/schema';
import { DEMO_ORIGIN, demoBlockMarkdown } from '@/lib/demos';
import { serveDemo } from '@/server/demos/serve';
import { rebuildAllPages } from '@/server/pages/projections';
import { pageHistory } from '@/server/pages/repo';
import { savePaper } from '@/server/papers';
import { api, closePool, resetDatabase, signUp } from './helpers';

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

function demoRequest(path: string, referer?: string): Request {
  return new Request(new URL(path, DEMO_ORIGIN), {
    headers: referer ? { referer: new URL(referer, DEMO_ORIGIN).href } : {},
  });
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

    const index = await serveDemo(demoRequest(`/d/${id}/`));
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toMatch(/^text\/html/);
    // A page has the height reporter added, so it isn't kept as long as the files are.
    expect(index.headers.get('cache-control')).toBe('public, max-age=300');
    const page = await index.text();
    expect(page).toContain('/assets/index.js');
    expect(page).toMatch(/^<!doctype html><script data-potentialpaper>/);
    expect(Number(index.headers.get('content-length'))).toBe(Buffer.byteLength(page));

    // The build asks from the root; the page that asked says which demo it belongs to.
    const fromRoot = await serveDemo(demoRequest('/assets/index.js', `/d/${id}/`));
    expect(fromRoot.status).toBe(302);
    expect(fromRoot.headers.get('location')).toBe(`${DEMO_ORIGIN}/d/${id}/assets/index.js`);
    const chained = await serveDemo(demoRequest('/assets/chunk.js', `/d/${id}/assets/index.js`));
    expect(chained.headers.get('location')).toBe(`${DEMO_ORIGIN}/d/${id}/assets/chunk.js`);
    const script = await serveDemo(demoRequest(`/d/${id}/assets/chunk.js`));
    expect(script.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect(script.headers.get('cache-control')).toContain('immutable');
    expect(await script.text()).toBe('document.title = "ok";');

    expect((await serveDemo(demoRequest(`/d/${id}`))).headers.get('location')).toBe(`${DEMO_ORIGIN}/d/${id}/`);
    expect((await serveDemo(demoRequest(`/d/${id}/README.md`))).status).toBe(404);
    expect((await serveDemo(demoRequest('/assets/index.js'))).status).toBe(404);
  });

  it('goes into a section as a block, renders as a frame, and survives a rebuild', async () => {
    const paperId = await paper();
    const cookie = await signUp('ada@ethz.ch');
    vi.stubGlobal('fetch', fakeGitHub());
    const body = { url: `https://github.com/${OWNER}/${REPO}/tree/main/dist` };
    const first = await api('POST', '/demos', { cookie, body });
    expect((await api('POST', '/demos', { cookie, body })).body.id).toBe(first.body.id);
    expect(await getDb().select().from(demoSnapshots)).toHaveLength(1);

    const content = `# Reproductions\n\n${demoBlockMarkdown({ id: first.body.id, title: 'Attention, in 3D', description: 'Rotate it.' })}`;
    const edit = await api('POST', '/pages/edit', {
      cookie,
      body: { paper: PAPER, baseOid: null, section: 0, content, summary: '' },
    });
    expect(edit.status).toBe(200);
    const [before] = await getDb().select().from(pageCurrent).where(eq(pageCurrent.paperId, paperId));
    expect(before.communityHtml).toContain(`<figure class="demo" data-demo="${first.body.id}">`);
    expect(before.communityHtml).toContain(`data-src="${DEMO_ORIGIN}/d/${first.body.id}/"`);
    expect(before.communityHtml).toContain(`${OWNER}/${REPO}/dist@${MAIN.slice(0, 7)}`);
    expect(before.communityHtml).toContain('<b>Demo:</b> Attention, in 3D. Rotate it.');

    await rebuildAllPages();
    const [after] = await getDb().select().from(pageCurrent).where(eq(pageCurrent.paperId, paperId));
    expect(after.communityHtml).toBe(before.communityHtml);
  });

  it('refuses a block naming a demo this site does not have', async () => {
    await paper();
    const cookie = await signUp('ada@ethz.ch');
    const content = demoBlockMarkdown({ id: 'e'.repeat(32), title: 'Made up' });
    const edit = await api('POST', '/pages/edit', {
      cookie,
      body: { paper: PAPER, baseOid: null, section: 0, content, summary: '' },
    });
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
