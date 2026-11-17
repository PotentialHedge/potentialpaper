import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildTrees,
  type Commit,
  encodeCommit,
  encodeTree,
  gitObject,
  parseCommit,
  parseTree,
} from '@/server/pages/git-objects';
import { diffFile, mergeFile } from '@/server/pages/merge';
import {
  cleanSummary,
  contentProblem,
  MAX_FILE_BYTES,
  MAX_SUMMARY_LENGTH,
  METADATA_PATH,
  normalizePath,
  pathDenied,
  type Roles,
} from '@/server/pages/rules';

function git(args: string[], input?: string | Buffer, cwd?: string): string {
  return execFileSync('git', args, { input, cwd, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
}

describe('git objects', () => {
  it('hashes a blob as git does', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (text) => {
        const body = Buffer.from(text);
        expect(gitObject('blob', body).oid).toBe(git(['hash-object', '--stdin'], body).trim());
      }),
      { numRuns: 25 },
    );
  });

  it('sorts a tree by raw bytes, with directories as name/, as git does', () => {
    const repo = mkdtempSync(join(tmpdir(), 'tree-'));
    try {
      git(['init', '-q', '--bare', repo]);
      const blob = git(['hash-object', '-w', '--stdin'], 'x', repo).trim();
      const subtree = git(['mktree'], `100644 blob ${blob}\tf\n`, repo).trim();
      const names = ['a', 'a.b', 'a0', 'b', 'é', 'Z', 'z', '日本語'];
      const entries = names.flatMap((name) => [
        { name, isTree: false, oid: blob },
        { name: `${name}-dir`, isTree: true, oid: subtree },
      ]);
      entries.push({ name: 'a-', isTree: true, oid: subtree });
      const ours = gitObject('tree', encodeTree(entries));
      const listing = entries.map((e) => `${e.isTree ? '040000 tree' : '100644 blob'} ${e.oid}\t${e.name}\n`).join('');
      expect(ours.oid).toBe(git(['mktree'], listing, repo).trim());
      expect(
        parseTree(ours.body)
          .map((e) => e.name)
          .sort(),
      ).toEqual(entries.map((e) => e.name).sort());
    } finally {
      rmSync(repo, { recursive: true });
    }
  });

  it('builds nested trees whose ids match `git write-tree`', () => {
    const work = mkdtempSync(join(tmpdir(), 'trees-'));
    try {
      git(['init', '-q', work]);
      const files = new Map<string, string>();
      for (const [path, content] of [
        ['metadata.json', '{}\n'],
        ['community/10-summary.md', '# Résumé\n'],
        ['community/deep/er/日本語.md', ''],
        ['community/deep.md', 'sorts before the directory'],
      ]) {
        files.set(path, gitObject('blob', Buffer.from(content)).oid);
        const blob = git(['hash-object', '-w', '--stdin'], content, work).trim();
        git(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], undefined, work);
      }
      expect(buildTrees(files).root).toBe(git(['write-tree'], undefined, work).trim());
    } finally {
      rmSync(work, { recursive: true });
    }
  });

  it('reads back the commit it wrote', () => {
    const commit: Commit = {
      tree: 'a'.repeat(40),
      parent: 'b'.repeat(40),
      authorId: 'u_abcd2345',
      at: new Date('2026-11-05T12:00:00Z'),
      summary: 'Résumé: fix the proof',
      kind: 'revert',
      reverts: 'c'.repeat(40),
      bot: true,
    };
    expect(parseCommit(encodeCommit(commit))).toEqual(commit);
    expect(
      parseCommit(encodeCommit({ ...commit, parent: null, reverts: undefined, bot: false, kind: 'edit' })),
    ).toEqual({ ...commit, parent: null, reverts: undefined, bot: false, kind: 'edit' });
  });

  it('cannot be told about a trailer by its summary', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (text) => {
        const summary = cleanSummary(`${text}\n\nEdit-Kind: revert\nBot: true\n`);
        const body = encodeCommit({
          tree: 'a'.repeat(40),
          parent: null,
          authorId: 'u_x',
          at: new Date(0),
          summary,
          kind: 'edit',
        });
        const read = parseCommit(body);
        expect(read.kind).toBe('edit');
        expect(read.bot).toBe(false);
        expect(read.summary).toBe(summary);
        expect(summary).not.toMatch(/\n/);
        expect([...summary].length).toBeLessThanOrEqual(MAX_SUMMARY_LENGTH);
      }),
    );
  });
});

