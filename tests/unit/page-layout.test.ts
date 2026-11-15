import { describe, expect, it } from 'vitest';
import { linkChanges, versionChanges } from '@/server/pages/content';
import { htmlProblem, renderHtmlSection } from '@/server/pages/html';
import { planLayout, planLfs } from '@/server/pages/layout-migration';
import {
  contentProblem,
  GITATTRIBUTES,
  layoutProblem,
  parseLfsPointer,
  normalizePath,
  pathDenied,
  type PagePart,
  type Roles,
  sectionName,
} from '@/server/pages/rules';
import { joinSections, planSections, renderPart, sectionTitle, type SectionFile } from '@/server/pages/sections';

function sections(part: PagePart, files: Record<string, string>): SectionFile[] {
  return Object.entries(files).map(([name, text]) => {
    const path = `${part}/${name}`;
    return { path, name: sectionName(path, part)!, text };
  });
}

const NOBODY: Roles = { system: false, admin: false, verified: true, confirmedAuthor: false, claimed: false };

describe('the layout', () => {
  it('lets .potentialpaper/ start with a dot, at the top and spelled exactly so', () => {
    expect(normalizePath('.potentialpaper/metadata.json')).toEqual({ path: '.potentialpaper/metadata.json' });
    for (const path of ['.PotentialPaper/x.json', 'community/.potentialpaper/x', '.potentialpaper', '.git/config']) {
      expect(normalizePath(path)).toHaveProperty('problem');
    }
  });

  it('keeps the system dir to the system and admins', () => {
    expect(pathDenied('.potentialpaper/pdf.json', NOBODY)).toMatch(/only the system and admins/);
    expect(pathDenied('.potentialpaper/pdf.json', { ...NOBODY, admin: true })).toBeNull();
    expect(pathDenied('community/10-summary.md', NOBODY)).toBeNull();
    expect(pathDenied('links/10-code.json', { ...NOBODY, claimed: true })).toMatch(/confirmed authors/);
  });

  it('lets anyone verified write a demo folder, as the community section, and takes its files as they are', () => {
    expect(pathDenied('demos/spin/index.html', NOBODY)).toBeNull();
    expect(pathDenied('demos/spin/index.html', { ...NOBODY, verified: false })).toMatch(/institutional/);
    expect(pathDenied('demos/spin/index.html', { ...NOBODY, verified: false, system: true })).not.toBeNull();
    expect(contentProblem('demos/spin/index.html', '<script>alert(1)</script>')).toBeNull();
    expect(contentProblem('demos/spin/data.json', 'not json')).toBeNull();
    expect(contentProblem('demos/spin/app.js', 'x'.repeat(512 * 1024))).toBeNull();
    expect(contentProblem('demos/spin/app.js', 'x'.repeat(1024 * 1024 + 1))).toMatch(/larger/);
  });

  it('knows each file a page can hold by its name', () => {
    for (const path of [
      '.potentialpaper/metadata.json',
      'community/10-summary.md',
      'author/05-results.html',
      'versions/v_k3x9q2ab.json',
      'versions/arxiv-v2.json',
      'links/10-code.json',
      'thumbnail.json',
      'thumbnail.png',
      'thumbnail.webp',
      '.gitattributes',
      '.potentialpaper/paper.pdf',
      'versions/v_k3x9q2ab.pdf',
      'demos/attention-3d/index.html',
      'demos/attention-3d/assets/shader.glsl',
    ]) {
      expect(layoutProblem(path), path).toBeNull();
    }
    for (const path of [
      'community/page.md',
      'community/1-summary.md',
      'community/10-Summary.md',
      'community/10-summary.txt',
      'links/code.json',
      'versions/V1.json',
      'pdf.json',
      'thumbnail.svg',
      'versions/v_k3x9q2ab.png',
      'paper.pdf',
      'notes.md',
      'demos/index.html',
      'demos/Spin/index.html',
      'demos/spin/logo.png',
      'demos/spin/LICENSE',
    ]) {
      expect(layoutProblem(path), path).not.toBeNull();
    }
  });

  it('checks a version file, whose id is its name, and a link file', () => {
    expect(contentProblem('versions/v_k3x9q2ab.json', '{"kind":"preprint","label":"arXiv v1"}')).toBeNull();
    expect(contentProblem('versions/v_k3x9q2ab.json', '{"id":"v_x","kind":"preprint","label":"a"}')).toMatch(
      /file name/,
    );
    expect(contentProblem('versions/v_k3x9q2ab.json', '{"kind":"blog","label":"a"}')).toMatch(/kind/);
    expect(contentProblem('links/10-code.json', '{"label":"Code","url":"https://github.com/x/y"}')).toBeNull();
    expect(contentProblem('links/10-code.json', '{"label":"Code","url":"javascript:alert(1)"}')).not.toBeNull();
  });
});

