import { describe, expect, it } from 'vitest';
import { presentationWhen, presentationWhere, sortPresentations } from '@/lib/presentations';
import { parseVersionFile } from '@/lib/versions';
import { withPresentations } from '@/server/import-presentations';
import type { PaperVersion } from '@/lib/versions';

const poster = {
  kind: 'Poster',
  session: 'Sydney Poster Session 1',
  room: 'Hall 1 - 4',
  board: '#S2609',
  start: '2026-12-08T10:00:00+11:00',
  end: '2026-12-08T13:00:00+11:00',
};
const oral = {
  kind: 'Oral',
  room: 'Pyrmont Theatre',
  start: '2026-12-08T15:30:00+11:00',
  end: '2026-12-08T15:45:00+11:00',
};

describe('presentation text', () => {
  it('says the day and the times as the venue clock has them', () => {
    expect(presentationWhen(poster)).toBe('Tue 8 Dec, 10:00–13:00');
    expect(presentationWhen({ start: '2026-12-08T23:00+11:00', end: '2026-12-09T01:00+11:00' })).toBe(
      'Tue 8 Dec, 23:00 – Wed 9 Dec, 01:00',
    );
    expect(presentationWhen({ start: '2026-12-08T10:00:00+11:00' })).toBe('Tue 8 Dec, 10:00');
  });

  it('says the room and board it has', () => {
    expect(presentationWhere(poster)).toBe('Hall 1 - 4, board #S2609');
    expect(presentationWhere(oral)).toBe('Pyrmont Theatre');
    expect(presentationWhere({})).toBeNull();
  });

  it('sorts by the instant, whatever the offset', () => {
    const paris = { kind: 'Poster', start: '2026-12-08T01:00:00+01:00' };
    expect(sortPresentations([oral, poster, paris]).map((p) => p.start)).toEqual([
      poster.start, // 23:00 UTC the day before
      paris.start, // 00:00 UTC
      oral.start,
    ]);
  });
});

describe('withPresentations', () => {
  const versions: PaperVersion[] = [
    {
      id: 'v_1',
      label: 'NeurIPS 2026',
      kind: 'submitted',
      url: 'https://openreview.net/forum?id=abc',
      submissions: [
        {
          page: 'neurips/2026',
          status: 'accepted',
          decision: 'Accept (oral)',
          url: 'https://openreview.net/forum?id=abc',
          reviews: 'openreview/abc',
        },
      ],
    },
  ];
  const locations = () => ['Sydney, Australia', 'Paris, France', 'Atlanta, USA'];

  it('writes the presentations and site into the entry naming the reviews', () => {
    const after = withPresentations(
      versions,
      'openreview/abc',
      { site: 'Sydney', presentations: [oral, poster] },
      locations,
    )!;
    const entry = after[0].submissions![0];
    expect(entry.site).toBe('Sydney');
    expect(entry.presentations).toEqual([poster, oral]);
    expect(entry.decision).toBe('Accept (oral)');
    expect(versions[0].submissions![0].presentations).toBeUndefined();
  });

  it('removes them when the schedule has none, and skips a paper with no entry', () => {
    const once = withPresentations(versions, 'openreview/abc', { presentations: [poster] }, locations)!;
    expect(
      withPresentations(once, 'openreview/abc', { presentations: [] }, locations)![0].submissions![0],
    ).not.toHaveProperty('presentations');
    expect(withPresentations(versions, 'openreview/zzz', { presentations: [poster] }, locations)).toBeNull();
  });

  it('is kept in a version file', () => {
    const after = withPresentations(versions, 'openreview/abc', { presentations: [poster] }, locations)!;
    const { id: _, ...file } = after[0];
    const parsed = parseVersionFile('v_1', JSON.stringify(file));
    expect('version' in parsed ? parsed.version.submissions?.[0].presentations : parsed).toEqual([poster]);
  });
});
