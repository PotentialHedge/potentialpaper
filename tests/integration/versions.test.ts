import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { pageCurrent, pageEvents, pdfDocuments } from '@/db/schema';
import { historyWithHandles } from '@/server/pages/edit';
import { rebuildAllPages } from '@/server/pages/projections';
import { savePaper } from '@/server/papers';
import { compareVersions } from '@/server/versions';
import { api, closePool, resetDatabase, signUp } from './helpers';

process.env.EVIDENCE_FILES_DIR = mkdtempSync(join(tmpdir(), 'evidence-'));

const PAPER = { scheme: 'openreview', value: 'dskf2Ppd9o' } as const;

async function paper(): Promise<string> {
  return savePaper({
    title: 'Recursive Scaling in Masked Diffusion Models',
    authors: [],
    abstract: 'Masked diffusion models apply a transformer.',
    year: 2027,
    venue: null,
    identifiers: [PAPER],
    source: 'openreview',
    metadataLicense: 'CC0-1.0',
    abstractLicense: 'CC0-1.0',
  });
}

function pdfFile(text: string, name = 'paper.pdf'): File {
  return new File([`%PDF-1.4\n% ${text}\n%%EOF\n`], name, { type: 'application/pdf' });
}

async function uploadPdf(cookie: string, text: string) {
  const form = new FormData();
  form.set('file', pdfFile(text));
  const res = await api('POST', '/files', { cookie, form });
  expect(res.status).toBe(201);
  return res.body as { url: string; sha256: string; type: string };
}

beforeEach(resetDatabase);
afterAll(closePool);