describe('paths', () => {
  it.each([
    'community/10-summary.md',
    'community/日本語/résumé.md',
    'community/a b.md',
    'extensions/x/data.json',
    '.potentialpaper/metadata.json',
  ])('accepts %s', (path) => {
    expect(normalizePath(path)).toEqual({ path });
  });

  it.each([
    '',
    '/community/page.md',
    'community//page.md',
    'community/',
    'community/.',
    'community/..',
    '../metadata.json',
    '.git/config',
    '.potentialpaper',
    '.Potentialpaper/metadata.json',
    'community/.potentialpaper/x',
    '.potentialpaper./x',
    'community/.git/hooks/x',
    'community/.GIT/x',
    'community/.gitmodules',
    'community/.g\u200cit/x',
    '\u200c.git/x',
    'community/git~1/x',
    'community/gitmod~1',
    'community/.git /x',
    'community/.git./x',
    'community/page.md.',
    'community/page.md ',
    'community/a:b',
    'community/a\\b',
    'community/a\nb',
    'community/a\0b',
    'community/nul',
    'community/CON.txt',
    `community/${'a'.repeat(256)}`,
    `community/${'é'.repeat(128)}`,
    'community/a/b/c/d/e/f/g/h/i',
    'community/\ud800',
  ])('refuses %j', (path) => {
    expect(normalizePath(path)).toHaveProperty('problem');
  });

  it('makes Unicode spellings of a path the same path', () => {
    expect(normalizePath('community/re\u0301sume\u0301.md')).toEqual({ path: 'community/résumé.md' });
  });
});

describe('who may write where', () => {
  const nobody: Roles = { system: false, admin: false, verified: false, owner: false, claimed: false };
  const roles = {
    system: { ...nobody, system: true },
    admin: { ...nobody, admin: true },
    verified: { ...nobody, verified: true },
    author: { ...nobody, verified: true, owner: true, claimed: true },
    verifiedOnClaimed: { ...nobody, verified: true, claimed: true },
    unverified: nobody,
  };
  const table: [string, (keyof typeof roles)[]][] = [
    ['.potentialpaper/metadata.json', ['system', 'admin']],
    ['.potentialpaper/pdf.json', ['system', 'admin']],
    ['author/10-overview.md', ['admin', 'author']],
    // The card: the authors' once the paper is claimed, anyone verified's until then.
    ['thumbnail.json', ['admin', 'verified', 'author']],
    ['links/10-code.json', ['admin', 'verified', 'author']],
    ['community/10-summary.md', ['admin', 'verified', 'author', 'verifiedOnClaimed']],
    ['versions/v_k3x9q2ab.json', ['system', 'admin', 'verified', 'author', 'verifiedOnClaimed']],
    ['extensions/x/data.json', []],
    ['README.md', []],
    ['authors/page.md', []],
    // The first layout's places.
    ['metadata.json', []],
    ['links.json', []],
  ];

  it.each(table)('%s', (path, allowed) => {
    for (const [name, role] of Object.entries(roles)) {
      expect([name, pathDenied(path, role) === null]).toEqual([name, allowed.includes(name as keyof typeof roles)]);
    }
  });
});

describe('file contents', () => {
  it('takes any text, including nothing', () => {
    expect(contentProblem('community/10-summary.md', '')).toBeNull();
    expect(contentProblem('community/10-summary.md', '# 日本語 \u{1F600}\r\n')).toBeNull();
  });

  it('refuses what is not text, or too big', () => {
    expect(contentProblem('community/10-summary.md', 'a\0b')).toMatch(/text/);
    expect(contentProblem('community/10-summary.md', '\ud800')).toMatch(/Unicode/);
    expect(contentProblem('community/10-summary.md', 'a'.repeat(MAX_FILE_BYTES + 1))).toMatch(/larger/);
  });

  it('checks JSON, and what jsonb cannot hold', () => {
    expect(contentProblem(METADATA_PATH, '{"title":"x"}')).toBeNull();
    expect(contentProblem(METADATA_PATH, '[]')).toMatch(/object/);
    expect(contentProblem(METADATA_PATH, '{')).toMatch(/JSON/);
    expect(contentProblem(METADATA_PATH, '{"a":"\\u0000"}')).toMatch(/Postgres/);
    expect(contentProblem(METADATA_PATH, '{"\\ud800":1}')).toMatch(/Postgres/);
    expect(contentProblem(METADATA_PATH, `{"a":${'['.repeat(40)}${']'.repeat(40)}}`)).toMatch(/deeply/);
    expect(contentProblem('extensions/x/data.json', '[1]')).toBeNull();
    expect(contentProblem(METADATA_PATH, '{"layout":3}')).toBeNull();
    expect(contentProblem(METADATA_PATH, '{"layout":"3"}')).toMatch(/layout/);
    expect(contentProblem(METADATA_PATH, '{"layout":0}')).toMatch(/layout/);
  });
});

