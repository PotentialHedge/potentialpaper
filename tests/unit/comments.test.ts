import { describe, expect, it } from 'vitest';
import { ALIAS_ALPHABET, mentionedNames, randomAlias, splitMentions } from '@/lib/aliases';
import { gifUrl, renderComment } from '@/server/comments/render';

describe('mentions', () => {
  it('finds @names, not addresses or trailing punctuation', () => {
    expect(mentionedNames('@K3xm, ask @ada-l. ada@ethz.ch @x- @k3xm')).toEqual(['k3xm', 'ada-l']);
  });

  it('cuts text at known names only', () => {
    expect(splitMentions('hi @a2bc and @zz', new Set(['a2bc']))).toEqual([
      'hi ',
      { name: 'a2bc', text: '@a2bc' },
      ' and @zz',
    ]);
  });

  it('draws aliases from the alphabet', () => {
    expect([...randomAlias()].every((c) => ALIAS_ALPHABET.includes(c))).toBe(true);
  });
});

describe('renderComment', () => {
  it('marks known mentions, the viewer’s apart, and none in code or links', () => {
    const html = renderComment('@ada @bob `@ada` [@ada](https://x.org) $@ada$', {
      known: new Set(['ada', 'bob']),
      you: new Set(['bob']),
    });
    expect(html).toContain('<span class="mention" data-mention="ada">@ada</span>');
    expect(html).toContain('<span class="mention mention-you" data-mention="bob">@bob</span>');
    expect(html.match(/data-mention="ada"/g)).toHaveLength(1);
  });

  it('opens links in a new tab without passing on rank, and keeps raw HTML as text', () => {
    const html = renderComment('<b>x</b> https://example.org');
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain('rel="nofollow ugc noopener noreferrer" target="_blank"');
  });

  it('embeds only allowlisted GIFs', () => {
    expect(gifUrl('https://media.tenor.com/a/b.gif')).toBe('https://media.tenor.com/a/b.gif');
    expect(gifUrl('http://media.tenor.com/a/b.gif')).toBeNull();
    expect(gifUrl('https://evil.example/b.gif')).toBeNull();
    expect(renderComment('![t](https://evil.example/t.png)')).not.toContain('<img');
  });

  it('renders math with KaTeX, and leaves \\href inert', () => {
    const html = renderComment('$$\\href{javascript:alert(1)}{x}$$');
    expect(html).toContain('katex');
    expect(html).not.toMatch(/href="javascript/);
  });
});
