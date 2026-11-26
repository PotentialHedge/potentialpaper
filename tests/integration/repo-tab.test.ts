/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are checked field by field */
import { count, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { pageObjects } from '@/db/schema';
import { repoSource } from '@/server/pages/browse';
import { createPage, startRepo } from '@/server/pages/commit';
import { readCommit, readFiles, readHead } from '@/server/pages/repo';
import { firstCommitFiles } from '@/server/pages/starter';
import { savePaper } from '@/server/papers';
import { api, closePool, commitFiles, resetDatabase, signUp } from './helpers';

const PAPER = { scheme: 'arxiv', value: '1706.03762' } as const;

async function paper(): Promise<string> {
  return savePaper({
    title: 'Attention Is All You Need',
    authors: ['Ashish Vaswani', 'Noam Shazeer'],
    abstract: 'The dominant sequence transduction models are based on recurrence.',
    identifiers: [PAPER],
    source: 'arxiv',
    metadataLicense: 'CC0-1.0',
    abstractLicense: null,
  });
}

const folder = (path = '', page: { scheme: string; value: string } = PAPER) =>
  api('GET', `/repo?${new URLSearchParams({ ...page, path })}`);
const file = (path: string, page: { scheme: string; value: string } = PAPER) =>
  api('GET', `/repo/file?${new URLSearchParams({ ...page, path })}`);

const names = (body: any) => body.entries.map((e: { name: string }) => e.name);

async function objectCount(pageId: string): Promise<number> {
  const [row] = await getDb().select({ n: count() }).from(pageObjects).where(eq(pageObjects.pageId, pageId));
  return row.n;
}

afterAll(closePool);
beforeEach(resetDatabase);

describe('the Repo tab', () => {
  it('shows a paper with no repo the repo its first commit would start, writing nothing', async () => {
    const paperId = await paper();
    const top = await folder();
    expect(top.status).toBe(200);
    expect(top.body).toMatchObject({ placeholder: true, head: null, commits: 0, path: '' });
    // Folders first, then files.
    expect(names(top.body)).toEqual([
      '.potentialpaper',
      'community',
      'owners',
      '.gitattributes',
      'paper.json',
      'prek.toml',
      'README.md',
    ]);
    expect(top.body.entries.every((e: any) => e.last === null)).toBe(true);
    expect(top.body.readme.path).toBe('README.md');
    expect(top.body.readme.html).toContain("This is a paper's page");

    const paperJson = await file('paper.json');
    expect(paperJson.status).toBe(200);
    expect(paperJson.body.view.type).toBe('text');
    expect(JSON.parse(paperJson.body.view.text)).toMatchObject({
      title: 'Attention Is All You Need',
      authors: ['Ashish Vaswani', 'Noam Shazeer'],
      abstract: 'The dominant sequence transduction models are based on recurrence.',
    });
    const sections = await folder('community');
    expect(names(sections.body)).toContain('10-tl-dr.md');
    expect((await file('community/10-tl-dr.md')).body.view).toEqual({ type: 'text', text: '' });

    expect(await readHead(getDb(), paperId)).toBeNull();
    expect(await objectCount(paperId)).toBe(0);
  });

  it('builds the placeholder from what the first commit writes, to the same tree', async () => {
    const paperId = await paper();
    const placeholder = await repoSource(getDb(), paperId);
    expect(placeholder.head).toBeNull();
    const head = await startRepo(paperId);
    const commit = await readCommit(getDb(), paperId, head);
    // The same tree object: every path, every byte.
    expect(placeholder.root).toBe(commit.tree);
    const written = await readFiles(getDb(), paperId, commit.tree);
    expect([...written.keys()].sort()).toEqual((await firstCommitFiles(getDb(), paperId)).map(([p]) => p).sort());
  });

  it('browses a repo a folder and a file at a time, with each entry’s last commit', async () => {
    const paperId = await paper();
    const ada = await signUp('ada@ethz.ch');
    const first = await commitFiles(ada, PAPER, null, { 'community/10-tl-dr.md': '# Summary\nAttention.\n' }, 'Start');
    expect(first.status).toBe(200);
    const second = await commitFiles(
      ada,
      PAPER,
      first.body.head,
      { 'community/40-critique.md': 'Quadratic in **length**.\n' },
      'Add a critique',
    );
    expect(second.status).toBe(200);

    const top = await folder();
    expect(top.status).toBe(200);
    expect(top.body).toMatchObject({ placeholder: false, commits: 2 });
    expect(top.body.head).toMatchObject({ oid: second.body.head, seq: 2, summary: 'Add a critique' });
    const byName = new Map(top.body.entries.map((e: any) => [e.name, e]));
    expect((byName.get('community') as any).last).toMatchObject({ oid: second.body.head, summary: 'Add a critique' });
    expect((byName.get('owners') as any).last).toMatchObject({ summary: 'Start' });
    expect(byName.get('README.md') as any).toMatchObject({ type: 'file', lfs: false });
    expect((byName.get('README.md') as any).bytes).toBeGreaterThan(100);

    const community = await folder('community/');
    expect(community.body.path).toBe('community');
    expect(community.body.readme).toBeNull();
    const critique = community.body.entries.find((e: any) => e.name === '40-critique.md');
    expect(critique.last.summary).toBe('Add a critique');

    // A section shows as the page shows it.
    const shown = await file('community/40-critique.md');
    expect(shown.body.view.type).toBe('markdown');
    expect(shown.body.view.html).toContain('<strong>length</strong>');
    expect(shown.body.view.html).toContain('Critique');
    expect(shown.body.placeholder).toBe(false);

    expect((await file('community/nope.md')).status).toBe(404);
    expect((await folder('nope')).status).toBe(404);
    expect((await folder('community/../owners')).status).toBe(422);
    expect((await file('')).status).toBe(422);
    expect(await objectCount(paperId)).toBeGreaterThan(0);
  });

  it('shows a page of another kind, and nothing for a page that isn’t there', async () => {
    await createPage('venue', 'iclr/2027');
    const venue = await folder('', { scheme: 'venue', value: 'iclr/2027' });
    expect(venue.status).toBe(200);
    expect(venue.body).toMatchObject({ placeholder: false, commits: 1 });
    expect(names(venue.body)).toContain('README.md');
    expect(venue.body.readme.html).toContain("This is a venue's page");

    expect((await folder('', { scheme: 'venue', value: 'nowhere/2027' })).status).toBe(404);
  });
});
