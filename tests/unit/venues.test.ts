import { describe, expect, it } from 'vitest';
import { seriesSlug, sourceTitle, sourceUrl, venuePlace } from '@/lib/venues';
import { keysAbove } from '@/server/page-claims';
import { venueFileUpdate } from '@/server/venue-pages';

describe('venuePlace', () => {
  it("maps a conference's main edition to its series and edition", () => {
    expect(venuePlace('openreview:ICLR.cc/2027/Conference', 'ICLR 2027')).toEqual({
      series: { key: 'iclr', name: 'ICLR' },
      edition: { key: 'iclr/2027', name: 'ICLR 2027', year: 2027 },
      source: 'openreview:ICLR.cc/2027/Conference',
    });
    expect(venuePlace('openreview:NeurIPS.cc/2025/Conference')?.edition).toEqual({
      key: 'neurips/2025',
      name: 'NeurIPS 2025',
      year: 2025,
    });
    expect(venuePlace('openreview:robot-learning.org/CoRL/2024/Conference')?.series).toEqual({
      key: 'corl',
      name: 'CoRL',
    });
  });

  it('leaves tracks, workshops, undated venues and other sources for later', () => {
    expect(venuePlace('openreview:NeurIPS.cc/2025/Datasets_and_Benchmarks_Track')).toBeNull();
    expect(venuePlace('openreview:ICLR.cc/2025/Workshop/GenAI')).toBeNull();
    expect(venuePlace('openreview:TMLR')).toBeNull();
    expect(venuePlace('acl:2025/Conference')).toBeNull();
    expect(venuePlace('no-colon')).toBeNull();
  });

  it('makes slugs and source links', () => {
    expect(seriesSlug('Learning on Graphs')).toBe('learning-on-graphs');
    expect(seriesSlug('---')).toBeNull();
    expect(sourceUrl('openreview:ICLR.cc/2027/Conference')).toBe(
      'https://openreview.net/group?id=ICLR.cc%2F2027%2FConference',
    );
    expect(sourceTitle('openreview:x')).toBe('OpenReview');
  });
});

describe("the venues bot's edits", () => {
  it('writes a new file whole, and on an existing one only adds a missing source', () => {
    const wanted = { name: 'ICLR 2027', sources: ['openreview:ICLR.cc/2027/Conference'] };
    expect(venueFileUpdate(null, wanted)).toEqual(wanted);
    expect(venueFileUpdate({ name: 'ICLR 2027 (Rio)' }, wanted)).toEqual({
      name: 'ICLR 2027 (Rio)',
      ...{ sources: wanted.sources },
    });
    expect(venueFileUpdate({ name: 'x', sources: wanted.sources }, wanted)).toBeNull();
    expect(venueFileUpdate({ name: 'x', unknown: true }, wanted)).toBeNull();
  });
});

describe('keysAbove', () => {
  it("lists a venue's key and every key above it", () => {
    expect(keysAbove('iclr/2027/workshop')).toEqual(['iclr/2027/workshop', 'iclr/2027', 'iclr']);
    expect(keysAbove('iclr')).toEqual(['iclr']);
  });
});
