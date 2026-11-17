import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as gitRoute from '@/app/git/[...path]/route';
import { getDb } from '@/db';
import { accounts, lfsObjects, pageCurrent } from '@/db/schema';
import { setThumbnail } from '@/server/pages/card';
import { clonePath } from '@/server/pages/clone';
import { commitPage, SYSTEM_ACTOR } from '@/server/pages/commit';
import { gitIdentity } from '@/server/pages/receive';
import { readCommit, readFiles, readHead, readText } from '@/server/pages/repo';
import { GITATTRIBUTES } from '@/server/pages/rules';
import { savePaper } from '@/server/papers';
import { mintToken } from '@/server/tokens';
import { closePool, resetDatabase } from './helpers';

/**
 * Git LFS against the route in this process: the batch API, uploads and their checks, and with stock
 * `git lfs`, a clone that has the files and a push of a PDF and a picture. The `git lfs` part needs it
 * installed (on PATH, or in ~/.local/bin), and is skipped otherwise.
 */

beforeEach(resetDatabase);
afterAll(closePool);

const LFS_BIN = [join(homedir(), '.local/bin'), ...(process.env.PATH ?? '').split(':')].find((dir) =>
  existsSync(join(dir, 'git-lfs')),
);
const PATH = LFS_BIN ? `${LFS_BIN}:${process.env.PATH}` : process.env.PATH;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

// Bytes stored "in R2" go to files here in tests, served by the test server as the dev site serves them.
const storage = mkdtempSync(join(tmpdir(), 'lfs-storage-'));
const saved = { ...process.env };
process.env.EVIDENCE_FILES_DIR = join(storage, 'files');
process.env.THUMBNAILS_DIR = join(storage, 'thumbnails');
for (const key of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) delete process.env[key];

let server: Server;
let base: string;
const requests: string[] = [];

