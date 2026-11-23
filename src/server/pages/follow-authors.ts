import { and, asc, eq, inArray } from 'drizzle-orm';
import { authorClaims } from '@/db/schema';
import { normalizeTitle } from '@/lib/versions';
import type { Writer } from './projections';

/**
 * A claim names an author by position (`author_index`) and by the name printed there (`author_name`). When a commit
 * changes `paper.json`'s authors, claims follow their name: a claim whose position still prints its name stays; one
 * whose name moved, or was respelled, takes the position the name is at now, compared as `normalizeTitle` does
 * (accents, case and punctuation dropped). A confirmed claim whose name is gone goes back to pending, at its old
 * position, for someone to decide again. Pending and confirmed claims follow; decided-against ones stay as they were.
 *
 * It reads only the claims and the new list, and a second run changes nothing, so a rebuild gives the same rows.
 */

interface ClaimRef {
  id: string;
  authorIndex: number;
  authorName: string;
  status: string;
}

export interface ClaimMove {
  id: string;
  authorIndex: number;
  authorName: string;
  /** The claim's name is no longer on the paper: a confirmed claim goes back to pending. */
  unconfirm: boolean;
}

/**
 * Where each claim goes for a new author list. Claims at the same position with the same name (rival pending claims,
 * or one confirmed and others waiting) move together. A position can be taken by one such group only, so two authors
 * with the same name keep two positions; groups that stay take theirs first, then the rest take the first free match
 * in the order of their old positions, which keeps same-named authors in order. Pure.
 */
export function planClaimMoves(claims: readonly ClaimRef[], authors: readonly string[]): ClaimMove[] {
  const groups = new Map<string, ClaimRef[]>();
  for (const claim of claims) {
    const key = `${claim.authorIndex}\u0000${claim.authorName}`;
    groups.set(key, [...(groups.get(key) ?? []), claim]);
  }
  const taken = new Set<number>();
  const moving: ClaimRef[][] = [];
  for (const group of groups.values()) {
    const { authorIndex, authorName } = group[0];
    if (authors[authorIndex] === authorName) taken.add(authorIndex);
    else moving.push(group);
  }
  moving.sort((a, b) => a[0].authorIndex - b[0].authorIndex || (a[0].authorName < b[0].authorName ? -1 : 1));

  const normalized = authors.map(normalizeTitle);
  const moves: ClaimMove[] = [];
  for (const group of moving) {
    const wanted = normalizeTitle(group[0].authorName);
    const found = normalized.findIndex((name, i) => !taken.has(i) && name !== '' && name === wanted);
    if (found >= 0) taken.add(found);
    for (const claim of group) {
      if (found >= 0) moves.push({ id: claim.id, authorIndex: found, authorName: authors[found], unconfirm: false });
      else if (claim.status === 'confirmed') {
        moves.push({ id: claim.id, authorIndex: claim.authorIndex, authorName: claim.authorName, unconfirm: true });
      }
    }
  }
  return moves.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Moves a paper's claims to where their names are in `authors`, in the commit's transaction. */
export async function followAuthors(tx: Writer, paperId: string, authors: readonly string[]): Promise<void> {
  const claims = await tx
    .select({
      id: authorClaims.id,
      authorIndex: authorClaims.authorIndex,
      authorName: authorClaims.authorName,
      status: authorClaims.status,
    })
    .from(authorClaims)
    .where(and(eq(authorClaims.paperId, paperId), inArray(authorClaims.status, ['pending', 'confirmed'])))
    .orderBy(asc(authorClaims.id));
  const moves = planClaimMoves(claims, authors);
  if (moves.length === 0) return;

  // Confirmed claims are unique by position, so two that swap would collide half-way: everything that moves
  // steps aside to a negative position first, then takes its own.
  for (const [i, move] of moves.entries()) {
    await tx
      .update(authorClaims)
      .set({ authorIndex: -1 - i })
      .where(eq(authorClaims.id, move.id));
  }
  for (const move of moves) {
    await tx
      .update(authorClaims)
      .set({
        authorIndex: move.authorIndex,
        authorName: move.authorName,
        ...(move.unconfirm ? { status: 'pending' as const, decidedAt: null, decidedBy: null } : {}),
      })
      .where(eq(authorClaims.id, move.id));
  }
}
