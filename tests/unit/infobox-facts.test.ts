import { describe, expect, it } from 'vitest';
import { parseFacts } from '@/lib/infobox-facts';
import type { Roles } from '@/server/pages/rules';
import { contentProblem, isFactsPath, layoutProblem, pathDenied } from '@/server/pages/rules';

const row = (fields: Record<string, unknown>) => JSON.stringify(fields);
const roles = (over: Partial<Roles> = {}): Roles => ({
  system: false,
  admin: false,
  verified: true,
  owner: false,
  claimed: false,
  ...over,
});

describe('infobox rows', () => {
  it('reads one row a line, trimmed, with blank lines allowed', () => {
    const text = `${row({ label: ' PyTorch implementation ', value: '76.1% top-1', url: 'https://github.com/x/y' })}\n\n${row({ label: 'Compute', value: '8×A100, 3 days' })}\n`;
    expect(parseFacts(text, 'paper')).toEqual({
      facts: [
        { label: 'PyTorch implementation', value: '76.1% top-1', url: 'https://github.com/x/y' },
        { label: 'Compute', value: '8×A100, 3 days' },
      ],
    });
  });

  it("refuses a label the infobox fills in itself, whatever its case, so a row can't contradict an import", () => {
    expect(parseFacts(row({ label: 'Accepted at', value: 'NeurIPS 2026' }), 'paper')).toEqual({
      problem: expect.stringMatching(/line 1: "Accepted at" is a row the infobox fills in itself/),
    });
    expect('problem' in parseFacts(row({ label: 'keywords', value: 'x' }), 'paper')).toBe(true);
    expect('problem' in parseFacts(row({ label: 'Location', value: 'Paris' }), 'venue')).toBe(true);
    // Only the kind's own built-in rows are taken.
    expect('facts' in parseFacts(row({ label: 'Location', value: 'Lab 3' }), 'paper')).toBe(true);
  });

  it('names the line of a bad row', () => {
    expect(parseFacts(`${row({ label: 'A', value: 'b' })}\nnot json`, 'paper')).toEqual({
      problem: 'has a line 2 that is not JSON (one row a line)',
    });
    expect(parseFacts(row({ label: 'A', value: 'b', colour: 'red' }), 'paper')).toMatchObject({
      problem: expect.stringMatching(/^has a line 1 that is not a row/),
    });
    expect('problem' in parseFacts(row({ label: 'A', value: 'b', url: 'javascript:alert(1)' }), 'paper')).toBe(true);
  });

  it("is each part's facts.jsonl on every kind with a repo, written by that part's writers", () => {
    expect(isFactsPath('community/facts.jsonl', 'paper')).toBe(true);
    expect(isFactsPath('owners/facts.jsonl', 'venue')).toBe(true);
    expect(isFactsPath('community/facts.jsonl', 'category')).toBe(true);
    expect(isFactsPath('owners/facts.jsonl', 'org')).toBe(true);
    // A category has no owners' part.
    expect(isFactsPath('owners/facts.jsonl', 'category')).toBe(false);
    expect(layoutProblem('community/facts.jsonl', 'paper')).toBeNull();
    expect(layoutProblem('community/facts.jsonl', 'category')).toBeNull();
    expect(contentProblem('community/facts.jsonl', row({ label: 'Area', value: 'x' }), 'paper')).toMatch(
      /fills in itself/,
    );
    expect(pathDenied('community/facts.jsonl', roles(), 'paper')).toBeNull();
    expect(pathDenied('owners/facts.jsonl', roles(), 'paper')).not.toBeNull();
    expect(pathDenied('owners/facts.jsonl', roles({ owner: true }), 'paper')).toBeNull();
  });
});