beforeAll(async () => {
  server = createServer(async (req, res) => {
    requests.push(`${req.method} ${req.url!.replace(/\?.*/, '')} ${req.headers.authorization ? 'auth' : 'anonymous'}`);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const stored = /^\/(files|thumbnails)\/([^/]+)$/.exec(req.url!);
    if (stored) {
      const path = join(storage, stored[1], stored[2]);
      res.writeHead(existsSync(path) ? 200 : 404);
      res.end(existsSync(path) ? readFileSync(path) : undefined);
      return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value);
    const hasBody = req.method === 'POST' || req.method === 'PUT';
    const request = new Request(new URL(req.url!, base), {
      method: req.method,
      headers,
      ...(hasBody ? { body: Buffer.concat(chunks) } : {}),
    });
    const handler = req.method === 'POST' ? gitRoute.POST : req.method === 'PUT' ? gitRoute.PUT : gitRoute.GET;
    const response = await handler(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) for await (const chunk of response.body) res.write(chunk);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The batch API's addresses are absolute, on the site's origin.
  process.env.APP_URL = base;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  process.env = saved;
  rmSync(storage, { recursive: true, force: true });
});

let count = 0;

async function newPaper() {
  count += 1;
  const id = { scheme: 'arxiv', value: `2202.${String(count).padStart(5, '0')}` } as const;
  const paperId = await savePaper({
    title: `Paper ${count}`,
    authors: ['Ada Lovelace'],
    abstract: 'An abstract.',
    year: 2022,
    venue: null,
    source: 'arxiv',
    metadataLicense: 'CC0-1.0',
    abstractLicense: 'CC0-1.0',
    identifiers: [id],
  });
  await commitPage(paperId, null, SYSTEM_ACTOR, [], 'Start the page');
  return { paperId, id };
}

async function newPusher() {
  count += 1;
  const [account] = await getDb()
    .insert(accounts)
    .values({ handle: `lfs-${count}`, verifiedAt: new Date() })
    .returning();
  const { token } = await mintToken({ account, name: 'git', scopes: ['push'] });
  return { actor: { kind: 'account', accountId: account.id, isAdmin: false } as const, token };
}

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const basic = (token: string) => `Basic ${Buffer.from(`me:${token}`).toString('base64')}`;

function batch(id: { scheme: 'arxiv'; value: string }, body: unknown, auth?: string) {
  return gitRoute.POST(
    new Request(`${base}${clonePath(id, '/info/lfs/objects/batch')}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/vnd.git-lfs+json',
        Accept: 'application/vnd.git-lfs+json',
        ...(auth ? { Authorization: auth } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

describe('the Git LFS batch API', () => {
  it('uploads a PDF for a pusher, checks its bytes, and then hands it out to anyone', async () => {
    const { id } = await newPaper();
    const { token } = await newPusher();
    const object = { oid: sha256(PDF), size: PDF.length };

    const anonymous = await batch(id, { operation: 'upload', objects: [object] });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toMatch(/^Basic /);

    const asked = await batch(id, { operation: 'upload', transfers: ['basic'], objects: [object] }, basic(token));
    expect(asked.status).toBe(200);
    expect(asked.headers.get('content-type')).toBe('application/vnd.git-lfs+json');
    const [upload] = (
      (await asked.json()) as { objects: { actions: { upload: { href: string; header: Record<string, string> } } }[] }
    ).objects;
    expect(upload.actions.upload.href).toBe(`${base}${clonePath(id, `/info/lfs/objects/${object.oid}`)}`);

    const put = (bytes: Buffer, oid = object.oid) =>
      gitRoute.PUT(
        new Request(`${base}${clonePath(id, `/info/lfs/objects/${oid}`)}`, {
          method: 'PUT',
          headers: upload.actions.upload.header,
          body: new Uint8Array(bytes),
        }),
      );
    expect((await put(Buffer.from('%PDF-1.4 something else'))).status).toBe(422);
    const text = Buffer.from('just some text');
    const notPdf = await put(text, sha256(text));
    expect(notPdf.status).toBe(422);
    expect(((await notPdf.json()) as { message: string }).message).toMatch(/only PDFs and pictures/);
    expect((await put(PDF)).status).toBe(200);
    const [row] = await getDb().select().from(lfsObjects).where(eq(lfsObjects.sha256, object.oid));
    expect(row).toMatchObject({ type: 'application/pdf', bytes: PDF.length });

    // Once there, an upload is skipped, and a download points at the bytes.
    const again = (await (await batch(id, { operation: 'upload', objects: [object] }, basic(token))).json()) as {
      objects: { actions?: unknown }[];
    };
    expect(again.objects[0].actions).toBeUndefined();
    const download = (await (
      await batch(id, { operation: 'download', objects: [object, { oid: 'f'.repeat(64), size: 1 }] })
    ).json()) as { objects: { actions?: { download: { href: string } }; error?: { code: number } }[] };
    expect(download.objects[0].actions!.download.href).toBe(`${base}${row.url}`);
    expect(download.objects[1].error!.code).toBe(404);
    expect(Buffer.from(await (await fetch(download.objects[0].actions!.download.href)).arrayBuffer())).toEqual(PDF);
  });

  it('says pages have no locks, as git lfs takes without a word', async () => {
    const { id } = await newPaper();
    const verify = await gitRoute.POST(
      new Request(`${base}${clonePath(id, '/info/lfs/locks/verify')}`, { method: 'POST', body: '{}' }),
    );
    expect(verify.status).toBe(501);
  });
});

describe('a page with Git LFS', () => {
  it('starts with .gitattributes, and the picture editor writes a pointer and its words', async () => {
    const { paperId } = await newPaper();
    const { actor } = await newPusher();
    await setThumbnail(paperId, actor, { image: GIF, alt: 'A dot' });
    const db = getDb();
    const files = await readFiles(db, paperId, (await readCommit(db, paperId, (await readHead(db, paperId))!)).tree);
    expect(await readText(db, paperId, files.get('.gitattributes'))).toBe(GITATTRIBUTES);
    expect(await readText(db, paperId, files.get('thumbnail.gif'))).toBe(
      `version https://git-lfs.github.com/spec/v1\noid sha256:${sha256(GIF)}\nsize ${GIF.length}\n`,
    );
    expect(JSON.parse((await readText(db, paperId, files.get('thumbnail.json')))!)).toEqual({ alt: 'A dot' });
    const [current] = await db.select().from(pageCurrent).where(eq(pageCurrent.pageId, paperId));
    expect(current.thumbnail).toMatchObject({ sha256: sha256(GIF), type: 'image/gif', alt: 'A dot' });
    expect(current.thumbnail!.url).toMatch(/^\/thumbnails\//);
  });
});

function git(args: string[], cwd: string, env: Record<string, string> = {}): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-c', 'credential.helper=', ...args],
      {
        cwd,
        timeout: 60_000,
        env: {
          ...process.env,
          PATH: PATH!,
          HOME: cwd,
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: '',
          GIT_CONFIG_NOSYSTEM: '1',
          ...env,
        },
      },
      (err, stdout, stderr) => resolve({ ok: !err, output: `${stdout}${stderr}`.replace(/[ \t]+$/gm, '') }),
    );
  });
}

