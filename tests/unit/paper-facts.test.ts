import { describe, expect, it } from 'vitest';
import { citationTags, paperFacts, paperJsonLd } from '@/lib/paper-facts';
import type { Submission } from '@/lib/submissions';
import type { PaperVersion } from '@/lib/versions';

const versions: PaperVersion[] = [
  {
    id: 'v1',
    label: 'ICLR 2026',
    kind: 'submitted',
    date: '2025-09-19',
    submissions: [{ venue: 'ICLR 2026', status: 'rejected', decision: 'Reject', reviews: 'openreview/a1' }],
  },
  {
    id: 'v2',
    label: 'NeurIPS 2026',
    kind: 'submitted',
    date: '2026-05-01',
    submissions: [
      {
        venue: 'NeurIPS 2026',
        status: 'accepted',
        decision: 'Accept (poster)',
        site: 'Sydney',
        reviews: 'openreview/b2',
      },
    ],
  },
];

const submission = (venueId: string, name: string, externalId: string, keywords: string[]): Submission => ({
  venue: { id: `openreview:${venueId}`, name, url: null, forms: {} },
  externalId,
  number: 1,
  status: null,
  decision: null,
  keywords,
  url: null,
  fetchedAt: new Date(),
  notes: [],
});

const facts = paperFacts({
  paper: { title: 'A paper', authors: ['Ada Lovelace', 'Alan Turing'], abstract: 'It works.' },
  versions,
  submissions: [
    submission('ICLR.cc/2026/Conference', 'ICLR 2026', 'A1', ['Optimal transport', 'games']),
    submission('NeurIPS.cc/2026/Conference', 'NeurIPS 2026', 'B2', ['Games', 'mean field']),
  ],
  identifiers: [{ scheme: 'arxiv', value: '2609.02302' }],
  pdf: 'https://example.org/a.pdf',
});

describe('paperFacts', () => {
  it('lists where the paper went, newest first, with what the venue decided and where it is presented', () => {
    expect(facts.venues).toEqual([
      expect.objectContaining({
        venue: 'NeurIPS 2026',
        status: 'accepted',
        presentation: 'Poster',
        site: 'Sydney',
        path: '/v/neurips/2026',
      }),
      expect.objectContaining({
        venue: 'ICLR 2026',
        status: 'rejected',
        presentation: null,
        site: null,
        path: '/v/iclr/2026',
      }),
    ]);
    expect(facts.published?.venue).toBe('NeurIPS 2026');
    expect(facts.firstDate).toBe('2025-09-19');
  });

  it("keeps each venue's keywords once, whatever their case", () => {
    expect(facts.keywords).toEqual(['Optimal transport', 'games', 'mean field']);
  });

  it('gives Google Scholar its tags, an author each', () => {
    const tags = citationTags(facts);
    expect(tags.filter(([name]) => name === 'citation_author').map(([, v]) => v)).toEqual([
      'Ada Lovelace',
      'Alan Turing',
    ]);
    expect(tags).toContainEqual(['citation_conference_title', 'NeurIPS 2026']);
    expect(tags).toContainEqual(['citation_publication_date', '2025/09/19']);
    expect(tags).toContainEqual(['citation_arxiv_id', '2609.02302']);
    expect(tags).toContainEqual(['citation_pdf_url', 'https://example.org/a.pdf']);
  });

  it('describes the paper as a ScholarlyArticle presented at the venue', () => {
    const ld = paperJsonLd(facts, 'https://x.org/s/1', 'https://x.org');
    expect(ld).toMatchObject({
      '@type': 'ScholarlyArticle',
      isPartOf: {
        '@type': 'Event',
        name: 'NeurIPS 2026',
        url: 'https://x.org/v/neurips/2026',
        location: { name: 'Sydney' },
      },
      sameAs: ['https://arxiv.org/abs/2609.02302'],
    });
  });
});
