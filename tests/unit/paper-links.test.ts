import { describe, expect, it } from 'vitest';
import { bibtex, bibtexKey, titleLinks } from '@/lib/paper-links';

describe('titleLinks', () => {
  it('links an arXiv paper to its abstract, PDF and Scholar', () => {
    const links = titleLinks({ identifiers: [{ scheme: 'arxiv', value: '1706.03762' }], title: 'Attention' });
    expect(links.map((l) => l.label)).toEqual(['arXiv', 'PDF', 'Scholar']);
    expect(links[1].url).toBe('https://arxiv.org/pdf/1706.03762');
  });

  it('prefers our PDF and finds OpenReview in a submission', () => {
    const links = titleLinks({
      identifiers: [{ scheme: 'doi', value: '10.1/x' }],
      title: 'T',
      pdf: 'https://cdn/x.pdf',
      forums: [null, 'https://openreview.net/forum?id=abc123'],
    });
    expect(links.map((l) => [l.label, l.url])).toEqual([
      ['PDF', 'https://cdn/x.pdf'],
      ['OpenReview', 'https://openreview.net/forum?id=abc123'],
      ['DOI', 'https://doi.org/10.1/x'],
      ['Scholar', expect.stringContaining('scholar.google.com')],
    ]);
  });
});

describe('bibtex', () => {
  const paper = {
    title: 'Attention Is All You Need',
    authors: ['Ashish Vaswani', 'Noam Shazeer'],
    year: 2017,
    venue: null,
  };

  it('keys by surname, year and first word', () => {
    expect(bibtexKey(paper)).toBe('vaswani2017attention');
  });

  it('writes an arXiv preprint', () => {
    expect(bibtex({ paper, identifiers: [{ scheme: 'arxiv', value: '1706.03762' }] })).toBe(
      [
        '@article{vaswani2017attention,',
        '  title = {Attention Is All You Need},',
        '  author = {Ashish Vaswani and Noam Shazeer},',
        '  journal = {arXiv preprint arXiv:1706.03762},',
        '  year = {2017},',
        '  eprint = {1706.03762},',
        '  archivePrefix = {arXiv}',
        '}',
      ].join('\n'),
    );
  });

  it('puts a venue in booktitle', () => {
    expect(bibtex({ paper: { ...paper, venue: 'ICLR 2025' }, identifiers: [] })).toMatch(
      /^@inproceedings\{[^]*booktitle = \{ICLR 2025\}/,
    );
  });
});
