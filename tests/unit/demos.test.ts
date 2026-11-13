import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { demoBlockId, demoBlockMarkdown, demoBlockText, sourceLabel, type DemoSource } from '@/lib/demos';
import { parseRefAdvertisement, parseSourceUrl, resolveRest } from '@/server/demos/github';
import { findFile, HEIGHT_REPORTER, splitDemoPath, withHeightReporter } from '@/server/demos/serve';
import { chooseRoot, contentType, selectFiles, snapshotId } from '@/server/demos/snapshot';
import { readTar } from '@/server/demos/tar';
import { demoIds, renderMarkdown } from '@/server/pages/markdown';

const COMMIT = 'a'.repeat(40);
const DEMO: DemoSource = {
  id: 'f'.repeat(32),
  source: 'https://github.com/someone/attention-3d',
  commit: COMMIT,
  root: 'dist',
};

describe('a demo source URL', () => {
  it('names a repo, a folder at a ref, or a gist', () => {
    expect(parseSourceUrl('https://github.com/mrdoob/three.js')).toEqual({
      kind: 'repo',
      owner: 'mrdoob',
      repo: 'three.js',
      rest: '',
    });
    expect(parseSourceUrl('https://github.com/a/b.git')).toMatchObject({ repo: 'b' });
    expect(parseSourceUrl('https://github.com/a/b/tree/feature/x/dist')).toMatchObject({ rest: 'feature/x/dist' });
    expect(parseSourceUrl('https://github.com/a/b/blob/main/demo/index.html')).toMatchObject({
      rest: 'main/demo/index.html',
    });
    expect(parseSourceUrl('https://gist.github.com/someone/872660eb549d211d675acd338fd4a7ca')).toEqual({
      kind: 'gist',
      id: '872660eb549d211d675acd338fd4a7ca',
    });
  });

  it('refuses anything that is not public GitHub', () => {
    for (const bad of [
      'http://github.com/a/b',
      'https://gitlab.com/a/b',
      'https://github.com/a',
      'https://github.com/a/b/issues/3',
      'https://github.com.evil.org/a/b',
      'https://gist.github.com/someone/not-hex',
      'not a url',
    ]) {
      expect(parseSourceUrl(bad)).toBeNull();
    }
  });
});

describe('resolving a ref', () => {
  const pkt = (line: string) => (line.length + 4).toString(16).padStart(4, '0') + line;
  const advert =
    pkt('# service=git-upload-pack\n') +
    '0000' +
    pkt(`${'1'.repeat(40)} HEAD\0multi_ack symref=HEAD:refs/heads/main\n`) +
    pkt(`${'1'.repeat(40)} refs/heads/main\n`) +
    pkt(`${'2'.repeat(40)} refs/heads/feature/x\n`) +
    pkt(`${'3'.repeat(40)} refs/tags/v1\n`) +
    pkt(`${'4'.repeat(40)} refs/tags/v1^{}\n`) +
    '0000';
  const refs = parseRefAdvertisement(advert);

  it('reads the advertisement', () => {
    expect(refs.get('HEAD')).toBe('1'.repeat(40));
    expect(refs.get('refs/heads/feature/x')).toBe('2'.repeat(40));
  });

  it('takes the longest branch that fits, then the folder', () => {
    expect(resolveRest(refs, '')).toEqual({ commit: '1'.repeat(40), folder: '' });
    expect(resolveRest(refs, 'main/dist')).toEqual({ commit: '1'.repeat(40), folder: 'dist' });
    expect(resolveRest(refs, 'feature/x/docs/demo')).toEqual({ commit: '2'.repeat(40), folder: 'docs/demo' });
    // An annotated tag points at its tag object; the commit is the peeled one.
    expect(resolveRest(refs, 'v1')).toEqual({ commit: '4'.repeat(40), folder: '' });
    expect(resolveRest(refs, `${'9'.repeat(40)}/site`)).toEqual({ commit: '9'.repeat(40), folder: 'site' });
    expect(resolveRest(refs, 'nope/dist')).toBeNull();
  });
});

