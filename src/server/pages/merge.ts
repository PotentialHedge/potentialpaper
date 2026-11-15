import { createTwoFilesPatch, diffArrays } from 'diff';

/** Merging and diffing whole text files. Pure: the versions go in, a result comes out. */

/** `null` means the file does not exist in that version. */
export type Version = string | null;

export type MergeResult = { ok: true; content: Version } | { ok: false };

/** Lines `[start, end)` of the base replaced by `lines`. */
interface Hunk {
  start: number;
  end: number;
  lines: string[];
}

/**
 * How different a side may be from the base for a merge to try. Finding differences takes time that grows
 * with how many there are, not with the file's size, so everyday edits to a long page stay quick. Both
 * limits are for hostile or wholesale rewrites, which become conflicts, because this runs holding the page's lock.
 */
const MERGE_LIMITS = { maxEditLength: 2000, timeout: 400 };

function hunks(base: string[], side: string[]): Hunk[] | null {
  const parts = diffArrays(base, side, MERGE_LIMITS);
  if (!parts) return null;
  const found: Hunk[] = [];
  let at = 0;
  let open: Hunk | null = null;
  for (const part of parts) {
    if (!part.added && !part.removed) {
      at += part.count ?? part.value.length;
      open = null;
      continue;
    }
    if (!open) {
      open = { start: at, end: at, lines: [] };
      found.push(open);
    }
    if (part.added) open.lines.push(...part.value);
    if (part.removed) {
      at += part.count ?? part.value.length;
      open.end = at;
    }
  }
  return found;
}

/** A side's text for base lines `[start, end)`, which every one of its `hunks` lies within. */
function sideOf(base: string[], side: Hunk[], start: number, end: number): string[] {
  const lines: string[] = [];
  let at = start;
  for (const hunk of side) {
    lines.push(...base.slice(at, hunk.start), ...hunk.lines);
    at = hunk.end;
  }
  lines.push(...base.slice(at, end));
  return lines;
}

/**
 * A three-way merge of lines, or `null` for a conflict. Changes that touch conflict, as they do in git. With
 * `markers`, a conflict is written into the result between git's conflict markers instead.
 */
function mergeLines(
  base: string[],
  ours: Hunk[],
  theirs: Hunk[],
  markers?: { ours: string; theirs: string },
): string[] | null {
  const merged: string[] = [];
  let copied = 0;
  let a = 0;
  let b = 0;
  while (a < ours.length || b < theirs.length) {
    const startsWithOurs = b >= theirs.length || (a < ours.length && ours[a].start <= theirs[b].start);
    const first = startsWithOurs ? ours[a] : theirs[b];
    const [start, firstA, firstB] = [first.start, a, b];
    let end = first.end;
    // Takes in every hunk reaching this region, which may reach further and take in more.
    for (;;) {
      if (a < ours.length && ours[a].start <= end) end = Math.max(end, ours[a++].end);
      else if (b < theirs.length && theirs[b].start <= end) end = Math.max(end, theirs[b++].end);
      else break;
    }
    merged.push(...base.slice(copied, start));
    const oursText = sideOf(base, ours.slice(firstA, a), start, end);
    const theirsText = sideOf(base, theirs.slice(firstB, b), start, end);
    // Only one side changed this region, or both made the same change.
    if (a === firstA) merged.push(...theirsText);
    else if (b === firstB || oursText.join('\n') === theirsText.join('\n')) merged.push(...oursText);
    else if (markers) {
      merged.push(`<<<<<<< ${markers.ours}`, ...oursText, '=======', ...theirsText, `>>>>>>> ${markers.theirs}`);
    } else return null;
    copied = end;
  }
  merged.push(...base.slice(copied));
  return merged;
}

/**
 * Applies what `ours` changed since `base` on top of `theirs`. Text merges line by line and is a conflict
 * only where both sides changed the same lines. A file one side deleted and the other changed is a
 * conflict, and so is a file both sides created differently, which has no base to merge from.
 */
export function mergeFile(base: Version, ours: Version, theirs: Version): MergeResult {
  if (ours === theirs || ours === base) return { ok: true, content: theirs };
  if (theirs === base) return { ok: true, content: ours };
  if (base === null || ours === null || theirs === null) return { ok: false };

  const lines = base.split('\n');
  const oursHunks = hunks(lines, ours.split('\n'));
  const theirsHunks = oursHunks && hunks(lines, theirs.split('\n'));
  const merged = theirsHunks && mergeLines(lines, oursHunks, theirsHunks);
  return merged ? { ok: true, content: merged.join('\n') } : { ok: false };
}

/**
 * As `mergeFile`, but never failing: where both sides changed the same lines, both are kept between git's
 * conflict markers, for a person to choose. A file one side deleted keeps the other side's text.
 */
export function mergeWithMarkers(
  base: Version,
  ours: Version,
  theirs: Version,
  labels: { ours: string; theirs: string },
): { content: Version; conflict: boolean } {
  const plain = mergeFile(base, ours, theirs);
  if (plain.ok) return { content: plain.content, conflict: false };
  if (ours === null || theirs === null) return { content: ours ?? theirs, conflict: true };
  const lines = (base ?? '').split('\n');
  const oursHunks = hunks(lines, ours.split('\n'));
  const theirsHunks = oursHunks && hunks(lines, theirs.split('\n'));
  const merged = theirsHunks && mergeLines(lines, oursHunks, theirsHunks, labels);
  if (merged) return { content: merged.join('\n'), conflict: true };
  // Too different to merge line by line: the whole of both.
  const whole = [`<<<<<<< ${labels.ours}`, ours, '=======', theirs, `>>>>>>> ${labels.theirs}`].join('\n');
  return { content: whole, conflict: true };
}

export interface FileDiff {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  /** A unified diff, or `null` if the file is too different to diff in reasonable time. */
  patch: string | null;
}

const DIFF_TIMEOUT_MS = 1000;

export function diffFile(path: string, before: Version, after: Version): FileDiff {
  const patch = createTwoFilesPatch(
    before === null ? '/dev/null' : `a/${path}`,
    after === null ? '/dev/null' : `b/${path}`,
    before ?? '',
    after ?? '',
    undefined,
    undefined,
    { timeout: DIFF_TIMEOUT_MS },
  );
  return {
    path,
    status: before === null ? 'added' : after === null ? 'deleted' : 'modified',
    patch: patch ?? null,
  };
}
