import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalPaperId, paperIdFromText, paperPath, parseDoi, parsePaperId } from '@/lib/paper-ids';

describe('arXiv ids', () => {
  it('drops the version, since a page is for the work', () => {
    expect(parsePaperId('arxiv', '1706.03762v5')).toEqual({ scheme: 'arxiv', value: '1706.03762' });
    expect(parsePaperId('arxiv', 'hep-th/9901001v2')).toEqual({ scheme: 'arxiv', value: 'hep-th/9901001' });
    expect(parsePaperId('arxiv', 'math.GT/0309136')).toEqual({ scheme: 'arxiv', value: 'math.gt/0309136' });
  });

  it('refuses anything else', () => {
    for (const bad of ['', '1706', '1706.123', '1706.123456', '../etc/passwd', '1706.03762?x=1']) {
      expect(parsePaperId('arxiv', bad)).toBeNull();
    }
  });
});

describe('DOIs', () => {
  it('are case-insensitive', () => {
    expect(parseDoi('10.1145/ABC.Def')).toEqual({ scheme: 'doi', value: '10.1145/abc.def' });
  });

  it("treats arXiv's own DOI as the preprint", () => {
    expect(parseDoi('10.48550/arXiv.1706.03762')).toEqual({ scheme: 'arxiv', value: '1706.03762' });
  });

  it('refuses a space or a missing suffix', () => {
    expect(parseDoi('10.1145/a b')).toBeNull();
    expect(parseDoi('10.1145/')).toBeNull();
    expect(parseDoi('11.1145/a')).toBeNull();
  });
});

describe('what people paste into search', () => {
  it.each([
    ['1706.03762', 'arxiv', '1706.03762'],
    ['arXiv:1706.03762v2', 'arxiv', '1706.03762'],
    ['https://arxiv.org/abs/1706.03762v2', 'arxiv', '1706.03762'],
    ['https://arxiv.org/pdf/1706.03762.pdf', 'arxiv', '1706.03762'],
    ['https://doi.org/10.1145/3065386', 'doi', '10.1145/3065386'],
    ['doi:10.1145/3065386', 'doi', '10.1145/3065386'],
    ['10.1145/3065386', 'doi', '10.1145/3065386'],
    ['https://openreview.net/forum?id=YOc8jsq9dV', 'openreview', 'YOc8jsq9dV'],
  ])('%s', (text, scheme, value) => {
    expect(paperIdFromText(text)).toEqual({ scheme, value });
  });

  it('leaves words to full-text search', () => {
    expect(paperIdFromText('attention is all you need')).toBeNull();
    expect(paperIdFromText('transformers')).toBeNull();
  });
});

describe('addresses', () => {
  it('keeps the slashes in old arXiv ids and DOIs, and encodes the rest', () => {
    expect(paperPath({ scheme: 'arxiv', value: 'hep-th/9901001' })).toBe('/abs/hep-th/9901001');
    expect(paperPath({ scheme: 'doi', value: '10.1002/(sici)1<2>3' })).toBe('/doi/10.1002/(sici)1%3C2%3E3');
  });

  it('prefers arXiv, then DOI', () => {
    const doi = { scheme: 'doi', value: '10.1/a' } as const;
    const arxiv = { scheme: 'arxiv', value: '1706.03762' } as const;
    const openreview = { scheme: 'openreview', value: 'abcdefgh' } as const;
    expect(canonicalPaperId([openreview, doi, arxiv])).toEqual(arxiv);
    expect(canonicalPaperId([openreview, doi])).toEqual(doi);
  });

  it('a parsed identifier parses back to itself from its address', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^10\.\d{4,9}\/[\x21-\x7e]{1,40}$/), (doi) => {
        const id = parseDoi(doi);
        if (id?.scheme !== 'doi') return;
        const path = paperPath(id).slice('/doi/'.length);
        expect(parseDoi(path.split('/').map(decodeURIComponent).join('/'))).toEqual(id);
      }),
    );
  });
});
