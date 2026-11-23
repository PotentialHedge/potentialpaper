import { describe, expect, it } from 'vitest';
import { parseArxivFeed } from '@/server/paper-sources/arxiv';
import { parseOpenAlexWork } from '@/server/paper-sources/openalex';
import { SourceUnavailable } from '@/server/paper-sources/types';

const feed = (entry: string) =>
  `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <title>arXiv Query</title>${entry}
</feed>`;

const ENTRY = `<entry>
  <id>http://arxiv.org/abs/1706.03762v7</id>
  <title>Attention Is
    All You &amp; Need</title>
  <summary>  The dominant
    models.  </summary>
  <published>2017-06-12T17:57:34Z</published>
  <updated>2023-08-02T00:41:18Z</updated>
  <arxiv:doi>10.1000/ABC</arxiv:doi>
  <arxiv:journal_ref>NeurIPS 2017</arxiv:journal_ref>
  <author><name>Ashish Vaswani</name></author>
  <author><name>Noam Shazeer</name></author>
</entry>`;

describe('arXiv feed', () => {
  it('reads an entry', () => {
    expect(parseArxivFeed(feed(ENTRY), '1706.03762')).toEqual({
      title: 'Attention Is All You & Need',
      authors: ['Ashish Vaswani', 'Noam Shazeer'],
      abstract: 'The dominant models.',
      identifiers: [
        { scheme: 'arxiv', value: '1706.03762' },
        { scheme: 'doi', value: '10.1000/abc' },
      ],
      source: 'arxiv',
      metadataLicense: 'CC0-1.0',
      abstractLicense: 'CC0-1.0',
      versions: [
        { label: 'arXiv v1', kind: 'preprint', date: '2017-06-12', url: 'https://arxiv.org/abs/1706.03762v1' },
        { label: 'arXiv v7', kind: 'preprint', date: '2023-08-02', url: 'https://arxiv.org/abs/1706.03762v7' },
        // Its journal_ref, as where it was published.
        { label: 'NeurIPS 2017', kind: 'journal', submissions: [{ venue: 'NeurIPS 2017', status: 'accepted' }] },
      ],
    });
  });

  it('a single author is still a list, and a numeric title still text', () => {
    const paper = parseArxivFeed(
      feed(
        `<entry><id>http://arxiv.org/abs/2001.00001v1</id><title>2024</title><author><name>A</name></author></entry>`,
      ),
      '2001.00001',
    );
    expect(paper?.title).toBe('2024');
    expect(paper?.authors).toEqual(['A']);
    expect(paper?.abstractLicense).toBeNull();
    // Only v1, so only one version, undated when the feed gives no date.
    expect(paper?.versions).toEqual([
      { label: 'arXiv v1', kind: 'preprint', date: undefined, url: 'https://arxiv.org/abs/2001.00001v1' },
    ]);
  });

  it('no entry means no such paper', () => {
    expect(parseArxivFeed(feed(''), '2199.99999')).toBeNull();
  });

  it('ignores an entry for another paper', () => {
    expect(parseArxivFeed(feed(ENTRY), '1111.11111')).toBeNull();
  });

  it('something that is not a feed is an outage, not a miss', () => {
    expect(() => parseArxivFeed('<html>busy</html>', '1706.03762')).toThrow(SourceUnavailable);
  });
});

describe('OpenAlex work', () => {
  const work = {
    title: 'ImageNet  classification',
    publication_year: 2017,
    authorships: [{ raw_author_name: 'A. Krizhevsky', author: { display_name: 'Alex Krizhevsky' } }],
    primary_location: { source: { display_name: 'Communications of the ACM' } },
    locations: [{ landing_page_url: 'https://arxiv.org/abs/1234.56789v2' }],
    abstract_inverted_index: { We: [0], trained: [1, 3], a: [2] },
  };

  it('uses names as printed, and finds an arXiv copy', () => {
    const paper = parseOpenAlexWork(work, '10.1145/3065386');
    expect(paper?.title).toBe('ImageNet classification');
    expect(paper?.authors).toEqual(['A. Krizhevsky']);
    expect(paper?.identifiers).toEqual([
      { scheme: 'doi', value: '10.1145/3065386' },
      { scheme: 'arxiv', value: '1234.56789' },
    ]);
    expect(paper?.versions).toEqual([
      {
        label: 'Communications of the ACM',
        kind: 'camera-ready',
        date: '2017',
        url: 'https://doi.org/10.1145/3065386',
        submissions: [{ venue: 'Communications of the ACM', status: 'accepted' }],
      },
    ]);
  });

  it('keeps an abstract only under an open license, and records that license', () => {
    expect(parseOpenAlexWork(work, '10.1/a')).toMatchObject({ abstract: null, abstractLicense: null });
    const closed = { ...work, primary_location: { license: 'acm-tdm' } };
    expect(parseOpenAlexWork(closed, '10.1/a')).toMatchObject({ abstract: null, abstractLicense: null });
    const open = { ...work, best_oa_location: { license: 'cc-by' } };
    expect(parseOpenAlexWork(open, '10.1/a')).toMatchObject({
      abstract: 'We trained a trained',
      abstractLicense: 'cc-by',
      source: 'openalex',
      metadataLicense: 'CC0-1.0',
    });
  });

  it('a work with no title is no paper', () => {
    expect(parseOpenAlexWork({ ...work, title: null }, '10.1/a')).toBeNull();
  });
});
