import { describe, expect, it } from 'vitest';
import { newLinkId, parseLabeledLinks } from '@/lib/labeled-links';
import { categoryNameKey, categorySlug } from '@/lib/categories';
import { cleanKeywords } from '@/server/import-reviews';
import { ESTABLISHED_DAYS, isEstablished, protectionHolds } from '@/server/page-protection';
import { foldCategories } from '@/server/category-pages';

describe('category names', () => {
  it('makes an address from a name', () => {
    expect(categorySlug('Linear attention')).toBe('linear-attention');
    expect(categorySlug('State-space models (SSMs)')).toBe('state-space-models-ssms');
    expect(categorySlug('Mixture-of-Experts & routing')).toBe('mixture-of-experts-and-routing');
    expect(categorySlug('Ünïcode naïve')).toBe('unicode-naive');
    expect(categorySlug('注意力')).toBeNull();
    expect(categorySlug('x'.repeat(100))!.length).toBe(60);
  });

  it('tells duplicates by case, accents, punctuation and plurals, not by words', () => {
    expect(categoryNameKey('State-space models')).toBe(categoryNameKey('state space model'));
    expect(categoryNameKey('Mixtures of experts')).toBe(categoryNameKey('mixture of expert'));
    expect(categoryNameKey('Diffusion policies')).toBe(categoryNameKey('diffusion policy'));
    expect(categoryNameKey('Linear attention')).not.toBe(categoryNameKey('Attention'));
    // Words that end in s without being plurals stay.
    expect(categoryNameKey('Gaussian process')).toBe('gaussian process');
    expect(categoryNameKey('Graph analysis')).toBe('graph analysis');
  });
});

describe('link ids', () => {
  it('are ULIDs that a links.jsonl accepts, in time order', () => {
    const a = newLinkId(1_700_000_000_000);
    const b = newLinkId(1_700_000_000_001);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
    const line = JSON.stringify({ id: a, to: 'category:linear-attention', label: 'in-category' });
    expect(parseLabeledLinks(line, 'paper')).toMatchObject({ links: [{ id: a }] });
  });
});

describe('keywords', () => {
  it('keeps them trimmed, once each, and at most 30', () => {
    expect(cleanKeywords([' Linear  attention ', 'linear attention', '', 'SSM'])).toEqual({
      keywords: ['Linear attention', 'SSM'],
    });
    expect(cleanKeywords(undefined)).toEqual({});
    expect(cleanKeywords(Array.from({ length: 40 }, (_, i) => `k${i}`)).keywords).toHaveLength(30);
  });
});

describe('page protection', () => {
  const someone = { system: false, admin: false, owner: false, established: false };
  it('holds the community, not admins, the system, owners in their part, or bots in their grants', () => {
    expect(protectionHolds('established', 'community/10-a.md', someone, 'category')).toBe(true);
    expect(protectionHolds('established', 'community/10-a.md', { ...someone, established: true }, 'category')).toBe(
      false,
    );
    expect(protectionHolds('admins', 'community/10-a.md', { ...someone, established: true }, 'category')).toBe(true);
    expect(protectionHolds('admins', 'category.json', { ...someone, admin: true }, 'category')).toBe(false);
    expect(protectionHolds('admins', 'category.json', { ...someone, system: true }, 'category')).toBe(false);
    // A paper's authors keep their section; their community edits are held like anyone's.
    expect(protectionHolds('admins', 'owners/10-a.md', { ...someone, owner: true }, 'paper')).toBe(false);
    expect(protectionHolds('admins', 'community/10-a.md', { ...someone, owner: true }, 'paper')).toBe(true);
    expect(
      protectionHolds('admins', 'reviews/openreview/x/submission.json', {
        ...someone,
        grants: ['reviews/openreview/**'],
      }),
    ).toBe(false);
  });

  it('counts an account as established some days after its address was confirmed', () => {
    const now = new Date('2026-11-17T00:00:00Z');
    const days = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);
    expect(isEstablished(null, now)).toBe(false);
    expect(isEstablished(days(ESTABLISHED_DAYS - 1), now)).toBe(false);
    expect(isEstablished(days(ESTABLISHED_DAYS), now)).toBe(true);
  });
});

describe('merging categories', () => {
  const file = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  const link = (id: string, to: string) => JSON.stringify({ id, to, label: 'in-category' });
  it("folds the duplicate's sections and links into the survivor, never into itself, and keeps the survivor's name", () => {
    const survivor = new Map([
      ['category.json', file({ name: 'Mixture of experts' })],
      ['community/10-what-it-is.md', '# What it is\n\nRouting.\n'],
      ['community/links.jsonl', `${link('A1', 'category:sparse-models')}\n`],
    ]);
    const duplicate = new Map([
      ['category.json', file({ name: 'Sparse experts' })],
      ['community/10-what-it-is.md', '# What it is\n\nRouting.\n'],
      ['community/20-history.md', '# History\n\nSince 1991.\n'],
      [
        'community/links.jsonl',
        [
          link('A1', 'category:scaling'),
          link('B2', 'category:sparse-models'),
          link('C3', 'category:mixture-of-experts'),
        ].join('\n'),
      ],
    ]);
    const changes = new Map(
      foldCategories(survivor, duplicate, 'sparse-experts', 'mixture-of-experts').map((c) => [c.path, c.content]),
    );
    expect(changes.has('category.json')).toBe(false);
    // The same text isn't copied twice; the new section says where it came from.
    expect([...changes.keys()].filter((path) => path.endsWith('.md'))).toEqual(['community/20-history.md']);
    expect(changes.get('community/20-history.md')).toBe(
      '# History\n\nSince 1991.\n\n*From category:sparse-experts, merged into this page.*\n',
    );
    const links = changes
      .get('community/links.jsonl')!
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(links.map((l) => l.to)).toEqual(['category:sparse-models', 'category:scaling']);
    // An id the survivor's file has already is made anew.
    expect(links[1].id).not.toBe('A1');
  });
});
