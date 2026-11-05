import { describe, expect, it } from 'vitest';
import { domainCandidates } from '@/server/institution-domains';
import { isRequestableDomain } from '@/server/institution-requests';

describe('domainCandidates', () => {
  it('goes from longest to shortest and never to one label', () => {
    expect(domainCandidates('a.inf.ethz.ch')).toEqual(['a.inf.ethz.ch', 'inf.ethz.ch', 'ethz.ch']);
    expect(domainCandidates('uk')).toEqual([]);
  });
});

describe('isRequestableDomain', () => {
  it('accepts what could be an institution', () => {
    for (const d of ['new-institute.example', 'cs.small-college.edu', 'lab.org']) {
      expect(isRequestableDomain(d)).toBe(true);
    }
  });

  it('refuses free mail, at any depth', () => {
    for (const d of ['gmail.com', 'outlook.com', 'mail.gmail.com', 'zoho.com']) {
      expect(isRequestableDomain(d)).toBe(false);
    }
  });

  it('refuses public suffixes, which would admit a whole namespace', () => {
    for (const d of ['ac.uk', 'co.uk', 'edu.cn', 'github.io']) expect(isRequestableDomain(d)).toBe(false);
  });

  it('refuses a registry label the suffix list misses', () => {
    for (const d of ['ac.cd', 'edu.na']) expect(isRequestableDomain(d)).toBe(false);
  });

  it('refuses what is not a domain', () => {
    for (const d of ['', 'localhost', 'a b.com', '%.edu', '_x.org']) expect(isRequestableDomain(d)).toBe(false);
  });
});
