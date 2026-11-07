import { readFileSync } from 'node:fs';
import { inArray } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { institutionDomains } from '@/db/schema';
import { emailDomain, hasSubaddress } from '@/lib/email-address';

/**
 * Who may sign up: an allowlist of institutional email domains. Sign-up is refused for an address
 * whose domain is not on it, and confirming the address proves the person controls a mailbox at that
 * institution.
 *
 * Two sources, the table winning over the file for the same domain:
 *
 * - `config/institution-domains.json` (`INSTITUTION_DOMAINS_PATH` overrides): about 55k generated
 *   domains (`npm run institutions:build`). Edit the curated file and rebuild, never this one. Read
 *   once per process.
 * - the `institution_domains` table: domains an admin added by hand, with an SQL insert.
 *   **Queried on every check, not cached:** Next can load a module more than once, so a copy in memory
 *   could miss an addition, and an addition has to work at once. Checks come with sign-ups, which are
 *   rare and need the database anyway.
 *
 * A domain also admits its subdomains (`inf.ethz.ch` matches `ethz.ch`), the longest match winning,
 * and matching never goes below two labels, so a bare TLD on the list admits nobody.
 */

export interface Institution {
  domain: string;
  name: string;
}

const DEFAULT_PATH = 'config/institution-domains.json';

let cached: { path: string; domains: Map<string, string> } | undefined;

function fileDomains(): Map<string, string> {
  const path = process.env.INSTITUTION_DOMAINS_PATH || DEFAULT_PATH;
  if (cached?.path === path) return cached.domains;
  // Read at runtime from the working directory; the image copies config/ in
  // itself. Traced, this one read pulls the whole project into standalone.
  const parsed = JSON.parse(readFileSync(/*turbopackIgnore: true*/ path, 'utf8')) as {
    domains?: Record<string, unknown>;
  };
  if (!parsed.domains || typeof parsed.domains !== 'object') {
    throw new Error(`${path} must be { "domains": { "<domain>": "<institution name>" } }`);
  }
  const map = new Map<string, string>();
  for (const [domain, name] of Object.entries(parsed.domains)) {
    if (typeof name !== 'string' || !name) throw new Error(`${path}: "${domain}" needs an institution name`);
    map.set(domain.trim().toLowerCase().replace(/\.$/, ''), name);
  }
  cached = { path, domains: map };
  return map;
}

/** `a.b.ethz.ch` as `a.b.ethz.ch`, `b.ethz.ch`, `ethz.ch`: longest first, and never one label. */
export function domainCandidates(domain: string): string[] {
  const labels = domain.split('.');
  const out: string[] = [];
  for (let i = 0; labels.length - i >= 2; i += 1) out.push(labels.slice(i).join('.'));
  return out;
}

/** The institution a domain belongs to, or `null` when it is on neither list. */
export async function institutionForDomain(
  domain: string,
  database: Pick<Database, 'select'> = getDb(),
): Promise<Institution | null> {
  const candidates = domainCandidates(domain);
  if (candidates.length === 0) return null;
  const rows = await database.select().from(institutionDomains).where(inArray(institutionDomains.domain, candidates));
  const approved = new Map(rows.map((r) => [r.domain, r.name]));
  const file = fileDomains();
  for (const candidate of candidates) {
    const name = approved.get(candidate) ?? file.get(candidate);
    if (name) return { domain: candidate, name };
  }
  return null;
}

/**
 * The institution an email address belongs to, or `null` if its domain is not on the list, or if the
 * address has a `+tag` (`hasSubaddress`): one inbox, one account.
 */
export async function institutionForEmail(
  email: string,
  database: Pick<Database, 'select'> = getDb(),
): Promise<Institution | null> {
  const domain = emailDomain(email);
  if (!domain || hasSubaddress(email)) return null;
  return institutionForDomain(domain, database);
}

/** How many institutions are on the generated list, for telling people who may sign up. */
export function listedInstitutionCount(): number {
  return new Set(fileDomains().values()).size;
}
