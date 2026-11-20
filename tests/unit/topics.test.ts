import { describe, expect, it } from 'vitest';
import { newLinkId, parseLabeledLinks } from '@/lib/labeled-links';
import { parseAliases, topicNameKey, topicSlug } from '@/lib/topics';
import { cleanKeywords } from '@/server/import-reviews';
import { ESTABLISHED_DAYS, isEstablished, protectionHolds } from '@/server/page-protection';
import { sortTopicPapers, type TopicPaper } from '@/server/topic-papers';
import { foldTopics } from '@/server/topic-pages';

describe('topic names', () => {
  it('makes an address from a name', () => {
    expect(topicSlug('Linear attention')).toBe('linear-attention');
    expect(topicSlug('State-space models (SSMs)')).toBe('state-space-models-ssms');
    expect(topicSlug('Mixture-of-Experts & routing')).toBe('mixture-of-experts-and-routing');
    expect(topicSlug('Ünïcode naïve')).toBe('unicode-naive');
    expect(topicSlug('注意力')).toBeNull();
    expect(topicSlug('x'.repeat(100))!.length).toBe(60);
  });

  it('tells duplicates by case, accents, punctuation and plurals, not by words', () => {
    expect(topicNameKey('State-space models')).toBe(topicNameKey('state space model'));
    expect(topicNameKey('Mixtures of experts')).toBe(topicNameKey('mixture of expert'));
    expect(topicNameKey('Diffusion policies')).toBe(topicNameKey('diffusion policy'));
    expect(topicNameKey('Linear attention')).not.toBe(topicNameKey('Attention'));
    // Words that end in s without being plurals stay.
    expect(topicNameKey('Gaussian process')).toBe('gaussian process');
    expect(topicNameKey('Graph analysis')).toBe('graph analysis');
  });

  it('reads aliases from a form: each once, never the name', () => {
    expect(parseAliases('SSMs, state space model\nS4;  S4 ', 'State-space models')).toEqual(['SSMs', 'S4']);
  });
});

describe('link ids', () => {
  it('are ULIDs that a links.jsonl accepts, in time order', () => {
    const a = newLinkId(1_700_000_000_000);
    const b = newLinkId(1_700_000_000_001);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
    const line = JSON.stringify({ id: a, to: 'topic:linear-attention', label: 'in-topic' });
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
    expect(protectionHolds('established', 'community/10-a.md', someone, 'topic')).toBe(true);
    expect(protectionHolds('established', 'community/10-a.md', { ...someone, established: true }, 'topic')).toBe(false);
    expect(protectionHolds('admins', 'community/10-a.md', { ...someone, established: true }, 'topic')).toBe(true);
    expect(protectionHolds('admins', 'topic.json', { ...someone, admin: true }, 'topic')).toBe(false);
    expect(protectionHolds('admins', 'topic.json', { ...someone, system: true }, 'topic')).toBe(false);
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

describe("a topic's papers", () => {
  const paper = (title: string, over: Partial<TopicPaper> = {}): TopicPaper => ({
    paperId: title,
    title,
    year: 2025,
    introduces: false,
    via: null,
    venue: null,
    status: null,
    decision: null,
    score: null,
    ...over,
  });
  const papers = [
    paper('Old', { year: 2019 }),
    paper('ICLR high', {
      venue: { id: 'i', name: 'ICLR 2027', key: 'iclr/2027' },
      score: { mean: 8, min: 1, max: 10, label: 'Rating' },
    }),
    paper('NeurIPS mid', {
      year: 2026,
      venue: { id: 'n', name: 'NeurIPS 2026', key: null },
      score: { mean: 4, min: 1, max: 6, label: 'Overall' },
    }),
    paper('ICLR low', {
      venue: { id: 'i', name: 'ICLR 2027', key: 'iclr/2027' },
      score: { mean: 3, min: 1, max: 10, label: 'Rating' },
    }),
  ];

  it('sorts by date, by venue, and by score within its venue’s scale, unscored last', () => {
    expect(sortTopicPapers(papers, 'date').map((p) => p.title)).toEqual([
      'NeurIPS mid',
      'ICLR high',
      'ICLR low',
      'Old',
    ]);
    expect(sortTopicPapers(papers, 'venue').map((p) => p.title)).toEqual([
      'ICLR high',
      'ICLR low',
      'NeurIPS mid',
      'Old',
    ]);
    // 8 of 1–10 is 0.78 of the way; 4 of 1–6 is 0.6; 3 of 1–10 is 0.22.
    expect(sortTopicPapers(papers, 'score').map((p) => p.title)).toEqual([
      'ICLR high',
      'NeurIPS mid',
      'ICLR low',
      'Old',
    ]);
  });
});

describe('merging topics', () => {
  const file = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  it("folds the duplicate's names, broader topics, sections and links into the survivor", () => {
    const survivor = new Map([
      ['topic.json', file({ name: 'Mixture of experts', aliases: ['MoE'], broader: ['sparse-models'] })],
      ['community/10-what-it-is.md', '# What it is\n\nRouting.\n'],
      ['community/links.jsonl', `${JSON.stringify({ id: 'A1', to: 'topic:routing', label: 'related' })}\n`],
    ]);
    const duplicate = new Map([
      [
        'topic.json',
        file({
          name: 'Sparse experts',
          aliases: ['moe', 'Expert layers'],
          broader: ['sparse-models', 'scaling', 'mixture-of-experts'],
        }),
      ],
      ['community/10-what-it-is.md', '# What it is\n\nRouting.\n'],
      ['community/20-history.md', '# History\n\nSince 1991.\n'],
      [
        'community/links.jsonl',
        [
          JSON.stringify({ id: 'A1', to: 'topic:scaling', label: 'related' }),
          JSON.stringify({ id: 'B2', to: 'topic:routing', label: 'related' }),
          JSON.stringify({ id: 'C3', to: 'topic:mixture-of-experts', label: 'related' }),
        ].join('\n'),
      ],
    ]);
    const changes = new Map(
      foldTopics(survivor, duplicate, 'sparse-experts', 'mixture-of-experts').map((c) => [c.path, c.content]),
    );
    expect(JSON.parse(changes.get('topic.json')!)).toEqual({
      name: 'Mixture of experts',
      aliases: ['MoE', 'Sparse experts', 'Expert layers'],
      broader: ['sparse-models', 'scaling'],
    });
    // The same text isn't copied twice; the new section says where it came from.
    expect([...changes.keys()].filter((path) => path.endsWith('.md'))).toEqual(['community/20-history.md']);
    expect(changes.get('community/20-history.md')).toBe(
      '# History\n\nSince 1991.\n\n*From topic:sparse-experts, merged into this page.*\n',
    );
    const links = changes
      .get('community/links.jsonl')!
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(links.map((l) => l.to)).toEqual(['topic:routing', 'topic:scaling']);
    // An id the survivor's file has already is made anew.
    expect(links[1].id).not.toBe('A1');
  });
});
