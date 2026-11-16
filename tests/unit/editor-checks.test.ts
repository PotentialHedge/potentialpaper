import { describe, expect, it } from 'vitest';
import {
  fixEndOfFile,
  formatted,
  MAX_ADDED_KB,
  problems,
  trimTrailingWhitespace,
} from '../../editors/vscode/extension/src/checks';

describe("the web editor's prek checks", () => {
  it('fixes the end of a file as end-of-file-fixer does', () => {
    expect(fixEndOfFile('')).toBe('');
    expect(fixEndOfFile('\n\n')).toBe('');
    expect(fixEndOfFile('a')).toBe('a\n');
    expect(fixEndOfFile('a\n\n\n')).toBe('a\n');
    expect(fixEndOfFile('a\r\n\r\n')).toBe('a\r\n');
  });

  it('trims trailing whitespace, keeping a Markdown line break', () => {
    expect(trimTrailingWhitespace('a.html', 'x  \ny\t\n')).toBe('x\ny\n');
    expect(trimTrailingWhitespace('community/10-a.md', 'x   \ny \n   \n')).toBe('x  \ny\n\n');
  });

  it('formats the files the hooks fix, and leaves demos alone', async () => {
    expect(await formatted('links/10-code.json', '{"label":"Code","url":"https://x.org"}')).toBe(
      '{\n  "label": "Code",\n  "url": "https://x.org"\n}\n',
    );
    expect(await formatted('community/10-summary.md', '# Hi\n* a\n')).toBe('# Hi\n\n- a\n');
    expect(await formatted('community/10-summary.md', '')).toBeNull();
    expect(await formatted('community/10-summary.md', '# Hi\n')).toBeNull();
    expect(await formatted('demos/x/index.html', 'a  ')).toBeNull();
  });

  it('refuses what the checking hooks refuse', () => {
    const big = 'x'.repeat((MAX_ADDED_KB + 1) * 1024);
    const found = problems(
      [
        { path: 'links/10-a.json', text: '{', added: true },
        { path: 'community/10-Summary.md', text: 'a\n', added: true },
        { path: 'community/20-con.md', text: big, added: true },
        { path: 'demos/x/data.json', text: '{}', added: true },
        { path: 'community/aux.md', text: '', added: true },
      ],
      [
        'links/10-a.json',
        'community/10-summary.md',
        'community/10-Summary.md',
        'community/20-con.md',
        'demos/x/data.json',
        'community/aux.md',
      ],
    ).map((p) => p.path);
    expect(found).toContain('links/10-a.json');
    expect(found).toContain('community/10-Summary.md');
    expect(found).toContain('community/20-con.md');
    expect(found).toContain('community/aux.md');
    expect(found).not.toContain('demos/x/data.json');
  });

  it('lets an ordinary change through', () => {
    expect(
      problems([{ path: 'links/10-code.json', text: '{}', added: false }], ['links/10-code.json', 'prek.toml']),
    ).toEqual([]);
  });
});
