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
  versionStanding,
  type PaperVersion,
} from '@/lib/versions';
import { encodeCommit, parseCommit, type Commit } from '@/server/pages/git-objects';
import { contentProblem, pathDenied, versionPath, type Roles } from '@/server/pages/rules';
import {
  abstractOverlap,
  normalizeTitle,
  openReviewVersion,
  parseArxivHistory,
  sameWork,
  venueName,
} from '@/server/version-sources';
import { mergeFoundVersions } from '@/server/versions';
import { versionChanges, versionsIn } from '@/server/pages/content';

const SHA = 'a'.repeat(64);

const workshop: PaperVersion = {
  id: 'v_k3x9q2mf',
  label: 'SPIGM @ ICML 2026',
  kind: 'workshop',
  date: '2026-04-29',
  status: 'accepted',
  decision: 'Poster',
  url: 'https://openreview.net/forum?id=zI2IeuDcoS',
  pdf: { sha256: SHA, bytes: 1000, url: 'https://pdfs.example.org/pdf/x.pdf' },
  evidence: ['https://openreview.net/forum?id=zI2IeuDcoS'],
};
const conference: PaperVersion = {
  id: 'v_9q2mfk3x',
  label: 'ICLR 2027',
  kind: 'conference',
  date: '2026-09-11',
  status: 'under_review',
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
    expect(versionStanding(workshop)).toBe('Accepted · Poster');
    expect(versionStanding({ status: 'accepted', decision: 'Accept (Oral)' })).toBe('Accept (Oral)');
    expect(versionStanding({})).toBeNull();
    expect(formatVersionDate('2026-04-09')).toBe('9 Apr 2026');
    expect(formatVersionDate('2026-04')).toBe('Apr 2026');
    expect(newVersionId()).toMatch(/^v_[a-z2-9]{8}$/);
  });

  it('is written by anyone verified, and the system', () => {
    const roles: Roles = { system: false, admin: false, verified: true, confirmedAuthor: false, claimed: true };
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
          kind: 'conference',
          status: 'accepted',
          decision: 'Poster',
          url: 'http://openreview.net/forum?id=dskf2Ppd9o/',
          evidence: ['https://e.org'],
        },
        { label: 'arXiv v1', kind: 'preprint', date: '2026-06-16', url: 'https://arxiv.org/abs/2606.18022v1' },
      ],
    );
    expect(merged.map((v) => v.label)).toEqual(['arXiv v1', 'ICLR 2027']);
    expect(merged[1]).toMatchObject({ id: conference.id, status: 'accepted', decision: 'Poster', note: 'ours' });
    expect(merged[0].id).toBeUndefined();
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

