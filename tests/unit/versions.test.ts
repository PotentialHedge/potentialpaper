import { describe, expect, it } from 'vitest';
import { cleanEvidence, evidenceLabel, evidenceProblem } from '@/lib/evidence';
import { diffShort, diffTexts, sentencesOf } from '@/lib/text-diff';
import {
  encodeVersionFile,
  formatVersionDate,
  newVersionId,
  parseVersionFile,
  sortVersions,
  versionProblem,
  paperPdfOf,
  submissionStanding,
  versionStanding,
  venuePagesOf,
  withVenueNames,
  type PaperVersion,
} from '@/lib/versions';
import { encodeCommit, parseCommit, type Commit } from '@/server/pages/git-objects';
import { contentProblem, pathDenied, versionPath, type Roles } from '@/server/pages/rules';
import { attachPdf, attachSubmission, mergeFoundVersions } from '@/server/versions';
import { versionChanges, versionsIn } from '@/server/pages/content';

const SHA = 'a'.repeat(64);

const workshop: PaperVersion = {
  id: 'v_k3x9q2mf',
  label: 'SPIGM @ ICML 2026',
  kind: 'submitted',
  date: '2026-04-29',
  submissions: [
    {
      venue: 'SPIGM @ ICML 2026',
      status: 'accepted',
      decision: 'Poster',
      url: 'https://openreview.net/forum?id=zI2IeuDcoS',
    },
  ],
  url: 'https://openreview.net/forum?id=zI2IeuDcoS',
  pdf: { sha256: SHA, bytes: 1000, url: 'https://pdfs.example.org/pdf/x.pdf' },
  evidence: ['https://openreview.net/forum?id=zI2IeuDcoS'],
};
const conference: PaperVersion = {
  id: 'v_9q2mfk3x',
  label: 'ICLR 2027',
  kind: 'submitted',
  date: '2026-09-11',
  submissions: [{ venue: 'ICLR 2027', status: 'under_review' }],
};

