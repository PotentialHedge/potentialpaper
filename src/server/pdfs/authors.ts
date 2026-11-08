import { normalizeText } from './emails';

/**
 * Which printed author an address on a first page belongs to, so an account with that address can be made
 * that author without picking one (`server/claims.ts`). **Only when it is unambiguous:** a wrong answer
 * would make someone speak as their co-author, so anything unclear returns nothing, and the person picks.
 *
 * Two kinds of evidence, the first winning:
 *
 * 1. **The address's local part spells the name:** `ashish.vaswani`, `avaswani`, `vaswani`, `ashish`,
 *    `ashishv`, `lukaszkaiser` for Łukasz Kaiser. Exactly one author may match, at the strongest level any
 *    author matches.
 * 2. **The address is printed in the name's own block:** in `pdftotext -raw`'s lines, the address alone on
 *    its line, and within the three lines above it a line that is just that author's name, with no other
 *    address in between (`Jakob Uszkoreit∗` / `Google Research` / `usz@google.com`). Looser layouts (a
 *    line of names, then a line of addresses) proved wrong too often on real papers to use.
 */

/** Lower-case ASCII letters only: `Łukasz` → `lukasz`, `Jean-Luc` → `jeanluc`. */
function fold(text: string): string {
  return text
    .replace(/[łŁ]/g, 'l')
    .replace(/[øØ]/g, 'o')
    .replace(/ß/g, 'ss')
    .replace(/[đĐ]/g, 'd')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

/** The name's parts, folded: `Aidan N. Gomez` → `['aidan', 'n', 'gomez']`. */
function nameParts(name: string): string[] {
  return name
    .split(/[\s.]+/)
    .map(fold)
    .filter(Boolean);
}

/** How strongly a local part spells a name: 0 not at all, up to 3 for the whole name. */
function nameScore(local: string, name: string): number {
  const parts = nameParts(name);
  if (parts.length === 0) return 0;
  const first = parts[0];
  const last = parts[parts.length - 1];
  const tokens = local
    .toLowerCase()
    .split(/[._\-+0-9]+/)
    .map(fold)
    .filter(Boolean);
  const joined = tokens.join('');
  if (!joined) return 0;
  const full = parts.join('');
  // The whole name, either way round: `ashish.vaswani`, `ashishvaswani`, `vaswani.ashish`, `aidanngomez`.
  if (joined === first + last || joined === last + first || joined === full) return 3;
  if (parts.length < 2) return joined === full && full.length >= 4 ? 1 : 0;
  if (tokens.length >= 2 && tokens.includes(first) && tokens.includes(last)) return 3;
  // An initial and a name: `avaswani`, `a.vaswani`, `ashishv`, `vaswania`.
  if (last.length >= 3 && (joined === first[0] + last || joined === last + first[0])) return 2;
  if (first.length >= 3 && (joined === first + last[0] || joined === last[0] + first)) return 2;
  // One name alone: `vaswani`, `noam`. Too short a name proves nothing.
  if ((joined === last && last.length >= 4) || (joined === first && first.length >= 4)) return 1;
  return 0;
}

/** Each author whose local part spells their name, at the strongest level that has a match. */
function byName(local: string, authors: readonly string[]): number[] {
  const scores = authors.map((name) => nameScore(local, name));
  const best = Math.max(0, ...scores);
  if (best === 0) return [];
  return scores.flatMap((score, index) => (score === best ? [index] : []));
}

/** A line that is one author's name and nothing else but footnote markers: that author's index. */
function nameLine(line: string, authors: readonly string[]): number | null {
  const words = line
    .replace(/[0-9*∗†‡§¶♯♮#,]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0 || words.length > 6) return null;
  const folded = fold(words.join(''));
  const matches = authors.flatMap((name, index) => {
    const parts = nameParts(name);
    const ok = folded === parts.join('') || (parts.length >= 2 && folded === parts[0] + parts[parts.length - 1]);
    return ok ? [index] : [];
  });
  return matches.length === 1 ? matches[0] : null;
}

/** Whether a line holds this one address and nothing else but brackets and punctuation. */
function aloneOnLine(line: string, email: string): boolean {
  const rest = line.toLowerCase().replace(email, '');
  return rest !== line.toLowerCase() && !/[\p{L}\p{N}@]/u.test(rest);
}

/**
 * The printed author each of `emails` belongs to, by index into `authors`, for the addresses where that is
 * unambiguous. `raw` is the first page through `pdftotext -raw`, used for the second kind of evidence.
 */
export function authorsForEmails(
  emails: readonly string[],
  authors: readonly string[],
  raw: string,
): Map<string, number> {
  const out = new Map<string, number>();
  const lines = normalizeText(raw).normalize('NFC').split('\n');

  const inBlock = new Map<string, number>();
  for (const email of emails) {
    const at = lines.findIndex((line) => aloneOnLine(line, email));
    if (at < 0) continue;
    for (let i = at - 1; i >= Math.max(0, at - 3); i -= 1) {
      if (lines[i].includes('@')) break;
      const index = nameLine(lines[i], authors);
      if (index !== null) {
        inBlock.set(email, index);
        break;
      }
    }
  }

  for (const email of emails) {
    const named = byName(email.split('@')[0], authors);
    if (named.length === 1) out.set(email, named[0]);
    else if (named.length === 0 && inBlock.has(email)) out.set(email, inBlock.get(email)!);
  }

  // Several addresses on one author: a person may print two, but only the best-evidenced survive, and none
  // if the best is a single name (`aditya@` and `iyer@` for Aditya Iyer are more likely a misreading).
  const owners = new Map<number, string[]>();
  for (const [email, index] of out) owners.set(index, [...(owners.get(index) ?? []), email]);
  for (const [index, list] of owners) {
    if (list.length < 2) continue;
    const score = (email: string) => nameScore(email.split('@')[0], authors[index]);
    const best = Math.max(...list.map(score));
    for (const email of list) if (score(email) < best || best <= 1) out.delete(email);
  }
  return out;
}
