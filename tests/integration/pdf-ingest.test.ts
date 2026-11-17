import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { authorClaims, pageCurrent, pageObjects, pdfDocuments } from '@/db/schema';
import { getPaper, search } from '@/server/api/handlers';
import { claimByEmail, ownAddressesOnPaper } from '@/server/claims';
import { commitPage, SYSTEM_ACTOR } from '@/server/pages/commit';
import { readHead } from '@/server/pages/repo';
import { recordLfsObject } from '@/server/lfs';
import { encodeLfsPointer, PAPER_PDF_PATH, PDF_PATH, versionPath, versionPdfPath } from '@/server/pages/rules';
import { savePaper } from '@/server/papers';
import { ingest, MAX_ATTEMPTS } from '@/server/pdfs/ingest';
import { ORIGIN, api, closePool, lastMailTo, resetDatabase, signUp } from './helpers';

/**
 * These tests run poppler (\`pdftotext\`, \`pdftoppm\`). A machine without it skips them, saying so; CI installs it
 * (\`.github/workflows/ci.yml\`) and never skips.
 */
const HAS_POPPLER = spawnSync('pdftotext', ['-v']).error === undefined;
if (!HAS_POPPLER && process.env.CI) throw new Error('pdftotext is missing: CI must install poppler-utils');
if (!HAS_POPPLER) console.warn('pdf-ingest: skipped, poppler (pdftotext) is not installed here');
const describePoppler = describe.skipIf(!HAS_POPPLER);

const PAPER = { scheme: 'arxiv', value: '1706.03762' } as const;
const AUTHORS = ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar'];
/** The addresses printed on the test PDF's first page. */
const ON_PAPER = ['ashish@ethz.ch', 'noam@ethz.ch', 'niki@inf.ethz.ch', 'brain-team@ethz.ch'];

/** A one-page PDF with these lines of text, in Helvetica: enough for pdftotext and pdftoppm. */
function tinyPdf(lines: string[]): Buffer {
  const escape = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const content = `BT /F1 11 Tf 14 TL 72 720 Td ${lines.map((l) => `(${escape(l)}) '`).join(' ')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const PDF = tinyPdf([
  'Attention Is All You Need',
  'Ashish Vaswani*  Noam Shazeer*  Niki Parmar',
  'Google Brain',
  '{ashish, noam}@ethz.ch',
  'niki@inf.ethz.ch',
  'Contact: brain-team@ethz.ch',
  'Abstract. We measure pass@1 and NDCG@10.',
]);
const SHA = createHash('sha256').update(PDF).digest('hex');

let pdfDir: string;
let coversDir: string;
beforeAll(() => {
  pdfDir = mkdtempSync(join(tmpdir(), 'pdfs-'));
  coversDir = mkdtempSync(join(tmpdir(), 'covers-'));
  writeFileSync(join(pdfDir, `${SHA}.pdf`), PDF);
  process.env.COVERS_DIR = coversDir;
});
afterAll(async () => {
  rmSync(pdfDir, { recursive: true, force: true });
  rmSync(coversDir, { recursive: true, force: true });
  await closePool();
});
beforeEach(resetDatabase);

async function paperWithPdf(sha256 = SHA, url = `https://pdfs.invalid/pdf/${SHA}.pdf`): Promise<string> {
  const paperId = await savePaper({
    title: 'Attention Is All You Need',
    authors: AUTHORS,
    abstract: null,
    year: 2017,
    venue: null,
    identifiers: [PAPER],
    source: 'arxiv',
    metadataLicense: 'CC0-1.0',
    abstractLicense: null,
  });
  const source = {
    source: 'https://arxiv.org/abs/1706.03762',
    license: 'CC BY 4.0',
    fetchedAt: '2026-11-08T00:00:00Z',
  };
  await recordLfsObject(getDb(), { sha256, bytes: PDF.length, url, type: 'application/pdf' });
  await commitPage(
    paperId,
    await readHead(getDb(), paperId),
    SYSTEM_ACTOR,
    [
      { path: PAPER_PDF_PATH, content: encodeLfsPointer({ sha256, bytes: PDF.length }) },
      { path: PDF_PATH, content: `${JSON.stringify(source, null, 2)}\n` },
    ],
    'Add the PDF',
  );
  return paperId;
}

const claim = (cookie: string, authorIndex: number) =>
  api('POST', '/claims', { cookie, body: { paper: PAPER, authorIndex, evidence: '' } });

async function claimRow(paperId: string, authorIndex: number) {
  const rows = await getDb().select().from(authorClaims).where(eq(authorClaims.paperId, paperId));
  return rows.find((r) => r.authorIndex === authorIndex) ?? null;
}