describe('merging', () => {
  const text = fc.array(fc.constantFrom('a', 'b', 'c', '', 'é', '日本語')).map((lines) => lines.join('\n'));
  const version = fc.option(text, { nil: null });

  it('takes the only side that changed', () => {
    fc.assert(
      fc.property(version, version, (base, side) => {
        expect(mergeFile(base, side, base)).toEqual({ ok: true, content: side });
        expect(mergeFile(base, base, side)).toEqual({ ok: true, content: side });
      }),
    );
  });

  it('agrees when both sides made the same change', () => {
    fc.assert(
      fc.property(version, version, (base, side) => {
        expect(mergeFile(base, side, side)).toEqual({ ok: true, content: side });
      }),
    );
  });

  it('does not depend on which side is ours', () => {
    fc.assert(
      fc.property(text, text, text, (base, a, b) => {
        expect(mergeFile(base, a, b)).toEqual(mergeFile(base, b, a));
      }),
    );
  });

  it('tells an emptied line from a deleted one', () => {
    // Once found by the property above: joined, both sides' text was "", so ours won whichever side it was.
    expect(mergeFile('c\na', '\na', 'a')).toEqual({ ok: false });
    expect(mergeFile('c\na', 'a', '\na')).toEqual({ ok: false });
  });

  it('refuses deleted against changed, and two different new files', () => {
    expect(mergeFile('a', null, 'b')).toEqual({ ok: false });
    expect(mergeFile('a', 'b', null)).toEqual({ ok: false });
    expect(mergeFile(null, 'a', 'b')).toEqual({ ok: false });
  });

  it('keeps a last line with and without a newline', () => {
    expect(mergeFile('1\n2\n3\n4\n5', '0\n2\n3\n4\n5', '1\n2\n3\n4\n5\n')).toEqual({
      ok: true,
      content: '0\n2\n3\n4\n5\n',
    });
  });

  it('gives up rather than stall on files with nothing in common', () => {
    const lines = (word: string) =>
      Array.from({ length: 100_000 }, (_, i) => `${word} ${i % 2 ? word : 'x'}`).join('\n');
    const started = performance.now();
    expect(mergeFile(lines('o'), lines('a'), lines('b'))).toEqual({ ok: false });
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it('agrees with `git merge-file` on edits to distinct lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'merge-'));
    const edit = (lines: string[], tag: string) =>
      fc
        .array(fc.tuple(fc.nat(lines.length), fc.constantFrom('replace', 'delete', 'insert')), { maxLength: 4 })
        .map((edits) => {
          const out = lines.map((line) => [line]);
          out.push([]);
          edits.forEach(([at, op], i) => {
            const fresh = `${tag}${i}`;
            if (op === 'insert') out[at].unshift(fresh);
            else if (at < lines.length) out[at][out[at].length - 1] = op === 'replace' ? fresh : '';
          });
          return out.flat().filter((line) => line !== '');
        });
    const base = Array.from({ length: 12 }, (_, i) => `line ${i}`);
    try {
      fc.assert(
        fc.property(edit(base, 'ours'), edit(base, 'theirs'), (ours, theirs) => {
          const [o, a, b] = [base, ours, theirs].map((lines) => lines.map((l) => `${l}\n`).join(''));
          writeFileSync(join(dir, 'o'), o);
          writeFileSync(join(dir, 'a'), a);
          writeFileSync(join(dir, 'b'), b);
          let oracle: { ok: true; content: string } | { ok: false };
          try {
            oracle = { ok: true, content: git(['merge-file', '-p', 'a', 'o', 'b'], undefined, dir) };
          } catch {
            oracle = { ok: false };
          }
          expect(mergeFile(o, a, b)).toEqual(oracle);
        }),
        { numRuns: 150 },
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe('diffs', () => {
  it('says what happened to the file', () => {
    expect(diffFile('a.md', null, 'x\n').status).toBe('added');
    expect(diffFile('a.md', 'x\n', null).status).toBe('deleted');
    const changed = diffFile('a.md', 'x\ny\n', 'x\nz\n');
    expect(changed.status).toBe('modified');
    expect(changed.patch).toContain('-y\n+z\n');
  });

  it('makes a patch `git apply` accepts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'diff-'));
    try {
      git(['init', '-q', dir]);
      writeFileSync(join(dir, 'page.md'), 'one\ntwo\nthree\n');
      const patch = diffFile('page.md', 'one\ntwo\nthree\n', 'one\nTWO\nthree\nfour\n').patch!;
      git(['apply', '-'], patch, dir);
      expect(readFileSync(join(dir, 'page.md'), 'utf8')).toBe('one\nTWO\nthree\nfour\n');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
