import { describe, expect, it } from 'vitest';
import { cleanEvidence, evidenceLabel, evidenceProblem } from '@/lib/evidence';
import { diffShort, diffTexts, sentencesOf } from '@/lib/text-diff';
import {
  encodeVersionsFile,
  formatVersionDate,
  newVersionId,
  parseVersionsFile,
  sortVersions,
  versionProblem,
  versionStanding,
  type PaperVersion,
} from '@/lib/versions';
import { encodeCommit, parseCommit, type Commit } from '@/server/pages/git-objects';
import { contentProblem, pathDenied, VERSIONS_PATH, type Roles } from '@/server/pages/rules';
import { normalizeTitle, openReviewVersion, parseArxivHistory } from '@/server/version-sources';
import { mergeFoundVersions } from '@/server/versions';

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

describe('versions.jsonl', () => {
  it('round-trips, oldest first, one line each', () => {
    const text = encodeVersionsFile([conference, workshop]);
    expect(text.split('\n')).toHaveLength(3);
    expect(parseVersionsFile(text)).toEqual([workshop, conference]);
    expect(contentProblem(VERSIONS_PATH, text)).toBeNull();
  });

  it('refuses a bad version, a duplicate id, an unknown field', () => {
    expect(versionProblem({ ...workshop, kind: 'blog' })).toMatch(/kind/);
    expect(versionProblem({ ...workshop, date: '26-04-29' })).toMatch(/date/);
    expect(versionProblem({ ...workshop, url: 'javascript:alert(1)' })).toMatch(/address/);
    expect(versionProblem({ ...workshop, evidence: ['http://x.org'] })).toMatch(/evidence/);
    expect(versionProblem({ ...workshop, extra: 1 })).toMatch(/unknown field/);
    expect(versionProblem({ ...workshop, pdf: { ...workshop.pdf, sha256: 'x' } })).toMatch(/SHA-256/);
    expect(parseVersionsFile(encodeVersionsFile([workshop]) + encodeVersionsFile([workshop]))).toBeNull();
    expect(contentProblem(VERSIONS_PATH, '{"id":1}\n')).toMatch(/versions/);
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
    expect(pathDenied(VERSIONS_PATH, roles)).toBeNull();
    expect(pathDenied(VERSIONS_PATH, { ...roles, system: true, verified: false })).toBeNull();
    expect(pathDenied(VERSIONS_PATH, { ...roles, verified: false })).toMatch(/confirm/);
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
      label: 'ICLR 2027 Conference',
      kind: 'conference',
      status: 'under_review',
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
});