describePoppler('pdfs:ingest', () => {
  it('runs every stage once, and a second run has nothing to do', async () => {
    const paperId = await paperWithPdf();
    const first = await ingest({ pdfDir });
    expect(first).toEqual({
      documents: 1,
      stages: {
        text: { done: 1, failed: 0 },
        emails: { done: 1, failed: 0 },
        // Only a version's PDF has its whole text read.
        fulltext: { done: 0, failed: 0 },
        cover: { done: 1, failed: 0 },
      },
    });
    const [doc] = await getDb().select().from(pdfDocuments).where(eq(pdfDocuments.sha256, SHA));
    expect(doc.pages).toBe(1);
    expect(doc.bytes).toBe(PDF.length);
    expect(doc.firstPageRaw).toContain('Google Brain');
    expect(doc.emails.sort()).toEqual([...ON_PAPER].sort());
    expect(doc.coverUrl).toBe(`/covers/${SHA}.jpg`);
    expect(Object.keys(doc.stages).sort()).toEqual(['cover', 'emails', 'text']);
    expect(doc.fullText).toBeNull();

    expect((await ingest({ pdfDir })).documents).toBe(0);

    // Once a version points at it, its text is read for comparing versions, and nothing else runs again.
    const version = { label: 'arXiv v1', kind: 'preprint' };
    await commitPage(
      paperId,
      await readHead(getDb(), paperId),
      SYSTEM_ACTOR,
      [
        { path: versionPath('v_abcdefgh'), content: `${JSON.stringify(version)}\n` },
        { path: versionPdfPath('v_abcdefgh'), content: encodeLfsPointer({ sha256: SHA, bytes: PDF.length }) },
      ],
      'Add a version',
    );
    expect((await ingest({ pdfDir })).stages).toMatchObject({ text: { done: 0 }, fulltext: { done: 1, failed: 0 } });
    const [read] = await getDb().select().from(pdfDocuments).where(eq(pdfDocuments.sha256, SHA));
    expect(read.fullText).toContain('Attention Is All You Need');
    expect((await ingest({ pdfDir })).documents).toBe(0);
    // --stage … --force reruns only that stage; --sha reruns all of one PDF's.
    expect((await ingest({ pdfDir, stages: ['emails'], force: true })).stages).toEqual({
      emails: { done: 1, failed: 0 },
    });
    expect((await ingest({ pdfDir, sha256: SHA })).stages.text.done).toBe(1);
  });

  it('records a failure, waits before retrying it, and gives up after a few attempts', async () => {
    const missing = 'b'.repeat(64);
    await paperWithPdf(missing, 'https://127.0.0.1:9/nothing.pdf');
    const report = await ingest({ pdfDir });
    expect(report.stages.text).toEqual({ done: 0, failed: 1 });
    // The emails stage waits for the text it reads.
    expect(report.stages.emails).toEqual({ done: 0, failed: 0 });
    const [doc] = await getDb().select().from(pdfDocuments).where(eq(pdfDocuments.sha256, missing));
    expect(doc.stages.text).toMatchObject({ failedVersion: 1, attempts: 1 });
    expect(doc.stages.text.version).toBeUndefined();
    // Not due again until its retry time.
    expect((await ingest({ pdfDir })).documents).toBe(0);

    await getDb().execute(sql`
      update pdf_documents set stages = jsonb_set(stages, '{text,retryAt}', '"2000-01-01T00:00:00Z"')
       where sha256 = ${missing}`);
    expect((await ingest({ pdfDir })).stages.text.failed).toBe(1);
    await getDb().execute(sql`
      update pdf_documents set stages = jsonb_set(stages, '{text}', ${JSON.stringify({
        failedVersion: 1,
        attempts: MAX_ATTEMPTS,
        retryAt: '2000-01-01T00:00:00Z',
      })}::jsonb) where sha256 = ${missing}`);
    expect((await ingest({ pdfDir })).documents).toBe(0);
  }, 30_000);
});