describe('versions/<id>.json', () => {
  it('round-trips, the id in the name and a field to a line', () => {
    const text = encodeVersionFile(workshop);
    expect(text).not.toContain(workshop.id);
    expect(text.split('\n')[1]).toBe(`  "date": "${workshop.date}",`);
    const { pdf: _pdf, ...withoutPdf } = workshop;
    void _pdf;
    expect(parseVersionFile(workshop.id, text)).toEqual({ version: withoutPdf, pdfInfo: {} });
    expect(text).not.toContain(SHA);
    expect(contentProblem(versionPath(workshop.id), text)).toBeNull();
  });

  it('keeps a PDF beside its file, as a Git LFS pointer, and only its source and license inside', () => {
    const copied = {
      ...workshop,
      pdf: { ...workshop.pdf!, source: 'https://openreview.net/pdf?id=x', license: 'CC BY 4.0' },
    };
    const text = encodeVersionFile(copied);
    expect(JSON.parse(text).pdf).toEqual({ source: 'https://openreview.net/pdf?id=x', license: 'CC BY 4.0' });
    const changes = versionChanges([], [copied, conference]);
    expect(changes.map((c) => c.path).sort()).toEqual([
      'versions/v_9q2mfk3x.json',
      'versions/v_k3x9q2mf.json',
      'versions/v_k3x9q2mf.pdf',
    ]);
    const texts = new Map(changes.map((c) => [c.path, c.content!]));
    expect(texts.get('versions/v_k3x9q2mf.pdf')).toBe(
      `version https://git-lfs.github.com/spec/v1\noid sha256:${SHA}\nsize 1000\n`,
    );
    const read = versionsIn(texts, (sha) => (sha === SHA ? workshop.pdf!.url : undefined));
    expect(read).toEqual([copied, conference]);
    // Without the bytes known here, the version shows without its PDF.
    expect(versionsIn(texts, () => undefined)[0].pdf).toBeUndefined();
    expect(versionChanges([copied], [{ ...copied, pdf: undefined }])).toEqual([
      { path: 'versions/v_k3x9q2mf.pdf', content: null },
      { path: 'versions/v_k3x9q2mf.json', content: encodeVersionFile({ ...copied, pdf: undefined }) },
    ]);
    expect(contentProblem(versionPath(workshop.id), '{"label":"x","kind":"other","pdf":{"sha256":"x"}}')).toMatch(
      /pdf\.sha256/,
    );
  });

  it('refuses a bad version, a duplicate id, an unknown field', () => {
    expect(versionProblem({ ...workshop, kind: 'blog' })).toMatch(/kind/);
    expect(versionProblem({ ...workshop, kind: 'workshop' })).toMatch(/kind/);
    expect(versionProblem({ ...workshop, submissions: [{ venue: 'X', status: 'published' }] })).toMatch(/submission/);
    expect(versionProblem({ ...workshop, submissions: [{ status: 'accepted' }] })).toMatch(/submission/);
    expect(versionProblem({ ...workshop, submissions: [{ venue: 'X', reviews: '../x' }] })).toMatch(/submission/);
    expect(versionProblem({ ...workshop, status: 'accepted' })).toMatch(/unknown field/);
    expect(versionProblem({ ...workshop, date: '26-04-29' })).toMatch(/date/);
    expect(versionProblem({ ...workshop, url: 'javascript:alert(1)' })).toMatch(/address/);
    expect(versionProblem({ ...workshop, evidence: ['http://x.org'] })).toMatch(/evidence/);
    expect(versionProblem({ ...workshop, extra: 1 })).toMatch(/unknown field/);
    expect(versionProblem({ ...workshop, pdf: { ...workshop.pdf, sha256: 'x' } })).toMatch(/SHA-256/);
    expect(parseVersionFile(workshop.id, '[]')).toEqual({ problem: 'is not a JSON object' });
    expect(contentProblem(versionPath('v_aaaaaaaa'), '{"id":1}\n')).toMatch(/file name/);
  });

  it('sorts undated versions last, keeping their order', () => {
    const undated = { ...conference, id: 'v_aaaaaaaa', date: undefined };
    expect(sortVersions([undated, conference, workshop]).map((v) => v.id)).toEqual([
      workshop.id,
      conference.id,
      undated.id,
    ]);
  });

  it('words a version', () => {
    expect(versionStanding(workshop)).toBe('SPIGM @ ICML 2026: Accepted · Poster');
    expect(submissionStanding({ status: 'accepted', decision: 'Accept (Oral)' })).toBe('Accept (Oral)');
    expect(submissionStanding({ status: 'desk_rejected' })).toBe('Desk rejected');
    expect(versionStanding({})).toBeNull();
    expect(
      versionStanding({ submissions: [{ venue: 'ICLR 2026', status: 'rejected' }, { venue: 'NeurIPS 2026' }] }),
    ).toBe('ICLR 2026: Rejected; NeurIPS 2026');
    expect(formatVersionDate('2026-04-09')).toBe('9 Apr 2026');
    expect(formatVersionDate('2026-04')).toBe('Apr 2026');
    expect(newVersionId()).toMatch(/^v_[a-z2-9]{8}$/);
  });

  it('is written by anyone verified, and the system', () => {
    const roles: Roles = { system: false, admin: false, verified: true, owner: false, claimed: true };
    expect(pathDenied(versionPath('v_aaaaaaaa'), roles)).toBeNull();
    expect(pathDenied(versionPath('v_aaaaaaaa'), { ...roles, system: true, verified: false })).toBeNull();
    expect(pathDenied(versionPath('v_aaaaaaaa'), { ...roles, verified: false })).toMatch(/confirm/);
  });

  it('folds found versions into the page’s by address', () => {
    const merged = mergeFoundVersions(
      [{ ...conference, url: 'https://openreview.net/forum?id=dskf2Ppd9o', note: 'ours' }],
      [
        {
          label: 'ICLR 2027 Conference',
          kind: 'submitted',
          submissions: [{ venue: 'ICLR 2027', status: 'accepted', decision: 'Poster' }],
          url: 'http://openreview.net/forum?id=dskf2Ppd9o/',
          evidence: ['https://e.org'],
        },
        { label: 'arXiv v1', kind: 'preprint', date: '2026-06-16', url: 'https://arxiv.org/abs/2606.18022v1' },
      ],
    );
    expect(merged.map((v) => v.label)).toEqual(['arXiv v1', 'ICLR 2027']);
    expect(merged[1]).toMatchObject({
      id: conference.id,
      submissions: [{ venue: 'ICLR 2027', status: 'accepted', decision: 'Poster' }],
      note: 'ours',
    });
    expect(merged[0].id).toBeUndefined();
    // What a venue's bot imported stays as it said.
    const imported = { venue: 'ICLR 2027', status: 'rejected' as const, reviews: 'openreview/dskf2ppd9o' };
    const kept = mergeFoundVersions(
      [{ ...conference, submissions: [imported] }],
      [{ label: 'x', kind: 'submitted', url: '', submissions: [{ venue: 'ICLR 2027', status: 'accepted' }] }],
    );
    expect(kept.find((v) => v.id === conference.id)?.submissions).toEqual([imported]);
  });

  it('records an imported submission in the version it is of, once', () => {
    const forum = 'https://openreview.net/forum?id=dskf2Ppd9o';
    const entry = { venue: 'ICLR 2027', status: 'under_review' as const, url: forum, reviews: 'openreview/dskf2ppd9o' };
    let n = 0;
    const id = () => `v_new${n++}`;
    // None at its forum: a new submitted version.
    const made = attachSubmission([workshop], entry, { newId: id, date: '2026-09-19' });
    expect(made.find((v) => v.id === 'v_new0')).toMatchObject({
      kind: 'submitted',
      date: '2026-09-19',
      url: forum,
      submissions: [entry],
    });
    // Again, decided: the same entry, brought up to date, and a decision dropped by the source is gone.
    const decided = attachSubmission(made, { ...entry, status: 'accepted', decision: 'Poster' }, { newId: id });
    expect(decided).toHaveLength(2);
    expect(decided.find((v) => v.id === 'v_new0')?.submissions).toEqual([
      { ...entry, status: 'accepted', decision: 'Poster' },
    ]);
    expect(attachSubmission(decided, entry, { newId: id }).find((v) => v.id === 'v_new0')?.submissions).toEqual([
      entry,
    ]);
    // Someone's entry for the same forum gains the link rather than a second entry.
    const hand = { ...conference, submissions: [{ venue: 'ICLR 2027', url: forum, evidence: ['https://e.org'] }] };
    // A date someone gave a version stands.
    expect(attachSubmission([hand], entry, { newId: id, date: '2026-01-01' })[0].date).toBe(conference.date);
    expect(attachSubmission([hand], entry, { newId: id })[0].submissions).toEqual([
      { ...entry, evidence: ['https://e.org'] },
    ]);
  });

  it('names a venue by its page, and shows the page’s name', () => {
    const forum = 'https://openreview.net/forum?id=dskf2Ppd9o';
    const file = (submissions: unknown[]) => JSON.stringify({ label: 'NeurIPS 2026', kind: 'submitted', submissions });
    expect(parseVersionFile('v_a', file([{ page: 'neurips/2026', status: 'accepted' }]))).toHaveProperty('version');
    expect(parseVersionFile('v_a', file([{ venue: 'NeurIPS 2026', page: 'neurips/2026' }]))).toEqual({
      problem: expect.stringMatching(/needs a venue/),
    });
    expect(parseVersionFile('v_a', file([{ status: 'accepted' }]))).toEqual({
      problem: expect.stringMatching(/needs a venue/),
    });
    expect(parseVersionFile('v_a', file([{ page: 'NeurIPS 2026' }]))).toEqual({
      problem: expect.stringMatching(/needs a venue/),
    });

    const versions: PaperVersion[] = [
      { id: 'v_a', label: 'x', kind: 'submitted', submissions: [{ page: 'neurips/2026', url: forum }] },
      { id: 'v_b', label: 'y', kind: 'preprint', submissions: [{ venue: 'SPIGM @ ICML 2026' }] },
      { id: 'v_c', label: 'z', kind: 'preprint' },
    ];
    expect(venuePagesOf(versions)).toEqual(['neurips/2026']);
    const shown = withVenueNames(versions, new Map([['neurips/2026', 'NeurIPS 2026']]));
    expect(shown[0].submissions).toEqual([{ page: 'neurips/2026', venue: 'NeurIPS 2026', url: forum }]);
    expect(shown[1]).toBe(versions[1]);
    expect(versionStanding(shown[0])).toBe('NeurIPS 2026');
    // A page with no name yet shows its key.
    expect(withVenueNames(versions, new Map())[0].submissions![0].venue).toBe('neurips/2026');
  });

  it('records an imported submission by its venue page, over a hand-written one at its forum', () => {
    const forum = 'https://openreview.net/forum?id=dskf2Ppd9o';
    const entry = { page: 'iclr/2027', status: 'accepted' as const, url: forum, reviews: 'openreview/dskf2ppd9o' };
    const made = attachSubmission([], entry, { newId: () => 'v_new', label: 'ICLR 2027' });
    expect(made[0]).toMatchObject({ label: 'ICLR 2027', submissions: [entry] });
    const hand = { ...conference, submissions: [{ venue: 'ICLR 2027', url: forum }] };
    expect(attachSubmission([hand], entry)[0].submissions).toEqual([entry]);
    // A lookup's entry by name at the same forum is the same submission as one by page.
    const merged = mergeFoundVersions(
      [{ ...conference, submissions: [{ page: 'iclr/2027', url: forum }] }],
      [
        {
          label: 'x',
          kind: 'submitted',
          url: conference.url!,
          submissions: [{ venue: 'ICLR 2027', url: forum, status: 'accepted' }],
        },
      ],
    );
    expect(merged[0].submissions).toEqual([{ page: 'iclr/2027', url: forum, status: 'accepted' }]);
  });

  it('gives a PDF to the version at its address, and shows the newest version’s', () => {
    const pdf = { sha256: 'b'.repeat(64), bytes: 9, url: '/x.pdf', source: workshop.url };
    const given = attachPdf([conference, { ...workshop, pdf: undefined }], pdf, { url: workshop.url!, label: 'x' });
    expect(given.find((v) => v.id === workshop.id)?.pdf).toEqual(pdf);
    expect(
      attachPdf([], pdf, { url: 'https://arxiv.org/abs/1', label: 'arXiv', kind: 'preprint' }, () => 'v_a'),
    ).toEqual([
      {
        id: 'v_a',
        label: 'arXiv',
        kind: 'preprint',
        url: 'https://arxiv.org/abs/1',
        pdf,
        evidence: ['https://arxiv.org/abs/1'],
      },
    ]);
    expect(paperPdfOf([workshop, conference])).toEqual(workshop.pdf);
    expect(paperPdfOf([conference])).toBeNull();
  });
});