describe('versions', () => {
  it('are added with PDFs and evidence, merge with edits to other versions, and compare', async () => {
    const paperId = await paper();
    const ada = await signUp('ada@ethz.ch');
    const bob = await signUp('bob@ethz.ch');

    const workshopPdf = await uploadPdf(ada, 'workshop');
    expect(workshopPdf.type).toBe('application/pdf');
    const [doc] = await getDb().select().from(pdfDocuments).where(eq(pdfDocuments.sha256, workshopPdf.sha256));
    expect(doc?.url).toBe(workshopPdf.url);

    const opened = await api('GET', `/pages/versions?scheme=${PAPER.scheme}&value=${PAPER.value}`);
    expect(opened.body).toEqual({ head: null, versions: [] });

    const first = await api('POST', '/pages/versions', {
      cookie: ada,
      body: {
        paper: PAPER,
        baseOid: null,
        versions: [
          {
            label: 'SPIGM @ ICML 2026',
            kind: 'submitted',
            date: '2026-04-29',
            submissions: [{ venue: 'SPIGM @ ICML 2026', status: 'accepted', decision: 'Poster' }],
            url: 'https://openreview.net/forum?id=zI2IeuDcoS',
            pdf: { url: workshopPdf.url },
            evidence: ['https://openreview.net/group?id=ICML.cc/2026/Workshop/SPIGM'],
          },
          {
            label: 'ICLR 2027',
            kind: 'submitted',
            date: '2026-09-11',
            submissions: [{ venue: 'ICLR 2027', status: 'under_review' }],
          },
        ],
        evidence: ['https://openreview.net/forum?id=zI2IeuDcoS'],
      },
    });
    expect(first.status).toBe(200);
    const { body: loaded } = await api('GET', `/pages/versions?scheme=${PAPER.scheme}&value=${PAPER.value}`);
    expect(loaded.head).toBe(first.body.head);
    expect(loaded.versions.map((v: { label: string }) => v.label)).toEqual(['SPIGM @ ICML 2026', 'ICLR 2027']);
    const [workshop, iclr] = loaded.versions;
    expect(workshop.pdf).toMatchObject({ sha256: workshopPdf.sha256, url: workshopPdf.url });

    // Bob marks ICLR accepted while Ada, from the same base, adds a note to the workshop: both stay.
    const bobs = await api('POST', '/pages/versions', {
      cookie: bob,
      body: {
        paper: PAPER,
        baseOid: loaded.head,
        versions: [
          workshop,
          { ...iclr, submissions: [{ venue: 'ICLR 2027', status: 'accepted', decision: 'Poster' }] },
        ],
      },
    });
    expect(bobs.status).toBe(200);
    const adas = await api('POST', '/pages/versions', {
      cookie: ada,
      body: {
        paper: PAPER,
        baseOid: loaded.head,
        versions: [{ ...workshop, note: 'Four pages; the first experiments.' }, iclr],
      },
    });
    expect(adas.status).toBe(200);
    expect(adas.body.merged).toBe(true);
    const [row] = await getDb().select().from(pageCurrent).where(eq(pageCurrent.pageId, paperId));
    expect(row.versions?.map((v) => [v.label, v.submissions?.[0].status, v.note ?? null])).toEqual([
      ['SPIGM @ ICML 2026', 'accepted', 'Four pages; the first experiments.'],
      ['ICLR 2027', 'accepted', null],
    ]);

    // The evidence is in the commit, its history row and its event, and survives a rebuild.
    const history = async () => (await historyWithHandles(paperId)).reverse();
    expect((await history())[0]).toMatchObject({
      summary: 'Add the versions “SPIGM @ ICML 2026”, “ICLR 2027”',
      evidence: ['https://openreview.net/forum?id=zI2IeuDcoS'],
    });
    const [event] = await getDb().select().from(pageEvents).where(eq(pageEvents.pageId, paperId)).limit(1);
    expect(event.payload.evidence).toEqual(['https://openreview.net/forum?id=zI2IeuDcoS']);
    await rebuildAllPages();
    expect((await history())[0].evidence).toEqual(['https://openreview.net/forum?id=zI2IeuDcoS']);

    // Comparing waits for the text, then diffs it.
    const iclrPdf = await uploadPdf(bob, 'iclr');
    const third = await api('POST', '/pages/versions', {
      cookie: bob,
      body: {
        paper: PAPER,
        baseOid: adas.body.head,
        versions: row.versions!.map((v) => (v.label === 'ICLR 2027' ? { ...v, pdf: { url: iclrPdf.url } } : v)),
      },
    });
    expect(third.status).toBe(200);
    const ids = { a: row.versions![0].id, b: row.versions![1].id };
    const meta = { title: 'Recursive Scaling in Masked Diffusion Models', abstract: null };
    expect((await compareVersions(paperId, ids, meta))?.text).toEqual({ status: 'pending' });
    await getDb()
      .update(pdfDocuments)
      .set({ fullText: 'Recursion helps. It helps a little.' })
      .where(eq(pdfDocuments.sha256, workshopPdf.sha256));
    await getDb()
      .update(pdfDocuments)
      .set({ fullText: 'Recursion helps. It helps a lot.' })
      .where(eq(pdfDocuments.sha256, iclrPdf.sha256));
    const compared = await compareVersions(paperId, ids, meta);
    expect(compared?.text).toMatchObject({ status: 'diff', diff: { stats: { removed: 1, added: 1, unchanged: 1 } } });
  });

  it('refuse a PDF that was not stored here, bad evidence, and the unverified', async () => {
    await paper();
    const ada = await signUp('ada@ethz.ch');
    const version = { label: 'arXiv v1', kind: 'preprint' };
    const foreign = await api('POST', '/pages/versions', {
      cookie: ada,
      body: { paper: PAPER, baseOid: null, versions: [{ ...version, pdf: { url: 'https://evil.example/x.pdf' } }] },
    });
    expect(foreign.status).toBe(422);
    expect(foreign.body.error.message).toMatch(/uploaded or copied here/);
    const badEvidence = await api('POST', '/pages/versions', {
      cookie: ada,
      body: { paper: PAPER, baseOid: null, versions: [version], evidence: ['javascript:alert(1)'] },
    });
    expect(badEvidence.status).toBe(422);
    const anonymous = await api('POST', '/pages/versions', {
      body: { paper: PAPER, baseOid: null, versions: [version] },
    });
    expect(anonymous.status).toBe(401);
    const html = new FormData();
    html.set('file', new File(['<html><script>x</script></html>'], 'x.html'));
    expect((await api('POST', '/files', { cookie: ada, form: html })).status).toBe(422);
  });
});