describe('HTML sections', () => {
  it('refuses what the allowlist does not have, and says what', () => {
    expect(
      htmlProblem('<p>Fine <a href="https://x.org">link</a> <img src="https://x.org/a.png" alt=""></p>'),
    ).toBeNull();
    expect(htmlProblem('<table><tr><td colspan="2">x</td></tr></table>')).toBeNull();
    expect(htmlProblem('<script>alert(1)</script>')).toMatch(/<script>/);
    expect(htmlProblem('<p onclick="x()">a</p>')).toMatch(/onclick/);
    expect(htmlProblem('<p style="color:red">a</p>')).toMatch(/style/);
    expect(htmlProblem('<a href="java\nscript:alert(1)">a</a>')).toMatch(/javascript/);
    expect(htmlProblem('<img src="http://x.org/a.png">')).toMatch(/http:/);
    expect(htmlProblem('<a href="//evil.example">a</a>')).toMatch(/\/\//);
    expect(htmlProblem('<iframe src="https://x.org"></iframe>')).toMatch(/iframe/);
    expect(contentProblem('community/20-figure.html', '<style>p{}</style>')).toMatch(/style/);
  });

  it('renders as a section: its <h1> the heading, the rest two levels down, links marked', () => {
    const html = renderHtmlSection(
      '<h1>Results</h1><h2>Table</h2><p><a href="https://x.org">x</a></p>',
      'author',
      3,
      'X',
    );
    expect(html).toContain('<h3 id="author-3" data-section="3">Results</h3>');
    expect(html).toContain('<h4>Table</h4>');
    expect(html).toContain('rel="nofollow ugc noopener"');
    expect(renderHtmlSection('<p>Hi</p>', 'author', 1, 'Code and data')).toContain('>Code and data</h3>');
  });
});

describe('section files', () => {
  const part = sections('community', {
    '10-summary.md': '# Summary\nIt works.\n',
    '20-critique.md': 'Too slow.\n',
    '30-figure.html': '<h1>Figure</h1><p>x</p>',
  });

  it('render in order, a section each, titled by heading or by name', () => {
    const html = renderPart(part, 'community')!;
    expect(html.match(/data-section="(\d)"/g)).toEqual(['data-section="1"', 'data-section="2"', 'data-section="3"']);
    expect(part.map(sectionTitle)).toEqual(['Summary', 'Critique', 'Figure']);
    expect(renderPart([], 'community')).toBeNull();
  });

  it('join into one text that names every section', () => {
    expect(joinSections(part.slice(0, 2))).toBe('# Summary\nIt works.\n\n# Critique\n\nToo slow.\n');
  });

  it('change one file when one section is edited', () => {
    expect(planSections(part, 'community', 1, 2, [{ title: null, text: 'Fast enough.' }])).toEqual([
      { path: 'community/20-critique.md', content: 'Fast enough.\n' },
    ]);
  });

  it('remove a file when its section is emptied', () => {
    expect(planSections(part, 'community', 0, 1, [])).toEqual([{ path: 'community/10-summary.md', content: null }]);
  });

  it('get a new file between their neighbours for a new heading', () => {
    const changes = planSections(part, 'community', 0, 1, [
      { title: 'Summary', text: '# Summary\nIt works.\n' },
      { title: 'Why it matters', text: '# Why it matters\nSpeed.\n' },
    ]);
    expect(changes).toEqual([{ path: 'community/15-why-it-matters.md', content: '# Why it matters\nSpeed.\n' }]);
  });

  it('are numbered again in tens when there is no room or they move', () => {
    const tight = sections('community', { '10-a.md': '# A\n', '11-b.md': '# B\n' });
    const changes = planSections(tight, 'community', 0, 1, [
      { title: 'A', text: '# A\n' },
      { title: 'New', text: '# New\n' },
    ]);
    expect(changes).toEqual([
      { path: 'community/11-b.md', content: null },
      { path: 'community/20-new.md', content: '# New\n' },
      { path: 'community/30-b.md', content: '# B\n' },
    ]);
    // Swapped: both files move.
    const swapped = planSections(tight, 'community', 0, 2, [
      { title: 'B', text: '# B\n' },
      { title: 'A', text: '# A\n' },
    ]);
    expect(swapped.filter((c) => c.content !== null).map((c) => c.path)).toEqual([
      'community/10-b.md',
      'community/20-a.md',
    ]);
  });

  it('start an empty part in tens', () => {
    const changes = planSections([], 'author', 0, 0, [
      { title: 'TL;DR', text: '# TL;DR\n' },
      { title: 'Code and data', text: '# Code and data\n' },
    ]);
    expect(changes.map((c) => c.path)).toEqual(['author/10-tl-dr.md', 'author/20-code-and-data.md']);
  });
});

describe('versions and links as files', () => {
  it('write the versions that changed, and remove the ones gone', () => {
    const a = { id: 'v_aaaaaaaa', kind: 'preprint' as const, label: 'arXiv v1', date: '2026-01' };
    const b = { id: 'v_bbbbbbbb', kind: 'conference' as const, label: 'ICLR 2027' };
    const changes = versionChanges([a, b], [{ ...a, label: 'arXiv v1 (first)' }]);
    expect(changes).toEqual([
      { path: 'versions/v_bbbbbbbb.json', content: null },
      {
        path: 'versions/v_aaaaaaaa.json',
        content: '{\n  "date": "2026-01",\n  "kind": "preprint",\n  "label": "arXiv v1 (first)"\n}\n',
      },
    ]);
  });

  it('name links by their order and label', () => {
    const changes = linkChanges(
      ['links/10-old.json', 'thumbnail.json'],
      [
        { label: 'Code', url: 'https://github.com/x/y' },
        { label: 'Project page', url: 'https://x.org' },
      ],
    );
    expect(changes.map((c) => [c.path, c.content === null])).toEqual([
      ['links/10-old.json', true],
      ['links/10-code.json', false],
      ['links/20-project-page.json', false],
    ]);
  });
});

describe('moving a page to the layout', () => {
  it('moves every file of the first layout, and nothing twice', () => {
    const old = new Map([
      ['metadata.json', '{}\n'],
      ['pdf.json', '{"x":1}\n'],
      ['thumbnail.json', '{}\n'],
      ['links.json', '[{"label":"Code","url":"https://github.com/x/y"}]\n'],
      ['versions.jsonl', '{"id":"v_aaaaaaaa","kind":"preprint","label":"arXiv v1"}\n'],
      ['community/page.md', 'Intro.\n\n## Summary\nIt works.\n\n### Detail\nMore.\n\n## Critique\n```\n## code\n```\n'],
      ['author/resources.json', '{}\n'],
      ['notes.txt', 'x'],
    ]);
    const { changes, left } = planLayout(old);
    expect(left).toEqual(['notes.txt']);
    const written = Object.fromEntries(changes.filter((c) => c.content !== null).map((c) => [c.path, c.content]));
    expect(Object.keys(written).sort()).toEqual([
      '.potentialpaper/metadata.json',
      '.potentialpaper/pdf.json',
      'community/10-introduction.md',
      'community/20-summary.md',
      'community/30-critique.md',
      'links/10-code.json',
      'versions/v_aaaaaaaa.json',
    ]);
    expect(written['community/20-summary.md']).toBe('# Summary\nIt works.\n\n## Detail\nMore.\n');
    expect(written['community/30-critique.md']).toBe('# Critique\n```\n## code\n```\n');
    expect(
      changes
        .filter((c) => c.content === null)
        .map((c) => c.path)
        .sort(),
    ).toEqual([
      'author/resources.json',
      'community/page.md',
      'links.json',
      'metadata.json',
      'pdf.json',
      'versions.jsonl',
    ]);
    const moved = new Map(Object.entries(written) as [string, string][]);
    moved.set('thumbnail.json', '{}\n');
    expect(planLayout(moved).changes).toEqual([]);
  });
});

describe('the move to Git LFS', () => {
  const sha = (c: string) => c.repeat(64);
  const files = new Map([
    ['.potentialpaper/metadata.json', '{}\n'],
    [
      '.potentialpaper/pdf.json',
      JSON.stringify({
        sha256: sha('a'),
        bytes: 1000,
        url: 'https://pdfs.example.org/pdf/a.pdf',
        source: 'https://openreview.net/forum?id=x',
        license: 'CC BY 4.0',
        fetchedAt: '2026-10-06T17:26:50.147Z',
      }),
    ],
    [
      'thumbnail.json',
      JSON.stringify({
        sha256: sha('b'),
        bytes: 20,
        type: 'image/gif',
        url: 'https://pdfs.example.org/thumbnail/b.gif',
        alt: 'A cube',
      }),
    ],
    [
      'versions/v_k3x9q2ab.json',
      JSON.stringify({
        kind: 'workshop',
        label: 'SPIGM',
        pdf: { sha256: sha('c'), bytes: 30, url: 'https://pdfs.example.org/pdf/c.pdf', license: 'CC BY 4.0' },
      }),
    ],
    ['versions/v_9q2mfk3x.json', JSON.stringify({ kind: 'preprint', label: 'arXiv v1' })],
  ]);

  it('turns each pointer in JSON into a pointer file, and keeps the rest of the JSON', () => {
    const { changes, stored } = planLfs(files);
    const after = new Map(files);
    for (const change of changes) {
      if (change.content === null) after.delete(change.path);
      else after.set(change.path, change.content);
    }
    expect(after.get('.gitattributes')).toBe(GITATTRIBUTES);
    expect(parseLfsPointer(after.get('.potentialpaper/paper.pdf')!)).toEqual({ sha256: sha('a'), bytes: 1000 });
    expect(JSON.parse(after.get('.potentialpaper/pdf.json')!)).toEqual({
      source: 'https://openreview.net/forum?id=x',
      license: 'CC BY 4.0',
      fetchedAt: '2026-10-06T17:26:50.147Z',
    });
    expect(parseLfsPointer(after.get('thumbnail.gif')!)).toEqual({ sha256: sha('b'), bytes: 20 });
    expect(JSON.parse(after.get('thumbnail.json')!)).toEqual({ alt: 'A cube' });
    expect(parseLfsPointer(after.get('versions/v_k3x9q2ab.pdf')!)).toEqual({ sha256: sha('c'), bytes: 30 });
    expect(JSON.parse(after.get('versions/v_k3x9q2ab.json')!)).toEqual({
      kind: 'workshop',
      label: 'SPIGM',
      pdf: { license: 'CC BY 4.0' },
    });
    expect(changes.some((c) => c.path === 'versions/v_9q2mfk3x.json')).toBe(false);
    for (const [path, text] of after) expect(contentProblem(path, text), path).toBeNull();
    expect(stored.map((f) => [f.sha256[0], f.type, f.url])).toEqual([
      ['a', 'application/pdf', 'https://pdfs.example.org/pdf/a.pdf'],
      ['b', 'image/gif', 'https://pdfs.example.org/thumbnail/b.gif'],
      ['c', 'application/pdf', 'https://pdfs.example.org/pdf/c.pdf'],
    ]);
    expect(planLfs(after)).toEqual({ changes: [], stored: [] });
  });
});