describe('evidence', () => {
  it('takes https and site paths, nothing else', () => {
    expect(evidenceProblem('https://openreview.net/forum?id=x')).toBeNull();
    expect(evidenceProblem('/files/abc.pdf')).toBeNull();
    expect(evidenceProblem('http://x.org')).toMatch(/https/);
    expect(evidenceProblem('https://x.org/a b')).toMatch(/space/);
    expect(evidenceProblem('//evil.org')).toMatch(/https/);
    expect(cleanEvidence([' https://a.org ', 'https://a.org', ''])).toEqual({ evidence: ['https://a.org'] });
  });

  it('names uploads by their file name', () => {
    expect(evidenceLabel(`https://pdfs.example.org/evidence/${SHA}-decision.pdf`)).toBe('decision.pdf');
    expect(evidenceLabel(`/files/${SHA}.pdf`)).toBe('uploaded PDF');
    expect(evidenceLabel('https://www.openreview.net/forum?id=x')).toBe('openreview.net/…');
  });

  it('rides in the commit as trailers', () => {
    const commit: Commit = {
      tree: 'b'.repeat(40),
      parent: null,
      authorId: 'u_abcdefgh',
      at: new Date('2026-11-13T00:00:00Z'),
      summary: 'Add a version',
      kind: 'edit',
      bot: false,
      evidence: ['https://openreview.net/forum?id=x', '/files/y.pdf'],
    };
    const body = encodeCommit(commit).toString();
    expect(body).toContain('\nEvidence: https://openreview.net/forum?id=x\nEvidence: /files/y.pdf\n');
    expect(parseCommit(Buffer.from(body))).toEqual({ ...commit, reverts: undefined });
  });
});

