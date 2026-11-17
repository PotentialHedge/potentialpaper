import { KINDS, PAGE_KINDS, type PageKind } from '../kinds';

/**
 * A plugin panel's `when` condition: whether the host shows the panel on a page at all, decided before any frame
 * starts, so a page doesn't load one frame per installed plugin (VS Code's activation events). The grammar is
 * VS Code's `when` clauses, cut down:
 *
 *     page.hasScores
 *     page.kind == venue && !signedIn
 *     (page.hasSubmissions || viewer.isOwner) && page.kind != topic
 *
 * Keys are the context keys a kind offers (`KindInfo.contextKeys` in `lib/kinds.ts`). A key a page's kind doesn't
 * offer reads as unset, so false. Values after `==` and `!=` are bare words or quoted strings. Pure.
 */

export type WhenContext = Record<string, string | boolean | undefined>;

export type WhenExpr =
  | { op: 'key'; key: string }
  | { op: 'eq' | 'ne'; key: string; value: string }
  | { op: 'not'; arg: WhenExpr }
  | { op: 'and' | 'or'; args: WhenExpr[] };

/** Every context key some kind offers. */
export const CONTEXT_KEYS: readonly string[] = [...new Set(PAGE_KINDS.flatMap((kind) => KINDS[kind].contextKeys))];

export const MAX_WHEN_LENGTH = 300;

type Token = { t: 'key' | 'word' | 'str' | 'op'; v: string; at: number };

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (['==', '!=', '&&', '||'].includes(two)) {
      out.push({ t: 'op', v: two, at: i });
      i += 2;
      continue;
    }
    if ('!()'.includes(c)) {
      out.push({ t: 'op', v: c, at: i });
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = text.indexOf(c, i + 1);
      if (end === -1) throw new Error(`unclosed quote at ${i + 1}`);
      out.push({ t: 'str', v: text.slice(i + 1, end), at: i });
      i = end + 1;
      continue;
    }
    const word = /^[A-Za-z0-9_.:\/-]+/.exec(text.slice(i));
    if (!word) throw new Error(`unexpected "${c}" at ${i + 1}`);
    out.push({
      t: /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/.test(word[0]) ? 'key' : 'word',
      v: word[0],
      at: i,
    });
    i += word[0].length;
  }
  return out;
}

/** The condition as a tree, or an `Error` saying what's wrong with it. */
export function parseWhen(text: string): WhenExpr {
  if (text.length > MAX_WHEN_LENGTH) throw new Error(`at most ${MAX_WHEN_LENGTH} characters`);
  const tokens = tokenize(text);
  let at = 0;
  const peek = () => tokens[at];
  const isOp = (v: string) => peek()?.t === 'op' && peek()!.v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new Error(`expected "${v}"${peek() ? ` at ${peek()!.at + 1}` : ' at the end'}`);
    at++;
  };

  function primary(): WhenExpr {
    const token = peek();
    if (!token) throw new Error('ends too soon');
    if (token.t === 'op' && token.v === '(') {
      at++;
      const inner = or();
      expect(')');
      return inner;
    }
    if (token.t !== 'key') throw new Error(`expected a context key at ${token.at + 1}, got "${token.v}"`);
    at++;
    if (isOp('==') || isOp('!=')) {
      const op = peek()!.v === '==' ? 'eq' : 'ne';
      at++;
      const value = peek();
      if (!value || value.t === 'op') throw new Error(`expected a value after "${op === 'eq' ? '==' : '!='}"`);
      at++;
      return { op, key: token.v, value: value.v };
    }
    return { op: 'key', key: token.v };
  }
  function unary(): WhenExpr {
    if (isOp('!')) {
      at++;
      return { op: 'not', arg: unary() };
    }
    return primary();
  }
  function chain(op: 'and' | 'or', sep: string, next: () => WhenExpr): WhenExpr {
    const args = [next()];
    while (isOp(sep)) {
      at++;
      args.push(next());
    }
    return args.length === 1 ? args[0] : { op, args };
  }
  const and = () => chain('and', '&&', unary);
  const or = () => chain('or', '||', and);

  if (tokens.length === 0) throw new Error('is empty');
  const expr = or();
  if (at < tokens.length) throw new Error(`unexpected "${tokens[at].v}" at ${tokens[at].at + 1}`);
  return expr;
}

/** The context keys a condition reads. */
export function whenKeys(expr: WhenExpr): string[] {
  switch (expr.op) {
    case 'key':
    case 'eq':
    case 'ne':
      return [expr.key];
    case 'not':
      return whenKeys(expr.arg);
    default:
      return expr.args.flatMap(whenKeys);
  }
}

/** Why a condition can't be used, or `null`. Keys no kind offers are errors. */
export function whenProblem(text: string): string | null {
  let expr: WhenExpr;
  try {
    expr = parseWhen(text);
  } catch (e) {
    return (e as Error).message;
  }
  const unknown = whenKeys(expr).filter((key) => !CONTEXT_KEYS.includes(key));
  if (unknown.length > 0) {
    return `no page offers ${unknown.map((k) => `"${k}"`).join(', ')}; use ${CONTEXT_KEYS.join(', ')}`;
  }
  return null;
}

/** Whether the condition holds. A key the context lacks is unset: false, and equal to nothing. */
export function evalWhen(expr: WhenExpr, context: WhenContext): boolean {
  const value = (key: string) => (Object.hasOwn(context, key) ? context[key] : undefined);
  switch (expr.op) {
    case 'key':
      return Boolean(value(expr.key));
    case 'eq':
    case 'ne': {
      const v = value(expr.key);
      const same = v !== undefined && String(v) === expr.value;
      return expr.op === 'eq' ? same : !same;
    }
    case 'not':
      return !evalWhen(expr.arg, context);
    case 'and':
      return expr.args.every((arg) => evalWhen(arg, context));
    case 'or':
      return expr.args.some((arg) => evalWhen(arg, context));
  }
}

/** Whether a panel with this condition shows; no condition shows always, and a broken one never. */
export function whenHolds(text: string | undefined, context: WhenContext): boolean {
  if (text === undefined) return true;
  try {
    return evalWhen(parseWhen(text), context);
  } catch {
    return false;
  }
}

/** The context a page of a kind offers, from what the page knows: only the kind's own keys are set. */
export function pageWhenContext(
  kind: PageKind,
  facts: { hasScores?: boolean; hasSubmissions?: boolean; signedIn: boolean; isOwner: boolean },
): WhenContext {
  const all: WhenContext = {
    'page.kind': kind,
    signedIn: facts.signedIn,
    'viewer.isOwner': facts.isOwner,
    'page.hasScores': facts.hasScores ?? false,
    'page.hasSubmissions': facts.hasSubmissions ?? false,
  };
  return Object.fromEntries(KINDS[kind].contextKeys.map((key) => [key, all[key]]));
}
