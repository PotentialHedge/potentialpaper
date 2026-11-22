import { describe, expect, it } from 'vitest';
import { analyticsUrl } from '@/lib/analytics';

const origin = 'https://potentialpaper.com';

describe('analyticsUrl', () => {
  it('keeps the home page list parameters and drops the rest', () => {
    expect(analyticsUrl(`${origin}/?q=attention&page=2&token=abc#x`, origin)).toBe(`${origin}/?q=attention&page=2`);
  });
  it('drops every parameter on auth pages', () => {
    expect(analyticsUrl(`${origin}/signin/link?token=secret&next=%2Fprofile`, origin)).toBe(`${origin}/signin/link`);
  });
  it('keeps only origin and path of another site', () => {
    expect(analyticsUrl('https://www.google.com/search?q=me', origin)).toBe('https://www.google.com/search');
  });
  it('turns garbage into an empty string', () => {
    expect(analyticsUrl('http://[', origin)).toBe('');
  });
});