describe('a tar archive', () => {
  it('gives the regular files, long names included, and nothing else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'demo-tar-'));
    try {
      const long = `repo-sha/${'deep/'.repeat(30)}file.js`;
      mkdirSync(join(dir, 'repo-sha', 'assets'), { recursive: true });
      mkdirSync(join(dir, long, '..'), { recursive: true });
      writeFileSync(join(dir, 'repo-sha', 'index.html'), '<h1>hi</h1>');
      writeFileSync(join(dir, 'repo-sha', 'assets', 'ünï.js'), 'x');
      writeFileSync(join(dir, long), 'deep');
      execFileSync('ln', ['-s', '/etc/passwd', join(dir, 'repo-sha', 'link')]);
      const archive = execFileSync('tar', ['--format=pax', '-cf', '-', '-C', dir, 'repo-sha'], {
        env: { ...process.env, COPYFILE_DISABLE: '1' },
      });
      const files = new Map(readTar(archive).map((file) => [file.path, file.bytes.toString()]));
      expect(files.get('repo-sha/index.html')).toBe('<h1>hi</h1>');
      expect(files.get('repo-sha/assets/ünï.js')).toBe('x');
      expect(files.get(long)).toBe('deep');
      expect(files.has('repo-sha/link')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a demo's root", () => {
  const paths = new Set(['README.md', 'src/main.ts', 'dist/index.html', 'dist/assets/a.js', 'other/index.html']);

  it('is the folder named, or the first likely one with an index', () => {
    expect(chooseRoot(paths, '')).toBe('dist');
    expect(chooseRoot(new Set(['index.html', 'dist/index.html']), '')).toBe('');
    expect(chooseRoot(paths, 'other')).toBe('other');
    expect(chooseRoot(paths, 'other/index.html')).toBe('other');
    expect(chooseRoot(paths, 'src')).toBeNull();
    expect(chooseRoot(new Set(['src/index.ts']), '')).toBeNull();
  });

  it('keeps only its files, renamed, without git internals', () => {
    const bytes = Buffer.from('x');
    const kept = selectFiles(
      [
        { path: 'dist/index.html', bytes },
        { path: 'dist/.git/config', bytes },
        { path: 'distant/x', bytes },
        { path: 'src/a.ts', bytes },
      ],
      'dist',
    );
    expect(kept.map((file) => file.path)).toEqual(['index.html']);
  });
});

describe('a snapshot', () => {
  it('has the same id for the same files, in any order', () => {
    const a = { sha256: '1'.repeat(64), bytes: 1, type: 'text/html' };
    const b = { sha256: '2'.repeat(64), bytes: 1, type: 'text/javascript' };
    expect(snapshotId({ 'index.html': a, 'a.js': b })).toBe(snapshotId({ 'a.js': b, 'index.html': a }));
    expect(snapshotId({ 'index.html': a })).not.toBe(snapshotId({ 'index.html': b }));
    expect(snapshotId({ 'index.html': a })).toMatch(/^[0-9a-f]{32}$/);
  });

  it('serves the types a browser needs to run it', () => {
    expect(contentType('a/b.MJS')).toMatch(/^text\/javascript/);
    expect(contentType('m.wasm')).toBe('application/wasm');
    expect(contentType('scene.glb')).toBe('model/gltf-binary');
    expect(contentType('Makefile')).toBe('application/octet-stream');
  });

  it('finds a file, or the index of a folder', () => {
    const file = { sha256: '1'.repeat(64), bytes: 1, type: 'text/html' };
    const files = { 'index.html': file, 'about/index.html': file, 'a.js': file };
    expect(findFile(files, '')).toBe('index.html');
    expect(findFile(files, 'a.js')).toBe('a.js');
    expect(findFile(files, 'about')).toBe('about/index.html');
    expect(findFile(files, 'about/')).toBe('about/index.html');
    expect(findFile(files, 'b.js')).toBeNull();
  });

  it('is addressed as /d/<id>/<path>', () => {
    expect(splitDemoPath(`/d/${'f'.repeat(32)}/assets/a.js`)).toEqual({ id: 'f'.repeat(32), rest: 'assets/a.js' });
    expect(splitDemoPath(`/d/${'f'.repeat(32)}`)).toEqual({ id: 'f'.repeat(32), rest: '' });
    expect(splitDemoPath('/d/short/x')).toBeNull();
    expect(splitDemoPath('/assets/a.js')).toBeNull();
  });
});

describe('a demo block', () => {
  it('round-trips its id, title and description', () => {
    const block = demoBlockMarkdown({ id: DEMO.id, title: ' Attention,\n in 3D ', description: 'Rotate `it`.' });
    expect(block).toBe(`\`\`\`demo ${DEMO.id}\nAttention, in 3D\nRotate 'it'.\n\`\`\`\n`);
    expect(demoBlockId(`demo ${DEMO.id}`)).toBe(DEMO.id);
    expect(demoBlockId('demo nope')).toBeNull();
    expect(demoBlockId('js')).toBeNull();
    expect(demoBlockText('Attention, in 3D\nRotate it.\nAnd zoom.\n')).toEqual({
      title: 'Attention, in 3D',
      description: 'Rotate it. And zoom.',
    });
  });

  it('is found in Markdown, once each, and renders as a sandboxed frame with no src until shown', () => {
    const md = `## Demos\n\n${demoBlockMarkdown({ id: DEMO.id, title: 'A <b>' })}\n${demoBlockMarkdown({ id: DEMO.id, title: 'Again' })}\n\`\`\`js\nx\n\`\`\`\n`;
    expect(demoIds(md)).toEqual([DEMO.id]);
    const html = renderMarkdown(md, 'community', { demos: new Map([[DEMO.id, DEMO]]) });
    expect(html).toContain(`<iframe class="demo-frame" data-src="http://127.0.0.1:3000/d/${DEMO.id}/"`);
    expect(html).not.toMatch(/<iframe[^>]* src=/);
    expect(html).toContain('sandbox="allow-scripts');
    expect(html).toContain('<b>Demo:</b> A &lt;b&gt;');
    expect(html).toContain(sourceLabel(DEMO));
    expect(html).toContain('<code class="language-js">');
    expect(renderMarkdown(md, 'community')).toContain('class="demo-missing"');
  });
});

describe("a demo's page", () => {
  it('gets the height reporter after <head>, or after the doctype, so it keeps standards mode', () => {
    expect(withHeightReporter('<!doctype html><html><head><title>x</title></head></html>')).toBe(
      `<!doctype html><html><head>${HEIGHT_REPORTER}<title>x</title></head></html>`,
    );
    expect(withHeightReporter('<!DOCTYPE html>\n<HEAD lang="en">x')).toBe(
      `<!DOCTYPE html>\n<HEAD lang="en">${HEIGHT_REPORTER}x`,
    );
    expect(withHeightReporter('<!doctype html><canvas>')).toBe(`<!doctype html>${HEIGHT_REPORTER}<canvas>`);
    expect(withHeightReporter('<canvas>')).toBe(`${HEIGHT_REPORTER}<canvas>`);
    // A <header> is not the head.
    expect(withHeightReporter('<!doctype html><body><header>')).toBe(`<!doctype html>${HEIGHT_REPORTER}<body><header>`);
  });
});
