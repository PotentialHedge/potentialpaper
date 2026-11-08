/**
 * The email addresses printed on a PDF's first page, from `pdftotext`'s text of it (`raw` and `layout`
 * modes: each catches some addresses the other breaks). **Private:** what this returns goes only into
 * `pdf_documents.emails`.
 *
 * It handles what first pages actually do:
 *
 * - grouped addresses: `{alice, bob}@ethz.ch`, `{alice,bob}@inf.ethz.ch`, also split by `|` or `;`, in
 *   braces, brackets or parentheses, and across lines,
 * - an address broken over two lines (`alice@inf.` / `ethz.ch`),
 * - footnote markers (`alice@ethz.ch*`, `†`, a footnote number after the domain), ligatures and other
 *   compatibility characters (NFKC), and zero-width characters,
 * - templates and placeholders (`firstname.lastname@`, `email@domain.com`, `anonymous@`), which are dropped,
 * - things that look like addresses and aren't (`pass@1`, `NDCG@10`, `Acc@0.5`): a domain needs a real
 *   top-level domain.
 */

const LOCAL = String.raw`[A-Za-z0-9](?:[A-Za-z0-9._%+'-]{0,62}[A-Za-z0-9_+-])?`;
const DOMAIN = String.raw`(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}`;
/** One address. The lookarounds keep it from starting or ending inside a longer token. */
const SINGLE = new RegExp(
  String.raw`(?<![A-Za-z0-9._%+'-])(${LOCAL})\s?@\s?(${DOMAIN})(?![A-Za-z-]|\.[A-Za-z0-9])`,
  'g',
);
/** `{a, b}@domain`, with braces, brackets or parentheses, across lines. */
const GROUP = new RegExp(String.raw`[{[(]([^{}[\]()@]{1,600})[}\])]\s*@\s*(${DOMAIN})(?![A-Za-z-]|\.[A-Za-z0-9])`, 'g');

/** Generic top-level domains seen on papers; any two-letter one is taken as a country's. */
const GENERIC_TLDS = new Set(
  (
    'com org net edu gov mil int info biz name pro io ai app dev tech science cloud email academy institute ' +
    'research systems global group network online site xyz company center health law museum bio eco me ' +
    'studio solutions software engineering technology digital lab cat eus gal scot wales swiss berlin ' +
    'hamburg tokyo paris london nyc asia africa coop aero jobs mobi travel'
  ).split(' '),
);

const PLACEHOLDER_LOCALS = new Set([
  'email',
  'e-mail',
  'mail',
  'name',
  'yourname',
  'your.name',
  'your-name',
  'your_name',
  'author',
  'authors',
  'anonymous',
  'anon',
  'user',
  'username',
  'someone',
  'somebody',
  'xxx',
  'xx',
  'x',
  'abc',
  'example',
  'address',
  'myname',
  'first.last',
  'first_last',
  'first-last',
  'firstlast',
  'last.first',
  'name.surname',
  'name_surname',
  'name.lastname',
  'given.family',
  'givenname.familyname',
]);

const PLACEHOLDER_DOMAINS = new Set([
  'domain.com',
  'domain.edu',
  'domain.org',
  'email.com',
  'mail.com',
  'institution.edu',
  'institution.org',
  'institution.com',
  'university.edu',
  'univ.edu',
  'affiliation.edu',
  'affiliation.com',
  'company.com',
  'organization.org',
  'xxx.com',
  'xxx.edu',
  'xxx.xxx',
  'abc.com',
  'anon.com',
  'anonymous.com',
  'anonymous.edu',
  'anonymous.org',
]);

function isPlaceholder(local: string, domain: string): boolean {
  if (PLACEHOLDER_LOCALS.has(local) || PLACEHOLDER_DOMAINS.has(domain)) return true;
  if (/^anonymous|^anon[._-]/.test(local) || /(^|\.)anonymous(\.|$)|(^|\.)anon(\.|$)/.test(domain)) return true;
  if (/^(example|domain|email)\./.test(domain) || /\.example$|\.invalid$|\.test$|\.localhost$/.test(domain))
    return true;
  // `firstname.lastname@`, `first.last@`, `{firstname}@`: a template, not a person.
  if (/first[._-]?name|last[._-]?name|sur[._-]?name|family[._-]?name|given[._-]?name/.test(local)) return true;
  return false;
}

