import { describe, expect, it } from 'vitest';
import { parseLinkFile } from '@/lib/paper-links';
import { parseVersionFile } from '@/lib/versions';
import { contentProblem, layoutProblem, parseThumbnailWords, pathDenied } from '@/server/pages/rules';
import { PAGE_SCHEMA_NAMES, pageJsonSchema } from '@/server/pages/schemas';
import {
  missingStarterFiles,
  prekConfig,
  prekProblem,
  readme,
  readmeProblem,
  starterFiles,
} from '@/server/pages/starter';

const roles = { system: false, admin: false, verified: true, owner: false, claimed: false };

describe('page file schemas', () => {
  it('makes a closed JSON Schema for each kind of file, with its fields described', () => {
    for (const name of PAGE_SCHEMA_NAMES) {
      const schema = pageJsonSchema(name, 'https://example.org');
      expect(schema.$id).toBe(`https://example.org/schemas/${name}.json`);
      expect(schema.type).toBe('object');
      expect(schema.additionalProperties).toBe(false);
      for (const field of Object.values(schema.properties as Record<string, { description?: string }>)) {
        expect(field.description).toBeTruthy();
      }
    }
    const version = pageJsonSchema('version') as {
      required: string[];
      properties: Record<string, { enum?: string[] }>;
    };
    expect(version.required).toEqual(['label', 'kind']);
    expect(version.properties.kind.enum).toContain('submitted');
    expect(version.properties.kind.enum).not.toContain('workshop');
    expect(Object.keys(version.properties)).toContain('submissions');
    expect(Object.keys(version.properties)).not.toContain('status');
  });

  it('checks files with the same definitions', () => {
    expect(parseLinkFile('{"label":" Code ","url":"https://github.com/o/r"}')).toEqual({
      label: 'Code',
      url: 'https://github.com/o/r',
    });
    expect(parseLinkFile('{"label":"[x]","url":"https://a.org"}')).toBeNull();
    expect(parseLinkFile('{"label":"Code","url":"javascript:alert(1)"}')).toBeNull();
    expect(parseLinkFile('{"label":"Code","url":"https://a.org","extra":1}')).toBeNull();

    expect(parseVersionFile('v_a', '{"label":"arXiv v1","kind":"preprint","date":"2026-05"}')).toMatchObject({
      version: { id: 'v_a', label: 'arXiv v1' },
    });
    expect(parseVersionFile('v_a', '{"label":"x","kind":"blog"}')).toEqual({ problem: expect.stringMatching(/kind/) });
    expect(parseVersionFile('v_a', '{"label":"x","kind":"other","pdf":{"sha256":"0"}}')).toEqual({
      problem: expect.stringMatching(/pdf\.sha256/),
    });
    expect(parseVersionFile('v_a', '{"label":"x","kind":"other","what":1}')).toEqual({
      problem: 'has an unknown field “what”',
    });

    expect(parseThumbnailWords('{"alt":"","caption":"A plot"}')).toEqual({ caption: 'A plot' });
  });
});

describe('starter files', () => {
  it('starts a page with prek.toml and empty sections', () => {
    const files = new Map(starterFiles('paper', 'A paper'));
    expect(files.get('prek.toml')).toBe(prekConfig());
    expect(files.get('community/10-tl-dr.md')).toBe('');
    expect(files.get('owners/10-tl-dr.md')).toBe('');
    for (const path of files.keys()) expect(layoutProblem(path)).toBeNull();
  });

  it('checks each writable JSON file against its schema on the site, and keeps prek.toml fixed', () => {
    const config = prekConfig('https://papers.example.org');
    for (const name of ['link', 'version', 'thumbnail']) {
      expect(config).toContain(`https://papers.example.org/schemas/${name}.json`);
    }
    // Files only the system or a bot writes aren't people's to check.
    for (const name of ['pdf', 'submission', 'forms', 'note']) expect(config).not.toContain(`schemas/${name}.json`);
    expect(prekProblem(prekConfig())).toBeNull();
    expect(prekProblem(`${prekConfig()}\n[[repos]]\nrepo = "local"\n`)).toMatch(/fixed/);
    expect(pathDenied('prek.toml', roles)).toMatch(/system/);
    expect(contentProblem('community/10-summary.md', '')).toBeNull();
  });

  it('starts every page with a README.md, fixed but for its title, that says how its repo is laid out', () => {
    const files = new Map(starterFiles('paper', 'Attention Is All You Need'));
    const paper = readme('paper', 'Attention Is All You Need');
    expect(files.get('README.md')).toBe(paper);
    expect(paper).toMatch(/^# Attention Is All You Need\n\n/);
    expect(paper).toMatch(/```text\n\.\n├── paper\.json +title, authors, abstract\n/);
    expect(paper).toMatch(/├── community\//);
    expect(readme('paper', '  Two\n lines ')).toMatch(/^# Two lines\n/);
    expect(readme('venue', 'ICLR 2027')).toMatch(/venue\.json/);
    expect(readme('venue', 'ICLR 2027')).not.toMatch(/thumbnail/);
    expect(readmeProblem(paper)).toBeNull();
    // Any title, over the body of its own kind only.
    expect(readmeProblem(readme('paper', 'Another title'))).toBeNull();
    expect(readmeProblem(`${paper}\nmore\n`)).toMatch(/fixed/);
    expect(readmeProblem(paper.replace(/^# .*\n\n/, ''))).toMatch(/fixed/);
    expect(readmeProblem(readme('venue', 'ICLR 2027'), 'venue')).toBeNull();
    expect(readmeProblem(readme('venue', 'ICLR 2027'))).toMatch(/fixed/);
    expect(pathDenied('README.md', roles)).toMatch(/system/);
    expect(layoutProblem('README.md')).toBeNull();
  });

  it('adds what an older page is missing, without touching a part that has sections', () => {
    const paths = new Set(['.potentialpaper/metadata.json', 'community/10-summary.md']);
    const changes = missingStarterFiles(paths, {}, 'paper', 'A paper');
    expect(changes.map((c) => c.path)).toEqual([
      'prek.toml',
      'README.md',
      'owners/10-tl-dr.md',
      'owners/20-overview.md',
      'owners/30-results.md',
      'owners/40-demos.md',
      'owners/50-code-and-data.md',
      'owners/60-talks.md',
    ]);
    const all = new Set([...paths, ...changes.map((c) => c.path)]);
    expect(
      missingStarterFiles(all, { prek: prekConfig(), readme: readme('paper', 'A paper') }, 'paper', 'A paper'),
    ).toEqual([]);
    // A page renamed since gets its README's title brought up to date.
    expect(
      missingStarterFiles(all, { prek: prekConfig(), readme: readme('paper', 'Old') }, 'paper', 'A paper').map(
        (c) => c.path,
      ),
    ).toEqual(['README.md']);
    // Other kinds start with no sections: only the fixed files.
    expect(missingStarterFiles(new Set(), {}, 'category', 'Linear attention').map((c) => c.path)).toEqual([
      'prek.toml',
      'README.md',
    ]);
  });
});
