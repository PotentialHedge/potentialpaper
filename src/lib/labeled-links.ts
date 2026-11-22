import { z } from 'zod';
import { formatIdentifier, type PageKind, parseIdentifier } from './kinds';

/**
 * Labeled links (DESIGN.md §8): statements made on the source page about a target page of any kind, one JSON
 * object a line in a part's `links.jsonl` (`community/links.jsonl`, `owners/links.jsonl`), so they get history,
 * revert and blame like everything else. Where the file is says who asserts them: the page's owners (its
 * confirmed authors, organisers, members) or the community. `page_links` (`server/page-links.ts`) is the index
 * that answers "what links here".
 *
 * Pure, and shared by the server and the browser.
 */

export const LINKS_FILE = 'links.jsonl';
export const MAX_LINKS_PER_FILE = 500;
const MAX_NOTE = 2000;
const MAX_ANCHOR = 200;

export type LinkGroup = 'lineage' | 'support' | 'contest' | 'discourse' | 'category';

/**
 * What a link's `to` names: a page of a kind, or `web`, an https address elsewhere, which only the labels that say so
 * take. No label does now: a person's homepage, ORCID and Scholar profile are on their account (`lib/profile.ts`).
 */
export type LinkTargetKind = PageKind | 'web';

export interface LinkLabel {
  /** As the source page reads it: "extends". */
  reads: string;
  /** As the target page reads it; the same words for a symmetric label. */
  inverse: string;
  group: LinkGroup;
  /** The CiTO property it maps to, for export. */
  cito?: string;
  /** Contested labels need a note, because that is where the content is. */
  noteRequired?: boolean;
  /** The kinds it may go from and to; none means any page. */
  from?: readonly PageKind[];
  to?: readonly PageKind[];
  /**
   * An address elsewhere rather than a page: `to` is an https URL, whose host, if given, has to be one of these
   * (`orcid.org`). Such a link names no page, so it is in no page's "what links here".
   */
  web?: { hosts?: readonly string[] };
}

const PAPERS = { from: ['paper'], to: ['paper'] } as const;

/** The vocabulary (DESIGN.md §8). Labels are data: a new one is an entry here. */
export const LINK_LABELS = {
  extends: { reads: 'extends', inverse: 'extended by', group: 'lineage', cito: 'extends', ...PAPERS },
  'improves-on': { reads: 'improves on', inverse: 'improved on by', group: 'lineage', ...PAPERS },
  'uses-method': {
    reads: 'uses the method of',
    inverse: 'method used by',
    group: 'lineage',
    cito: 'usesMethodIn',
    ...PAPERS,
  },
  'uses-data': { reads: 'uses data from', inverse: 'data used by', group: 'lineage', cito: 'usesDataFrom', ...PAPERS },
  surveys: { reads: 'surveys', inverse: 'surveyed by', group: 'lineage', cito: 'reviews', ...PAPERS },
  replicates: {
    reads: 'replicates',
    inverse: 'replicated by',
    group: 'support',
    cito: 'confirms',
    noteRequired: true,
    ...PAPERS,
  },
  supports: { reads: 'gives evidence for', inverse: 'supported by', group: 'support', cito: 'supports', ...PAPERS },
  'fails-to-replicate': {
    reads: 'fails to replicate',
    inverse: 'not replicated by',
    group: 'contest',
    cito: 'disputes',
    noteRequired: true,
    ...PAPERS,
  },
  contradicts: {
    reads: 'contradicts',
    inverse: 'contradicted by',
    group: 'contest',
    cito: 'disputes',
    noteRequired: true,
    ...PAPERS,
  },
  corrects: {
    reads: 'corrects',
    inverse: 'corrected by',
    group: 'contest',
    cito: 'corrects',
    noteRequired: true,
    ...PAPERS,
  },
  'responds-to': { reads: 'responds to', inverse: 'response from', group: 'discourse', cito: 'repliesTo', ...PAPERS },
  'concurrent-with': { reads: 'concurrent with', inverse: 'concurrent with', group: 'discourse', ...PAPERS },
  'same-idea-as': { reads: 'same idea as', inverse: 'same idea as', group: 'discourse', ...PAPERS },
  /** Between pages of any kinds: category to category, paper to venue, … */
  related: { reads: 'related to', inverse: 'related to', group: 'discourse' },
  /**
   * A page is in a category, as a Wikipedia page is in a category (`handoffs/pages.md`): from a page of any kind, a category
   * too, which makes it a subcategory.
   */
  'in-category': { reads: 'is in', inverse: 'contains', group: 'category', to: ['category'] },
} as const satisfies Record<string, LinkLabel>;

export type LinkLabelName = keyof typeof LINK_LABELS;
export const LINK_LABEL_NAMES = Object.keys(LINK_LABELS) as LinkLabelName[];

/** The label that puts a page in a category: a paper's makes it a member of the category (`page_members.via`). */
export const CATEGORY_LABEL = 'in-category' satisfies LinkLabelName;

const anchor = z.string().trim().min(1).max(MAX_ANCHOR);