describe('finding versions', () => {
  const note = (venue: string, venueid: string) => ({
    id: 'zI2IeuDcoS',
    cdate: Date.parse('2026-04-29T10:00:00Z'),
    license: 'CC BY 4.0',
    content: {
      title: { value: 'Recursive Scaling in Masked Diffusion Models' },
      venue: { value: venue },
      venueid: { value: venueid },
      pdf: { value: '/pdf/dd92.pdf' },
    },
  });

  it('reads what became of a submission from OpenReview', () => {
    expect(openReviewVersion(note('SPIGM @ ICML Poster', 'ICML.cc/2026/Workshop/SPIGM'))).toMatchObject({
      label: 'SPIGM @ ICML 2026',
      kind: 'workshop',
      date: '2026-04-29',
      status: 'accepted',
      decision: 'Poster',
      url: 'https://openreview.net/forum?id=zI2IeuDcoS',
      pdfSource: 'https://openreview.net/pdf/dd92.pdf',
      license: 'CC-BY-4.0',
    });
    expect(
      openReviewVersion(note('ICLR 2027 Conference Submission', 'ICLR.cc/2027/Conference/Submission')),
    ).toMatchObject({
      label: 'ICLR 2027',
      kind: 'conference',
      status: 'under_review',
    });
    expect(
      openReviewVersion(
        note('ICLR 2026 Conference Desk Rejected Submission', 'ICLR.cc/2026/Conference/Desk_Rejected_Submission'),
      ),
    ).toMatchObject({ label: 'ICLR 2026', status: 'rejected', decision: 'Desk rejected' });
    expect(
      openReviewVersion(
        note('ICLR 2026 Conference Withdrawn Submission', 'ICLR.cc/2026/Conference/Withdrawn_Submission'),
      ),
    ).toMatchObject({ label: 'ICLR 2026', status: 'withdrawn' });
    // A workshop that names itself only by its conference is named by its venue id.
    expect(openReviewVersion(note('NeurIPS 2025 Workshop', 'NeurIPS.cc/2025/Workshop/OPT'))).toMatchObject({
      label: 'OPT @ NeurIPS 2025',
      kind: 'workshop',
      status: 'accepted',
    });
    expect(
      openReviewVersion(note('Submitted to ICLR 2026', 'ICLR.cc/2026/Conference/Rejected_Submission')),
    ).toMatchObject({
      label: 'ICLR 2026',
      status: 'rejected',
    });
  });

  it('reads arXiv’s submission history, copying PDFs only under an open license', () => {
    const html = `<div class="abs-license"><a href="http://creativecommons.org/licenses/by/4.0/">x</a></div>
      <strong><a href="/abs/2606.18022v1">[v1]</a></strong> Tue, 16 Jun 2026 15:02:49 UTC (1,234 KB)<br/>
      <strong>[v2]</strong> Mon, 28 Sep 2026 16:19:20 UTC (2,345 KB)`;
    const found = parseArxivHistory(html, '2606.18022');
    expect(found.map((v) => [v.label, v.date, v.pdfSource, v.license])).toEqual([
      ['arXiv v1', '2026-06-16', 'https://arxiv.org/pdf/2606.18022v1', 'CC-BY-4.0'],
      ['arXiv v2', '2026-09-28', 'https://arxiv.org/pdf/2606.18022v2', 'CC-BY-4.0'],
    ]);
    expect(
      parseArxivHistory(html.replace(/creativecommons[^"]+/, 'arxiv.org/licenses/nonexclusive-distrib/1.0/'), 'x')[0]
        .pdfSource,
    ).toBeNull();
    expect(normalizeTitle('Recursive  Scaling: in Masked-Diffusion')).toBe('recursive scaling in masked diffusion');
  });

  it('tells a resubmission from another paper with the same title', () => {
    const before = 'We introduce Hopformer, a two-stage transformer for forecasting many time series with covariates.';
    const after =
      'Forecasting multiple time series with external covariates needs shared structure. We introduce HopFormer.';
    const other = 'A survey of graph neural networks for molecules and proteins.';
    expect(abstractOverlap(before, before)).toBe(1);
    expect(abstractOverlap(before, other)).toBeLessThan(0.05);
    // A distinctive title needs little agreement; a generic one needs a lot.
    const distinctive = 'Hopformer: Homogeneity-Pursuit Transformer for Time Series Forecasting';
    expect(sameWork(distinctive, abstractOverlap(before, after))).toBe(true);
    expect(sameWork(distinctive, abstractOverlap(before, other))).toBe(false);
    expect(sameWork('Attention', 0.2)).toBe(false);
    expect(sameWork('Generative Model via Quantile Assignment', 0.08)).toBe(false);
    expect(sameWork('Attention', 0.5)).toBe(true);
    expect(sameWork('Generative Model via Quantile Assignment', null)).toBe(false);
    expect(sameWork('Autonomous Functional Play with Correspondence-Driven Trajectory Warping', null)).toBe(true);
  });
});

describe('venueName', () => {
  it('names a venue from its id, whatever its organisers typed', () => {
    expect(venueName('ICLR.cc/2027/Conference/Submission')).toEqual({
      label: 'ICLR 2027',
      kind: 'conference',
      year: 2027,
    });
    expect(venueName('AAAI.org/2026/Workshop/DAI')).toMatchObject({ label: 'DAI @ AAAI 2026', kind: 'workshop' });
    expect(venueName('AAAI.org/2026/Workshop/AgriAI/Rejected_Submission').label).toBe('AgriAI @ AAAI 2026');
    expect(venueName('AAAI.org/2026/Bridge/LMReasoning')).toMatchObject({
      label: 'LMReasoning @ AAAI 2026',
      kind: 'workshop',
    });
    expect(venueName('thecvf.com/CVPR/2026/Conference').label).toBe('CVPR 2026');
    expect(venueName('NeurIPS.cc/2025/Datasets_and_Benchmarks_Track').label).toBe(
      'NeurIPS 2025 Datasets and Benchmarks Track',
    );
    expect(venueName('TMLR')).toEqual({ label: 'TMLR', kind: 'journal', year: null });
  });

  it('says a past submission with no public decision was submitted, not under review', () => {
    const old = openReviewVersion(
      {
        id: 'x',
        content: {
          venue: { value: 'AAAI 2025 Workshop AI4WCN Submission' },
          venueid: { value: 'AAAI.org/2025/Workshop/AI4WCN/Submission' },
        },
      },
      new Date('2026-11-13'),
    );
    expect(old).toMatchObject({ label: 'AI4WCN @ AAAI 2025', status: 'submitted' });
  });
});