describe.skipIf(!LFS_BIN)('git lfs, end to end', () => {
  it('pushes a version PDF and a picture, and a fresh clone has them as files', async () => {
    const { paperId, id } = await newPaper();
    const { actor, token } = await newPusher();
    const { name } = await gitIdentity(paperId, actor);
    const home = tempDir('lfs-home-');
    expect(await git(['lfs', 'install'], home)).toMatchObject({ ok: true });
    const clone = join(home, 'page');
    expect(await git(['clone', '-q', `${base}${clonePath(id)}`, clone], home)).toMatchObject({ ok: true });
    for (const [key, value] of [
      ['remote.origin.pushurl', `${base.replace('//', `//me:${token}@`)}${clonePath(id)}`],
      ['user.name', name],
      ['user.email', `${name}@users.invalid`],
      ['commit.gpgsign', 'false'],
    ]) {
      execFileSync('git', ['config', key, value], { cwd: clone });
    }
    mkdirSync(join(clone, 'versions'), { recursive: true });
    writeFileSync(join(clone, 'versions/v_camready.json'), '{ "kind": "camera-ready", "label": "ICLR 2027" }\n');
    writeFileSync(join(clone, 'versions/v_camready.pdf'), PDF);
    writeFileSync(join(clone, 'thumbnail.gif'), GIF);
    writeFileSync(join(clone, 'thumbnail.json'), '{ "caption": "A dot" }\n');
    await git(['add', '-A'], clone, { HOME: home });
    expect(await git(['commit', '-q', '-m', 'Add the camera-ready'], clone, { HOME: home })).toMatchObject({
      ok: true,
    });
    // Stored as pointers, as .gitattributes says.
    expect((await git(['show', 'HEAD:thumbnail.gif'], clone, { HOME: home })).output).toMatch(
      /^version https:\/\/git-lfs/,
    );

    requests.length = 0;
    const pushed = await git(['push', 'origin', 'main'], clone, { HOME: home });
    expect(pushed).toMatchObject({ ok: true });
    expect(pushed.output).not.toMatch(/[Ll]ocking/);
    expect(requests.some((r) => r.startsWith('PUT ') && r.includes('/info/lfs/objects/'))).toBe(true);
    const [current] = await getDb().select().from(pageCurrent).where(eq(pageCurrent.pageId, paperId));
    expect(current.thumbnail).toMatchObject({ sha256: sha256(GIF), caption: 'A dot' });
    expect(current.versions![0]).toMatchObject({ id: 'v_camready', pdf: { sha256: sha256(PDF), bytes: PDF.length } });

    const again = join(home, 'again');
    expect(await git(['clone', '-q', `${base}${clonePath(id)}`, again], home, { HOME: home })).toMatchObject({
      ok: true,
    });
    expect(readFileSync(join(again, 'versions/v_camready.pdf'))).toEqual(PDF);
    expect(readFileSync(join(again, 'thumbnail.gif'))).toEqual(GIF);
  });

  it('refuses a PDF committed without Git LFS, saying what to do', async () => {
    const { paperId, id } = await newPaper();
    const { actor, token } = await newPusher();
    const { name } = await gitIdentity(paperId, actor);
    const home = tempDir('lfs-none-');
    const clone = join(home, 'page');
    // No `git lfs install` in this home: the filter isn't set up, so git stores the bytes.
    expect(await git(['clone', '-q', `${base}${clonePath(id)}`, clone], home)).toMatchObject({ ok: true });
    for (const [key, value] of [
      ['remote.origin.pushurl', `${base.replace('//', `//me:${token}@`)}${clonePath(id)}`],
      ['user.name', name],
      ['user.email', `${name}@users.invalid`],
    ]) {
      execFileSync('git', ['config', key, value], { cwd: clone });
    }
    mkdirSync(join(clone, 'versions'), { recursive: true });
    writeFileSync(join(clone, 'versions/v_x.json'), '{ "kind": "other", "label": "x" }\n');
    writeFileSync(join(clone, 'versions/v_x.pdf'), PDF);
    await git(['add', '-A'], clone);
    await git(['commit', '-q', '-m', 'Add a PDF'], clone);
    const pushed = await git(['push', 'origin', 'main'], clone);
    expect(pushed.ok).toBe(false);
    expect(pushed.output).toContain('versions/v_x.pdf has to be a Git LFS pointer');
  });
});