describe('comparing text', () => {
  it('splits sentences across layouts, undoing hyphenation and hiding addresses', () => {
    const a = 'We intro-\nduce recursion in MDMs. It works well, e.g. on\nSudoku.\n\n3\nMail a@b.org for code.';
    expect(sentencesOf(a)).toEqual([
      'We introduce recursion in MDMs.',
      'It works well, e.g. on Sudoku.',
      'Mail [email] for code.',
    ]);
  });

  it('diffs sentences, then words, collapsing what is the same', () => {
    const same = Array.from({ length: 20 }, (_, i) => `Sentence number ${i} stays.`).join(' ');
    const a = `${same} Recursion helps a little. The end.`;
    const b = `${same} Recursion helps a lot. The end.`;
    const diff = diffTexts(a, b)!;
    expect(diff.stats).toMatchObject({ removed: 1, added: 1, unchanged: 21 });
    expect(diff.blocks[0]).toEqual({ kind: 'skip', count: 18 });
    const change = diff.blocks.find((b) => b.kind === 'change');
    expect(
      change && change.kind === 'change' && change.words?.filter((w) => w.kind !== 'same').map((w) => w.text),
    ).toEqual(['little', 'lot']);
    expect(diffShort('A title', 'A title')).toBeNull();
  });
});