function validDomain(domain: string): boolean {
  const tld = domain.slice(domain.lastIndexOf('.') + 1);
  return tld.length === 2 || GENERIC_TLDS.has(tld);
}

/** Normalizes one address, or `null` if it isn't a person's address. */
function clean(local: string, domain: string): string | null {
  local = local.toLowerCase().replace(/^[.'-]+|[.'-]+$/g, '');
  domain = domain.toLowerCase().replace(/\.+$/, '');
  if (!local || local.length > 64 || local.includes('..')) return null;
  if (!validDomain(domain) || domain.length > 253) return null;
  if (isPlaceholder(local, domain)) return null;
  return `${local}@${domain}`;
}

/** NFKC (ligatures, full-width `＠`), without zero-width characters or soft hyphens. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[­​-‏⁠-⁤﻿]/g, '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n');
}

/**
 * Joins the line breaks that split addresses: one right before or after the `@`, and one after a `.`,
 * `-` or `_` in a domain or local part when the next line goes on in lower case.
 */
function joinBrokenLines(text: string): string {
  return text
    .replace(/[ \t]*\n[ \t]*(?=@)/g, '')
    .replace(/@[ \t]*\n[ \t]*/g, '@')
    .replace(/(?<=[A-Za-z0-9][._-])[ \t]*\n[ \t]*(?=[a-z0-9])/g, '');
}

function scan(text: string, found: string[]): void {
  // Groups first, then blanked out, so `bob}@ethz.ch` isn't read again as a lone address.
  const rest = text.replace(GROUP, (match, locals: string, domain: string) => {
    for (const local of locals.split(/[\s,;|/]+/)) {
      if (!new RegExp(`^${LOCAL}$`).test(local)) continue;
      const address = clean(local, domain);
      if (address) found.push(address);
    }
    return ' '.repeat(match.length);
  });
  for (const match of rest.matchAll(SINGLE)) {
    const address = clean(match[1], match[2]);
    if (address) found.push(address);
  }
}

/**
 * The distinct addresses on a first page, lower-cased, in the order first found. `raw` is
 * `pdftotext -raw`'s text of the page and `layout` its `-layout` text; either may be empty. Broken lines
 * are only joined in `raw`: `layout` sets columns side by side, so its next line may be another column's.
 */
export function extractEmails(raw: string, layout = ''): string[] {
  const direct: string[] = [];
  const joined: string[] = [];
  const rawText = normalizeText(raw);
  scan(rawText, direct);
  scan(normalizeText(layout), direct);
  scan(joinBrokenLines(rawText), joined);

  const candidates = [...new Set([...direct, ...joined])];
  const unbroken = new Set(direct);
  const split = (address: string) => address.split('@') as [string, string];
  return candidates.filter((address) => {
    const [local, domain] = split(address);
    return !candidates.some((other) => {
      if (other === address) return false;
      const [l, d] = split(other);
      // A local part broken after a hyphen or underscore (`seokhwan-` + `lee@koreanair.com`): the part on
      // the second line alone is someone else's address, if anyone's, so the joined one wins.
      if (d === domain && l.endsWith(local) && /[-_]$/.test(l.slice(0, -local.length))) return true;
      if (unbroken.has(address)) return false;
      // Otherwise a join that ran a sentence on into an address (`a@b.ch.` + `next`, `Zurich.` +
      // `alice@`) only makes a longer variant of one found unbroken, and the unbroken one wins.
      if (!unbroken.has(other)) return false;
      return (
        (l === local && domain.startsWith(`${d}.`)) ||
        (d === domain && local.endsWith(l) && !/[-_]$/.test(local.slice(0, -l.length)))
      );
    });
  });
}
