import { describe, expect, it } from 'vitest';
import { parseDismissed, withDismissed } from '@/lib/announcements';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('dismissed announcements', () => {
  it('adds an id newest last, once', () => {
    expect(withDismissed(undefined, A)).toBe(A);
    expect(withDismissed(`${A} ${B}`, A)).toBe(`${B} ${A}`);
  });

  it('keeps only ids, and reads an undecoded cookie', () => {
    expect(parseDismissed(`${A} junk <script>`)).toEqual([A]);
    expect(parseDismissed(`${A}%20${B}`)).toEqual([A, B]);
  });

  it('keeps the most recent 20', () => {
    let value: string | undefined;
    for (let i = 0; i < 25; i++) value = withDismissed(value, `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const ids = parseDismissed(value);
    expect(ids).toHaveLength(20);
    expect(ids.at(-1)).toBe('00000000-0000-4000-8000-000000000024');
  });
});
