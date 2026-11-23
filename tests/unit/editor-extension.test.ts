import { describe, expect, it } from 'vitest';
import { originOfRemote, sectionFormat } from '../../editors/vscode/extension/src/paths';

describe('the VS Code extension on a clone', () => {
  it('finds the site from the git remote', () => {
    expect(originOfRemote('https://potentialpaper.com/git/arxiv/1706.03762.git')).toBe('https://potentialpaper.com');
    expect(originOfRemote('https://me:pp_live_x@papers.example.com/git/openreview/abc.git')).toBe(
      'https://papers.example.com',
    );
    expect(originOfRemote('http://localhost:3000/git/doi/10.1/x.git')).toBe('http://localhost:3000');
    expect(originOfRemote('ssh://git@git.potentialpaper.com:2222/abs/1706.03762.git')).toBe(
      'https://potentialpaper.com',
    );
    expect(originOfRemote('git@git.potentialpaper.com:abs/1706.03762.git')).toBe('https://potentialpaper.com');
    expect(originOfRemote('git@github.com:someone/repo.git')).toBeNull();
    expect(originOfRemote('https://github.com/someone/repo.git')).toBeNull();
  });

  it('knows a section by its path', () => {
    expect(sectionFormat('community/10-summary.md')).toBe('markdown');
    expect(sectionFormat('owners/20-results.html')).toBe('html');
    expect(sectionFormat('links/10-code.json')).toBeNull();
    expect(sectionFormat('community/notes/10-x.md')).toBeNull();
    expect(sectionFormat(null)).toBeNull();
  });
});
