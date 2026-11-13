import { diffArrays, diffWords } from 'diff';

/**
 * Comparing the text of two versions of a paper. Two versions are rarely laid out alike (a workshop's
 * template, then a conference's), so lines are useless: the text is split into sentences, the sentences are
 * diffed, and words are diffed inside each changed stretch. Pure, for the compare page and the tests.
 */

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/**
 * The text as sentences: hyphenation at line ends undone, whitespace collapsed, addresses hidden (they are
 * private, as on page 1, `pdf_documents`), and page furniture (bare page numbers) dropped.
 */
export function sentencesOf(text: string): string[] {
  const joined = text
    .replace(/\f/g, '\n')
    .replace(EMAIL, '[email]')
    .split('\n')
    .filter((line) => !/^\s*\d{1,3}\s*$/.test(line))
    .join('\n')
    .replace(/(\p{L})-\n(\p{Ll})/gu, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
  if (joined === '') return [];
  // After . ! ? and a space, before something that starts a sentence; "e.g. the" and "Fig. 3" stay whole.
  return joined
    .split(
      /(?<=(?<!\b(?:e\.g|i\.e|et al|Fig|Figs|Eq|Eqs|Sec|vs|cf|resp|approx|No))[.!?]["”)]?)\s+(?=["“(\[]?[\p{Lu}\d])/u,
    )
    .map((s) => s.trim())
    .filter(Boolean);
}

export type DiffPart = { kind: 'same' | 'added' | 'removed'; text: string };

export type DiffBlock =
  | { kind: 'same'; sentences: string[] }
  /** A collapsed run of unchanged sentences. */
  | { kind: 'skip'; count: number }
  | { kind: 'change'; removed: string[]; added: string[]; words: DiffPart[] | null };

export interface TextDiff {
  blocks: DiffBlock[];
  stats: { sentencesA: number; sentencesB: number; removed: number; added: number; unchanged: number };
}

const SENTENCE_TIMEOUT_MS = 4000;
const WORD_TIMEOUT_MS = 500;
/** A changed stretch longer than this is shown as removed and added, without word marks. */
const MAX_WORD_DIFF_CHARS = 20_000;

function wordParts(before: string, after: string): DiffPart[] | null {
  if (before === '' || after === '' || before.length + after.length > MAX_WORD_DIFF_CHARS) return null;
  const changes = diffWords(before, after, { timeout: WORD_TIMEOUT_MS });
  if (!changes) return null;
  return changes.map((c) => ({ kind: c.added ? 'added' : c.removed ? 'removed' : 'same', text: c.value }));
}

/**
 * The sentence diff of two texts, with unchanged runs longer than twice `context` collapsed. `null` if the
 * texts are too different to diff in reasonable time.
 */
export function diffTexts(a: string, b: string, context = 2): TextDiff | null {
  const left = sentencesOf(a);
  const right = sentencesOf(b);
  const changes = diffArrays(left, right, { timeout: SENTENCE_TIMEOUT_MS });
  if (!changes) return null;

  const raw: ({ kind: 'same'; sentences: string[] } | { kind: 'change'; removed: string[]; added: string[] })[] = [];
  for (const change of changes) {
    if (!change.added && !change.removed) {
      raw.push({ kind: 'same', sentences: change.value });
      continue;
    }
    let last = raw[raw.length - 1];
    if (last?.kind !== 'change') raw.push((last = { kind: 'change', removed: [], added: [] }));
    if (change.removed) last.removed.push(...change.value);
    else last.added.push(...change.value);
  }

  const stats = { sentencesA: left.length, sentencesB: right.length, removed: 0, added: 0, unchanged: 0 };
  const blocks: DiffBlock[] = [];
  raw.forEach((block, index) => {
    if (block.kind === 'change') {
      stats.removed += block.removed.length;
      stats.added += block.added.length;
      blocks.push({ ...block, words: wordParts(block.removed.join(' '), block.added.join(' ')) });
      return;
    }
    const { sentences } = block;
    stats.unchanged += sentences.length;
    const head = index === 0 ? 0 : context;
    const tail = index === raw.length - 1 ? 0 : context;
    if (sentences.length <= head + tail + 1) {
      blocks.push(block);
      return;
    }
    if (head > 0) blocks.push({ kind: 'same', sentences: sentences.slice(0, head) });
    blocks.push({ kind: 'skip', count: sentences.length - head - tail });
    if (tail > 0) blocks.push({ kind: 'same', sentences: sentences.slice(-tail) });
  });
  return { blocks, stats };
}

/** Word marks for two short texts, such as two versions' titles or abstracts; `null` if they are equal. */
export function diffShort(a: string, b: string): DiffPart[] | null {
  if (a === b) return null;
  return (
    wordParts(a, b) ?? [
      { kind: 'removed', text: a },
      { kind: 'added', text: b },
    ]
  );
}