describePoppler('authors by an email on the first page', () => {
  it('makes an account the author when it signs up, if its address says which one, with no claim', async () => {
    const paperId = await paperWithPdf();
    await ingest({ pdfDir });
    await signUp('ashish@ethz.ch');
    expect(await claimRow(paperId, 0)).toMatchObject({
      authorName: 'Ashish Vaswani',
      status: 'confirmed',
      method: 'email',
      verification: { email: 'ashish@ethz.ch', sha256: SHA },
    });
    // An account whose address isn't on the paper gets nothing, and its claim waits for an admin.
    const stranger = await signUp('someone@ethz.ch');
    expect(await claimRow(paperId, 1)).toBeNull();
    expect((await claim(stranger, 1)).body.claim).toMatchObject({ status: 'pending', method: 'manual' });
    // Nobody can take an author who is confirmed.
    expect((await claim(stranger, 0)).status).toBe(409);
  });

  it('makes existing accounts authors once ingest reads the PDF, or once they confirm the address', async () => {
    const paperId = await paperWithPdf();
    await signUp('noam@ethz.ch');
    const niki = await signUp('niki@ethz.ch');
    expect(await claimRow(paperId, 1)).toBeNull();

    await ingest({ pdfDir });
    expect(await claimRow(paperId, 1)).toMatchObject({ authorName: 'Noam Shazeer', status: 'confirmed' });
    // Niki's address on the paper isn't the one she signed up with.
    expect(await claimRow(paperId, 2)).toBeNull();

    const added = await api('POST', '/me/affiliations', { cookie: niki, body: { email: 'niki@inf.ethz.ch' } });
    expect(added.status).toBe(201);
    // An address added but not confirmed proves nothing.
    await claimByEmail({});
    expect(await claimRow(paperId, 2)).toBeNull();
    const code = /\b(\d{6})\b/.exec(lastMailTo('niki@inf.ethz.ch')!.subject)![1];
    const verified = await api('POST', `/me/affiliations/${added.body.id}/verify`, { cookie: niki, body: { code } });
    expect(verified.status).toBe(200);
    expect(await claimRow(paperId, 2)).toMatchObject({
      authorName: 'Niki Parmar',
      status: 'confirmed',
      verification: { email: 'niki@inf.ethz.ch', sha256: SHA },
    });
  });

  it('confirms at once a claim from an address that says no name, and a pending one once ingest reads it', async () => {
    const paperId = await paperWithPdf();
    const team = await signUp('brain-team@ethz.ch');
    // Claimed before the PDF was read: pending, then confirmed by ingest as the author it picked.
    expect((await claim(team, 2)).body.claim.status).toBe('pending');
    await ingest({ pdfDir });
    expect(await claimRow(paperId, 2)).toMatchObject({ status: 'confirmed', method: 'email' });

    // After ingest, a claim from an address on the paper is confirmed when made.
    const other = await api('DELETE', `/claims?${new URLSearchParams(PAPER)}`, { cookie: team });
    expect(other.status).toBe(200);
    expect((await claim(team, 1)).body.claim).toMatchObject({ status: 'confirmed', method: 'email' });
  });

  it('lets an automatic author step down, and does not make them the author again', async () => {
    const paperId = await paperWithPdf();
    await ingest({ pdfDir });
    const ashish = await signUp('ashish@ethz.ch');
    const query = new URLSearchParams(PAPER);
    expect((await api('DELETE', `/claims?${query}`, { cookie: ashish })).status).toBe(200);
    expect(await claimRow(paperId, 0)).toMatchObject({ status: 'declined' });

    await ingest({ pdfDir, stages: ['emails'], force: true });
    await claimByEmail({});
    expect(await claimRow(paperId, 0)).toMatchObject({ status: 'declined' });
    // Claiming again is up to them.
    expect((await claim(ashish, 0)).body.claim).toMatchObject({ status: 'confirmed', method: 'email' });
  });

  it('never shows the PDF’s addresses, in an endpoint, the page’s data or its repo', async () => {
    const paperId = await paperWithPdf();
    await ingest({ pdfDir });
    const stranger = await signUp('someone@ethz.ch');
    const ashish = await signUp('ashish@ethz.ch');
    const team = await signUp('brain-team@ethz.ch');
    const query = new URLSearchParams(PAPER);
    const responses: unknown[] = [];
    responses.push((await claim(stranger, 1)).body, (await claim(team, 2)).body);
    for (const cookie of [stranger, ashish, team]) {
      responses.push((await api('GET', `/claims?${query}`, { cookie })).body);
    }
    responses.push((await api('GET', '/me', { cookie: stranger })).body);
    const paper = await getPaper(new Request(new URL(`/api/v1/papers/arxiv/1706.03762`, ORIGIN)), {
      params: Promise.resolve({ scheme: 'arxiv', value: ['1706.03762'] }),
    });
    responses.push(await paper.json());
    const found = await search(new Request(new URL(`/api/v1/search?q=attention`, ORIGIN)), {
      params: Promise.resolve({}),
    });
    responses.push(await found.json());
    const [current] = await getDb().select().from(pageCurrent).where(eq(pageCurrent.pageId, paperId));
    responses.push(current);
    const objects = await getDb().select().from(pageObjects).where(eq(pageObjects.pageId, paperId));
    responses.push(objects.map((o) => o.body.toString('latin1')).join('\n'));

    const visible = JSON.stringify(responses);
    expect(visible).toContain('Attention Is All You Need');
    for (const email of ON_PAPER) expect(visible).not.toContain(email);
    for (const name of ['ashish', 'noam', 'niki', 'brain-team']) expect(visible).not.toContain(`${name}@`);

    // The claim page learns only which of the viewer's own addresses are on the paper.
    const [strangerId, ashishId] = await Promise.all(
      [stranger, ashish].map(async (cookie) => (await api('GET', '/me', { cookie })).body.id as string),
    );
    expect(await ownAddressesOnPaper(paperId, strangerId)).toEqual({
      own: ['someone@ethz.ch'],
      onPaper: [],
      hasPdfEmails: true,
    });
    expect((await ownAddressesOnPaper(paperId, ashishId)).onPaper).toEqual(['ashish@ethz.ch']);
  });
});
