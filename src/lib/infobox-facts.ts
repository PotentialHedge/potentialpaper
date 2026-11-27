import { z } from 'zod';
import { evidenceProblem, MAX_EVIDENCE } from './evidence';
import type { PageKind } from './kinds';
import { httpUrl } from './paper-links';

/**
 * The rows people add to a page's infobox (DESIGN.md §4.8): a part's `facts.jsonl`, one JSON object a line, so they get
 * history, diffs, revert and blame like the rest of the page. `owners/facts.jsonl` is the owners' (a paper's confirmed
 * authors), `community/facts.jsonl` any verified researcher's: "PyTorch implementation: 76.1% top-1", "Compute: 8×A100,
 * 3 days". The infobox shows the owners' rows, then the community's, under the rows it reads from where each fact is
 * kept (`lib/paper-facts.ts`).
 *
 * A row can't take a label the infobox already shows from an import ("Accepted at", "Area"): those have one source each,
 * and a hand-written row can't contradict it. Pure, so the rules, the page and the tests share it.
 */

export const FACTS_FILE = 'facts.jsonl';
export const MAX_FACTS_PER_FILE = 30;
export const MAX_FACT_LABEL = 40;
export const MAX_FACT_VALUE = 300;

/**
 * The labels a row can't take, lower case: the ones each kind's infobox shows from where its facts are kept, and where
 * a paper was sent, which its Versions box shows.
 */
export const BUILT_IN_LABELS: Partial<Record<PageKind, readonly string[]>> = {
  paper: [
    'accepted at',
    'under review at',
    'rejected at',
    'withdrawn from',
    'desk rejected at',
    'submitted to',
    'poster',
    'oral',
    'area',
    'keywords',
  ],
  venue: ['dates', 'location', 'locations', 'website', 'submissions'],
};

/** Text on one line: not blank, no control characters. */
const line = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim() !== '' && !/\p{C}/u.test(value), { message: 'needs text on one line' });

/** One line of a `facts.jsonl`: the one definition, which both checks a line and is its JSON Schema. */
export const factLineSchema = z
  .strictObject({
    label: line(MAX_FACT_LABEL).meta({
      description: `What the row is about, shown on its left: "PyTorch implementation" (1 to ${MAX_FACT_LABEL} characters).`,
    }),
    value: line(MAX_FACT_VALUE).meta({
      description: `What it says, shown on its right: "76.1% top-1 on ImageNet" (1 to ${MAX_FACT_VALUE} characters, plain text).`,
    }),
    url: httpUrl(2000).optional().meta({ description: 'Where the value links to: the code, the results, the source.' }),
    evidence: z
      .array(z.string())
      .max(MAX_EVIDENCE)
      .optional()
      .meta({ description: `Up to ${MAX_EVIDENCE} https addresses that back the value up.` }),
  })
  .meta({
    title: 'Infobox row',
    description:
      "One line of a facts.jsonl: a row of the page's infobox. owners/facts.jsonl is the owners', community/facts.jsonl the community's.",
  });

export type FactLine = z.output<typeof factLineSchema>;

/** A page's own infobox rows, by part. */
export interface PageFacts {
  owners: FactLine[];
  community: FactLine[];
}

/** The rows in a `facts.jsonl` on a page of `kind`, or the first problem, naming its line. Blank lines are allowed. */
export function parseFacts(text: string, kind: PageKind): { facts: FactLine[] } | { problem: string } {
  const facts: FactLine[] = [];
  const builtIn = BUILT_IN_LABELS[kind] ?? [];
  for (const [index, raw] of text.split('\n').entries()) {
    if (raw.trim() === '') continue;
    const at = `line ${index + 1}`;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return { problem: `has a ${at} that is not JSON (one row a line)` };
    }
    const parsed = factLineSchema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return { problem: `has a ${at} that is not a row: ${issue.path.join('.') || 'it'}: ${issue.message}` };
    }
    const label = parsed.data.label.trim();
    if (builtIn.includes(label.toLowerCase())) {
      return { problem: `${at}: "${label}" is a row the infobox fills in itself, from where that fact is kept` };
    }
    for (const url of parsed.data.evidence ?? []) {
      const problem = evidenceProblem(url);
      if (problem) return { problem: `${at}: has evidence that ${problem}` };
    }
    if (facts.length === MAX_FACTS_PER_FILE) return { problem: `has more than ${MAX_FACTS_PER_FILE} rows` };
    facts.push({ ...parsed.data, label, value: parsed.data.value.trim() });
  }
  return { facts };
}
