import { readFileSync } from 'node:fs';
import { and, asc, eq, isNotNull, like, or, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { institutionDomains, institutionRequests, type InstitutionRequest } from '@/db/schema';
import { emailDomain, hasSubaddress, SUBADDRESS_REFUSED } from '@/lib/email-address';
import { institutionApprovedMail, institutionRejectedMail } from '@/lib/auth-mails';
import { normalizeEmail } from './affiliations';
import { ApiError } from './api/errors';
import { domainCandidates, institutionForDomain } from './institution-domains';
import { sendMail } from './mail';
import { consume, rateLimitHeaders, type RateLimitConfig } from './ratelimit';
import { siteUrl } from './site';

/**
 * Someone refused at sign-up asking for their institution to be added (DESIGN.md §5.2). The only
 * writer of `institution_requests`, and of `institution_domains`.
 *
 * Asking proves nothing about the address: anyone could type someone else's. That is harmless because
 * the admin judges the **domain**, the only mail an address can get from a request is the answer
 * (at most one per decision, and no mail at all is sent on asking), and signing up afterwards still
 * means confirming the mailbox.
 *
 * Decisions are per domain: approving one answers everyone who asked for it or a subdomain of it.
 */

/** Requests per address: 3, refilling over a day. */
const ADDRESS_BUDGET: RateLimitConfig = { burst: 3, perSecond: 3 / 86_400 };
/** Requests per client IP: 20, refilling over a day. What keeps the admin queue readable. */
const IP_BUDGET: RateLimitConfig = { burst: 20, perSecond: 20 / 86_400 };
/** Open requests one domain may hold. Enough to show demand; past it, more add nothing. */
const MAX_PENDING_PER_DOMAIN = 50;

interface RefusedDomains {
  freeMail: Set<string>;
  publicSuffixes: Set<string>;
  registryLabels: Set<string>;
}

let refused: RefusedDomains | undefined;

function refusedDomains(): RefusedDomains {
  if (refused) return refused;
  const path = process.env.REFUSED_DOMAINS_PATH || 'config/refused-domains.json';
  const parsed = JSON.parse(readFileSync(/*turbopackIgnore: true*/ path, 'utf8')) as {
    freeMail: string[];
    publicSuffixes: string[];
    registryLabels: string[];
  };
  refused = {
    freeMail: new Set(parsed.freeMail),
    publicSuffixes: new Set(parsed.publicSuffixes),
    registryLabels: new Set(parsed.registryLabels),
  };
  return refused;
}

const DOMAIN_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/**
 * Whether a domain could be an institution's at all, by the same tests the generated list uses. A
 * free-mail or disposable domain, a public suffix (listing `ac.uk` would admit all of its
 * universities) or a country's registry label is nobody's institution, at any depth.
 */
export function isRequestableDomain(domain: string): boolean {
  if (!DOMAIN_PATTERN.test(domain)) return false;
  const { freeMail, publicSuffixes, registryLabels } = refusedDomains();
  if (domainCandidates(domain).some((d) => freeMail.has(d))) return false;
  const labels = domain.split('.');
  if (publicSuffixes.has(domain) || publicSuffixes.has(`*.${labels.slice(1).join('.')}`)) return false;
  return !(labels.length === 2 && labels[1].length === 2 && registryLabels.has(labels[0]));
}

export interface NewRequest {
  email: string;
  institutionName: string;
  website?: string | null;
  note?: string | null;
}

/** Ask for the address's domain to be added. Asking again while one is open replaces it. */
export async function requestInstitution(
  input: NewRequest,
  clientIp: string | null,
  database: Database = getDb(),
): Promise<void> {
  const email = normalizeEmail(input.email);
  if (hasSubaddress(email)) throw new ApiError(422, 'validation_error', SUBADDRESS_REFUSED);
  const domain = emailDomain(email);
  if (!domain || !isRequestableDomain(domain)) {
    throw new ApiError(422, 'domain_not_institutional', 'use the address your institution gave you');
  }
  if (await institutionForDomain(domain, database)) {
    throw new ApiError(409, 'institution_already_listed', 'this institution is already on the list; you can sign up');
  }

  for (const [key, config] of [
    [`institution-request:${email}`, ADDRESS_BUDGET],
    ...(clientIp ? ([[`institution-request-ip:${clientIp}`, IP_BUDGET]] as const) : []),
  ] as const) {
    const budget = await consume(key, config);
    if (!budget.allowed) {
      throw new ApiError(
        429,
        'rate_limited',
        'too many requests; try again later',
        { retryAfterSeconds: budget.retryAfterSeconds },
        rateLimitHeaders(budget),
      );
    }
  }

  const fields = {
    domain,
    institutionName: input.institutionName.trim(),
    website: input.website?.trim() || null,
    note: input.note?.trim() || null,
  };
  await database.transaction(async (tx) => {
    // One domain's requests in turn, so the cap below holds under concurrency.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`institution-request:${domain}`}))`);
    const [{ open }] = await tx
      .select({ open: sql<number>`count(*)::int` })
      .from(institutionRequests)
      .where(and(eq(institutionRequests.domain, domain), eq(institutionRequests.status, 'pending')));
    if (open >= MAX_PENDING_PER_DOMAIN) return;
    await tx
      .insert(institutionRequests)
      .values({ email, ...fields })
      .onConflictDoUpdate({
        target: institutionRequests.email,
        targetWhere: sql`status = 'pending'`,
        set: { ...fields, createdAt: new Date() },
      });
  });
}

export interface DomainQueueEntry {
  domain: string;
  requests: Pick<InstitutionRequest, 'id' | 'institutionName' | 'website' | 'note' | 'createdAt'>[];
}

/** The open requests by domain, oldest first, for the admin queue. Never the addresses: the domain is what is judged. */
export async function pendingByDomain(database: Database = getDb()): Promise<DomainQueueEntry[]> {
  const rows = await database
    .select()
    .from(institutionRequests)
    .where(eq(institutionRequests.status, 'pending'))
    .orderBy(asc(institutionRequests.createdAt));
  const queue = new Map<string, DomainQueueEntry>();
  for (const { id, domain, institutionName, website, note, createdAt } of rows) {
    if (!queue.has(domain)) queue.set(domain, { domain, requests: [] });
    queue.get(domain)!.requests.push({ id, institutionName, website, note, createdAt });
  }
  return [...queue.values()];
}

export interface Decided {
  /** Requests answered by this decision. */
  decided: number;
  mailed: number;
  /** Mails that failed: their addresses are kept, and repeating the decision retries them. */
  mailFailed: number;
}

/** Requests for `domain` or under it: open ones, and decided ones whose answer has not gone out yet. */
function answerable(domain: string, status: 'approved' | 'rejected') {
  return and(
    or(eq(institutionRequests.domain, domain), like(institutionRequests.domain, `%.${domain}`)),
    or(
      eq(institutionRequests.status, 'pending'),
      and(eq(institutionRequests.status, status), isNotNull(institutionRequests.email)),
    ),
  );
}

/** Mail each address its answer; only a sent answer deletes the address (the table's rule). */
async function answer(
  rows: Pick<InstitutionRequest, 'id' | 'email'>[],
  mailFor: (email: string) => Parameters<typeof sendMail>[0],
  database: Database,
): Promise<Decided> {
  let mailed = 0;
  let mailFailed = 0;
  for (const row of rows) {
    if (!row.email) continue;
    try {
      await sendMail(mailFor(row.email));
      await database.update(institutionRequests).set({ email: null }).where(eq(institutionRequests.id, row.id));
      mailed += 1;
    } catch (err) {
      console.error('institution decision mail failed', row.id, err);
      mailFailed += 1;
    }
  }
  return { decided: rows.length, mailed, mailFailed };
}

function assertDecidable(domain: string): void {
  if (!isRequestableDomain(domain)) {
    throw new ApiError(422, 'domain_not_institutional', `${domain} cannot be an institution's domain`);
  }
}

/**
 * Add `domain` to the allowlist and tell everyone who asked for it or a subdomain. An admin may widen
 * a request for `cs.foo.edu` by approving `foo.edu`, which also admits its other subdomains. There must
 * be a request behind it: this is not a way to add any domain. Repeating it retries failed mails.
 */
export async function approveDomain(
  input: { domain: string; institutionName: string; adminAccountId: string },
  database: Database = getDb(),
): Promise<Decided> {
  const { domain, adminAccountId } = input;
  const name = input.institutionName.trim();
  assertDecidable(domain);
  const rows = await database.transaction(async (tx) => {
    const matched = await tx
      .select({ id: institutionRequests.id, email: institutionRequests.email })
      .from(institutionRequests)
      .where(answerable(domain, 'approved'))
      .for('update');
    if (matched.length === 0) throw new ApiError(404, 'not_found', `no open request for ${domain}`);
    await tx
      .insert(institutionDomains)
      .values({ domain, name, addedBy: adminAccountId })
      .onConflictDoUpdate({ target: institutionDomains.domain, set: { name, addedBy: adminAccountId } });
    await tx
      .update(institutionRequests)
      .set({ status: 'approved', decidedBy: adminAccountId, decidedAt: new Date() })
      .where(and(answerable(domain, 'approved'), eq(institutionRequests.status, 'pending')));
    return matched;
  });
  return answer(
    rows,
    (email) => ({ to: email, ...institutionApprovedMail(name, domain, `${siteUrl()}/welcome`) }),
    database,
  );
}

/** Decline every request for `domain` or under it, and say so. Repeating it retries failed mails. */
export async function rejectDomain(
  input: { domain: string; reason?: string | null; adminAccountId: string },
  database: Database = getDb(),
): Promise<Decided> {
  const { domain, adminAccountId } = input;
  const rows = await database.transaction(async (tx) => {
    const matched = await tx
      .select({ id: institutionRequests.id, email: institutionRequests.email })
      .from(institutionRequests)
      .where(answerable(domain, 'rejected'))
      .for('update');
    if (matched.length === 0) throw new ApiError(404, 'not_found', `no open request for ${domain}`);
    await tx
      .update(institutionRequests)
      .set({ status: 'rejected', decidedBy: adminAccountId, decidedAt: new Date() })
      .where(and(answerable(domain, 'rejected'), eq(institutionRequests.status, 'pending')));
    return matched;
  });
  const reason = input.reason?.trim() || null;
  return answer(rows, (email) => ({ to: email, ...institutionRejectedMail(domain, siteUrl(), reason) }), database);
}
