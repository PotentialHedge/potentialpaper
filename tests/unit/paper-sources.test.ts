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
      year: 2017,
      venue: 'NeurIPS 2017',
      identifiers: [
        { scheme: 'arxiv', value: '1706.03762' },
        { scheme: 'doi', value: '10.1000/abc' },
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
    expect(paper?.venue).toBe('Communications of the ACM');
    expect(paper?.identifiers).toEqual([
      { scheme: 'doi', value: '10.1145/3065386' },
      { scheme: 'arxiv', value: '1234.56789' },
    ]);
  });

  it('keeps an abstract only under an open license', () => {
    expect(parseOpenAlexWork(work, '10.1/a')?.abstract).toBeNull();
    const closed = { ...work, primary_location: { license: 'acm-tdm' } };
    expect(parseOpenAlexWork(closed, '10.1/a')?.abstract).toBeNull();
    const open = { ...work, best_oa_location: { license: 'cc-by' } };
    expect(parseOpenAlexWork(open, '10.1/a')?.abstract).toBe('We trained a trained');
  });

  it('a work with no title is no paper', () => {
    expect(parseOpenAlexWork({ ...work, title: null }, '10.1/a')).toBeNull();
  });
});
