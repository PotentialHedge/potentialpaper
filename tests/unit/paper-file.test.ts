import { describe, expect, it } from 'vitest';
import { encodePaperFile, listedVenue, paperFileOf, paperRowOf, parsePaperFile } from '@/lib/paper-file';
import { planPaperFile } from '@/server/pages/layout-migration';
import type { PaperVersion } from '@/lib/versions';

const ROW = {
  title: '  Attention Is All You Need ',
  authors: ['Ashish Vaswani', ' ', 'Noam Shazeer'],
  abstract: 'The dominant sequence transduction models…',
  metadataLicense: 'CC0-1.0',
  abstractLicense: 'CC0-1.0',
};

describe('paper.json', () => {
  it('is made from a row, and reads back to it', () => {
    const file = paperFileOf(ROW);
    expect(file).toEqual({
      title: 'Attention Is All You Need',
      authors: ['Ashish Vaswani', 'Noam Shazeer'],
      abstract: 'The dominant sequence transduction models…',
      license: { metadata: 'CC0-1.0', abstract: 'CC0-1.0' },
    });
    expect(parsePaperFile(encodePaperFile(file))).toEqual(file);
    expect(paperRowOf(file)).toEqual({ ...ROW, title: file.title, authors: file.authors });
  });

  it('leaves out what the row lacks, and refuses what is not one', () => {
    expect(paperFileOf({ ...ROW, abstract: null, metadataLicense: null, abstractLicense: null })).toEqual({
      title: 'Attention Is All You Need',
      authors: ['Ashish Vaswani', 'Noam Shazeer'],
    });
    expect(parsePaperFile('{"title":"x","authors":[],"venue":"ICLR"}')).toBeNull();
    expect(parsePaperFile('not json')).toBeNull();
  });
});

describe('listedVenue', () => {
  const version = (date: string, submissions: PaperVersion['submissions']): PaperVersion => ({
    id: `v_${date}`,
    label: date,
    kind: 'submitted',
    date,
    submissions,
  });

  it('names the venue it was accepted at, else the newest it went to, and the first version’s year', () => {
    const rejected = version('2025-09-20', [{ venue: 'ICLR 2026', status: 'rejected' }]);
    const accepted = version('2026-05-10', [{ venue: 'NeurIPS 2026', status: 'accepted' }]);
    const review = version('2026-09-20', [{ venue: 'ICLR 2027', status: 'under_review' }]);
    expect(listedVenue([review, rejected, accepted])).toEqual({ venue: 'NeurIPS 2026', year: 2025 });
    expect(listedVenue([rejected, review])).toEqual({ venue: 'ICLR 2027', year: 2025 });
    expect(listedVenue([])).toEqual({ venue: null, year: null });
    const undated = { ...review, date: undefined };
    expect(listedVenue([undated])).toEqual({ venue: 'ICLR 2027', year: 2027 });
  });
});

describe('planPaperFile', () => {
  it('moves a paper to paper.json and leaves metadata.json with its kind and key', () => {
    const files = new Map([['.potentialpaper/metadata.json', '{"layout":5,"title":"Old"}']]);
    const changes = planPaperFile({ kind: 'paper', key: 'abc' }, files, ROW);
    expect(changes.map((c) => c.path)).toEqual(['.potentialpaper/metadata.json', 'paper.json']);
    expect(JSON.parse(changes[0].content!)).toEqual({ layout: 6, kind: 'paper', key: 'abc' });
    expect(JSON.parse(changes[1].content!).title).toBe('Attention Is All You Need');
  });

  it('stamps other kinds, and skips a page already moved', () => {
    const venue = new Map([['.potentialpaper/metadata.json', '{"layout":5,"kind":"venue","key":"iclr"}']]);
    expect(planPaperFile({ kind: 'venue', key: 'iclr' }, venue, null).map((c) => c.path)).toEqual([
      '.potentialpaper/metadata.json',
    ]);
    expect(
      planPaperFile({ kind: 'paper', key: 'abc' }, new Map([['.potentialpaper/metadata.json', '{"layout":6}']]), ROW),
    ).toEqual([]);
  });
});
