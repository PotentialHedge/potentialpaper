import { SLUG } from './kinds';

/**
 * Topics (`handoffs/pages.md` Phase 5): research ideas at the size of a Wikipedia article ("Linear attention"), which
 * anyone verified makes and the community writes. What the server and the browser share about them: a topic's
 * address from its name, and when two names are the same name, so that the form can say "that topic is there
 * already" before a duplicate is made.
 *
 * Pure.
 */

const MAX_SLUG = 60;

/** "State-space models (SSMs)" → `state-space-models-ssms`; `null` if nothing of it is Latin letters or digits. */
export function topicSlug(name: string): string | null {
  const slug = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/, '');
  return slug.length >= 2 && SLUG.test(slug) ? slug : null;
}

/** A plural's last letters, so "models" and "model" are one word; short words and "-ss" are left alone. */
function singular(word: string): string {
  if (word.length <= 3 || word.endsWith('ss') || word.endsWith('us') || word.endsWith('is')) return word;
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}

/**
 * A name as duplicates are told by: lower case, accents and punctuation gone, each word singular. "State-space
 * models" and "state space model" are the same name; "Linear attention" and "Attention" are not.
 */
export function topicNameKey(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(singular)
    .join(' ');
}

/** Aliases as a form gives them, one a line or separated by commas: trimmed, each once, none that is the name. */
export function parseAliases(text: string, name = ''): string[] {
  const seen = new Set([topicNameKey(name)]);
  const out: string[] = [];
  for (const raw of text.split(/[\n,;]/)) {
    const alias = raw.replace(/\s+/g, ' ').trim();
    const key = topicNameKey(alias);
    if (!alias || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(alias);
  }
  return out;
}

/** The labels a paper is in a topic by: about it, or the paper that introduced it. */
export type TopicLinkLabel = 'in-topic' | 'introduces-topic';
