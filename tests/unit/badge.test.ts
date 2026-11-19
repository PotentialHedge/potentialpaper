import { describe, expect, it } from 'vitest';
import { renderBadge } from '@/lib/badge';

describe('renderBadge', () => {
  it('escapes the message and names it for screen readers', () => {
    const svg = renderBadge({ label: 'potentialpaper', message: 'A <b> & "c"', color: '#1d1d1d' });
    expect(svg).toContain('aria-label="potentialpaper: A &lt;b&gt; &amp; &quot;c&quot;"');
    expect(svg).not.toContain('<b>');
  });

  it('cuts a long message and drops the label when compact', () => {
    const svg = renderBadge({ label: 'potentialpaper', message: 'x'.repeat(100), color: '#000', compact: true });
    expect(svg).toContain(`${'x'.repeat(59)}…`);
    expect(svg).not.toContain('potentialpaper');
  });
});