/** One line of a `links.jsonl`: the one definition, which both checks a line and is its JSON Schema. */
export const labeledLinkSchema = z
  .strictObject({
    id: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,40}$/)
      .meta({ description: 'The link\'s id, unique in its file: a ULID such as "01JC8Z4X6Q0N4C3T6G1W6R2B7M".' }),
    to: z.string().max(300).meta({
      description:
        'The target, by public identifier: arxiv:1706.03762, doi:10.…, openreview:…, venue:iclr/2027, category:linear-attention, org:eth, user:alice.',
    }),
    label: z.enum(LINK_LABEL_NAMES).meta({ description: 'What the link says (DESIGN.md §8).' }),
    note: z.string().trim().min(1).max(MAX_NOTE).optional().meta({
      description: 'Why: required for contested labels (replicates, fails-to-replicate, contradicts, corrects).',
    }),
    from_anchor: anchor.optional().meta({ description: 'Where on this page: "Section 3".' }),
    to_anchor: anchor.optional().meta({ description: 'Where on the target: "Eq. 2".' }),
    evidence: z
      .url({ protocol: /^https$/ })
      .max(500)
      .optional()
      .meta({ description: 'An https address that backs it up.' }),
  })
  .meta({
    title: 'Labeled link',
    description:
      'One line of a links.jsonl: a labeled link from this page to a page of any kind. owners/links.jsonl is asserted by the owners, community/links.jsonl by the community.',
  });

export type LabeledLinkLine = z.output<typeof labeledLinkSchema>;

export interface LabeledLink extends LabeledLinkLine {
  /** `to` in its normal form: an identifier, or for a `web` label the address as written. */
  target: string;
  targetKind: LinkTargetKind;
  /** The line it is on, from 1. */
  line: number;
}

/** Why the line can't go from a page of `from`, or `null`. */
function lineProblem(
  link: LabeledLinkLine,
  from: PageKind,
): { problem: string } | { target: string; kind: LinkTargetKind } {
  const label: LinkLabel = LINK_LABELS[link.label];
  if (label.from && !label.from.includes(from)) {
    return { problem: `"${link.label}" goes from ${label.from.join(' or ')} pages, not from a ${from} page` };
  }
  if (label.web) {
    const url = webAddress(link.to);
    if (!url) return { problem: `"${link.label}" goes to an https address, not ${JSON.stringify(link.to)}` };
    const hosts = label.web.hosts;
    if (hosts && !hosts.includes(url.hostname.replace(/^www\./, ''))) {
      return { problem: `"${link.label}" goes to an address on ${hosts.join(' or ')}, not ${url.hostname}` };
    }
    return { target: link.to, kind: 'web' };
  }
  const address = parseIdentifier(link.to);
  if (!address) return { problem: `"to" is not an identifier of a page: ${JSON.stringify(link.to)}` };
  if (label.to && !label.to.includes(address.kind)) {
    return { problem: `"${link.label}" goes to ${label.to.join(' or ')} pages, not to ${link.to}` };
  }
  if (label.noteRequired && !link.note) return { problem: `"${link.label}" needs a note saying why` };
  return { target: formatIdentifier(address), kind: address.kind };
}

/** An https address, or `null`. */
function webAddress(text: string): URL | null {
  if (!/^https:\/\//.test(text)) return null;
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

/**
 * The links in a `links.jsonl` on a page of kind `from`, or the first problem, naming its line. Blank lines are
 * allowed (a file ends with one); ids are unique in the file.
 */
export function parseLabeledLinks(text: string, from: PageKind): { links: LabeledLink[] } | { problem: string } {
  const links: LabeledLink[] = [];
  const ids = new Set<string>();
  const lines = text.split('\n');
  for (const [index, raw] of lines.entries()) {
    if (raw.trim() === '') continue;
    const at = `line ${index + 1}`;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return { problem: `has a ${at} that is not JSON (one link a line)` };
    }
    const parsed = labeledLinkSchema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return { problem: `has a ${at} that is not a link: ${issue.path.join('.') || 'it'}: ${issue.message}` };
    }
    const checked = lineProblem(parsed.data, from);
    if ('problem' in checked) return { problem: `${at}: ${checked.problem}` };
    if (ids.has(parsed.data.id)) return { problem: `${at}: the id ${parsed.data.id} is used twice` };
    ids.add(parsed.data.id);
    if (links.length === MAX_LINKS_PER_FILE) return { problem: `has more than ${MAX_LINKS_PER_FILE} links` };
    links.push({ ...parsed.data, target: checked.target, targetKind: checked.kind, line: index + 1 });
  }
  return { links };
}

/** One line of a `links.jsonl`, as the file keeps it. */
export function encodeLabeledLink(link: LabeledLinkLine): string {
  const { id, to, label, note, from_anchor, to_anchor, evidence } = link;
  return JSON.stringify({
    id,
    to,
    label,
    ...(note ? { note } : {}),
    ...(from_anchor ? { from_anchor } : {}),
    ...(to_anchor ? { to_anchor } : {}),
    ...(evidence ? { evidence } : {}),
  });
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A new link's id: a ULID (time first, so a file's ids sort by when the links were made). */
export function newLinkId(now: number = Date.now()): string {
  let time = '';
  for (let t = now, i = 0; i < 10; i += 1, t = Math.floor(t / 32)) time = CROCKFORD[t % 32] + time;
  const random = crypto.getRandomValues(new Uint8Array(16));
  return time + [...random].map((b) => CROCKFORD[b % 32]).join('');
}
