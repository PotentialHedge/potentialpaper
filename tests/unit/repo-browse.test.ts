import { describe, expect, it } from 'vitest';
import { repoWhere } from '@/components/pages/RepoTab';
import { cleanRepoPath, placeholderSource } from '@/server/pages/browse';
import { buildTrees, gitObject, parseTree } from '@/server/pages/git-objects';
import { GITATTRIBUTES, GITATTRIBUTES_PATH, README_PATH } from '@/server/pages/rules';
import { readme, starterFiles } from '@/server/pages/starter';

describe('the placeholder repo', () => {
  const files: [string, string][] = [
    ['.potentialpaper/metadata.json', '{"layout":7}\n'],
    [GITATTRIBUTES_PATH, GITATTRIBUTES],
    ...starterFiles('paper'),
  ];

  it('is the tree a commit of the same files stores', async () => {
    const source = placeholderSource(files);
    const tree = new Map(files.map(([path, text]) => [path, gitObject('blob', Buffer.from(text)).oid]));
    expect(source.root).toBe(buildTrees(tree).root);
    expect(source.head).toBeNull();
  });

  it('reads back every file, and its folders', async () => {
    const { repo, root } = placeholderSource(files);
    const top = parseTree((await repo.read([root])).get(root)!.body);
    expect(top.filter((e) => e.isTree).map((e) => e.name)).toEqual(['.potentialpaper', 'community', 'owners']);
    const entry = top.find((e) => e.name === README_PATH)!;
    expect((await repo.read([entry.oid])).get(entry.oid)!.body.toString('utf8')).toBe(readme('paper'));
    expect((await repo.sizes([entry.oid])).get(entry.oid)).toBe(Buffer.byteLength(readme('paper')));
  });
});

describe('repo paths', () => {
  it('takes a folder or file path, and nothing that climbs out', () => {
    expect(cleanRepoPath('')).toBe('');
    expect(cleanRepoPath('/community/')).toBe('community');
    expect(cleanRepoPath('reviews/openreview/abc')).toBe('reviews/openreview/abc');
    expect(cleanRepoPath('a//b')).toBeNull();
    expect(cleanRepoPath('a/../b')).toBeNull();
    expect(cleanRepoPath('./a')).toBeNull();
  });

  it('reads where the Repo tab is from the hash', () => {
    expect(repoWhere('')).toBeNull();
    expect(repoWhere('#edit')).toBeNull();
    expect(repoWhere('#repository')).toBeNull();
    expect(repoWhere('#repo')).toEqual({ type: 'tree', path: '' });
    expect(repoWhere('#repo/tree/community')).toEqual({ type: 'tree', path: 'community' });
    expect(repoWhere('#repo/blob/demos/my%20demo/index.html')).toEqual({
      type: 'blob',
      path: 'demos/my demo/index.html',
    });
    expect(repoWhere('#repo/blob/%E0%A4%A')).toEqual({ type: 'tree', path: '' });
  });
});
